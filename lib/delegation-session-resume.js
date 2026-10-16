/**
 * Optional, explicit resume of an earlier reviewer session.
 *
 * A review start may name a finished review delegation (`resume_session_of`).
 * When every check below passes, the new delegation re-enters the SAME child
 * chat (and therefore the same harness session) as a new turn appended to its
 * history. It is still a new delegation with its own attempt, report, verdict
 * and material id: nothing from the earlier round is carried over as a verdict.
 *
 * The capability is off by default and is not wired into any loop; callers that
 * never pass `resume_session_of` get a fresh chat exactly as before.
 *
 * Every refusal is a deterministic FALLBACK, not an error: the slot starts a
 * new chat and the reason is recorded on the delegation. The decision is a pure
 * function of its inputs so the start path can re-run it synchronously right
 * before the record is created (concurrent starts never share a live session).
 */

import { decodeModelValue } from './model-catalog.js';
import { delegationController } from './delegation-control.js';
import { isTerminalDelegationStatus } from './delegation-status.js';
import { isImplementOrFixDelegationRow } from './delegation-implement-verify-gate.js';
import { sameCanonicalModel } from './model-identity.js';
import {
  buildSessionResumePromptBlock,
  normalizeSessionResumeRecord,
} from './delegation-session-resume-record.js';
import { delegationController } from './delegation-control.js';

export { buildSessionResumePromptBlock, normalizeSessionResumeRecord };

/** Stable reason codes recorded on `delegation.sessionResume.reasonCode`. */
export const SESSION_RESUME_REASON = Object.freeze({
  RESUMED: 'resumed',
  REVIEW_ONLY: 'resume_review_only',
  SOURCE_NOT_FOUND: 'resume_source_not_found',
  SCOPE_CHANGED: 'resume_scope_changed',
  CONFIG_CHANGED: 'resume_config_changed',
  UNSUPPORTED: 'resume_unsupported',
  LOCKED_OUT: 'resume_locked_out',
  INDEPENDENCE: 'resume_independence',
  SOURCE_BUSY: 'resume_source_busy',
  SOURCE_CLAIMED: 'resume_session_claimed',
  SOURCE_CANCELLED: 'resume_source_cancelled',
  SOURCE_UNUSABLE: 'resume_source_unusable',
  AFTER_RESTART: 'resume_after_restart',
  CHAT_MISSING: 'resume_chat_missing',
  SESSION_MISSING: 'resume_session_missing',
  SESSION_RESET: 'resume_session_reset',
  PEER_CONTEXT: 'resume_peer_context',
  SOURCE_SUPERSEDED: 'resume_source_superseded',
  PHASE_CHANGED: 'phase_changed',
  CONTAMINATED: 'resume_implementation_history',
  // Policy-level decisions (no source session was even considered).
  FRESH_BY_POLICY: 'reuse_fresh_by_policy',
  FIRST_SESSION: 'reuse_first_session',
  LEARNING: 'reuse_learning_pair',
  NO_ELIGIBLE_SOURCE: 'reuse_no_eligible_source',
  NOT_POOL_MEMBER: 'reuse_not_pool_member',
});

const REASON_TEXT = Object.freeze({
  [SESSION_RESUME_REASON.REVIEW_ONLY]: 'Session resume applies to review assignments only; started a new chat.',
  [SESSION_RESUME_REASON.SOURCE_NOT_FOUND]: 'The named review delegation was not found for this controller; started a new chat.',
  [SESSION_RESUME_REASON.SCOPE_CHANGED]: 'The review subject, mode or leaf differs from the named delegation; started a new chat.',
  [SESSION_RESUME_REASON.CONFIG_CHANGED]: 'Harness, model, options, execution mode or folder differ from the named session; started a new chat.',
  [SESSION_RESUME_REASON.UNSUPPORTED]: 'The harness adapter cannot resume a session; started a new chat.',
  [SESSION_RESUME_REASON.LOCKED_OUT]: 'The harness/model pair is under an active lockout; started a new chat.',
  [SESSION_RESUME_REASON.INDEPENDENCE]: 'The reviewer shares a base model with an implementer of this leaf; a resumed session could not be proven independent, started a new chat.',
  [SESSION_RESUME_REASON.SOURCE_BUSY]: 'The named session is still running; started a new chat.',
  [SESSION_RESUME_REASON.SOURCE_CLAIMED]: 'Another delegation already holds the named session; started a new chat.',
  [SESSION_RESUME_REASON.SOURCE_CANCELLED]: 'The named delegation was cancelled; started a new chat.',
  [SESSION_RESUME_REASON.SOURCE_UNUSABLE]: 'The named delegation did not finish with a usable report; started a new chat.',
  [SESSION_RESUME_REASON.AFTER_RESTART]: 'The named session was interrupted by a server restart; started a new chat.',
  [SESSION_RESUME_REASON.CHAT_MISSING]: 'The named session chat no longer exists; started a new chat.',
  [SESSION_RESUME_REASON.SESSION_MISSING]: 'The named chat has no harness session id to resume; started a new chat.',
  [SESSION_RESUME_REASON.SESSION_RESET]: 'The session was reset or compacted since the named delegation; started a new chat.',
  [SESSION_RESUME_REASON.SOURCE_SUPERSEDED]: 'A newer delegation already used the named session chat; started a new chat.',
  [SESSION_RESUME_REASON.PHASE_CHANGED]: 'The review phase changed (audit and closure never share a session); started a new chat.',
  [SESSION_RESUME_REASON.CONTAMINATED]: 'The named session also ran implementation or fix work; a reviewer must not reuse it, started a new chat.',
  [SESSION_RESUME_REASON.FRESH_BY_POLICY]: 'Session continuation is off for this review subject; started a new chat.',
  [SESSION_RESUME_REASON.FIRST_SESSION]: 'First review session of this reviewer under the reuse policy; started a new chat.',
  [SESSION_RESUME_REASON.LEARNING]: 'The reviewer pair is still being learned; this reviewer has no earlier session yet, started a new chat.',
  [SESSION_RESUME_REASON.NO_ELIGIBLE_SOURCE]: 'No earlier finished review session of this reviewer matches the policy scope; started a new chat.',
  [SESSION_RESUME_REASON.NOT_POOL_MEMBER]: 'This reviewer is not a member of the fixed pair, so no session is reused; started a new chat.',
  [SESSION_RESUME_REASON.PEER_CONTEXT]: 'The named session saw peer opinions (exchange phase) and this start is independent; started a new chat.',
});

/** Policy-level codes that are a plain "fresh chat", not a refused resume. */
const FRESH_REASON_CODES = new Set([
  SESSION_RESUME_REASON.FRESH_BY_POLICY,
  SESSION_RESUME_REASON.FIRST_SESSION,
  SESSION_RESUME_REASON.LEARNING,
  SESSION_RESUME_REASON.NOT_POOL_MEMBER,
]);

const USABLE_VERDICTS = new Set(['PASS', 'FAIL', 'BLOCKED']);

/** Chat field holding the harness session id, per transport. */
const SESSION_ID_FIELD = Object.freeze({
  sdk: 'cursorSessionId',
  opencode: 'opencodeSessionId',
  codebuddy: 'codebuddySessionId',
  deepseek: 'deepseekSessionId',
  codex: 'codexThreadId',
  qwen: 'qwenSessionId',
  claude: 'claudeSessionId',
});

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return String(value ?? '').trim();
}

/**
 * @param {unknown} model
 * @returns {string}
 */
function baseModel(model) {
  const raw = text(model);
  return raw ? text(decodeModelValue(raw).modelId).toLowerCase() : '';
}

/**
 * Normalized `::` params (`effort=...`) of a stored model value, so param order
 * never reads as a config change.
 *
 * @param {unknown} model
 * @returns {string}
 */
function modelParamsKey(model) {
  const params = decodeModelValue(text(model)).params || [];
  return JSON.stringify(
    params
      .map((row) => [String(row.id).trim(), String(row.value).trim()])
      .sort((a, b) => a[0].localeCompare(b[0])),
  );
}

/**
 * @param {unknown} options
 * @returns {string}
 */
function optionsKey(options) {
  const bag = options && typeof options === 'object' ? options : {};
  const sorted = Object.keys(bag).sort().map((key) => [key, bag[key]]);
  return JSON.stringify(sorted);
}

/**
 * True when two executor configs name the same session: same canonical model
 * (a Claude alias equals the numbered id it resolves to), same `::` params and
 * the same option bag. The callers compare the transport separately.
 *
 * @param {string} transport
 * @param {{ model?: unknown, options?: unknown }} a
 * @param {{ model?: unknown, options?: unknown }} b
 * @returns {boolean}
 */
function sameExecutorConfig(transport, a, b) {
  return modelParamsKey(a?.model) === modelParamsKey(b?.model)
    && optionsKey(a?.options) === optionsKey(b?.options)
    && sameCanonicalModel(transport, baseModel(a?.model), baseModel(b?.model));
}

/**
 * Newest finished review of the same controller, subject and executor config,
 * so the start can re-enter that reviewer session. `scope=leaf` (default) also
 * requires the same leaf; `scope=orchestrator` accepts any leaf of the
 * controller. With `reviewMode`, a source of the same phase wins over a newer
 * one of another phase (audit and closure never share a session; the other
 * phase is returned only so the gate can record `phase_changed`).
 * Returns '' when none exists; `inspectDelegationSessionResume` still applies
 * every gate and falls back to a new chat.
 *
 * @param {{ delegations?: object[], parentChatId?: unknown, reviewSubject?: unknown, leafId?: unknown, reviewMode?: unknown, scope?: unknown, executor?: { transport?: unknown, model?: unknown, options?: unknown } }} input
 * @returns {string}
 */
export function findPairResumeSource(input = {}) {
  const rows = Array.isArray(input.delegations) ? input.delegations : [];
  const parentChatId = text(input.parentChatId);
  if (!parentChatId) return '';
  const transport = text(input.executor?.transport).toLowerCase();
  const acrossLeaves = text(input.scope).toLowerCase() === 'orchestrator';
  const stamp = (row) => Date.parse(row?.queuedAt || row?.createdAt || '') || 0;
  const candidates = rows
    .filter((row) => text(row?.assignment).toLowerCase() === 'review'
      && delegationController(row) === parentChatId
      && text(row.status) === 'completed'
      && text(row.childChatId) !== ''
      && text(row.executor?.transport).toLowerCase() === transport
      && sameExecutorConfig(transport, row.executor, input.executor)
      && text(row.reviewSubject).toLowerCase() === text(input.reviewSubject).toLowerCase()
      && (acrossLeaves || text(row.leafId) === text(input.leafId)))
    .sort((a, b) => stamp(b) - stamp(a));
  const mode = text(input.reviewMode).toLowerCase();
  const sameMode = mode ? candidates.filter((row) => text(row.reviewMode).toLowerCase() === mode) : [];
  const match = sameMode[0] || candidates[0];
  return match ? text(match.id) : '';
}

/**
 * @param {string} transport
 * @param {object | null | undefined} chat
 * @returns {string}
 */
export function readChatHarnessSessionId(transport, chat) {
  const field = SESSION_ID_FIELD[text(transport).toLowerCase()];
  return field ? text(chat?.[field]) : '';
}

/**
 * Read the optional resume pointer from a start input (camel or snake case).
 *
 * @param {object | null | undefined} input
 * @returns {string}
 */
export function readResumeSessionOfInput(input) {
  return text(input?.resumeSessionOf ?? input?.resume_session_of);
}

/**
 * @param {string} code
 * @param {object} [extra]
 * @returns {{ requested: true, resume: false, reasonCode: string, reason: string }}
 */
function fallback(code, extra = {}) {
  return {
    requested: true,
    resume: false,
    reasonCode: code,
    reason: REASON_TEXT[code] || code,
    sourceDelegationId: text(extra.sourceDelegationId),
  };
}

/**
 * Decide whether a review start may re-enter an earlier reviewer chat.
 *
 * Order matters and is part of the contract: structural refusals first, then
 * hard exclusions (lockout, independence), then liveness/claim checks.
 *
 * @param {{
 *   resumeSessionOf?: unknown,
 *   parentChatId?: unknown,
 *   assignment?: unknown,
 *   reviewSubject?: unknown,
 *   reviewMode?: unknown,
 *   leafId?: unknown,
 *   sessionScope?: 'leaf' | 'orchestrator',
 *   executor?: { transport?: unknown, model?: unknown, options?: unknown },
 *   executionMode?: unknown,
 *   executionFolder?: unknown,
 *   allowChildDelegations?: boolean,
 *   depth?: number,
 *   rootChatId?: string,
 *   planReviewerPhase?: unknown,
 *   exchangeOfDelegationId?: unknown,
 *   delegations?: object[],
 *   findChat?: (chatId: string) => object | null,
 *   capabilities?: { canResumeSession?: boolean } | null,
 *   lockoutActive?: boolean,
 *   isRunActive?: (chatId: string) => boolean,
 *   currentGeneration?: (chatId: string) => number,
 * }} input
 * @returns {{
 *   requested: boolean,
 *   resume: boolean,
 *   reasonCode: string,
 *   reason: string,
 *   sourceDelegationId: string,
 *   childChatId?: string,
 *   round?: number,
 *   sessionGeneration?: number,
 * }}
 */
export function inspectDelegationSessionResume(input = {}) {
  const sourceId = readResumeSessionOfInput(input);
  if (!sourceId) {
    return { requested: false, resume: false, reasonCode: '', reason: '', sourceDelegationId: '' };
  }
  if (text(input.assignment).toLowerCase() !== 'review') {
    return fallback(SESSION_RESUME_REASON.REVIEW_ONLY, { sourceDelegationId: sourceId });
  }
  const rows = Array.isArray(input.delegations) ? input.delegations : [];
  const parentChatId = text(input.parentChatId);
  const source = rows.find((row) => text(row?.id) === sourceId) || null;
  // A foreign controller's row is reported as missing so existence is not leaked.
  const controller = delegationController(source);
  if (!source || !parentChatId || controller !== parentChatId) {
    return fallback(SESSION_RESUME_REASON.SOURCE_NOT_FOUND, { sourceDelegationId: sourceId });
  }
  const failWith = (code) => fallback(code, { sourceDelegationId: sourceId });
  // `orchestrator` scope lets a session travel between leaves of one
  // controller; every other gate below still applies.
  const acrossLeaves = text(input.sessionScope).toLowerCase() === 'orchestrator';
  if (text(source.assignment).toLowerCase() !== 'review'
    || isImplementOrFixDelegationRow(source)
    || text(source.reviewSubject).toLowerCase() !== text(input.reviewSubject).toLowerCase()
    || (!acrossLeaves && text(source.leafId) !== text(input.leafId))) {
    return failWith(SESSION_RESUME_REASON.SCOPE_CHANGED);
  }
  const wantedMode = text(input.reviewMode).toLowerCase();
  if (wantedMode && text(source.reviewMode).toLowerCase() !== wantedMode) {
    return failWith(SESSION_RESUME_REASON.PHASE_CHANGED);
  }
  const transport = text(input.executor?.transport).toLowerCase();
  const sameConfig = text(source.executor?.transport).toLowerCase() === transport
    && sameExecutorConfig(transport, source.executor, input.executor)
    && text(source.executionMode) === text(input.executionMode)
    && text(source.executionFolder) === text(input.executionFolder)
    // Delegation rights and tree position are part of the session config: a
    // resumed chat must not keep a grant the new round was not given.
    && (source.allowChildDelegations === true) === (input.allowChildDelegations === true)
    && (Number(source.depth) || 1) === (Number(input.depth) || 1)
    && text(source.rootChatId) === text(input.rootChatId);
  if (!sameConfig) return failWith(SESSION_RESUME_REASON.CONFIG_CHANGED);
  if (input.capabilities?.canResumeSession !== true) return failWith(SESSION_RESUME_REASON.UNSUPPORTED);
  if (input.lockoutActive === true) return failWith(SESSION_RESUME_REASON.LOCKED_OUT);
  const reviewerBase = baseModel(input.executor?.model);
  const sharesImplementer = rows.some((row) => text(row?.leafId) === text(input.leafId)
    && delegationController(row) === parentChatId
    && isImplementOrFixDelegationRow(row)
    && reviewerBase !== ''
    && baseModel(row?.executor?.model) === reviewerBase);
  if (sharesImplementer) return failWith(SESSION_RESUME_REASON.INDEPENDENCE);
  // Every delegation that ever ran in the source chat shares its context, so
  // the peer check and the round counter look at the whole chat, not one row.
  const chatRows = rows.filter((row) => text(row?.childChatId) !== ''
    && text(row.childChatId) === text(source.childChatId));
  // A reviewer session must never carry implementation or fix history.
  if (chatRows.some((row) => isImplementOrFixDelegationRow(row))) {
    return failWith(SESSION_RESUME_REASON.CONTAMINATED);
  }
  const sawExchange = (row) => text(row?.planReviewerPhase).toLowerCase() === 'exchange'
    || text(row?.exchangeOfDelegationId) !== '';
  const sourceSawPeers = chatRows.some(sawExchange) || sawExchange(source);
  const stamp = (row) => Date.parse(row?.queuedAt || row?.createdAt || '') || 0;
  const superseded = chatRows.some((row) => text(row.id) !== sourceId
    && isTerminalDelegationStatus(row.status)
    && (row.sessionResume?.status === 'resumed'
      ? text(row.sessionResume.sourceDelegationId) === sourceId || stamp(row) >= stamp(source)
      : stamp(row) > stamp(source)));
  if (superseded) return failWith(SESSION_RESUME_REASON.SOURCE_SUPERSEDED);
  const phase = text(input.planReviewerPhase).toLowerCase() || 'independent';
  if (phase === 'independent' && sourceSawPeers) return failWith(SESSION_RESUME_REASON.PEER_CONTEXT);
  if (!isTerminalDelegationStatus(source.status)) return failWith(SESSION_RESUME_REASON.SOURCE_BUSY);
  if (text(source.status) === 'cancelled') return failWith(SESSION_RESUME_REASON.SOURCE_CANCELLED);
  if (text(source.status) === 'interrupted') return failWith(SESSION_RESUME_REASON.AFTER_RESTART);
  const verdict = text(source.reportVerdict || source.verdict).toUpperCase();
  if (text(source.status) !== 'completed' || !USABLE_VERDICTS.has(verdict)) {
    return failWith(SESSION_RESUME_REASON.SOURCE_UNUSABLE);
  }
  const childChatId = text(source.childChatId);
  const claimed = rows.some((row) => text(row?.id) !== sourceId
    && text(row?.childChatId) === childChatId
    && !isTerminalDelegationStatus(row.status));
  if (!childChatId || claimed) return failWith(SESSION_RESUME_REASON.SOURCE_CLAIMED);
  const chat = typeof input.findChat === 'function' ? input.findChat(childChatId) : null;
  if (!chat) return failWith(SESSION_RESUME_REASON.CHAT_MISSING);
  if (!readChatHarnessSessionId(transport, chat)) return failWith(SESSION_RESUME_REASON.SESSION_MISSING);
  if (typeof input.isRunActive === 'function' && input.isRunActive(childChatId)) {
    return failWith(SESSION_RESUME_REASON.SOURCE_BUSY);
  }
  const generation = typeof input.currentGeneration === 'function'
    ? Math.max(0, Number(input.currentGeneration(childChatId)) || 0)
    : 0;
  // A row without a record started on a fresh chat, i.e. generation 0.
  const recorded = Math.max(0, Number(source.sessionResume?.sessionGeneration) || 0);
  if (recorded !== generation) {
    return failWith(SESSION_RESUME_REASON.SESSION_RESET);
  }
  const previousRound = chatRows.reduce(
    (max, row) => Math.max(max, Number(row.sessionResume?.round) || 1),
    1,
  );
  return {
    requested: true,
    resume: true,
    reasonCode: SESSION_RESUME_REASON.RESUMED,
    reason: 'Re-entered the named reviewer session as a new round.',
    sourceDelegationId: sourceId,
    childChatId,
    round: previousRound + 1,
    sessionGeneration: generation,
  };
}

/**
 * A policy-level decision that never reached the resume gate (no source was
 * considered): fresh by policy, first session, learning, no eligible source...
 * Same shape as a gate fallback so cards and records treat both alike.
 *
 * @param {string} code a `SESSION_RESUME_REASON` value
 * @returns {ReturnType<typeof inspectDelegationSessionResume>}
 */
export function buildPolicyReuseDecision(code) {
  return {
    requested: true,
    resume: false,
    reasonCode: code,
    reason: REASON_TEXT[code] || code,
    sourceDelegationId: '',
  };
}

/**
 * Durable shape stored on the delegation row. `null` when resume was never
 * requested so legacy and default rows are unchanged. Plain "fresh chat"
 * outcomes (first session, learning, fresh by policy) get status `fresh`; a
 * refused resume stays `fallback`.
 *
 * @param {ReturnType<typeof inspectDelegationSessionResume>} decision
 * @param {{ generation?: number }} [extra]
 * @returns {object | null}
 */
export function buildSessionResumeRecord(decision, extra = {}) {
  if (!decision?.requested) return null;
  const status = decision.resume ? 'resumed' : FRESH_REASON_CODES.has(decision.reasonCode) ? 'fresh' : 'fallback';
  return {
    requested: true,
    status,
    reasonCode: decision.reasonCode,
    reason: decision.reason,
    sourceDelegationId: decision.sourceDelegationId,
    round: decision.resume ? decision.round : 1,
    sessionGeneration: decision.resume
      ? decision.sessionGeneration
      : Math.max(0, Number(extra.generation) || 0),
  };
}
