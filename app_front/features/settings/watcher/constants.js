/**
 * Static configuration and empty-state templates for the Workspace Watcher
 * settings. Nothing in here is mutable at runtime.
 */

import { SCOUT_HISTORY_PAGE_SIZE } from '../../watcher/scoutHistoryView.js';
import { SCOUT_INBOX_PAGE_SIZE } from '../../watcher/scoutFindingsInboxView.js';

export const MODES = ['off', 'observe', 'autopilot'];
export const PICK_ROLES = ['plan', 'implement', 'review'];
/** Scout categories — must match `WORKSPACE_SCOUT_CATEGORIES` on the server so
 *  the checkboxes and the closed-set allow-list never drift. */
export const SCOUT_CATEGORIES = ['bug', 'improvement', 'refactor', 'security', 'opportunity', 'documentation'];
/** Mirror of `WORKSPACE_WATCHER_MAX_PENDING_SCOUT_FINDINGS` on the server. */
export const SCOUT_PENDING_FINDINGS_CAPACITY = 200;
/** Cooldown slider bounds in ms. The persisted default is 30s (see below), so
 *  the slider spans a practical 0–15 min band in 30s steps. */
export const COOLDOWN_MIN_MS = 0;
export const COOLDOWN_MAX_MS = 15 * 60_000;
export const COOLDOWN_STEP_MS = 30_000;
/**
 * Client mirror of `defaultWorkspaceWatcherPolicy()` on the server, used only by
 * the "Reset to defaults" action. It is kept aligned with the server default
 * (cooldown 30s) so a reset followed by a refetch never jumps: the editor and
 * the newly-created watcher row must agree end-to-end.
 */
export const DEFAULT_POLICY = {
  maxParallel: 1,
  maxParallelWorktree: 0,
  maxParallelProject: 0,
  maxCyclesPerDay: 20,
  maxConsecutiveFailures: 3,
  maxSameFindings: 2,
  cooldownMs: 30_000,
  backoffBaseMs: 60_000,
  backoffCapMs: 6 * 60 * 60_000,
  requirePlanApproval: true,
  requireReviewForDone: 'off',
  requireIndependentReview: false,
  reviewGateMaxAttempts: 2,
  planApprovalScope: 'leaf',
  phases: { plan: true, review: true, implement: true, integrate: false },
  allowedHarnesses: [],
  pickRoles: [...PICK_ROLES],
  quietHours: { start: '', end: '' },
  scoutEnabled: false,
  scoutMaxParallel: 1,
  scoutMaxPerDay: 4,
  scoutIntervalHours: 6,
  scoutAutoCreate: false,
  scoutAllowedHarnesses: [],
  scoutCategories: [...SCOUT_CATEGORIES],
  orchestrator: { harness: '', model: '' },
  autoIntegrate: false,
  autoIntegrateMaxPerHour: 10,
  autoIntegrateMaxFailures: 3,
  autoRestart: false,
};
export const WATCHER_TABS = ['status', 'monitor', 'settings', 'scout', 'actions'];
/** Settings-nav sub-tab id → panel id. The bar lives in the settings header,
 *  the same place as the Harness and App sub-tabs. */
export const WATCHER_SETTINGS_TAB = {
  watcher: 'status',
  'watcher-monitor': 'monitor',
  'watcher-settings': 'settings',
  'watcher-scout': 'scout',
  'watcher-actions': 'actions',
};

/** Scout profile list state (stage 5.1). Held in the store so a management
 *  action can repaint only the list, never the editable policy form. */
export const EMPTY_SCOUT_PROFILES_STATE = {
  loading: true,
  error: '',
  profiles: [],
  busy: false,
  busyId: '',
  busyAction: '',
  confirmArchiveId: '',
  message: '',
  messageTone: 'ok',
};
/** Scout scan history (stage 5.3). Repainted independently of the policy form. */
export const EMPTY_SCOUT_HISTORY_STATE = {
  loading: true,
  error: '',
  history: [],
  total: 0,
  scoutId: '',
  max: SCOUT_HISTORY_PAGE_SIZE,
  busy: false,
  message: '',
  messageTone: 'ok',
};
/** Shared Scout proposal inbox (stage 5.3). */
export const EMPTY_SCOUT_INBOX_STATE = {
  loading: true,
  error: '',
  findings: [],
  total: 0,
  scoutId: '',
  category: '',
  status: '',
  max: SCOUT_INBOX_PAGE_SIZE,
  busy: false,
  busyId: '',
  expandedSources: {},
  capacityExceeded: false,
  message: '',
  messageTone: 'ok',
};
/** Scout profile editor state (stage 5.2). Module-scoped and completely separate
 *  from the list state: a live refresh may repaint the list without ever
 *  overwriting an unsaved draft when `dirty === true`. */
export const EMPTY_SCOUT_EDITOR_STATE = {
  mode: null,
  draft: null,
  originalProfile: null,
  templates: [],
  preview: null,
  previewError: '',
  restoreDiff: null,
  restoreMeta: null,
  restoreError: '',
  fieldErrors: {},
  casConflict: false,
  busy: false,
  dirty: false,
  error: '',
  selectedId: '',
  /** Kept here, not in the DOM: a repaint rebuilds the `<details>` element. */
  advancedOpen: false,
};

export const CLOCK_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;
