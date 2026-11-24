/**
 * Single-use, time-boxed binding for two-step voice actions implemented outside the family handler factories
 * (`workspace` task_run, `delete_chat`).
 *
 * Step one resolves ONE concrete target and calls `bind`, which returns the id the model must send back; step two
 * calls `consume` with that id. The binding is tied to the action, the workspace and the active chat, expires,
 * is used at most once (even a refused attempt closes it) and, in Realtime, also needs driver speech after the
 * question (`driver`, the `voiceConfirmGuard` ask / consume pair). The data step two executes comes from the
 * binding, never from the confirming call.
 */

/** How long a step-one binding stays valid. */
export const VOICE_CONFIRM_BINDING_TTL_MS = 60_000;

/**
 * @typedef {{ workspaceFolder: string, chatId: string }} BindingContext
 * @typedef {{ ask: (action: string, target: string) => void, consume: (action: string, target: string) => boolean }} BindingDriver
 */

/**
 * @param {{ now?: () => number, ttlMs?: number }} [deps]
 */
export function createConfirmBinding(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const ttlMs = deps.ttlMs ?? VOICE_CONFIRM_BINDING_TTL_MS;
  /** @type {{ action: string, id: string, context: BindingContext, data: Record<string, any>, expiresAt: number } | null} */
  let pending = null;
  let sequence = 0;

  return {
    /**
     * @param {string} action
     * @param {string} prefix readable id prefix
     * @param {BindingContext} context
     * @param {Record<string, any>} data
     * @param {BindingDriver} [driver]
     * @returns {string} the id for step two
     */
    bind(action, prefix, context, data, driver) {
      sequence += 1;
      const id = `${prefix}${sequence}`;
      pending = { action, id, context, data, expiresAt: now() + ttlMs };
      driver?.ask(action, id);
      return id;
    },

    /**
     * @param {string} action
     * @param {string} id
     * @param {BindingContext} context
     * @param {BindingDriver} [driver]
     * @returns {{ ok: true, data: Record<string, any>, result?: never } | { ok: false, result: object, data?: never }}
     */
    consume(action, id, context, driver) {
      const bound = pending;
      pending = null;
      /** @param {string} error @param {Record<string, unknown>} [extra] @returns {{ ok: false, result: { ok: false, error: string } }} */
      const refuse = (error, extra = {}) => ({ ok: false, result: { ok: false, ...extra, error: `${error} Nothing was done.` } });
      if (!bound || bound.action !== action) {
        return refuse('Nothing is awaiting confirmation for this action. Run the first step, tell the user what will happen, then confirm with the returned id.', { needsClarification: true, code: 'no_pending' });
      }
      if (!id) return refuse('id is required to confirm. A bare yes never acts. Run the first step again.', { needsClarification: true, code: 'no_id' });
      if (bound.expiresAt < now()) return refuse('The confirmation expired. Ask again.', { code: 'expired' });
      if (bound.id !== id) return refuse('That id is not the one described to the user. Run the first step again.', { code: 'id_mismatch' });
      if (['workspaceFolder', 'chatId'].some((key) => bound.context[key] !== context[key])) {
        return refuse('The workspace or chat changed since the question. Ask again.', { code: 'context_changed' });
      }
      if (driver && !driver.consume(action, id)) {
        return refuse('The user has not answered yet. Ask the question aloud, wait for their reply, then run the first step again.', { code: 'no_driver_answer' });
      }
      return { ok: true, data: bound.data };
    },

    /** Drops the pending binding (another voice tool ran, or the session ended). */
    cancel() {
      pending = null;
    },

    /** @returns {string|null} action of the pending binding */
    pendingAction() {
      return pending ? pending.action : null;
    },
  };
}
