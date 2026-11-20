/**
 * Workspace Watcher — selective repair of restart-damaged history (leaf R18).
 *
 * Before R11 a cycle orphaned by a server restart was closed as `failure`: it
 * bumped `failures[todo]`, armed `backoffUntil` and could park the todo with a
 * failure-ceiling `blockedReason`. R11 fixed the behaviour going forward but does
 * not undo old damage. This module previews and (only on request) applies a
 * SELECTIVE correction. It is never run by the server on its own.
 *
 * Evidence rule. The operator names explicit restart instants (`restartAt`). A
 * closed `cycleChats` entry is a restart artefact only when ALL hold:
 *  1. `outcome === 'failure'`, `closeSource === 'reconcile'`, `closeReason` is
 *     `cycle_room_gone` or `missing_report`, and the cycle metric (if it still
 *     exists) carries no `reportedOutcome`;
 *  2. the cycle SPANNED a restart: `startedAt < restartAt <= closedAt`
 *     (`startedAt` from the entry, else the metric; missing => insufficient);
 *  3. `closedAt - restartAt <= graceMs` (default 30 min, hard max 6 h).
 * A cycle that started after the restart, or closed before it, ran entirely in
 * one process: it is `genuine` even with `missing_report`. The slot instance
 * token is not persisted on `cycleChats`; when an entry or metric carries one it
 * is attached as extra evidence, never required. Rows lacking close evidence, or
 * called without any restart instant, are `insufficient_evidence`.
 *
 * Todo `blockedReason` (F2 choice): the row is committed first, then each todo is
 * updated with its own CAS and the status is written back into the audit record
 * (`todoUpdate`). A CAS miss is repaired by a rerun: preview re-proposes a
 * blocked-only candidate for a todo that already has a repair record, is still
 * blocked by the failure-ceiling reason and is now under the ceiling.
 */

import { createHash } from 'node:crypto';
import {
  loadWorkspaceWatchersDocument,
  mutateWorkspaceWatchersDocument,
  workspaceWatchersDocumentCasToken,
  WORKSPACE_WATCHER_CYCLE_INTERRUPTED_OUTCOME,
} from './persist/workspace-watchers-persist.js';
import { loadWorkspaceWatcherCycleMetrics } from './workspace-watcher-cycle-metrics.js';
import { listTodos, updateTodo } from './persist/todos-store.js';
import { isWorkspaceWatcherBlockedReason, WORKSPACE_WATCHER_FAILURE_CEILING_PREFIX } from './workspace-watcher-blocked-reason.js';

export const HISTORY_REPAIR_KIND = 'restart_artefact_correction';
export const HISTORY_REPAIR_DEFAULT_GRACE_MS = 30 * 60_000;
export const HISTORY_REPAIR_MAX_GRACE_MS = 6 * 60 * 60_000;
const ARTEFACT_CLOSE_REASONS = Object.freeze(['cycle_room_gone', 'missing_report']);

/**
 * @param {unknown} value
 * @returns {number} epoch ms or NaN
 */
function toMs(value) {
  const ms = Date.parse(String(value ?? '').trim());
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * Normalize the operator input: valid restart instants and a bounded grace.
 *
 * @param {{ restartAt?: unknown, graceMs?: unknown }} options
 * @returns {{ restartAt: string[], restartMs: number[], graceMs: number }}
 */
export function normalizeHistoryRepairWindow(options = {}) {
  const raw = Array.isArray(options.restartAt) ? options.restartAt : (options.restartAt ? [options.restartAt] : []);
  const restartMs = raw.map(toMs).filter(Number.isFinite).sort((a, b) => a - b);
  const grace = Number(options.graceMs);
  const graceMs = Number.isFinite(grace) && grace > 0
    ? Math.min(Math.floor(grace), HISTORY_REPAIR_MAX_GRACE_MS)
    : HISTORY_REPAIR_DEFAULT_GRACE_MS;
  return { restartAt: restartMs.map((ms) => new Date(ms).toISOString()), restartMs, graceMs };
}

/**
 * Classify one closed cycleChats entry.
 *
 * @param {Record<string, any>} entry
 * @param {{ restartMs: number[], graceMs: number }} window
 * @param {Record<string, any> | null} metric
 * @returns {{ verdict: 'artefact' | 'genuine' | 'insufficient_evidence' | 'ignored', reason: string, restartAt?: string, instanceId?: string }}
 */
export function classifyCycleChatEntry(entry, window, metric) {
  if (String(entry?.outcome || '') !== 'failure') return { verdict: 'ignored', reason: 'not_failure' };
  const closeSource = String(entry?.closeSource || '').trim();
  const closeReason = String(entry?.closeReason || '').trim();
  if (!closeSource || !closeReason) return { verdict: 'insufficient_evidence', reason: 'legacy_row_without_close_evidence' };
  if (closeSource !== 'reconcile') return { verdict: 'genuine', reason: `close_source_${closeSource}` };
  if (!ARTEFACT_CLOSE_REASONS.includes(closeReason)) return { verdict: 'genuine', reason: `close_reason_${closeReason}` };
  if (String(metric?.reportedOutcome || '').trim()) return { verdict: 'genuine', reason: 'outcome_was_reported' };
  if (!window.restartMs.length) return { verdict: 'insufficient_evidence', reason: 'no_restart_instant_given' };
  const startedAt = toMs(entry.startedAt || metric?.startedAt);
  const closedAt = toMs(entry.at);
  if (!Number.isFinite(startedAt)) return { verdict: 'insufficient_evidence', reason: 'started_at_missing' };
  if (!Number.isFinite(closedAt)) return { verdict: 'insufficient_evidence', reason: 'close_time_missing' };
  const spanned = window.restartMs.find((r) => startedAt < r && r <= closedAt);
  if (spanned === undefined) return { verdict: 'genuine', reason: 'did_not_span_a_restart' };
  if (closedAt - spanned > window.graceMs) return { verdict: 'insufficient_evidence', reason: 'closed_after_grace' };
  const instanceId = String(entry.instanceId || metric?.instanceId || '').trim();
  return {
    verdict: 'artefact',
    reason: `reconcile_${closeReason}_spanned_restart`,
    restartAt: new Date(spanned).toISOString(),
    ...(instanceId ? { instanceId } : {}),
  };
}

/**
 * @param {Record<string, number>} failures
 * @returns {number}
 */
function sumFailures(failures) {
  let total = 0;
  for (const value of Object.values(failures || {})) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) total += Math.floor(n);
  }
  return total;
}

/**
 * @param {Record<string, any>} row
 * @param {Map<string, Record<string, any>>} metricsByCycle
 * @param {Record<string, any>} window
 * @param {Record<string, Record<string, any>>} todos
 * @returns {{ candidates: Record<string, any>[], insufficient: Record<string, any>[] }}
 */
function buildRowCandidates(row, metricsByCycle, window, todos) {
  const byTodo = new Map();
  const insufficient = [];
  for (const entry of Array.isArray(row.cycleChats) ? row.cycleChats : []) {
    const todoId = String(entry.todoIds?.[0] || '').trim();
    const verdict = classifyCycleChatEntry(entry, window, metricsByCycle.get(String(entry.cycleId || '')) || null);
    if (verdict.verdict === 'ignored' || !todoId) continue;
    if (verdict.verdict === 'insufficient_evidence') {
      insufficient.push({ todoId, cycleId: entry.cycleId, chatId: entry.id, at: entry.at, reason: verdict.reason, status: 'insufficient_evidence' });
    }
    const group = byTodo.get(todoId) || { artefacts: [], genuine: 0 };
    if (verdict.verdict === 'artefact') group.artefacts.push({ entry, verdict });
    else group.genuine += 1;
    byTodo.set(todoId, group);
  }
  const ceiling = Number(row.policy?.maxConsecutiveFailures) || 0;
  const failuresAfter = { ...(row.failures || {}) };
  const candidates = [];
  const blockedFor = (todoId, newFailures) => {
    const reason = String(todos[todoId]?.blockedReason || '');
    const clear = reason.startsWith(WORKSPACE_WATCHER_FAILURE_CEILING_PREFIX)
      && isWorkspaceWatcherBlockedReason(reason) && ceiling > 0 && newFailures < ceiling;
    return { reason, clear };
  };
  for (const [todoId, group] of byTodo) {
    if (!group.artefacts.length) continue;
    const currentFailures = Number(row.failures?.[todoId]) || 0;
    // Never below the failures that are visibly genuine (insufficient rows stay counted).
    const newFailures = Math.max(group.genuine, currentFailures - group.artefacts.length, 0);
    if (newFailures > 0) failuresAfter[todoId] = newFailures; else delete failuresAfter[todoId];
    const { reason, clear } = blockedFor(todoId, newFailures);
    candidates.push({
      workspaceFolder: row.workspaceFolder,
      todoId,
      cycleIds: group.artefacts.map((a) => String(a.entry.cycleId || '')),
      current: { failures: currentFailures, backoffUntil: '', blockedReason: reason },
      proposed: { failures: newFailures, backoffUntil: '', blockedReason: clear ? '' : reason, cycleOutcome: WORKSPACE_WATCHER_CYCLE_INTERRUPTED_OUTCOME },
      genuineFailuresKept: group.genuine,
      todoUpdatedAt: String(todos[todoId]?.updatedAt || ''),
      evidence: group.artefacts.map((a) => ({
        cycleId: a.entry.cycleId, chatId: a.entry.id, startedAt: a.entry.startedAt || '', closedAt: a.entry.at,
        closeSource: a.entry.closeSource, closeReason: a.entry.closeReason, rule: a.verdict.reason,
        restartAt: a.verdict.restartAt, ...(a.verdict.instanceId ? { instanceId: a.verdict.instanceId } : {}),
      })),
    });
  }
  // Retry ONLY the most recent repair record of a todo whose blocker update
  // ended in `cas_miss`. The retry is bound to that record (`retryOf`) and is
  // refused when the todo's blocker is no longer the one the record saw.
  const latestByTodo = new Map();
  for (const record of row.historyRepairs || []) latestByTodo.set(String(record.todoId), record);
  for (const [todoId, record] of latestByTodo) {
    if (record.todoUpdate !== 'cas_miss') continue;
    if (candidates.some((c) => c.todoId === todoId)) continue;
    const failures = Number(row.failures?.[todoId]) || 0;
    const { reason, clear } = blockedFor(todoId, failures);
    if (!clear || reason !== String(record.before?.blockedReason || '')) continue;
    candidates.push({
      workspaceFolder: row.workspaceFolder,
      todoId,
      cycleIds: [],
      blockedOnly: true,
      retryOf: record.idempotencyKey,
      current: { failures, backoffUntil: '', blockedReason: reason },
      proposed: { failures, backoffUntil: '', blockedReason: '', cycleOutcome: '' },
      genuineFailuresKept: 0,
      todoUpdatedAt: String(todos[todoId]?.updatedAt || ''),
      evidence: [{ rule: 'retry_of_cas_miss_below_ceiling', retryOf: record.idempotencyKey }],
    });
  }
  // Row-level backoff is derived from the post-apply aggregate of ALL candidates.
  const backoffBefore = String(row.backoffUntil || '');
  const backoffAfter = backoffBefore && sumFailures(failuresAfter) === 0 ? '' : backoffBefore;
  for (const c of candidates) {
    c.current.backoffUntil = backoffBefore;
    c.proposed.backoffUntil = backoffAfter;
    c.row = { failuresBefore: sumFailures(row.failures), failuresAfter: sumFailures(failuresAfter), failuresMapAfter: failuresAfter };
  }
  return { candidates, insufficient };
}

/**
 * @param {Record<string, any>[]} candidates
 * @returns {string}
 */
function fingerprint(candidates) {
  return createHash('sha256').update(JSON.stringify(candidates)).digest('hex').slice(0, 32);
}

/**
 * @param {Record<string, any>} candidate
 * @returns {string}
 */
function candidateIdempotencyKey(candidate) {
  const cycles = [...candidate.cycleIds].sort().join(',');
  const blocked = candidate.blockedOnly ? `|blocked|${candidate.todoUpdatedAt}` : '';
  return createHash('sha256').update(`${HISTORY_REPAIR_KIND}|${candidate.workspaceFolder}|${candidate.todoId}|${cycles}${blocked}`).digest('hex').slice(0, 32);
}

/**
 * Read the todos of every row in scope through the async facade. The result is
 * handed to the synchronous preview builder so no facade call ever happens while
 * the watcher document lock is held.
 *
 * @param {Record<string, any>} doc
 * @param {Record<string, any>} options
 * @returns {Promise<Map<string, Record<string, any>>>} todos by id, per workspace folder
 */
async function loadTodosByFolder(doc, options) {
  const byFolder = new Map();
  for (const row of Object.values(doc.items || {})) {
    if (options.workspaceFolder && row.workspaceFolder !== options.workspaceFolder) continue;
    try {
      const items = (await listTodos(options.dataDir, row.workspaceFolder)).items || [];
      byFolder.set(row.workspaceFolder, Object.fromEntries(items.map((t) => [String(t.id), t])));
    } catch {
      // Unreadable todo store: blockedReason correction is simply not proposed.
      byFolder.set(row.workspaceFolder, {});
    }
  }
  return byFolder;
}

/**
 * @param {Record<string, any>} doc
 * @param {Record<string, any>} options
 * @param {Map<string, Record<string, any>>} todosByFolder
 * @returns {Record<string, any>}
 */
function buildPreview(doc, options, todosByFolder) {
  const window = normalizeHistoryRepairWindow(options);
  const metricsByCycle = new Map(loadWorkspaceWatcherCycleMetrics({ dataDir: options.dataDir }).map((m) => [String(m.cycleId), m]));
  const candidates = [];
  const insufficient = [];
  for (const row of Object.values(doc.items || {})) {
    if (options.workspaceFolder && row.workspaceFolder !== options.workspaceFolder) continue;
    const done = new Set((row.historyRepairs || []).map((r) => r.idempotencyKey));
    const todos = todosByFolder.get(row.workspaceFolder) || {};
    const built = buildRowCandidates(row, metricsByCycle, window, todos);
    candidates.push(...built.candidates.filter((c) => !done.has(candidateIdempotencyKey(c))));
    insufficient.push(...built.insufficient.map((i) => ({ workspaceFolder: row.workspaceFolder, ...i })));
  }
  return {
    casToken: workspaceWatchersDocumentCasToken(doc),
    previewId: fingerprint(candidates),
    window: { restartAt: window.restartAt, graceMs: window.graceMs },
    candidates,
    insufficient_evidence: insufficient,
  };
}

/**
 * Dry-run: list candidate corrections. Read-only.
 *
 * @param {{ dataDir?: string, restartAt?: string | string[], graceMs?: number, workspaceFolder?: string }} [options]
 * @returns {Promise<{ casToken: { revision: number, updatedAt: string }, previewId: string, window: Record<string, any>, candidates: Record<string, any>[], insufficient_evidence: Record<string, any>[] }>}
 */
export async function previewWorkspaceWatcherHistoryRepair(options = {}) {
  const doc = loadWorkspaceWatchersDocument({ dataDir: options.dataDir });
  return buildPreview(doc, options, await loadTodosByFolder(doc, options));
}

/**
 * Apply exactly the previewed candidates. Aborts (no write) when the store CAS
 * token or the recomputed preview differs from the one the operator saw.
 *
 * @param {{ dataDir?: string, apply?: boolean, casToken?: Record<string, any>, previewId?: string, actor?: string, restartAt?: string | string[], graceMs?: number, workspaceFolder?: string, now?: number, beforeTodoUpdate?: Function }} options
 * @returns {Promise<{ ok: boolean, reason?: string, applied: Record<string, any>[], todoUpdates: Record<string, any>[] }>}
 */
export async function applyWorkspaceWatcherHistoryRepair(options = {}) {
  const fail = (reason) => ({ ok: false, reason, applied: [], todoUpdates: [] });
  if (options.apply !== true) return fail('apply_flag_required');
  if (!options.casToken || !options.previewId) return fail('preview_token_required');
  const at = new Date(Number.isFinite(options.now) ? options.now : Date.now()).toISOString();
  const applied = [];
  // Todos are read before the lock (no facade await under it); the preview is
  // recomputed from the locked document and the same todo snapshot, and each todo
  // write below is still guarded by its own expectedUpdatedAt.
  const todosByFolder = await loadTodosByFolder(loadWorkspaceWatchersDocument({ dataDir: options.dataDir }), options);
  const result = mutateWorkspaceWatchersDocument((doc) => {
    const token = workspaceWatchersDocumentCasToken(doc);
    if (token.revision !== options.casToken.revision || token.updatedAt !== options.casToken.updatedAt) return null;
    const preview = buildPreview(doc, options, todosByFolder);
    if (preview.previewId !== options.previewId) return null;
    const items = { ...doc.items };
    const byRow = new Map();
    for (const c of preview.candidates) byRow.set(c.workspaceFolder, [...(byRow.get(c.workspaceFolder) || []), c]);
    for (const [folder, list] of byRow) {
      const row = items[folder];
      const relabel = new Set(list.flatMap((c) => c.cycleIds));
      const records = list.map((candidate) => ({
        idempotencyKey: candidate.retryOf || candidateIdempotencyKey(candidate),
        kind: HISTORY_REPAIR_KIND,
        actor: String(options.actor || 'operator'),
        at,
        todoId: candidate.todoId,
        cycleIds: candidate.cycleIds,
        before: candidate.current,
        after: candidate.proposed,
        row: { failuresBefore: candidate.row.failuresBefore, failuresAfter: candidate.row.failuresAfter },
        evidence: candidate.evidence,
        todoUpdate: candidate.proposed.blockedReason !== candidate.current.blockedReason ? 'pending' : 'not_needed',
      }));
      items[folder] = {
        ...row,
        failures: list[0].row.failuresMapAfter,
        backoffUntil: list[0].proposed.backoffUntil,
        cycleChats: row.cycleChats.map((c) => (relabel.has(String(c.cycleId))
          ? { ...c, outcome: WORKSPACE_WATCHER_CYCLE_INTERRUPTED_OUTCOME, closeReason: WORKSPACE_WATCHER_CYCLE_INTERRUPTED_OUTCOME }
          : c)),
        historyRepairs: [...(row.historyRepairs || []), ...records.filter((_, i) => !list[i].blockedOnly)],
      };
      applied.push(...records.map((record, i) => ({ record, candidate: list[i] })));
    }
    return { items };
  }, { dataDir: options.dataDir });
  if (!result.ok) return fail(result.reason === 'aborted' ? 'stale_preview' : result.reason);
  const todoUpdates = [];
  for (const { record, candidate } of applied) {
    if (record.todoUpdate !== 'pending') continue;
    try {
      if (typeof options.beforeTodoUpdate === 'function') options.beforeTodoUpdate(candidate);
      await updateTodo(options.dataDir, candidate.workspaceFolder, candidate.todoId, {
        blockedReason: '',
        expectedUpdatedAt: candidate.todoUpdatedAt,
        appendChangelog: { kind: 'note', text: `History repair ${record.idempotencyKey}: cleared failure-ceiling blocker caused by restart-artefact cycles.` },
      });
      todoUpdates.push({ todoId: candidate.todoId, status: 'cleared' });
    } catch (err) {
      // CAS miss: the audit says so and a rerun re-proposes a blocked-only candidate.
      todoUpdates.push({ todoId: candidate.todoId, status: 'cas_miss', message: err instanceof Error ? err.message : String(err) });
    }
  }
  if (todoUpdates.length) {
    // A retry updates the ORIGINAL cas_miss record instead of appending a new one.
    const statusByKey = new Map(applied.filter((a) => a.record.todoUpdate === 'pending')
      .map((a, i) => [a.record.idempotencyKey, a.candidate.blockedOnly && todoUpdates[i].status === 'cleared'
        ? 'cleared_on_retry' : todoUpdates[i].status]));
    mutateWorkspaceWatchersDocument((doc) => {
      const items = { ...doc.items };
      for (const [folder, row] of Object.entries(items)) {
        if (!(row.historyRepairs || []).some((r) => statusByKey.has(r.idempotencyKey))) continue;
        items[folder] = {
          ...row,
          historyRepairs: row.historyRepairs.map((r) => (statusByKey.has(r.idempotencyKey) ? { ...r, todoUpdate: statusByKey.get(r.idempotencyKey), ...(statusByKey.get(r.idempotencyKey) === 'cleared_on_retry' ? { retriedAt: at } : {}) } : r)),
        };
      }
      return { items };
    }, { dataDir: options.dataDir });
  }
  return { ok: true, applied: applied.map((a) => a.record), todoUpdates };
}
