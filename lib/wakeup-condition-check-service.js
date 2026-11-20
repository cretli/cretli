/**
 * Create / list / cancel / run-now for `condition_check` rows. One module is
 * shared by the REST routes and the MCP tools so both validate identically.
 * Nothing here calls a model: a check only stores a named predicate and a todo
 * reference, and the scheduler evaluates it on the server.
 */

import { randomUUID } from 'node:crypto';
import { armWakeup, cancelWakeup, listWakeups } from './persist/wakeups-persist.js';
import { getConditionPredicate } from './wakeup-condition-predicates.js';
import {
  CONDITION_CHECK_ACTION_START_TODO_CHAT,
  CONDITION_CHECK_BRIEF_MAX,
  CONDITION_CHECK_DEFAULT_TTL_MS,
  CONDITION_CHECK_KIND,
} from './wakeup-condition-check.js';

const TITLE_MAX = 120;
const MIN_TTL_MS = 60_000;
const MAX_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** @returns {{ ok: false, status: number, code: string, error: string }} */
const fail = (status, code, error, extra = {}) => ({ ok: false, status, code, error, ...extra });

/**
 * @param {{
 *   dataDir?: string,
 *   getScheduler: () => Record<string, any>|null,
 *   getTodo: (workspaceFolder: string, todoId: string) => Record<string, any>|null|Promise<Record<string, any>|null>,
 *   now?: () => number,
 * }} deps
 */
export function createConditionCheckService(deps) {
  const options = { dataDir: deps.dataDir };
  const clock = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const scheduler = () => deps.getScheduler?.() || null;
  const kindDefinition = () => scheduler()?.listKindDefinitions?.().find((k) => k.kind === CONDITION_CHECK_KIND) || null;

  function toItem(row) {
    const described = scheduler()?.describeRow?.(row) || { dueAt: null, details: null };
    return {
      id: row.id,
      kind: row.kind,
      state: row.state,
      reason: row.reason || '',
      title: row.title || '',
      todoId: row.action?.todoId || row.subjectId || '',
      predicate: row.predicate || null,
      createdAt: row.createdAt || null,
      expiresAt: row.expiresAt || null,
      startedChatId: row.startedChatId || '',
      progress: described.details?.progress || null,
    };
  }

  /**
   * @param {{ workspaceFolder?: string, title?: string, predicate?: { id?: string, params?: Record<string, any> }, todoId?: string, brief?: string, expiresInMs?: number }} input
   * @returns {Promise<{ ok: true, item: Record<string, any> } | { ok: false, status: number, code: string, error: string }>}
   */
  async function create(input = {}) {
    const workspaceFolder = String(input.workspaceFolder || '').trim();
    if (!workspaceFolder) return fail(400, 'invalid_workspace', 'workspaceFolder is required');
    const predicateId = String(input.predicate?.id || '').trim();
    const predicate = getConditionPredicate(predicateId);
    if (!predicate) return fail(400, 'unknown_predicate', `Unknown predicate: ${predicateId || '(empty)'}`);
    const params = predicate.validate(input.predicate?.params);
    if (!params.ok) return fail(400, 'invalid_params', params.error);
    const todoId = String(input.todoId || '').trim();
    if (!todoId) return fail(400, 'invalid_todo', 'todoId is required');
    const todo = await deps.getTodo(workspaceFolder, todoId);
    if (!todo) return fail(400, 'todo_not_found', 'The todo does not exist in this workspace');
    const brief = String(input.brief ?? '').trim();
    if (brief.length > CONDITION_CHECK_BRIEF_MAX) return fail(400, 'brief_too_long', `brief must be at most ${CONDITION_CHECK_BRIEF_MAX} characters`);
    const title = String(input.title || todo.title || '').trim().slice(0, TITLE_MAX);
    if (!title) return fail(400, 'invalid_title', 'title is required');
    const ttl = Number(input.expiresInMs);
    const ttlMs = Number.isFinite(ttl) && ttl > 0 ? Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Math.round(ttl))) : CONDITION_CHECK_DEFAULT_TTL_MS;
    const now = clock();
    const createdAt = new Date(now).toISOString();
    const row = {
      id: randomUUID(),
      kind: CONDITION_CHECK_KIND,
      subjectType: 'todo',
      subjectId: todoId,
      state: 'armed',
      reason: '',
      attempts: 0,
      pendingAttempt: 0,
      resumeRequestId: '',
      title,
      predicate: { id: predicateId, params: params.value },
      action: {
        type: CONDITION_CHECK_ACTION_START_TODO_CHAT,
        todoId,
        brief: brief || `Scheduled check met: ${title}. Continue the todo.`,
        workspaceFolder,
      },
      createdAt,
      pausedAt: createdAt,
      expiresAt: new Date(now + ttlMs).toISOString(),
      startedChatId: '',
    };
    const armed = armWakeup(row, { ...options, now });
    return { ok: true, item: toItem(armed.record) };
  }

  /** @param {{ state?: string }} [filter] */
  function list(filter = {}) {
    const state = String(filter.state || '').trim();
    return listWakeups({ kind: CONDITION_CHECK_KIND, ...(state ? { state } : {}) }, options).map(toItem);
  }

  /** @param {string} id */
  function cancel(id) {
    const existing = listWakeups({ kind: CONDITION_CHECK_KIND }, options).find((row) => row.id === String(id || ''));
    if (!existing) return fail(404, 'not_found', 'Not found');
    if (existing.state !== 'armed') return fail(409, 'not_armed', 'Only an armed check can be cancelled');
    const result = cancelWakeup(existing.id, 'cancelled_by_user', { ...options, now: clock() });
    return { ok: true, item: toItem(result.record || existing) };
  }

  /**
   * Evaluates one check immediately. It never bypasses the predicate: an unmet
   * condition returns `condition_not_met` with the current progress and
   * changes nothing.
   *
   * @param {string} id
   */
  async function runNow(id) {
    const existing = listWakeups({ kind: CONDITION_CHECK_KIND }, options).find((row) => row.id === String(id || ''));
    if (!existing) return fail(404, 'not_found', 'Not found');
    const live = scheduler();
    if (!live || typeof live.runNow !== 'function') return fail(503, 'scheduler_unavailable', 'The scheduler is not running');
    const result = await live.runNow(existing.id);
    if (!result.ok) {
      return result.code === 'not_found'
        ? fail(404, 'not_found', 'Not found')
        : fail(409, 'not_armed', 'Only an armed check can be run');
    }
    const after = listWakeups({ kind: CONDITION_CHECK_KIND }, options).find((row) => row.id === existing.id) || existing;
    const progress = kindDefinition()?.getEvaluation?.(existing.id) || null;
    if (after.state === 'resumed') return { ok: true, item: toItem(after) };
    if (result.action === 'expire') return fail(409, 'expired', 'The check expired', { item: toItem(after) });
    if (result.action === 'block' || after.state === 'blocked') return fail(409, 'blocked', after.reason || result.reason, { item: toItem(after) });
    if (result.action === 'resume') return fail(409, 'start_deferred', 'The chat could not be started yet; the check stays armed', { item: toItem(after) });
    return fail(409, 'condition_not_met', result.reason || 'not_met', { progress, item: toItem(after) });
  }

  return { create, list, cancel, runNow };
}
