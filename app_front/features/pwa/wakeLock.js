/**
 * Screen wake lock shared by independent reasons (`agent` run, open `car` view).
 * One sentinel is held while at least one reason is set; dropping a reason never
 * releases a lock another reason still needs.
 *
 * @param {{ navigator?: any, document?: any }} [env] injected for tests
 */
export function createWakeLock(env = {}) {
  const nav = 'navigator' in env ? env.navigator : (typeof navigator === 'undefined' ? undefined : navigator);
  const doc = 'document' in env ? env.document : (typeof document === 'undefined' ? undefined : document);
  /** @type {Set<string>} */
  const reasons = new Set();
  let sentinel = null;
  let listening = false;
  // Bumped on every release/acquire decision so a slow `request()` cannot resurrect a dropped lock.
  let generation = 0;

  async function acquireIfNeeded() {
    if (!reasons.size || sentinel) return;
    if (!nav || !nav.wakeLock) return;
    if (doc && doc.hidden) return;
    const mine = ++generation;
    try {
      const next = await nav.wakeLock.request('screen');
      if (mine !== generation || !reasons.size) {
        await next.release?.();
        return;
      }
      sentinel = next;
      next.addEventListener?.('release', () => {
        if (sentinel === next) sentinel = null;
        if (reasons.size) void acquireIfNeeded();
      });
    } catch (_) {
      sentinel = null;
    }
  }

  async function releaseNow() {
    generation += 1;
    const held = sentinel;
    sentinel = null;
    if (!held) return;
    try {
      await held.release();
    } catch (_) {}
  }

  const api = {
    /** Re-requests the lock after the page becomes visible again (the browser drops it when hidden). */
    init() {
      if (listening || !doc || typeof doc.addEventListener !== 'function') return;
      listening = true;
      doc.addEventListener('visibilitychange', () => {
        if (doc.hidden) {
          void releaseNow();
          return;
        }
        if (reasons.size) void acquireIfNeeded();
      });
    },
    /**
     * @param {string} reason
     * @param {boolean} active
     * @returns {Promise<void>}
     */
    async setReason(reason, active) {
      api.init();
      if (active) {
        reasons.add(reason);
        await acquireIfNeeded();
        return;
      }
      reasons.delete(reason);
      if (!reasons.size) await releaseNow();
    },
    hasReason: (reason) => reasons.has(reason),
    isHeld: () => !!sentinel,
  };
  return api;
}

let shared = createWakeLock();

/** Test hook: rebuilds the shared lock on injected globals. */
export function setSharedWakeLockEnv(env) {
  shared = createWakeLock(env);
  return shared;
}

export function initAgentWakeLock() {
  shared.init();
}

/** Keeps the screen awake while an agent run is active (mobile). */
export function syncAgentWakeLock(active) {
  void shared.setReason('agent', !!active);
}

/** Keeps the screen awake for as long as the car view is open, whether or not an agent works. */
export function syncCarWakeLock(open) {
  void shared.setReason('car', !!open);
}
