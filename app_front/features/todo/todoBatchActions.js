/**
 * Async handlers of the bulk "integrate with agent" flow (start / resume /
 * cancel / abandon / clear lock), extracted from `todoPanel.js` so they run
 * without a DOM. Every side effect goes through the injected `deps`, which lets
 * tests drive delayed responses for two workspaces and assert that an answer
 * for workspace A is dropped after the panel switched to B.
 */
import {
  resolveBatchControls,
  resolveResumeAgentNeed,
} from './todoBatchSelection.js';

/** Server errors that mean "the agent may still be running": retry with force. */
const LIVENESS_ERRORS = Object.freeze(['liveness_unknown', 'agent_busy']);

/**
 * @typedef {{ folder: string, generation: number }} BatchScope
 * @typedef {{ harness: string, model: string }} BatchAgent
 */

/**
 * @param {object} deps
 * @param {object} deps.api integrateTodosBatch / resumeIntegrateBatch / abandonIntegrateBatch / cancelIntegrateBatch / clearIntegrationLock
 * @param {(key: string, params?: Record<string, string>) => string} deps.t
 * @param {(msg: string, isErr?: boolean) => void} deps.setStatus
 * @param {(message: string) => boolean} deps.confirmAction
 * @param {() => BatchScope} deps.captureScope
 * @param {(scope: BatchScope) => boolean} deps.isCurrentScope
 * @param {() => object | null} deps.getActiveBatch
 * @param {(batch: object | null) => void} deps.applyActiveBatch
 * @param {(lock: object | null) => void} deps.applyLock
 * @param {() => Promise<unknown> | unknown} deps.refreshList
 * @param {(chat: object, options?: object) => void} deps.openChat
 * @param {() => void} deps.showChatPanel
 * @param {() => void} deps.exitSelection
 * @param {() => void} deps.repaintActionBar
 * @param {{ begin: () => number, release: (token: number) => boolean, isPending: () => boolean }} deps.startGuard
 * @param {Map<string, BatchAgent>} deps.agentById
 * @param {() => { workspaceFile?: string }} deps.getWorkspaceContext
 * @param {(options: { harness: string, onStart: (agent: BatchAgent) => void }) => void} deps.openAgentPicker
 * @param {(todoId?: string) => string} deps.resolveHarness
 * @param {(result: object, fallbackKey: string) => string} deps.describeFailure
 * @returns {{
 *   openStartPicker: (ids: string[]) => void,
 *   startBatch: Function, resume: Function, executeResume: Function,
 *   abandon: Function, cancel: Function, clearLock: Function,
 * }}
 */
export function createBatchActions(deps) {
  const { t, setStatus, api } = deps;

  /** Network failure is only worth a message while the panel still shows that workspace. */
  function reportNetworkError(scope) {
    if (deps.isCurrentScope(scope)) setStatus(t('todo.networkError'), true);
  }

  /** @param {string[]} ids */
  function openStartPicker(ids) {
    if (deps.startGuard.isPending()) return;
    // The scope is captured before the picker opens: it may sit open across a switch.
    const scope = deps.captureScope();
    deps.openAgentPicker({
      harness: deps.resolveHarness(ids[0]),
      onStart: ({ harness, model }) => startBatch(ids, { harness, model }, scope),
    });
  }

  /**
   * @param {string[]} todoIds
   * @param {BatchAgent} options
   * @param {BatchScope} scope
   */
  async function startBatch(todoIds, options, scope) {
    if (deps.startGuard.isPending()) return;
    if (!scope.folder) {
      setStatus(t('todo.selectWorkspace'), true);
      return;
    }
    if (!deps.isCurrentScope(scope)) return;
    const model = String(options.model || 'auto');
    const startToken = deps.startGuard.begin();
    deps.repaintActionBar();
    setStatus(t('todo.batchStarting'));
    try {
      const data = await api.integrateTodosBatch(todoIds, scope.folder, {
        workspaceFile: deps.getWorkspaceContext().workspaceFile,
        agentTransport: options.harness,
        model,
      });
      if (!deps.isCurrentScope(scope)) return;
      if (!data?.ok) {
        setStatus(deps.describeFailure(data, 'todo.batchStartFailed'), true);
        if (data?.batch) deps.applyActiveBatch(data.batch);
        return;
      }
      if (data.batch?.id) deps.agentById.set(String(data.batch.id), { harness: options.harness, model });
      deps.exitSelection();
      deps.applyActiveBatch(data.batch);
      const skipped = Array.isArray(data.skipped) ? data.skipped.length : 0;
      if (data.chat) {
        deps.openChat(data.chat, { initialPrompt: data.initialPrompt });
        deps.showChatPanel();
      }
      await deps.refreshList();
      if (!deps.isCurrentScope(scope)) return;
      setStatus(skipped
        ? t('todo.batchStartedWithSkipped', { count: String(skipped) })
        : t('todo.batchStarted'));
    } catch {
      reportNetworkError(scope);
    } finally {
      // The guard is reset on a workspace switch, so a stale token releases nothing.
      if (deps.startGuard.release(startToken)) deps.repaintActionBar();
    }
  }

  /**
   * Resume needs the harness / model only when the server will open a chat.
   * Reuse what the batch was started with; when unknown (reload, another
   * device) ask through the same agent picker.
   *
   * @param {'retry' | 'skip'} entryAction
   */
  function resume(entryAction) {
    const batch = deps.getActiveBatch();
    if (!batch) return;
    const scope = deps.captureScope();
    const known = deps.agentById.get(String(batch.id));
    const need = resolveResumeAgentNeed(batch, known, entryAction);
    if (!need.needsPicker) {
      void executeResume(batch, entryAction, need.agent, scope);
      return;
    }
    const firstEntry = (Array.isArray(batch.entries) ? batch.entries : [])[0];
    deps.openAgentPicker({
      harness: deps.resolveHarness(String(firstEntry?.todoId || '')),
      onStart: ({ harness, model }) => {
        if (!deps.isCurrentScope(scope)) return;
        const agent = { harness, model: String(model || 'auto') };
        deps.agentById.set(String(batch.id), agent);
        void executeResume(batch, entryAction, agent, scope);
      },
    });
  }

  /**
   * @param {object} batch
   * @param {'retry' | 'skip'} entryAction
   * @param {BatchAgent | null} agent
   * @param {BatchScope} scope
   */
  async function executeResume(batch, entryAction, agent, scope) {
    if (!deps.isCurrentScope(scope)) return;
    const needsForce = resolveBatchControls(batch).needsForce;
    if (needsForce && !deps.confirmAction(t('todo.batchForceLivenessConfirm'))) return;
    const send = (forceLiveness) => api.resumeIntegrateBatch(batch.id, scope.folder, {
      entryAction,
      forceLiveness,
      workspaceFile: deps.getWorkspaceContext().workspaceFile,
      ...(agent ? { agentTransport: agent.harness, model: agent.model } : {}),
    });
    setStatus(t('todo.batchResuming'));
    try {
      let result = await send(needsForce);
      if (!deps.isCurrentScope(scope)) return;
      if (!result?.ok && LIVENESS_ERRORS.includes(String(result?.error || ''))) {
        if (!deps.confirmAction(t('todo.batchForceLivenessConfirm'))) return;
        result = await send(true);
        if (!deps.isCurrentScope(scope)) return;
      }
      if (!result?.ok) {
        setStatus(deps.describeFailure(result, 'todo.batchResumeFailed'), true);
        if (result?.batch) deps.applyActiveBatch(result.batch);
        return;
      }
      deps.applyActiveBatch(result.batch);
      if (result.chat) {
        deps.openChat(result.chat, { initialPrompt: result.initialPrompt });
        deps.showChatPanel();
      }
      await deps.refreshList();
      if (!deps.isCurrentScope(scope)) return;
      setStatus(t('todo.batchResumed'));
    } catch {
      reportNetworkError(scope);
    }
  }

  async function abandon() {
    const batch = deps.getActiveBatch();
    if (!batch) return;
    if (!deps.confirmAction(t('todo.batchAbandonConfirm'))) return;
    const scope = deps.captureScope();
    const needsForce = resolveBatchControls(batch).needsForce;
    if (needsForce && !deps.confirmAction(t('todo.batchForceLivenessConfirm'))) return;
    setStatus(t('todo.batchAbandoning'));
    try {
      let result = await api.abandonIntegrateBatch(batch.id, scope.folder, { forceLiveness: needsForce });
      if (!deps.isCurrentScope(scope)) return;
      if (!result?.ok && LIVENESS_ERRORS.includes(String(result?.error || ''))) {
        if (!deps.confirmAction(t('todo.batchForceLivenessConfirm'))) return;
        result = await api.abandonIntegrateBatch(batch.id, scope.folder, { forceLiveness: true });
        if (!deps.isCurrentScope(scope)) return;
      }
      if (!result?.ok) {
        setStatus(deps.describeFailure(result, 'todo.batchAbandonFailed'), true);
        if (result?.batch) deps.applyActiveBatch(result.batch);
        return;
      }
      deps.applyActiveBatch(result.batch);
      await deps.refreshList();
      if (!deps.isCurrentScope(scope)) return;
      setStatus(t('todo.batchAbandoned'));
    } catch {
      reportNetworkError(scope);
    }
  }

  async function cancel() {
    const batch = deps.getActiveBatch();
    if (!batch) return;
    if (!deps.confirmAction(t('todo.batchCancelConfirm'))) return;
    const scope = deps.captureScope();
    setStatus(t('todo.batchCancelling'));
    try {
      const result = await api.cancelIntegrateBatch(batch.id, scope.folder);
      if (!deps.isCurrentScope(scope)) return;
      if (!result?.ok) {
        setStatus(deps.describeFailure(result, 'todo.batchCancelFailed'), true);
        return;
      }
      if (result.batch) deps.applyActiveBatch(result.batch);
      setStatus(t('todo.batchCancelRequested'));
    } catch {
      reportNetworkError(scope);
    }
  }

  /** Operator clear of a stranded single-flow integration lock. */
  async function clearLock() {
    const scope = deps.captureScope();
    if (!scope.folder) {
      setStatus(t('todo.selectWorkspace'), true);
      return;
    }
    if (!deps.confirmAction(t('todo.lockClearConfirm'))) return;
    setStatus(t('todo.lockClearing'));
    try {
      const result = await api.clearIntegrationLock(scope.folder);
      if (!deps.isCurrentScope(scope)) return;
      // `no_lock` means somebody else already released it: the notice is stale either way.
      if (!result?.ok && String(result?.error || result?.reason || '') !== 'no_lock') {
        setStatus(deps.describeFailure(result, 'todo.lockClearFailed'), true);
        return;
      }
      deps.applyLock(null);
      await deps.refreshList();
      if (!deps.isCurrentScope(scope)) return;
      setStatus(t('todo.lockCleared'));
    } catch {
      reportNetworkError(scope);
    }
  }

  return { openStartPicker, startBatch, resume, executeResume, abandon, cancel, clearLock };
}
