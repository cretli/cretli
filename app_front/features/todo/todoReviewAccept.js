/**
 * State machine of the manual "Accept" action in the task panel review details
 * (`docs/todo-review-contract.md` §7.3). DOM-free so it is testable on its own;
 * `cr-todo-review-badge` only renders `entries` and forwards clicks.
 *
 * Each entry is keyed by `delegationId:attemptId` and pins the attempt, material
 * and todo revision the first time the button appears. The pin is sent back
 * unchanged. It is dropped when the todo/review snapshot version changes and
 * re-taken after a 409, so a stale screen never repeats the same rejected pin.
 */

const STALE_CODES = new Set([
  'ack_attempt_mismatch',
  'ack_material_mismatch',
  'ack_todo_revision_mismatch',
  'ack_todo_unavailable',
]);

/**
 * @param {{
 *   loadContext: (delegationId: string) => Promise<any>,
 *   accept: (delegationId: string, payload: object) => Promise<any>,
 *   resolveErrorKey: (res: any) => string,
 *   confirm?: () => boolean,
 *   onChange?: () => void,
 *   onAccepted?: (target: object) => void,
 * }} deps
 */
export function createManualAcceptController(deps) {
  /** @type {Record<string, { phase: string, pinned?: object, messageKey?: string, tone?: string }>} */
  let entries = {};
  let version = '';
  let generation = 0;

  const keyOf = (target) => `${target.delegationId}:${target.attemptId}`;
  const set = (key, value) => {
    entries = { ...entries, [key]: value };
    deps.onChange?.();
  };

  async function load(target, keep = {}) {
    const key = keyOf(target);
    const gen = generation;
    set(key, { phase: 'loading', ...keep });
    const fail = (messageKey) => {
      if (gen === generation) set(key, { phase: 'error', messageKey, tone: 'error' });
      return false;
    };
    try {
      const ctx = await deps.loadContext(target.delegationId);
      if (gen !== generation) return false;
      if (!ctx?.ok) return fail('chat.delegationAcceptContextFailed');
      if (String(ctx.attemptId || '') !== target.attemptId) return fail('chat.delegationAcceptStaleAttempt');
      const resolution = String(ctx.todoResolution ?? '');
      if (resolution && resolution !== 'exact' && resolution !== 'prefix' && resolution !== 'unattributed') {
        return fail('chat.delegationAcceptStaleTodo');
      }
      set(key, {
        phase: 'ready',
        pinned: {
          attemptId: target.attemptId,
          materialRevision: String(ctx.materialRevision ?? ''),
          todoRevision: String(ctx.todoRevision ?? ''),
        },
        ...keep,
      });
      return true;
    } catch {
      return fail('chat.delegationAcceptContextFailed');
    }
  }

  return {
    get entries() {
      return entries;
    },

    /**
     * Align with the current targets. A changed `snapshotVersion` (todo
     * `updatedAt` / review computation) drops every pin and starts over.
     *
     * @param {Array<{ delegationId: string, attemptId: string }>} targets
     * @param {string} snapshotVersion
     */
    sync(targets, snapshotVersion) {
      if (snapshotVersion !== version) {
        version = snapshotVersion;
        generation += 1;
        entries = {};
      }
      for (const target of targets) {
        if (!entries[keyOf(target)]) void load(target);
      }
    },

    /** @param {{ delegationId: string, attemptId: string }} target */
    async click(target) {
      const key = keyOf(target);
      const entry = entries[key];
      if (!entry || entry.phase === 'loading' || entry.phase === 'busy' || entry.phase === 'done') return;
      if (entry.phase !== 'ready' || !entry.pinned) {
        await load(target);
        return;
      }
      if (deps.confirm && !deps.confirm()) return;
      const { pinned } = entry;
      const gen = generation;
      set(key, { phase: 'busy', pinned });
      let res;
      try {
        res = await deps.accept(target.delegationId, {
          attemptId: /** @type {any} */ (pinned).attemptId,
          materialRevision: /** @type {any} */ (pinned).materialRevision,
          todoRevision: /** @type {any} */ (pinned).todoRevision,
        });
      } catch {
        res = null;
      }
      if (gen !== generation) return;
      if (res?.ok && !res.skipped) {
        set(key, { phase: 'done', pinned, messageKey: 'chat.delegationAcceptDone', tone: 'success' });
        deps.onAccepted?.(target);
        return;
      }
      const messageKey = res?.ok ? 'chat.delegationAcceptFailed' : deps.resolveErrorKey(res);
      if (STALE_CODES.has(String(res?.code || ''))) {
        // The pin is stale: drop it and re-pin from the server's current values.
        await load(target, { messageKey, tone: 'error' });
        return;
      }
      set(key, { phase: 'ready', pinned, messageKey, tone: 'error' });
    },
  };
}
