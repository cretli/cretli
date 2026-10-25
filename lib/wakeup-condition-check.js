/**
 * Wake-up kind `condition_check`: a deterministic, LLM-free follow-up. The
 * server evaluates a named predicate every tick and, only when it holds,
 * starts ONE fresh chat for a todo with a short brief. It never resumes an
 * existing chat and never calls a model while the condition is unmet.
 *
 * Hard rules: `prepare` and `decide` perform no store writes (evaluation
 * progress lives in memory); the chat is created at most once per row
 * (`startedChatId` is persisted before the first prompt is sent and reused by
 * any retry); after a crash only proof counts as success and an unknown state
 * becomes `start_uncertain` instead of a second chat.
 */

import { getConditionPredicate } from './wakeup-condition-predicates.js';
import { CONDITION_CHECK_SETTINGS_SCHEMA, readConditionCheckSettings } from './condition-check-settings.js';

export const CONDITION_CHECK_KIND = 'condition_check';
export const CONDITION_CHECK_ACTION_START_TODO_CHAT = 'start_todo_chat';
export const CONDITION_CHECK_BRIEF_MAX = 1500;
export const CONDITION_CHECK_DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const EVALUATION_CACHE_MAX = 500;

/** Definitive refusals: no run started, so the attempt is refunded. */
const REFUND_CODES = new Set([
  'adapter_unavailable', 'recipient_busy', 'still_active', 'update_in_progress', 'runtime_not_ready',
  'todo.blockedByTree', 'WORKTREE_REUSE_BUSY',
]);
const isRefundCode = (code) => REFUND_CODES.has(code) || code.startsWith('slot_');
const BLOCK_CODES = new Set(['chat_archived', 'chat_not_found', 'start_failed']);

const codeOf = (err) => String(err && typeof err === 'object' && ('code' in err || 'key' in err) ? (err.code || err.key) : '').trim();

/**
 * @param {Record<string, any>} row stored wake-up row
 * @returns {Record<string, any>|null} a normalized record, or null for a malformed row
 */
export function normalizeConditionCheckRecord(row) {
  if (!row || typeof row !== 'object' || !row.id) return null;
  const predicate = row.predicate && typeof row.predicate === 'object' ? row.predicate : {};
  const action = row.action && typeof row.action === 'object' ? row.action : {};
  return {
    ...row,
    title: String(row.title || ''),
    predicate: { id: String(predicate.id || ''), params: predicate.params && typeof predicate.params === 'object' ? predicate.params : {} },
    action: {
      type: String(action.type || ''),
      todoId: String(action.todoId || ''),
      brief: String(action.brief || ''),
      workspaceFolder: String(action.workspaceFolder || ''),
    },
    expiresMs: Date.parse(row.expiresAt || ''),
    startedChatId: String(row.startedChatId || ''),
    requestSeq: Number(row.requestSeq) || 0,
    attempts: Number(row.attempts) || 0,
    pendingAttempt: Number(row.pendingAttempt) || 0,
  };
}

/**
 * @param {{
 *   loadDelegations: () => Record<string, any>[],
 *   getLimit?: (input: Record<string, any>) => Record<string, any>|null,
 *   startTodoAgent: (input: Record<string, any>) => Promise<Record<string, any>>,
 *   startChatRun: (input: Record<string, any>) => Promise<Record<string, any>>,
 *   lookupChatRunRequest: (input: Record<string, any>) => Record<string, any>|null,
 *   probeChatRunLiveness: (input: Record<string, any>) => Record<string, any>|null,
 *   patchRow: (id: string, fields: Record<string, any>, now: number) => Record<string, any>|null,
 *   readSettings?: () => Record<string, any>,
 * }} deps
 * @returns {Record<string, any>} a kind for `createWakeupScheduler().registerKind`
 */
export function createConditionCheckKind(deps) {
  const readSettings = deps.readSettings || (() => readConditionCheckSettings());
  /** @type {Map<string, { at: string, met: boolean, current: number|null, target: number|null, error: string }>} */
  const evaluations = new Map();

  function remember(id, entry) {
    evaluations.delete(id);
    evaluations.set(id, entry);
    if (evaluations.size > EVALUATION_CACHE_MAX) evaluations.delete(evaluations.keys().next().value);
  }

  /** Read-only snapshot for the read API; empty after a restart until the next tick. */
  function getEvaluation(id) {
    return evaluations.get(String(id || '')) || null;
  }

  function prepare(record, ctx) {
    const settings = ctx.settings || {};
    const expired = Number.isFinite(record.expiresMs) && ctx.now >= record.expiresMs;
    if (expired || settings.enabled === false) return { skipped: true };
    const predicate = getConditionPredicate(record.predicate.id);
    if (!predicate) return { unknownPredicate: true };
    const at = new Date(ctx.now).toISOString();
    let evaluation;
    try {
      const params = predicate.validate(record.predicate.params);
      if (!params.ok) throw new Error(params.error || 'invalid_params');
      evaluation = predicate.evaluate(params.value, { loadDelegations: deps.loadDelegations });
    } catch (err) {
      // A failing predicate degrades to `defer`; it must never stop the tick.
      const error = err instanceof Error ? err.message : String(err || 'predicate_failed');
      remember(record.id, { at, met: false, current: null, target: null, error });
      return { error };
    }
    remember(record.id, { at, met: evaluation.met === true, current: evaluation.current, target: evaluation.target, error: '' });
    let lockout = null;
    if (evaluation.met === true && settings.harness && typeof deps.getLimit === 'function') {
      try {
        lockout = deps.getLimit({ harness: settings.harness, model: settings.model || undefined }) || null;
      } catch {
        lockout = null;
      }
    }
    return { evaluation, lockout };
  }

  function decide({ record, now, settings, prepared }) {
    if (settings?.enabled === false) return { action: 'skip', reason: 'disabled' };
    if (Number.isFinite(record.expiresMs) && now >= record.expiresMs) return { action: 'expire', reason: 'expired' };
    if (prepared?.unknownPredicate) return { action: 'block', reason: 'unknown_predicate' };
    if (prepared?.error) return { action: 'defer', reason: `predicate_error: ${prepared.error}` };
    if (prepared?.evaluation?.met !== true) return { action: 'defer', reason: 'not_met' };
    if (prepared.lockout) return { action: 'defer', reason: 'harness_locked' };
    return { action: 'resume', reason: 'met' };
  }

  function classifyStartError(err) {
    const code = codeOf(err);
    if (isRefundCode(code)) return { outcome: 'refund', reason: code };
    if (err && typeof err === 'object' && err.status === 404) return { outcome: 'blocked', reason: 'todo_not_found' };
    if (BLOCK_CODES.has(code)) return { outcome: 'blocked', reason: code };
    return { outcome: 'blocked', reason: code || 'start_failed' };
  }

  /** Refund outcome that also moves the request id forward for the next attempt. */
  function refund(record, reason, ctx) {
    deps.patchRow(record.id, { requestSeq: (Number(record.requestSeq) || 0) + 1 }, ctx.now);
    return { outcome: 'refund', reason };
  }

  async function execute(row, ctx) {
    const record = normalizeConditionCheckRecord(row);
    const settings = ctx.settings || {};
    let chatId = record.startedChatId;
    let prompt = record.action.brief;
    if (!chatId) {
      let started;
      try {
        started = await deps.startTodoAgent({
          workspaceFolder: record.action.workspaceFolder,
          todoId: record.action.todoId,
          body: {
            forceNew: true,
            workspaceFolder: record.action.workspaceFolder,
            ...(settings.harness ? { agentTransport: settings.harness } : {}),
            ...(settings.model ? { model: settings.model } : {}),
          },
        });
      } catch (err) {
        const failed = classifyStartError(err);
        return failed.outcome === 'refund' ? refund(record, failed.reason, ctx) : failed;
      }
      chatId = String(started?.chat?.id || '').trim();
      if (!chatId) return { outcome: 'blocked', reason: 'start_failed' };
      // Persist the chat id BEFORE the first prompt so a crash or a refund can
      // never lead to a second chat for this row.
      deps.patchRow(record.id, { startedChatId: chatId }, ctx.now);
      prompt = `${record.action.brief}\n\n${String(started.initialPrompt || '')}`.trim();
    } else {
      prompt = `${record.action.brief}\n\ncretli-ref todo=${record.action.todoId}`;
    }
    try {
      const run = await deps.startChatRun({ chatId, prompt, requestId: record.resumeRequestId, mode: 'agent' });
      if (run?.accepted === true) return { outcome: 'resumed', reason: '' };
      if (run?.accepted === false) return refund(record, 'not_accepted', ctx);
      return { outcome: 'ambiguous', reason: 'acceptance_unconfirmed' };
    } catch (err) {
      const code = codeOf(err);
      if (isRefundCode(code)) return refund(record, code, ctx);
      if (BLOCK_CODES.has(code)) return { outcome: 'blocked', reason: code };
      return { outcome: 'ambiguous', reason: code || 'start_error' };
    }
  }

  function resolveCrash(row) {
    const record = normalizeConditionCheckRecord(row);
    // No chat id on the row means a chat may or may not exist: never start another.
    if (!record.startedChatId) return { outcome: 'blocked', reason: 'start_uncertain' };
    let lookup = null;
    try {
      lookup = deps.lookupChatRunRequest({ chatId: record.startedChatId, requestId: record.resumeRequestId });
    } catch {
      lookup = null;
    }
    if (lookup?.accepted === true) return { outcome: 'resumed', reason: '' };
    if (lookup?.accepted === false) return refund(record, 'not_accepted', { now: Date.now() });
    const live = deps.probeChatRunLiveness({ chatId: record.startedChatId });
    if (live?.known === true && live.busy === true) return { outcome: 'resumed', reason: '' };
    return { outcome: 'blocked', reason: 'start_uncertain' };
  }

  return {
    kind: CONDITION_CHECK_KIND,
    label: 'Scheduled checks',
    description: 'Starts one fresh chat for a todo when a server-evaluated condition holds. Never calls a model while waiting.',
    settingsSchema: CONDITION_CHECK_SETTINGS_SCHEMA,
    getSettings: readSettings,
    normalize: normalizeConditionCheckRecord,
    resolveDueAt: () => null,
    // The condition is evaluated every tick, so there is no due time to show.
    describeRow: (record) => {
      const evaluation = getEvaluation(record.id);
      return {
        dueAt: null,
        details: {
          title: String(record.title || ''),
          todoId: String(record.action?.todoId || record.subjectId || ''),
          predicate: String(record.predicate?.id || ''),
          expiresAt: record.expiresAt || null,
          startedChatId: String(record.startedChatId || ''),
          progress: evaluation
            ? { at: evaluation.at, met: evaluation.met, current: evaluation.current, target: evaluation.target, error: evaluation.error }
            : null,
        },
      };
    },
    selectCandidates: ({ records }) => records
      .filter((record) => record.state === 'armed')
      .sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0))
      .map((record) => ({ record, dueAt: null })),
    // A refund hands the attempt back, so the attempt number alone repeats on a retry;
    // `requestSeq` (bumped on every refund) keeps the retry from deduping into the refused
    // request. Exactly-once is guaranteed by the persisted `startedChatId`, not by this id.
    buildRequestId: (record, attempt) => {
      const seq = Number(record.requestSeq) || 0;
      return `condcheck:${record.id}:${Number(attempt) || 1}${seq ? `:r${seq}` : ''}`;
    },
    prepare,
    decide,
    execute,
    resolveCrash,
    getEvaluation,
  };
}
