/**
 * Reactive state of the Workspace Watcher settings.
 *
 * Every reactive key is backed by a revision signal. Reading a key inside a
 * `SignalWatcher` component render subscribes the component; assigning a key
 * (the code always replaces objects immutably) bumps the revision and re-renders
 * exactly the regions that read it. Two escape hatches keep typing responsive:
 *  - `setSilent` stores a value without notifying (an editor keystroke must not
 *    rebuild the field the operator is typing in);
 *  - `touch` re-notifies after an in-place change, and `peek` reads without
 *    subscribing.
 * Plain keys (request sequence numbers, timers) are ordinary properties.
 */

import { signal } from '@lit-labs/signals';
import {
  EMPTY_SCOUT_EDITOR_STATE,
  EMPTY_SCOUT_HISTORY_STATE,
  EMPTY_SCOUT_INBOX_STATE,
  EMPTY_SCOUT_PROFILES_STATE,
} from './constants.js';

/**
 * @template {Record<string, unknown>} T
 * @param {T} initial
 * @returns {T & {
 *   peek: <K extends keyof T>(key: K) => T[K],
 *   setSilent: <K extends keyof T>(key: K, value: T[K]) => void,
 *   touch: (key: keyof T) => void,
 * }}
 */
function createReactiveStore(initial) {
  /** @type {Record<string, { value: unknown, rev: ReturnType<typeof signal<number>> }>} */
  const cells = {};
  const store = /** @type {any} */ ({});
  for (const [key, value] of Object.entries(initial)) {
    const cell = { value, rev: signal(0) };
    cells[key] = cell;
    Object.defineProperty(store, key, {
      enumerable: true,
      get() {
        cell.rev.get();
        return cell.value;
      },
      set(next) {
        cell.value = next;
        cell.rev.set(cell.rev.get() + 1);
      },
    });
  }
  store.peek = (key) => cells[key].value;
  store.setSilent = (key, value) => {
    cells[key].value = value;
  };
  store.touch = (key) => {
    cells[key].rev.set(cells[key].rev.get() + 1);
  };
  return store;
}

/** Reactive state plus the plain bookkeeping the controllers share. */
export const ws = Object.assign(createReactiveStore({
  /** @type {any} Last watcher view (`GET /api/workspace-watcher`). */
  lastView: null,
  /** @type {any} Aggregated monitoring stats. */
  lastStats: null,
  /** @type {any} Runtime-control payload, polled separately from the view. */
  runtimeControl: { statusUnavailable: true },
  /** @type {{ loaded: boolean, load: any }} Server load card (`/api/health`). */
  loadMetrics: { loaded: false, load: null },
  /** Todo id → title for the live cycle rows. */
  todoTitles: /** @type {Map<string, string>} */ (new Map()),
  /** Dashboard-local UI state (range / decisions filter / selected cycle). */
  dash: { range: '24h', decisionsFilter: 'all', selectedCycleId: '' },
  /** Active watcher sub-tab. */
  tab: 'status',
  /** Bumped on a language change so every region re-renders its labels. */
  langRev: 0,
  /** What the root panel shows: loading, an error, or the rendered form. */
  panelModel: /** @type {{ kind: string, message?: string, html?: string, data?: any, rev?: number }} */ ({ kind: 'loading' }),
  /** Audited workspace-scoped overrides (separate store from the policy pair). */
  workspaceOverridesState: { overrides: [], etag: '', error: '', busy: false },
  scoutProfilesState: { ...EMPTY_SCOUT_PROFILES_STATE },
  scoutHistoryState: { ...EMPTY_SCOUT_HISTORY_STATE },
  scoutInboxState: { ...EMPTY_SCOUT_INBOX_STATE },
  scoutEditorState: { ...EMPTY_SCOUT_EDITOR_STATE },
}), {
  /** Workspace folder the mounted form was rendered for. A live refresh for a
   *  different folder would otherwise repaint the status card while the form
   *  still edits the previous workspace. Empty until the first full render. */
  renderedWorkspaceFolder: '',
  /** @type {ReturnType<typeof setInterval> | null} */
  dashTimer: null,
  runtimePollInFlight: false,
  lastRuntimePollAt: 0,
  /** Monotonic refresh generation. A live event and a save can overlap; when a
   *  fetch resolves it must check that no newer refresh started, or an older
   *  response would overwrite fresher state. */
  refreshSeq: 0,
  /** Bumped every time `lastView` is replaced (a refresh result or an
   *  optimistic save). An optimistic-save rollback only restores its snapshot
   *  while the cache still holds that same generation. */
  viewSeq: 0,
  /** Monotonic id of the rendered form, so the panel re-binds only on a new one. */
  panelRev: 0,
  /** Index of the glob row a pending `remove-include`/`remove-exclude` click
   *  targets. Set by the delegated click binder right before dispatch. */
  scoutEditorRemoveIndex: -1,
  /**
   * Harness catalog rows (id + label) fetched with the full render so the
   * "Allowed harnesses" checkboxes can be built synchronously. An empty list
   * degrades to the already-saved ids, never a blank control.
   * @type {{ id: string, label: string }[]}
   */
  harnessOptions: [],
});
