/**
 * Keeps the voice model aware of app state (active chat, workspace, pending
 * approval, read mode) without paying for it on every turn.
 *
 * One state item lives in the conversation at a time. It is re-sent only when
 * the rendered text changes, replaces the previous item, is never part of the
 * history that gets pruned, and is restored if the provider reports it gone or
 * the session is reconnected (a new socket starts with an empty history).
 */

const MAX_TITLE_CHARS = 60;

/**
 * @typedef {{
 *   chatId?: string,
 *   title?: string,
 *   harness?: string,
 *   mode?: string,
 *   running?: boolean,
 *   workspace?: string,
 *   openPanel?: string,
 *   pendingApproval?: { kind: string, count?: number, summary?: string, requestId?: string } | null,
 *   readMode?: string,
 * }} VoiceStateSnapshot
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
function clip(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_CHARS);
}

/**
 * Compact (about 100 tokens) text form of the snapshot.
 *
 * @param {VoiceStateSnapshot} snapshot
 * @returns {string}
 */
export function formatVoiceState(snapshot) {
  const state = snapshot || {};
  const chat = state.chatId
    ? `${clip(state.title) || 'untitled'} (id ${clip(state.chatId)}, ${clip(state.harness) || 'sdk'}, ${clip(state.mode) || 'agent'}, ${state.running ? 'running' : 'idle'})`
    : 'none';
  const pendingApproval = state.pendingApproval;
  const pending = pendingApproval
    ? [
      clip(pendingApproval.kind),
      pendingApproval.summary ? `"${clip(pendingApproval.summary)}"` : '',
      pendingApproval.requestId ? `(request ${clip(pendingApproval.requestId)})` : '',
      pendingApproval.count > 1 ? `x${pendingApproval.count}` : '',
    ].filter(Boolean).join(' ')
    : 'none';
  return [
    'Current app state (replaces any earlier state message):',
    `active_chat: ${chat}`,
    `workspace: ${clip(state.workspace) || 'unknown'}`,
    `open_panel: ${clip(state.openPanel) || 'none'}`,
    `pending_approval: ${pending}`,
    `read_mode: ${clip(state.readMode) || 'off'}`,
  ].join('\n');
}

/**
 * @param {{
 *   getSnapshot: () => Promise<VoiceStateSnapshot> | VoiceStateSnapshot,
 *   sendItem: (item: { id: string, text: string }) => void,
 *   deleteItem?: (id: string) => void,
 * }} options
 */
export function createVoiceStateSync(options) {
  let counter = 0;
  let currentId = '';
  let currentText = '';
  let busy = false;
  let again = false;

  async function run() {
    const text = formatVoiceState(await options.getSnapshot());
    if (currentId && text === currentText) return;
    const previousId = currentId;
    counter += 1;
    const id = `cr_state_${counter}`;
    currentId = id;
    currentText = text;
    options.sendItem({ id, text });
    if (previousId && options.deleteItem) options.deleteItem(previousId);
  }

  return {
    /**
     * Sends the state when it changed, was lost, or never sent. Overlapping
     * calls collapse into one trailing run.
     *
     * @returns {Promise<void>}
     */
    async sync() {
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        do {
          again = false;
          await run();
        } while (again);
      } finally {
        busy = false;
      }
    },

    /**
     * @param {string} id
     * @returns {boolean} true for the state item, which must stay out of the prunable history
     */
    isStateItem(id) {
      return Boolean(id) && String(id).startsWith('cr_state_');
    },

    /**
     * The provider dropped an item. If it was ours, forget it so the next
     * sync() re-sends the state.
     *
     * @param {string} id
     * @returns {boolean} whether the lost item was the current state item
     */
    markDeleted(id) {
      if (!id || id !== currentId) return false;
      currentId = '';
      currentText = '';
      return true;
    },

    /** New socket or session: no history exists, send everything again. */
    reset() {
      currentId = '';
      currentText = '';
      again = false;
    },

    getCurrentText() {
      return currentText;
    },
  };
}
