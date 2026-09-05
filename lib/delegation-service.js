/**
 * Create, start, cancel, and retry plan-execution delegations.
 */

import { randomUUID } from 'crypto';
import { addChat, loadChats } from './persist/chats-persist.js';
import { appendChatHistoryEvents, loadChatHistory } from './persist/chat-history-persist.js';
import { markChatHasPendingDelegation } from './persist/chat-history-revisions.js';
import {
  createDelegationRecord,
  findActiveDelegationForParent,
  findDelegationByIdempotencyKey,
  getDelegationById,
  listDelegationsForParent,
  loadDelegations,
  updateDelegationRecord,
} from './persist/delegations-persist.js';
import { readChatPlanDocument } from './chat-plan-persist.js';
import { cancelChatRun, getChatRunState, hasChatRunAdapter, startChatRun } from './chat-run-service.js';
import { buildDelegationExecutorPrompt } from './delegation-prompt.js';
import {
  canTransitionDelegationStatus,
  isActiveDelegationStatus,
  isTerminalDelegationStatus,
} from './delegation-status.js';
import { isDelegationModelAvailable } from './delegation-executor.js';
import { normalizeAgentTransport } from './agent-transport.js';
import { resolveSdkCwdForChat } from './workspace.js';

/** @type {Map<string, Promise<unknown>>} */
const parentLocks = new Map();

/**
 * @param {string} parentChatId
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 * @template T
 */
async function withParentLock(parentChatId, task) {
  const key = String(parentChatId || '').trim();
  const previous = parentLocks.get(key) || Promise.resolve();
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const chain = previous.then(() => gate, () => gate);
  parentLocks.set(key, chain);
  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
    if (parentLocks.get(key) === chain) parentLocks.delete(key);
  }
}

/**
 * @param {object} delegation
 * @param {string} status
 * @param {Record<string, unknown>} [patch]
 */
function transition(delegation, status, patch = {}) {
  if (!canTransitionDelegationStatus(delegation.status, status) && delegation.status !== status) {
    return getDelegationById(delegation.id);
  }
  return updateDelegationRecord(delegation.id, { status, ...patch });
}

/**
 * @param {unknown} payload
 * @returns {Record<string, unknown> | null}
 */
function parseDelegationHistoryPayload(payload) {
  if (payload && typeof payload === 'object') return /** @type {Record<string, unknown>} */ (payload);
  if (typeof payload !== 'string' || !payload.trim()) return null;
  try {
    const parsed = JSON.parse(payload);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * @param {string} parentChatId
 * @param {{ id: string, event: string, attemptId?: string }} query
 * @returns {boolean}
 */
function hasDelegationHistoryEvent(parentChatId, query) {
  const store = loadChatHistory(parentChatId);
  const events = store?.events || [];
  const wantedAttempt = String(query.attemptId || '');
  return events.some((row) => {
    if (row.rec?.variant !== 'delegation') return false;
    const data = parseDelegationHistoryPayload(row.rec.payload);
    if (!data) return false;
    if (String(data.id || '') !== query.id || String(data.event || '') !== query.event) return false;
    const storedAttempt = String(data.attemptId || '');
    return storedAttempt === wantedAttempt;
  });
}

/**
 * Append a parent-history card after the disk write succeeds. Terminal
 * `finished` events set historyDeliveredAt only after a successful append.
 *
 * @param {object} delegation
 * @param {string} event
 * @returns {object | null}
 */
export function publishDelegationStatus(delegation, event) {
  const current = getDelegationById(delegation?.id) || delegation;
  if (!current?.id || !current.parentChatId) return current || null;
  const eventName = String(event || '').trim();
  if (!eventName) return current;
  const attemptId = String(current.attemptId || '');
  const already = hasDelegationHistoryEvent(current.parentChatId, {
    id: current.id,
    event: eventName,
    attemptId,
  });
  if (already) {
    if (eventName === 'finished' && !String(current.historyDeliveredAt || '').trim()) {
      return updateDelegationRecord(current.id, { historyDeliveredAt: new Date().toISOString() });
    }
    return current;
  }
  const payload = JSON.stringify({
    id: current.id,
    status: current.status,
    childChatId: current.childChatId,
    executor: current.executor,
    report: current.report || '',
    error: current.error || '',
    unverified: current.unverified !== false,
    acknowledgedAt: current.acknowledgedAt || '',
    attemptId,
    event: eventName,
  });
  const result = appendChatHistoryEvents(current.parentChatId, '', [
    { rec: { kind: 'meta', variant: 'delegation', payload } },
  ]);
  if (!result?.ok) return current;
  markChatHasPendingDelegation(current.parentChatId);
  const patch = {
    lastPublishedStatus: current.status,
    lastPublishedEvent: eventName,
  };
  if (eventName === 'finished') {
    patch.historyDeliveredAt = new Date().toISOString();
  }
  return updateDelegationRecord(current.id, patch) || current;
}

/**
 * @param {object} delegation
 * @param {{ report?: string, error?: string, status: string }} outcome
 */
export function finishDelegation(delegation, outcome) {
  const current = getDelegationById(delegation.id);
  if (!current) return null;
  if (isTerminalDelegationStatus(current.status) && current.status !== 'cancelling') {
    if (!String(current.historyDeliveredAt || '').trim()) {
      return publishDelegationStatus(current, 'finished');
    }
    return current;
  }
  const finishedAt = new Date().toISOString();
  const next = transition(current, outcome.status, {
    report: outcome.report || current.report || '',
    error: outcome.error || current.error || '',
    finishedAt,
  });
  if (!next) return null;
  return publishDelegationStatus(next, 'finished');
}

/**
 * @param {object} delegation
 * @param {string} runId
 * @param {string} attemptId
 * @param {string} eventRunId
 * @param {string} eventAttemptId
 * @returns {boolean}
 */
export function isDelegationEventCurrent(delegation, eventRunId, eventAttemptId) {
  if (!delegation) return false;
  const attemptId = String(delegation.attemptId || '').trim();
  const runId = String(delegation.runId || '').trim();
  const incomingAttempt = String(eventAttemptId || '').trim();
  const incomingRun = String(eventRunId || '').trim();
  if (incomingAttempt && attemptId && incomingAttempt !== attemptId) return false;
  if (incomingRun && runId && incomingRun !== runId) return false;
  return true;
}

/**
 * @param {{ chatId?: string, runId?: string }} input
 * @returns {boolean}
 */
function isChatRunStillActive(input) {
  let state = null;
  try {
    state = getChatRunState(input);
  } catch {
    state = null;
  }
  return !!(state?.busy || state?.waitingForInput);
}

/**
 * @param {object} deps
 */
export function createDelegationService(deps = {}) {
  const resolveCwd = typeof deps.workspaceDirForAgent === 'function'
    ? (chat) => resolveSdkCwdForChat(chat, deps.workspaceDirForAgent)
    : (chat) => String(chat?.workspaceFolder || '').trim();
  const isModelAvailable = typeof deps.isModelAvailable === 'function'
    ? deps.isModelAvailable
    : isDelegationModelAvailable;

  /**
   * @param {{
   *   parentChatId: string,
   *   executor: { transport: string, model: string, options?: object },
   *   planRevision: number,
   *   idempotencyKey: string,
   *   extraInstructions?: string,
   *   title?: string,
   * }} input
   */
  async function createAndStart(input) {
    const parentChatId = String(input?.parentChatId || '').trim();
    const idempotencyKey = String(input?.idempotencyKey || '').trim();
    if (!parentChatId) {
      return { ok: false, status: 400, error: 'Parent chat is required.', code: 'parent_required' };
    }
    return withParentLock(parentChatId, async () => {
      if (idempotencyKey) {
        const existing = findDelegationByIdempotencyKey(idempotencyKey);
        if (existing) return { ok: true, status: 200, delegation: existing, replayed: true };
      }
      const parent = loadChats().find((row) => row.id === parentChatId);
      if (!parent) {
        return { ok: false, status: 404, error: 'Chat not found.', code: 'chat_not_found' };
      }
      const active = findActiveDelegationForParent(parentChatId);
      if (active) {
        return { ok: true, status: 200, delegation: active, replayed: true };
      }
      const cwd = resolveCwd(parent);
      if (!cwd) {
        return { ok: false, status: 400, error: 'Workspace folder is missing.', code: 'no_workspace' };
      }
      const planDoc = readChatPlanDocument({ cwd, chatId: parentChatId });
      if (!planDoc.body) {
        return { ok: false, status: 400, error: 'No complete plan is saved for this chat.', code: 'plan_missing' };
      }
      const expectedRevision = Number(input.planRevision);
      if (Number.isFinite(expectedRevision) && expectedRevision > 0 && planDoc.revision !== expectedRevision) {
        return {
          ok: false,
          status: 409,
          error: 'The plan changed. Refresh the preview and try again.',
          code: 'plan_revision_conflict',
          plan: planDoc,
        };
      }
      const transport = normalizeAgentTransport(input?.executor?.transport);
      const model = String(input?.executor?.model || '').trim();
      if (!hasChatRunAdapter(transport)) {
        return {
          ok: false,
          status: 400,
          error: `Executor ${transport} cannot run without an open browser in this version.`,
          code: 'executor_unavailable',
        };
      }
      if (!model || isModelAvailable({ transport, model }) === false) {
        return {
          ok: false,
          status: 400,
          error: 'That model is not available. Choose another executor model.',
          code: 'model_unavailable',
        };
      }
      const promptBuilt = buildDelegationExecutorPrompt({
        planMarkdown: planDoc.body,
        workspaceFolder: cwd,
        extraInstructions: input.extraInstructions,
      });
      if (!promptBuilt.ok) {
        return { ok: false, status: 400, error: promptBuilt.error, code: promptBuilt.code };
      }
      const attemptId = randomUUID();
      let record = createDelegationRecord({
        parentChatId,
        workspaceFolder: cwd,
        planRevision: planDoc.revision,
        planHash: planDoc.contentHash,
        planMarkdown: planDoc.body,
        executor: {
          transport,
          model,
          options: input?.executor?.options && typeof input.executor.options === 'object'
            ? input.executor.options
            : {},
        },
        status: 'queued',
        attemptId,
        idempotencyKey,
        extraInstructions: input.extraInstructions,
      });
      const title = String(input.title || '').trim()
        || `${parent.title || 'Chat'} (build)`;
      let child;
      try {
        child = addChat(randomUUID(), title, parent.workspaceFile, parent.workspaceFolder, model, {
          agentTransport: transport,
          sdkMode: 'agent',
          sdkUiMode: parent.sdkUiMode,
          todoId: parent.todoId,
          forkParentChatId: parentChatId,
          forkKind: 'delegation',
          delegationParentChatId: parentChatId,
          delegationId: record.id,
        });
      } catch (err) {
        const failed = finishDelegation(record, {
          status: 'failed',
          error: err?.message || String(err),
        });
        return { ok: false, status: 500, error: 'Could not create the executor chat.', code: 'child_create_failed', delegation: failed };
      }
      record = updateDelegationRecord(record.id, { childChatId: child.id, status: 'starting' });
      publishDelegationStatus(record, 'started');
      try {
        const started = await startChatRun({
          chatId: child.id,
          prompt: promptBuilt.prompt,
          mode: 'agent',
          requestId: attemptId,
          displayText: promptBuilt.displayText,
          deps: {
            ...(deps.chatRunDeps || {}),
            delegationId: record.id,
            attemptId,
          },
        });
        const running = transition(record, 'running', {
          runId: started.runId,
          startedAt: new Date().toISOString(),
        });
        return { ok: true, status: 201, delegation: running, chat: child };
      } catch (err) {
        const failed = finishDelegation(record, {
          status: 'failed',
          error: err?.message || String(err),
        });
        return {
          ok: false,
          status: 500,
          error: failed?.error || 'Could not start the executor.',
          code: err?.code || 'start_failed',
          delegation: failed,
        };
      }
    });
  }

  /**
   * @param {string} id
   */
  async function cancel(id) {
    const current = getDelegationById(id);
    if (!current) return { ok: false, status: 404, error: 'Delegation not found.', code: 'not_found' };
    if (isTerminalDelegationStatus(current.status)) {
      return { ok: true, status: 200, delegation: current };
    }
    const cancelling = current.status === 'cancelling'
      ? current
      : transition(current, 'cancelling');
    if (!cancelling) {
      return { ok: false, status: 409, error: 'This delegation cannot be stopped.', code: 'cancel_blocked' };
    }
    publishDelegationStatus(cancelling, 'cancelling');
    let cancelFailed = false;
    try {
      await cancelChatRun({ chatId: current.childChatId, runId: current.runId });
    } catch {
      cancelFailed = true;
    }
    const stillBusy = cancelFailed || isChatRunStillActive({
      chatId: current.childChatId,
      runId: current.runId,
    });
    if (stillBusy) {
      return {
        ok: true,
        status: 202,
        pending: true,
        delegation: getDelegationById(id) || cancelling,
      };
    }
    const cancelled = finishDelegation(cancelling, { status: 'cancelled' });
    return { ok: true, status: 200, delegation: cancelled };
  }

  /**
   * @param {string} id
   * @param {{ reason?: string }} [input]
   */
  function acknowledge(id, input = {}) {
    const current = getDelegationById(id);
    if (!current) return { ok: false, status: 404, error: 'Delegation not found.', code: 'not_found' };
    const reason = String(input.reason || 'reviewed').trim() || 'reviewed';
    const status = current.status;
    const isWaiting = status === 'waiting_for_input';
    const isTerminalAttention = status === 'completed' || status === 'failed' || status === 'interrupted';
    if (reason === 'open_child') {
      if (!isWaiting) return { ok: true, status: 200, delegation: current, skipped: true };
      const next = updateDelegationRecord(current.id, { acknowledgedAt: new Date().toISOString() });
      return { ok: true, status: 200, delegation: next };
    }
    if (!isWaiting && !isTerminalAttention) {
      return { ok: true, status: 200, delegation: current, skipped: true };
    }
    const next = updateDelegationRecord(current.id, {
      acknowledgedAt: new Date().toISOString(),
      unverified: isTerminalAttention ? false : current.unverified,
    });
    if (isTerminalAttention && next) publishDelegationStatus(next, 'acknowledged');
    return { ok: true, status: 200, delegation: next || current };
  }

  /**
   * @param {string} chatId
   */
  async function cancelForDeletedChat(chatId) {
    const id = String(chatId || '').trim();
    if (!id) return { ok: true };
    const rows = loadDelegations().filter((row) => {
      if (row.childChatId !== id && row.parentChatId !== id) return false;
      return isActiveDelegationStatus(row.status);
    });
    for (const row of rows) {
      const result = await cancel(row.id);
      if (!result.ok) {
        return {
          ok: false,
          status: 409,
          error: result.error || 'Could not stop the executor run.',
          code: result.code || 'cancel_failed',
        };
      }
      if (!result.pending) continue;
      await new Promise((resolve) => setTimeout(resolve, 400));
      if (isChatRunStillActive({ chatId: row.childChatId, runId: row.runId })) {
        return {
          ok: false,
          status: 409,
          error: 'Could not stop the executor run.',
          code: 'cancel_pending',
        };
      }
      const latest = getDelegationById(row.id);
      if (latest && isActiveDelegationStatus(latest.status)) {
        finishDelegation(latest, { status: 'cancelled' });
      }
    }
    return { ok: true };
  }

  /**
   * @param {string} id
   */
  async function retry(id) {
    const current = getDelegationById(id);
    if (!current) return { ok: false, status: 404, error: 'Delegation not found.', code: 'not_found' };
    return withParentLock(current.parentChatId, async () => {
      const latest = getDelegationById(id);
      if (!latest) return { ok: false, status: 404, error: 'Delegation not found.', code: 'not_found' };
      if (isActiveDelegationStatus(latest.status)) {
        return { ok: false, status: 409, error: 'This delegation is still active.', code: 'still_active' };
      }
      const active = findActiveDelegationForParent(latest.parentChatId);
      if (active && active.id !== latest.id) {
        return {
          ok: false,
          status: 409,
          error: 'Another execution job is already running for this chat.',
          code: 'parent_busy',
        };
      }
      const parent = loadChats().find((row) => row.id === latest.parentChatId);
      if (!parent) return { ok: false, status: 404, error: 'Parent chat not found.', code: 'chat_not_found' };
      const previousAttemptSummary = [latest.report, latest.error].filter(Boolean).join('\n');
      const promptBuilt = buildDelegationExecutorPrompt({
        planMarkdown: latest.planMarkdown,
        workspaceFolder: latest.workspaceFolder,
        extraInstructions: latest.extraInstructions,
        previousAttemptSummary,
      });
      if (!promptBuilt.ok) {
        return { ok: false, status: 400, error: promptBuilt.error, code: promptBuilt.code };
      }
      const attemptId = randomUUID();
      updateDelegationRecord(latest.id, {
        status: 'starting',
        attemptId,
        runId: '',
        finishedAt: '',
        error: '',
        report: '',
        historyDeliveredAt: '',
        reportDeliveredAt: '',
      });
      try {
        const started = await startChatRun({
          chatId: latest.childChatId,
          prompt: promptBuilt.prompt,
          mode: 'agent',
          requestId: attemptId,
          displayText: promptBuilt.displayText,
          deps: {
            ...(deps.chatRunDeps || {}),
            delegationId: latest.id,
            attemptId,
          },
        });
        const running = updateDelegationRecord(latest.id, {
          status: 'running',
          runId: started.runId,
          startedAt: new Date().toISOString(),
        });
        publishDelegationStatus(running, 'retry');
        return { ok: true, status: 200, delegation: running };
      } catch (err) {
        const failed = finishDelegation(latest, {
          status: 'failed',
          error: err?.message || String(err),
        });
        return {
          ok: false,
          status: 500,
          error: failed?.error || 'Retry failed.',
          code: err?.code || 'start_failed',
          delegation: failed,
        };
      }
    });
  }

  return {
    createAndStart,
    cancel,
    retry,
    acknowledge,
    cancelForDeletedChat,
    getById: getDelegationById,
    listForParent: listDelegationsForParent,
  };
}

/**
 * After a process restart, do not silently resume work.
 * Unconfirmed active jobs become interrupted. Missing history cards are retried.
 */
export function reconcileDelegationsOnBoot() {
  for (const row of loadDelegations()) {
    if (isActiveDelegationStatus(row.status)) {
      if (isChatRunStillActive({ chatId: row.childChatId, runId: row.runId })) continue;
      finishDelegation(row, {
        status: 'interrupted',
        error: 'Server restarted before this run could be confirmed. Retry to continue.',
      });
      continue;
    }
    if (isTerminalDelegationStatus(row.status) && !String(row.historyDeliveredAt || '').trim()) {
      publishDelegationStatus(row, 'finished');
    }
  }
}

export const delegationService = createDelegationService();
