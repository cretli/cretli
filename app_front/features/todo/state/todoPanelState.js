import { createTodoListState } from '../../../state/todoListState.js';
import { createTodoListModel } from '../todoOfflineState.js';
import { TODO_INTEGRATION_PENDING_FILTERS } from '../todoTreeView.js';
import { createLatestRequestGate, createOwnedPendingGuard } from '../todoBatchSelection.js';

/**
 * Shared mutable state of the Todo panel. The panel used to keep these as
 * module-level `let` bindings; the feature modules now read and write them
 * through this single object.
 */
export const S = /** @type {Record<string, any>} */ ({
  /** @type {HTMLElement|null} */
  listEl: null,
  /** @type {HTMLElement|null} */
  statusEl: null,
  /** @type {import('./components/ui/cr-dialog.js').CrDialog | null} */
  /** @type {HTMLElement|null} */
  hintEl: null,
  /** @type {(panelId: string) => void} */
  showPanelFn: () => {},
  /** @type {boolean} */
  sdkReady: false,
  /** @type {object[]} */
  latestItems: [],
  /** Server revision (`rev`) of the list that is currently painted. */
  latestListRev: '',
  latestWorkspaceFolder: '',
  todoTab: 'list',
  refreshGeneration: 0,
  /** True until a workspace without a stored collapse preference got its defaults. */
  collapseDefaultsPending: false,
  /** @type {string} */
  pendingParentId: '',
  /** @type {HTMLElement | null} */
  editorDialog: null,
  /** @type {HTMLElement | null} */
  editorCard: null,
  /** @type {string} */
  editorTodoId: '',
  /** Todo id whose tab selection the open dialog is remembering. */
  editorTabTodoId: '',
  /** @type {{ id: string, pointerId: number, targetId: string, zone: string } | null} */
  dragState: null,
  /** @type {() => void} */
  openNewTodoModal: () => {},
  /** Selection mode for the bulk "integrate with agent" flow. */
  batchSelectionMode: false,
  /** @type {object | null} Batch view the panel currently tracks (active or just finished). */
  activeBatch: null,
  /** Batch id whose final notification was already shown. */
  lastNotifiedBatchId: '',
  /** Entry-state fingerprint; a poll only repaints rows when it changes. */
  batchBadgeSignature: '',
  /** setTimeout chain id for the active-batch poll. */
  batchPollTimer: 0,
  /** Guards a stale in-flight poll after stop/restart/workspace switch. */
  batchPollGeneration: 0,
  /** Bumped on every workspace switch; in-flight batch responses compare against it. */
  batchWorkspaceGeneration: 0,
  batchLongPressTimer: 0,
  batchLongPressPointerId: -1,
  batchLongPressStart: { x: 0, y: 0 },
  /** Set when a touch long-press already toggled selection, to swallow the click. */
  suppressRowOpenAfterLongPress: false,
  /** @type {HTMLElement | null} */
  batchActionBar: null,
  /** @type {Record<string, HTMLElement> | null} */
  batchActionBarRefs: null,
  /** @type {HTMLElement | null} */
  batchBanner: null,
  /** @type {Record<string, HTMLElement> | null} */
  batchBannerRefs: null,
  /** @type {object | null} Integration lock the server reported for the workspace. */
  integrationLock: null,
  /** @type {HTMLElement | null} Notice with the clear-lock control. */
  lockNotice: null,
  /** @type {{ text: HTMLElement, clear: HTMLElement } | null} */
  lockNoticeRefs: null,
  /** Free-text list search (title or id); not persisted. */
  todoSearchQuery: '',
  todoSearchUseFilters: false,
  /** Root order: manual | created | activity | active (persisted per workspace). */
  todoSort: 'manual',
  /** @type {HTMLButtonElement | null} */
  sortTrigger: null,
  /** @type {{ api: ReturnType<typeof import('../../../lib/dropdown.js').initDropdown>, panel: HTMLElement, list: HTMLElement } | null} */
  sortMenu: null,
  /** @type {object | null} View memory slice waiting for list data. */
  pendingTodoViewMemory: null,
  /** @type {HTMLButtonElement | null} */
  statusFilterTrigger: null,
  /** @type {{ api: ReturnType<typeof import('../../../lib/dropdown.js').initDropdown>, panel: HTMLElement, list: HTMLElement } | null} */
  statusFilterMenu: null,
  /** @type {ReturnType<typeof setTimeout> | 0} */
  editorSaveStateTimer: 0,
  /** Workspace-wide usage statistics dialog (aggregate view of the TODO panel). */
  usageDialog: null,
  usageSection: null,
  todoPaintContinuation: 0,
  /** Row count already painted by earlier chunks; only set while a continuation frame runs. */
  todoPaintResumeFrom: 0,
  /** Key of the last fully painted list; a matching key lets a repaint be skipped. */
  lastPaintSkipKey: '',
  /** Collapsed by default; a search opens it so matches inside are reachable. */
  deferredSectionOpen: false,
  /**
  * Settings PATCHes run one at a time, so a later response can never roll the
  * form back to an older assignee (model blur followed by a harness change).
  *
  * @type {Promise<void>}
  */
  editorSaveQueue: Promise.resolve(),
  /** @type {ReturnType<typeof setTimeout> | 0} */
  saveSlowTimer: 0,
  /**
  * One refresher per panel: server `todo.review` frames and reconnects collapse
  * into a single debounced list fetch. It renders through `renderList`, which
  * diffs rows in place, so an unchanged snapshot repaints nothing.
  */
  /** @type {ReturnType<typeof import('../todoReviewRefresh.js').createTodoReviewRefresher> | null} */
  reviewRefresher: null,
  /** @type {ReturnType<typeof setTimeout> | 0} */
  offlineRetryTimer: 0,
  offlineListenersBound: false,
});

/** @type {Map<HTMLElement, { api: ReturnType<typeof import('../../../lib/dropdown.js').initDropdown>, panel: HTMLElement, destroying: boolean }>} */
export const rowMenus = new Map();
/** Todo ids with a start-agent request in flight (row menu and card share it). */
export const startAgentInFlight = new Set();
export const BATCH_POLL_MS = 4000;
/** True while a start request is in flight (double-click guard). */
export const batchStartGuard = createOwnedPendingGuard();
/** Only the newest list request may update the tracked batch. */
export const batchListGate = createLatestRequestGate();
/** Harness / model used to start a batch, kept so a resume can reuse them. */
export const batchAgentById = new Map();
/** Long-press (touch) delay before selection mode starts on a row. */
export const BATCH_LONG_PRESS_MS = 500;
export const BATCH_LONG_PRESS_MOVE_PX = 12;
export const COLLAPSE_PREFIX = 'cretli-todo-collapsed:';
export const STATUS_FILTER_PREFIX = 'cretli-todo-status-filter:';
export const REVIEW_FILTER_PREFIX = 'cretli-todo-review-filter:';
export const INTEGRATION_FILTER_PREFIX = 'cretli-todo-integration-filter:';
export const SORT_PREFIX = 'cretli-todo-sort:';
/** Burst of `todosChanged` frames (several open chat sockets) becomes one fetch. */
export const REVIEW_REFRESH_DEBOUNCE_MS = 400;
/**
 * Tree expansion, bulk selection and list filters live in signals so rows and
 * other consumers can react to exactly the state they read (docs/shared-state.md).
 */
export const todoList = createTodoListState({ integrationDefault: TODO_INTEGRATION_PENDING_FILTERS });
export const EDITOR_SAVED_VISIBLE_MS = 2500;
/**
 * Full body / plan / changelog per todo, loaded on demand because the list rows
 * are lean. An entry is valid only for the `updatedAt` it was read at.
 *
 * `chatTitles` restores the titles that lean rows omit from `chats`.
 *
 * @type {Map<string, { updatedAt: string, body: unknown, plan: unknown, changelog: unknown, review: unknown, execution: unknown, chats?: unknown[], chatTitles: Map<string, string> }>}
 */
export const detailCache = new Map();
/** @type {Map<string, Promise<boolean>>} */
export const detailInFlight = new Map();
/** New rows created per frame when a big list is painted from scratch. */
export const TODO_PAINT_CHUNK = 60;
/** Signature last painted into each row element. */
export const paintedRowSignatures = new WeakMap();
/** How long the UI waits for a 202 worktree prepare before giving up. */
export const TODO_START_POLL_TIMEOUT_MS = 11 * 60 * 1000;
export const TODO_START_POLL_INTERVAL_MS = 2000;
export const SAVE_SLOW_MS = 1500;
export const LIST_SKELETON_ROWS = 7;
export const listModel = createTodoListModel();
