/**
 * Durable review-findings ledger, keyed by workspaceFolder + leafId.
 *
 * Server-side only and purely additive: prose reports stay authoritative for
 * verdicts. The ledger gives every parsed finding a canonical key and tracks
 * its outcome (open | fixed | still_open_at_stop | rejected | out_of_scope |
 * follow_up | unlinked) across audit/closure rounds of one review cycle.
 *
 * A cycle closes only when a resolved PASS round is announced
 * (`onReviewRoundResolved`), never on the closure epoch bump.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeJsonAtomic } from './atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';
import { ensureDelegationOwnerLock } from '../delegation-owner-lock.js';
import { redactPrivatePaths, scrubFindingFile } from '../review-lessons-privacy.js';
import {
  normalizeReviewFindingCategory,
  normalizeReviewFindingPriority,
  normalizeReviewFindingRejectReason,
} from '../review-findings-taxonomy.js';

const DATA_FILE = resolveDataPath('review-findings-ledger.json');
export const REVIEW_FINDINGS_LEDGER_SCHEMA_VERSION = 1;
const MAX_ENTRIES_PER_LEAF = 400;
const MAX_CLOSED_MEMBERS = 64;
const MAX_NOTE = 500;

export class ReviewFindingsLedgerCorruptError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'ReviewFindingsLedgerCorruptError';
    this.code = 'REVIEW_FINDINGS_LEDGER_CORRUPT';
  }
}

/** @returns {string} */
export function getReviewFindingsLedgerDataPath() {
  return DATA_FILE;
}

/**
 * @param {unknown} workspaceFolder
 * @returns {string}
 */
function normalizeWorkspace(workspaceFolder) {
  const raw = String(workspaceFolder || '').trim();
  return raw ? path.resolve(raw) : '';
}

/**
 * @param {unknown} leafId
 * @returns {string}
 */
function normalizeLeaf(leafId) {
  return String(leafId || '').trim().toLowerCase();
}

/**
 * @returns {object[]}
 */
function loadItems() {
  if (!fs.existsSync(DATA_FILE)) return [];
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    throw new ReviewFindingsLedgerCorruptError(
      `Review findings ledger is unreadable (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) {
    throw new ReviewFindingsLedgerCorruptError('Review findings ledger has no items array');
  }
  return parsed.items.filter((row) => row && typeof row === 'object' && !Array.isArray(row));
}

/**
 * @param {object[]} items
 */
function saveItems(items) {
  ensureDelegationOwnerLock();
  writeJsonAtomic(DATA_FILE, { v: REVIEW_FINDINGS_LEDGER_SCHEMA_VERSION, items });
}

/**
 * @param {string} workspaceFolder
 * @param {string} leafId
 * @returns {object}
 */
function emptyItem(workspaceFolder, leafId) {
  return {
    workspaceFolder,
    leafId,
    cycle: 1,
    seq: 0,
    audits: 0,
    closures: 0,
    delegations: {},
    closedMemberIds: [],
    entries: [],
    updatedAt: '',
  };
}

/**
 * Derive the outcome of one entry from its marks (last mark wins).
 *
 * @param {object} entry
 * @returns {string}
 */
export function deriveFindingOutcome(entry) {
  const marks = Array.isArray(entry.marks) ? entry.marks : [];
  const last = marks.reduce((best, mark) => (!best || mark.seq > best.seq ? mark : best), null);
  // OUT_OF_SCOPE is terminal: a finding a reviewer put outside the leaf scope is
  // never rejectable and never a suppress candidate, even if a rejection was
  // recorded against it by an older write.
  if (last?.status === 'OUT_OF_SCOPE') return 'out_of_scope';
  // FOLLOW_UP is likewise terminal: derived before any rejection is consulted so
  // a rejection attempt can never turn it into a suppress candidate.
  if (last?.status === 'FOLLOW_UP') return 'follow_up';
  if (entry.rejection) return 'rejected';
  if (entry.unlinked === true) return 'unlinked';
  if (last?.status === 'FIXED') return 'fixed';
  if (Number(entry.stopSeq) > 0 && Number(entry.stopSeq) > (last?.seq || 0)) return 'still_open_at_stop';
  return 'open';
}

/**
 * @param {object} item
 * @returns {object}
 */
function refreshOutcomes(item) {
  for (const entry of item.entries) entry.outcome = deriveFindingOutcome(entry);
  if (item.entries.length > MAX_ENTRIES_PER_LEAF) {
    item.entries = item.entries.slice(-MAX_ENTRIES_PER_LEAF);
  }
  item.updatedAt = new Date().toISOString();
  return item;
}

/**
 * @param {object[]} items
 * @param {string} workspaceFolder
 * @param {string} leafId
 * @returns {{ item: object, index: number }}
 */
function findItem(items, workspaceFolder, leafId) {
  const index = items.findIndex((row) => row.workspaceFolder === workspaceFolder && row.leafId === leafId);
  if (index >= 0) return { item: items[index], index };
  return { item: emptyItem(workspaceFolder, leafId), index: -1 };
}

/**
 * @param {object} item
 * @returns {void}
 */
function bumpSeq(item) {
  item.seq = Number(item.seq || 0) + 1;
}

/**
 * Persist one item through a mutator; returns the mutator result.
 *
 * @template T
 * @param {unknown} workspaceFolderRaw
 * @param {unknown} leafIdRaw
 * @param {(item: object) => T} mutate
 * @returns {T | null}
 */
function withItem(workspaceFolderRaw, leafIdRaw, mutate) {
  const workspaceFolder = normalizeWorkspace(workspaceFolderRaw);
  const leafId = normalizeLeaf(leafIdRaw);
  if (!workspaceFolder || !leafId) return null;
  const items = loadItems();
  const { item, index } = findItem(items, workspaceFolder, leafId);
  const result = mutate(item);
  refreshOutcomes(item);
  if (index >= 0) items[index] = item;
  else items.push(item);
  saveItems(items);
  return result;
}

/**
 * @param {unknown} workspaceFolder
 * @param {unknown} leafId
 * @returns {object | null} the ledger item (all cycles) or null
 */
export function getReviewFindingsLedger(workspaceFolder, leafId) {
  const ws = normalizeWorkspace(workspaceFolder);
  const leaf = normalizeLeaf(leafId);
  if (!ws || !leaf) return null;
  return loadItems().find((row) => row.workspaceFolder === ws && row.leafId === leaf) || null;
}

/**
 * @param {unknown} workspaceFolder
 * @returns {object[]} every ledger item (all leaves, all cycles) of the workspace
 */
export function listReviewFindingsLedgerItems(workspaceFolder) {
  const ws = normalizeWorkspace(workspaceFolder);
  if (!ws) return [];
  return loadItems().filter((row) => row.workspaceFolder === ws);
}

/**
 * Current-cycle entries that are still unresolved (outcome `open` or
 * `still_open_at_stop`), i.e. what a fixer or closure reviewer must address.
 *
 * @param {unknown} workspaceFolder
 * @param {unknown} leafId
 * @returns {object[]}
 */
export function listOpenReviewFindings(workspaceFolder, leafId) {
  const item = getReviewFindingsLedger(workspaceFolder, leafId);
  if (!item) return [];
  return item.entries.filter((entry) => entry.cycle === item.cycle
    && (entry.outcome === 'open' || entry.outcome === 'still_open_at_stop'));
}

/**
 * Entries a human may turn into a suppress rule: rejected findings only.
 * OUT_OF_SCOPE / follow_up entries never feed this list.
 *
 * @param {unknown} workspaceFolder
 * @param {unknown} leafId
 * @returns {object[]}
 */
export function listSuppressCandidateFindings(workspaceFolder, leafId) {
  const item = getReviewFindingsLedger(workspaceFolder, leafId);
  return item ? item.entries.filter((entry) => deriveFindingOutcome(entry) === 'rejected') : [];
}

/**
 * @param {object} item
 * @param {string} id raw id or canonical key from a report
 * @returns {object | null} unique linked entry of the current cycle
 */
function linkEntry(item, id) {
  const wanted = String(id || '').trim().toUpperCase();
  if (!wanted) return null;
  const pool = item.entries.filter((entry) => entry.cycle === item.cycle && !entry.unlinked);
  const byKey = pool.find((entry) => entry.key.toUpperCase() === wanted);
  if (byKey) return byKey;
  const byRaw = pool.filter((entry) => String(entry.rawId || '').toUpperCase() === wanted);
  return byRaw.length === 1 ? byRaw[0] : null;
}

/**
 * Remove everything one delegation contributed (retry = latest attempt only).
 *
 * @param {object} item
 * @param {string} delegationId
 */
function retractDelegation(item, delegationId) {
  item.entries = item.entries.filter((entry) => entry.origin?.delegationId !== delegationId);
  for (const entry of item.entries) {
    entry.marks = (entry.marks || []).filter((mark) => mark.delegationId !== delegationId);
  }
}

/**
 * First free key `<prefix>-<tag><n>` among the leaf's entries.
 *
 * @param {object} item
 * @param {string} prefix
 * @param {string} tag
 * @param {number} start
 * @returns {{ key: string, n: number }}
 */
function allocateFallbackKey(item, prefix, tag, start) {
  let n = start;
  while (item.entries.some((entry) => entry.key === `${prefix}-${tag}${n}`)) n += 1;
  return { key: `${prefix}-${tag}${n}`, n };
}

/**
 * Record the parsed findings of one finished code review.
 *
 * Idempotent per (delegation id, attempt id, report hash); a retry with a new
 * attempt replaces the earlier attempt's contribution.
 *
 * @param {{
 *   workspaceFolder: unknown, leafId: unknown, delegationId: unknown, attemptId?: unknown,
 *   mode?: unknown, reviewer?: unknown, findings: object[], reportHash?: unknown,
 *   source?: 'live'|'backfill',
 * }} input
 * @returns {{ recorded: boolean, keys: string[], reason?: string } | null}
 */
export function recordReviewFindings(input) {
  const delegationId = String(input?.delegationId || '').trim();
  if (!delegationId) return null;
  const findings = Array.isArray(input.findings) ? input.findings : [];
  const attemptId = String(input.attemptId || '').trim();
  const reportHash = String(input.reportHash
    || createHash('sha256').update(JSON.stringify(findings), 'utf8').digest('hex'));
  const mode = String(input.mode || '').trim() === 'closure' ? 'closure' : 'audit';
  // `backfill` marks findings seeded from historical reports (always low confidence).
  const source = String(input.source || '').trim() === 'backfill' ? 'backfill' : 'live';
  return withItem(input.workspaceFolder, input.leafId, (item) => {
    if (item.closedMemberIds.includes(delegationId) && !item.delegations[delegationId]) {
      return { recorded: false, keys: [], reason: 'closed_round_member' };
    }
    const known = item.delegations[delegationId];
    if (known && known.attemptId === attemptId && known.reportHash === reportHash) {
      return { recorded: false, keys: [], reason: 'replay' };
    }
    let ordinal;
    let cycle;
    // First-recorded time per finding key. A re-record of the same delegation
    // replaces its entries, but an old finding must keep its original timestamp
    // so the feedback pass never mistakes it for a new one.
    const recordedAt = new Date().toISOString();
    let priorRecordedAt = new Map();
    if (known) {
      ordinal = known.ordinal;
      cycle = known.cycle;
      priorRecordedAt = new Map(item.entries
        .filter((entry) => entry.origin?.delegationId === delegationId)
        .map((entry) => [entry.key, entry.recordedAt || recordedAt]));
      retractDelegation(item, delegationId);
    } else {
      cycle = item.cycle;
      if (mode === 'closure') {
        item.closures += 1;
        ordinal = item.closures;
      } else {
        item.audits += 1;
        ordinal = item.audits;
      }
    }
    const prefix = `R${cycle}${mode === 'closure' ? 'C' : 'A'}${ordinal}`;
    const keys = [];
    let anonymous = 0;
    let unlinkedCount = 0;
    const seen = new Set();
    for (const finding of findings) {
      const status = String(finding.status || 'NEW').toUpperCase();
      const rawId = String(finding.id || '').trim();
      bumpSeq(item);
      const base = {
        priority: normalizeReviewFindingPriority(finding.priority),
        category: normalizeReviewFindingCategory(finding.category),
        // Findings are scrubbed at write time: the stored ledger must not keep a
        // raw private path even if a read route is ever added without a scrub.
        files: Array.isArray(finding.files) ? finding.files.slice(0, 12).map(scrubFindingFile).filter(Boolean) : [],
        summary: redactPrivatePaths(String(finding.summary || '')).slice(0, 400),
        confidence: finding.confidence === 'low' || source === 'backfill' ? 'low' : 'high',
        source,
      };
      const statusOnly = mode === 'closure' && (status === 'FIXED' || status === 'STILL_OPEN'
        || status === 'OUT_OF_SCOPE' || status === 'FOLLOW_UP') && rawId;
      if (statusOnly) {
        const target = linkEntry(item, rawId);
        if (target && !seen.has(target.key)) {
          seen.add(target.key);
          target.marks.push({ delegationId, seq: item.seq, status });
          keys.push(target.key);
          continue;
        }
        if (status === 'FIXED' || status === 'STILL_OPEN') {
          const slot = allocateFallbackKey(item, prefix, 'U', unlinkedCount + 1);
          unlinkedCount = slot.n;
          const key = slot.key;
          item.entries.push({
            key, cycle, rawId, origin: { delegationId, mode, ordinal }, ...base,
            unlinked: true, marks: [{ delegationId, seq: item.seq, status }], rejection: null, stopSeq: 0,
            recordedAt: priorRecordedAt.get(key) || recordedAt,
          });
          keys.push(key);
          continue;
        }
      }
      // Compare the canonical key that will actually be stored. The raw id may
      // contain characters the key sanitizes away, so comparing against the raw
      // spelling would let two IDs collide on one generated key.
      let key = '';
      const canonicalId = rawId.toUpperCase().replace(/[^A-Z0-9._]/g, '');
      if (canonicalId) {
        const candidate = `${prefix}-${canonicalId}`;
        if (!item.entries.some((entry) => entry.key.toUpperCase() === candidate)) key = candidate;
      }
      if (!key) {
        const slot = allocateFallbackKey(item, prefix, 'N', anonymous + 1);
        anonymous = slot.n;
        key = slot.key;
      }
      const marks = [];
      if (status === 'FIXED' || status === 'OUT_OF_SCOPE' || status === 'FOLLOW_UP' || status === 'STILL_OPEN') {
        marks.push({ delegationId, seq: item.seq, status });
      }
      item.entries.push({
        key, cycle, rawId, origin: { delegationId, mode, ordinal }, ...base,
        unlinked: false, marks, rejection: null, stopSeq: 0,
        recordedAt: priorRecordedAt.get(key) || recordedAt,
      });
      keys.push(key);
    }
    bumpSeq(item);
    item.delegations[delegationId] = {
      cycle, mode, ordinal, attemptId, reportHash, recordedAt: new Date().toISOString(),
    };
    return { recorded: true, keys };
  });
}

/**
 * Mark every unresolved current-cycle finding as left open at a stop
 * (closure rounds exhausted).
 *
 * @param {{ workspaceFolder: unknown, leafId: unknown }} input
 * @returns {number} entries marked
 */
export function markReviewFindingsStillOpenAtStop(input) {
  return withItem(input?.workspaceFolder, input?.leafId, (item) => {
    let marked = 0;
    bumpSeq(item);
    for (const entry of item.entries) {
      if (entry.cycle !== item.cycle || deriveFindingOutcome(entry) !== 'open') continue;
      entry.stopSeq = item.seq;
      marked += 1;
    }
    return marked;
  }) || 0;
}

/**
 * Close the current cycle after a resolved PASS round; the next recorded
 * review starts a new cycle. Idempotent per round id.
 *
 * @param {{ workspaceFolder: unknown, leafId: unknown, roundId?: unknown, memberIds?: unknown[] }} input
 * @returns {boolean} true when a cycle was closed
 */
export function closeReviewFindingsCycle(input) {
  const roundId = String(input?.roundId || '').trim();
  const members = (Array.isArray(input?.memberIds) ? input.memberIds : []).map((id) => String(id || '').trim()).filter(Boolean);
  const result = withItem(input?.workspaceFolder, input?.leafId, (item) => {
    if (roundId && item.lastClosedRoundId === roundId) return false;
    if (roundId) item.lastClosedRoundId = roundId;
    item.closedMemberIds = [...new Set([...(item.closedMemberIds || []), ...members, ...(roundId ? [roundId] : [])])]
      .slice(-MAX_CLOSED_MEMBERS);
    // Delegation ordinal bookkeeping belongs to the closed cycle only.
    for (const id of Object.keys(item.delegations)) {
      if (item.delegations[id].cycle === item.cycle) item.delegations[id].closed = true;
    }
    item.cycle += 1;
    item.audits = 0;
    item.closures = 0;
    return true;
  });
  return result === true;
}

/**
 * @typedef {{ applied: string[], unknown: string[], invalid?: string[], notRejectable?: string[], humanLocked?: string[] }} RejectedFindingsResult
 */

/**
 * Classify rejection rows against a ledger item without mutating it.
 * `invalid` lists rows dropped for a missing key or a blank/unknown reason;
 * `notRejectable` lists OUT_OF_SCOPE / FOLLOW_UP entries, which never become
 * suppress candidates and are reported neither as applied nor unknown.
 *
 * @param {object | null} item
 * @param {unknown} rejected
 * @returns {{ result: RejectedFindingsResult, targets: { entry: object, row: object }[] }}
 */
function classifyRejectedFindings(item, rejected, actor = 'orchestrator') {
  const list = normalizeRejectedFindings(rejected);
  const raw = Array.isArray(rejected) ? rejected : [];
  const invalid = [];
  const valid = new Set(list.map((row) => row.key.toUpperCase()));
  raw.forEach((row, index) => {
    const key = row && typeof row === 'object' ? String(row.key || '').trim() : '';
    if (!key || !valid.has(key.toUpperCase())) invalid.push(key || `#${index}`);
  });
  const result = { applied: [], unknown: [], invalid: [...new Set(invalid)], notRejectable: [], humanLocked: [] };
  const targets = [];
  for (const row of list) {
    const entry = (item?.entries || []).find((candidate) => candidate.key.toUpperCase() === row.key.toUpperCase());
    if (!entry) {
      result.unknown.push(row.key);
      continue;
    }
    const outcome = deriveFindingOutcome(entry);
    if (outcome === 'out_of_scope' || outcome === 'follow_up') {
      result.notRejectable.push(entry.key);
      continue;
    }
    // A human decision is final: an orchestrator can never replace it.
    if (entry.rejection?.actor === 'human' && actor !== 'human') {
      result.humanLocked.push(entry.key);
      continue;
    }
    result.applied.push(entry.key);
    targets.push({ entry, row });
  }
  // Extra metadata is additive: omitted when empty so the base shape stays
  // `{ applied, unknown }`.
  if (!result.invalid.length) delete result.invalid;
  if (!result.notRejectable.length) delete result.notRejectable;
  if (!result.humanLocked.length) delete result.humanLocked;
  return { result, targets };
}

/**
 * Orchestrator rejection of findings (`workflow_update.rejected_findings`).
 * Writes nothing when no row resolves to a rejectable entry.
 *
 * @param {{
 *   workspaceFolder: unknown, leafId: unknown,
 *   rejected: { key?: unknown, reason?: unknown, note?: unknown }[],
 *   actor?: unknown, dryRun?: boolean,
 * }} input
 * @returns {RejectedFindingsResult | null}
 */
export function applyRejectedReviewFindings(input) {
  const actor = String(input?.actor || 'orchestrator').trim() || 'orchestrator';
  const current = getReviewFindingsLedger(input?.workspaceFolder, input?.leafId);
  const preview = classifyRejectedFindings(current, input?.rejected, actor);
  if (input?.dryRun === true || !preview.targets.length) return preview.result;
  return withItem(input.workspaceFolder, input.leafId, (item) => {
    const { result, targets } = classifyRejectedFindings(item, input.rejected, actor);
    const at = new Date().toISOString();
    for (const { entry, row } of targets) {
      entry.rejection = { reason: row.reason, note: row.note, actor, at };
    }
    return result;
  });
}

/**
 * Human rejection of one finding (UI). Overrides an orchestrator rejection,
 * is idempotent for the same reason + note, and is CAS-safe: when
 * `expectedSeq` is given it must equal the ledger item's current `seq`.
 * OUT_OF_SCOPE / FOLLOW_UP entries are never rejectable.
 *
 * @param {{
 *   workspaceFolder: unknown, leafId: unknown, key: unknown, reason: unknown,
 *   note?: unknown, expectedSeq?: unknown,
 * }} input
 * @returns {{ ok: boolean, code?: string, changed?: boolean, seq?: number, entry?: object }}
 */
export function rejectReviewFindingByHuman(input) {
  const reason = normalizeReviewFindingRejectReason(input?.reason);
  if (!reason) return { ok: false, code: 'VALIDATION' };
  const key = String(input?.key || '').trim().toUpperCase();
  if (!key) return { ok: false, code: 'VALIDATION' };
  // Free text from the UI is scrubbed of private paths before it is stored.
  const note = redactPrivatePaths(String(input?.note || '').trim()).slice(0, MAX_NOTE);
  const expectedSeq = input?.expectedSeq == null || input.expectedSeq === '' ? null : Number(input.expectedSeq);
  if (expectedSeq !== null && !Number.isSafeInteger(expectedSeq)) return { ok: false, code: 'VALIDATION' };
  const existing = getReviewFindingsLedger(input?.workspaceFolder, input?.leafId);
  if (!existing) return { ok: false, code: 'NOT_FOUND' };
  const outcome = withItem(input.workspaceFolder, input.leafId, (item) => {
    if (expectedSeq !== null && Number(item.seq || 0) !== expectedSeq) return { ok: false, code: 'CONFLICT', seq: item.seq };
    const entry = item.entries.find((row) => row.key.toUpperCase() === key);
    if (!entry) return { ok: false, code: 'NOT_FOUND' };
    const current = deriveFindingOutcome(entry);
    if (current === 'out_of_scope' || current === 'follow_up') return { ok: false, code: 'NOT_REJECTABLE' };
    const prior = entry.rejection;
    if (prior?.actor === 'human' && prior.reason === reason && (prior.note || '') === note) {
      return { ok: true, changed: false, seq: item.seq, entry: { ...entry } };
    }
    entry.rejection = { reason, note, actor: 'human', at: new Date().toISOString() };
    bumpSeq(item);
    return { ok: true, changed: true, seq: item.seq, entry };
  });
  if (!outcome) return { ok: false, code: 'NOT_FOUND' };
  if (outcome.entry) outcome.entry = { ...outcome.entry, outcome: deriveFindingOutcome(outcome.entry) };
  return outcome;
}

/**
 * @param {unknown} value
 * @returns {{ key: string, reason: string, note: string }[]} sorted, de-duplicated by key
 */
export function normalizeRejectedFindings(value) {
  if (!Array.isArray(value)) return [];
  /** @type {Map<string, { key: string, reason: string, note: string }>} */
  const byKey = new Map();
  for (const row of value) {
    if (!row || typeof row !== 'object') continue;
    const key = String(row.key || '').trim();
    const reason = normalizeReviewFindingRejectReason(row.reason);
    if (!key || !reason) continue;
    byKey.set(key.toUpperCase(), { key, reason, note: String(row.note || '').trim().slice(0, MAX_NOTE) });
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Prompt table of canonical keys for unresolved findings.
 *
 * @param {object[]} entries
 * @returns {string} empty when there is nothing open
 */
export function buildFindingKeysTable(entries) {
  const rows = (Array.isArray(entries) ? entries : []).filter((entry) => entry && entry.key);
  if (!rows.length) return '';
  const clean = (text) => String(text || '').replace(/\s+/g, ' ').replace(/\|/g, '/').trim().slice(0, 160);
  return [
    '[FINDING KEYS]',
    'Reference each prior finding by this canonical key (or its raw ID when unambiguous).',
    '| key | priority | category | files | summary |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map((entry) => `| ${entry.key} | ${entry.priority || '-'} | ${entry.category || 'other'} | ${clean((entry.files || []).join(', ')) || '-'} | ${clean(entry.summary) || '-'} |`),
  ].join('\n');
}
