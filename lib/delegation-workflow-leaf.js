/**
 * Per-leaf workflow scope: normalize leaf ids and infer loop state from job history.
 */

import { normalizeTodoRefId } from './todo-ref.js';
import { parseDelegationVerdict } from './delegation-verdict.js';
import { isTerminalDelegationStatus } from './delegation-status.js';
import { listDelegationsForParent } from './persist/delegations-persist.js';

const TODO_REF_IN_TEXT_RE = /cretli-ref\s+todo=([0-9a-f]{8,}(?:-[0-9a-f]{1,12})*)/gi;

/**
 * @param {unknown} input
 * @returns {string}
 */
export function normalizeDelegationWorkflowLeafId(input) {
  if (!input || typeof input !== 'object') return '';
  const row = /** @type {Record<string, unknown>} */ (input);
  const raw = row.leafId ?? row.leaf_id ?? row.todoId ?? row.todo_id ?? '';
  return normalizeTodoRefId(raw);
}

/**
 * @param {unknown} text
 * @returns {string}
 */
export function extractDelegationWorkflowLeafIdFromText(text) {
  const source = String(text || '');
  if (!source.trim()) return '';
  TODO_REF_IN_TEXT_RE.lastIndex = 0;
  const match = TODO_REF_IN_TEXT_RE.exec(source);
  if (!match) return '';
  return normalizeTodoRefId(match[1]);
}

/**
 * @param {string} storedLeafId
 * @param {string} candidateLeafId
 * @returns {boolean}
 */
export function delegationWorkflowLeafIdsMatch(storedLeafId, candidateLeafId) {
  const stored = normalizeTodoRefId(storedLeafId);
  const candidate = normalizeTodoRefId(candidateLeafId);
  if (!stored || !candidate) return false;
  if (stored === candidate) return true;
  return stored.startsWith(candidate) || candidate.startsWith(stored);
}

/**
 * Leaf attribution for one delegation row. The explicit `todoId`/`leafId`
 * field wins; otherwise the `cretli-ref todo=` in the source text is used.
 *
 * @param {object | null | undefined} row
 * @returns {string}
 */
export function readDelegationWorkflowLeafIdFromRow(row) {
  return normalizeDelegationWorkflowLeafId(row)
    || extractDelegationWorkflowLeafIdFromText(row?.sourceText);
}

/**
 * Leaf id for a new start: explicit request fields, then source text ref, then
 * parent chat todo link when the job is otherwise unattributed.
 *
 * @param {unknown} input
 * @param {{ sourceText?: unknown, parentTodoId?: unknown }} [options]
 * @returns {string}
 */
export function resolveDelegationWorkflowLeafIdForStart(input, options = {}) {
  const explicit = normalizeDelegationWorkflowLeafId(input);
  if (explicit) return explicit;
  const fromText = extractDelegationWorkflowLeafIdFromText(options.sourceText);
  if (fromText) return fromText;
  return normalizeTodoRefId(options.parentTodoId);
}

/**
 * True only when the row is explicitly attributed to the wanted leaf. An empty
 * `leafId` matches nothing: history inference must never fold every review of a
 * parent into one leaf (that is the "N leaves sum their rounds" regression).
 *
 * @param {object | null | undefined} row
 * @param {string} leafId
 * @returns {boolean}
 */
export function delegationRowMatchesWorkflowLeaf(row, leafId) {
  const wanted = normalizeTodoRefId(leafId);
  if (!wanted) return false;
  const fromRow = readDelegationWorkflowLeafIdFromRow(row);
  if (!fromRow) return false;
  return delegationWorkflowLeafIdsMatch(fromRow, wanted);
}

/**
 * Deadline-cancel attribution. Unlike {@link delegationRowMatchesWorkflowLeaf},
 * an empty workflow leaf is allowed and then matches only unattributed jobs, so
 * a legacy chat-wide deadline still cancels its own work without touching jobs
 * that belong to an explicit leaf.
 *
 * @param {object | null | undefined} row
 * @param {string} leafId
 * @returns {boolean}
 */
export function delegationBelongsToWorkflowLeaf(row, leafId) {
  const wanted = normalizeTodoRefId(leafId);
  const fromRow = readDelegationWorkflowLeafIdFromRow(row);
  if (!wanted) return !fromRow;
  return Boolean(fromRow) && delegationWorkflowLeafIdsMatch(fromRow, wanted);
}

/**
 * @param {object} row
 * @returns {number}
 */
function readDelegationCreatedMs(row) {
  const stamp = Date.parse(String(row?.createdAt || row?.queuedAt || ''));
  return Number.isFinite(stamp) ? stamp : 0;
}

/**
 * Infer loop state from terminal implement→review history for one leaf.
 *
 * Round definition: the number of implement/fix cycles since the last PASS
 * review of the leaf. A cycle opens on an implement/fix job (or, for legacy
 * rows without an implement, on the first review), and every review of the same
 * cycle is grouped into that one round, so a parallel review fan-out never
 * multiplies the round. A PASS review resets the counter to 0; the next
 * implement/fix then starts round 1 again. Jobs that are still active are not
 * counted, and an empty leaf never infers (legacy per-chat rows keep their
 * parent-written state).
 *
 * @param {{
 *   parentChatId?: unknown,
 *   leafId?: unknown,
 *   delegations?: object[],
 * }} input
 * @returns {{
 *   round: number,
 *   lastVerdict: string,
 *   findingsHash: string,
 *   reviewEventCount: number,
 * }}
 */
export function inferDelegationWorkflowFromHistory(input = {}) {
  const parentChatId = String(input.parentChatId || '').trim();
  const leafId = normalizeDelegationWorkflowLeafId({ leafId: input.leafId });
  const rows = Array.isArray(input.delegations)
    ? input.delegations
    : listDelegationsForParent(parentChatId);
  const scoped = rows
    .filter((row) => String(row?.parentChatId || '').trim() === parentChatId)
    .filter((row) => delegationRowMatchesWorkflowLeaf(row, leafId))
    .filter((row) => isTerminalDelegationStatus(row?.status))
    .sort((a, b) => readDelegationCreatedMs(a) - readDelegationCreatedMs(b));
  let round = 0;
  let groupCounted = false;
  let latestReview = null;
  let reviewEventCount = 0;
  for (const row of scoped) {
    const assignment = String(row?.assignment || '').trim();
    if (assignment === 'review') {
      reviewEventCount += 1;
      if (!groupCounted) {
        round += 1;
        groupCounted = true;
      }
      latestReview = row;
      const verdict = parseDelegationVerdict(String(row.report || ''));
      if (verdict === 'PASS') round = 0;
      continue;
    }
    if (assignment === 'implement' || assignment === 'fix') {
      round += 1;
      groupCounted = true;
    }
  }
  const lastVerdict = latestReview
    ? (parseDelegationVerdict(String(latestReview.report || '')) || 'unspecified')
    : 'unspecified';
  return {
    round,
    lastVerdict: lastVerdict || 'unspecified',
    findingsHash: '',
    reviewEventCount,
  };
}

/**
 * @param {unknown} stopReason
 * @returns {boolean}
 */
export function isDelegationWorkflowHardStopReason(stopReason) {
  const reason = String(stopReason || '').trim();
  if (!reason) return false;
  if (reason === 'rounds_exhausted' || reason === 'rounds_exhausted_soft') return false;
  return true;
}
