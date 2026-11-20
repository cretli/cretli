/**
 * Voice-triggered todo start, dependency-injected so the control flow is
 * unit-testable without the Todo panel DOM. `todoPanel.js` binds the real
 * api / chat / render functions.
 */

/**
 * @typedef {{
 *   findItem: (todoId: string) => object | undefined,
 *   resolveHarness: (item: object) => string,
 *   isSdkReady: () => boolean,
 *   startAgent: (todoId: string, body: object) => Promise<any>,
 *   pollStatus: (todoId: string, workspaceFolder: string) => Promise<any>,
 *   renderList: (data: any) => void,
 *   openChat: (chat: any, options: { initialPrompt?: string, reused: boolean }) => void,
 *   showChatPanel: () => void,
 *   messages: { sdkRequiresApiKey: string, startFailed: string, networkError: string },
 * }} TodoVoiceStartDeps
 */

/**
 * Starts a todo agent without any dialog. `ok: true` is returned only after the
 * chat was opened with its initial prompt; a dirty worktree, a missing SDK key,
 * a not-ready response or a failed request all return `ok: false`.
 *
 * @param {string} todoId
 * @param {{ agentTransport?: string, workspaceFile: string, workspaceFolder: string }} options
 * @param {TodoVoiceStartDeps} deps
 * @returns {Promise<{ ok: boolean, error?: string, code?: string }>}
 */
export async function startTodoForVoice(todoId, options, deps) {
  const item = deps.findItem(todoId) || {};
  const harness = String(options.agentTransport || deps.resolveHarness(item)).trim();
  if (!item.chatId && harness === 'sdk' && !deps.isSdkReady()) {
    return { ok: false, code: 'SDK_NOT_READY', error: deps.messages.sdkRequiresApiKey };
  }
  try {
    let data = await deps.startAgent(todoId, {
      workspaceFile: options.workspaceFile,
      workspaceFolder: options.workspaceFolder,
      model: 'auto',
      agentTransport: harness,
    });
    if (data?.ok && data.state === 'preparing') {
      data = await deps.pollStatus(todoId, options.workspaceFolder);
    }
    if (!data?.ok || !data.chat) {
      if (data?.code === 'WORKTREE_DIRTY') {
        return { ok: false, code: 'WORKTREE_DIRTY', error: 'The worktree has uncommitted changes. Start it from the Todo panel.' };
      }
      return { ok: false, code: data?.code, error: data?.error || deps.messages.startFailed };
    }
    deps.renderList(data);
    deps.openChat(data.chat, { initialPrompt: data.initialPrompt, reused: !!data.reused });
    deps.showChatPanel();
    return { ok: true };
  } catch {
    return { ok: false, error: deps.messages.networkError };
  }
}
