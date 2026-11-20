/**
 * Signals for data shared across panels. Fetchers in api.js publish their results here
 * (`publish*`), and panels read the signals or `subscribe` instead of listening for a
 * CustomEvent and re-fetching. The module is DOM-free so it can be unit tested in Node.
 * Docs: docs/shared-state.md.
 */
import { Signal, signal } from '@lit-labs/signals';

/**
 * @template T
 * @param {{ get(): T }} source
 * @param {(value: T) => void} listener called after every change (not for the initial value)
 * @returns {() => void} unsubscribe
 */
export function subscribe(source, listener) {
  let pending = false;
  let active = true;
  const computed = new Signal.Computed(() => source.get());
  const watcher = new Signal.subtle.Watcher(() => {
    if (pending || !active) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      if (!active) return;
      const value = computed.get();
      // Re-arm without arguments: watch(computed) would append a duplicate graph edge per change.
      watcher.watch();
      listener(value);
    });
  });
  watcher.watch(computed);
  computed.get();
  return () => {
    active = false;
    watcher.unwatch(computed);
  };
}

export function createSharedState() {
  const settings = signal(/** @type {object | null} */ (null));
  const chatsList = signal(/** @type {object | null} */ (null));
  const gitInfo = signal(/** @type {object | null} */ (null));
  /** Latest notification-center state mirror (same object the store reports). */
  const notifications = signal(/** @type {object | null} */ (null));
  /** Bumped on every `chatsChanged`-style watcher frame; consumers re-read their own view. */
  const watcherRevision = signal(0);

  return {
    settings,
    chatsList,
    gitInfo,
    notifications,
    watcherRevision,
    publishSettings(value) {
      if (value && value.ok !== false) settings.set(value);
    },
    publishChats(value) {
      if (value && value.ok !== false) chatsList.set(value);
    },
    publishGitInfo(value) {
      if (value && value.ok !== false) gitInfo.set(value);
    },
    publishNotifications(value) {
      notifications.set(value || null);
    },
    bumpWatcher() {
      watcherRevision.set(watcherRevision.get() + 1);
    },
    /** Calls `listener` on every watcher change, never for the current value. */
    onWatcherChanged(listener) {
      return subscribe(watcherRevision, () => listener());
    },
  };
}
