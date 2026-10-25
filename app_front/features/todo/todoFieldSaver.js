/**
 * Optimistic, de-duplicated saves for single todo fields (status, title, body).
 *
 * One save = exactly one PATCH. The UI is updated before the request starts
 * (`applyOptimistic`) and restored with `rollback` when the server answers with
 * `ok: false` (for example CONFLICT) or the request throws. Saves of the same
 * `(todoId, field)` never overlap: an identical value joins the in-flight
 * request, a different value is coalesced and sent once the current one ends.
 */

/**
 * @typedef {object} TodoFieldSaverDeps
 * @property {(id: string, patch: Record<string, unknown>) => Promise<any>} patch Sends the PATCH.
 * @property {(id: string, field: string) => unknown} read Current value shown in the UI.
 * @property {(id: string, field: string, value: unknown) => void} applyOptimistic Writes the value to the UI.
 * @property {(id: string, field: string, previous: unknown, error: { kind: 'server' | 'network', message: string }) => void} rollback
 * @property {(id: string, field: string, data: any) => void} onSaved Called with the PATCH response.
 * @property {(id: string, field: string) => void} [onSaving] Called when a request starts.
 */

/** @param {TodoFieldSaverDeps} deps */
export function createTodoFieldSaver(deps) {
  /**
   * @type {Map<string, {
   *   value: unknown,
   *   promise: Promise<boolean>,
   *   queued: { value: unknown, promise: Promise<boolean>, resolve: (ok: boolean) => void } | null,
   * }>}
   */
  const inflight = new Map();
  const keyOf = (id, field) => `${id}\u0000${field}`;

  /**
   * @param {string} id
   * @param {string} field
   * @param {unknown} value
   * @returns {Promise<boolean>} true when the value is saved (or already was)
   */
  function save(id, field, value) {
    const key = keyOf(id, field);
    const active = inflight.get(key);
    if (!active) {
      if (Object.is(deps.read(id, field), value)) return Promise.resolve(true);
      return run(key, id, field, value, deps.read(id, field));
    }
    if (Object.is(active.value, value) && !active.queued) return active.promise;
    // Coalesce: only the newest follow-up value is sent after the current request.
    if (active.queued) {
      active.queued.value = value;
    } else {
      let resolve = (_ok) => {};
      const promise = new Promise((r) => { resolve = r; });
      active.queued = { value, promise, resolve };
    }
    deps.applyOptimistic(id, field, value);
    return active.queued.promise;
  }

  /**
   * @param {string} key
   * @param {string} id
   * @param {string} field
   * @param {unknown} value
   * @param {unknown} previous Value to restore when the request fails.
   * @returns {Promise<boolean>}
   */
  function run(key, id, field, value, previous) {
    const entry = { value, promise: Promise.resolve(false), queued: null };
    inflight.set(key, entry);
    deps.applyOptimistic(id, field, value);
    deps.onSaving?.(id, field);
    entry.promise = (async () => {
      let ok = false;
      try {
        const data = await deps.patch(id, { [field]: value });
        if (data?.ok) {
          ok = true;
          deps.onSaved(id, field, data);
        } else {
          deps.rollback(id, field, previous, { kind: 'server', message: String(data?.error || '') });
        }
      } catch {
        deps.rollback(id, field, previous, { kind: 'network', message: '' });
      }
      inflight.delete(key);
      const next = entry.queued;
      if (next) {
        const settled = ok ? value : previous;
        if (Object.is(next.value, settled)) {
          // The user went back to the already-saved value: nothing to send.
          deps.applyOptimistic(id, field, settled);
          next.resolve(true);
        } else {
          void run(key, id, field, next.value, settled).then(next.resolve);
        }
      }
      return ok;
    })();
    return entry.promise;
  }

  return {
    save,
    /** @param {string} id @param {string} field */
    isSaving: (id, field) => inflight.has(keyOf(id, field)),
  };
}
