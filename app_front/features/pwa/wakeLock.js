let wakeLockSentinel = null;
let wantLock = false;
let initialized = false;

async function acquireWakeLockIfNeeded() {
  if (!wantLock || wakeLockSentinel) return;
  if (typeof navigator === 'undefined' || !navigator.wakeLock) return;
  if (typeof document !== 'undefined' && document.hidden) return;
  try {
    wakeLockSentinel = await navigator.wakeLock.request('screen');
    wakeLockSentinel.addEventListener('release', () => {
      wakeLockSentinel = null;
      if (wantLock) acquireWakeLockIfNeeded();
    });
  } catch (_) {
    wakeLockSentinel = null;
  }
}

async function releaseWakeLockNow() {
  if (!wakeLockSentinel) return;
  try {
    await wakeLockSentinel.release();
  } catch (_) {}
  wakeLockSentinel = null;
}

export function initAgentWakeLock() {
  if (initialized || typeof document === 'undefined') return;
  initialized = true;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      void releaseWakeLockNow();
      return;
    }
    if (wantLock) void acquireWakeLockIfNeeded();
  });
}

/** Keeps the screen awake while an agent run is active (mobile). */
export function syncAgentWakeLock(active) {
  wantLock = !!active;
  if (!wantLock) {
    void releaseWakeLockNow();
    return;
  }
  void acquireWakeLockIfNeeded();
}
