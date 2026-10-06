/**
 * Machine-readable sidebar chat-row contract for the Lit migration (todo stage 6.2).
 * Human-readable spec: docs/sidebar-lit-migration-contracts.md
 *
 * Do not import this module from runtime sidebar code yet; tests and docs reference it.
 */

/** Primary row lookup selector used across the app. */
export const SIDEBAR_CHAT_ROW_SELECTOR = '.sidebar-chat-item[data-chat-id]';

/** Root class on each chat row (`<li>`). */
export const SIDEBAR_CHAT_ROW_ROOT_CLASS = 'sidebar-chat-item';

/** Required `data-*` attributes on the row element (camelCase = dataset key). */
export const SIDEBAR_CHAT_ROW_DATA_ATTRS = [
  'data-chat-id',
  'data-visual-key',
  'data-nest-level',
  'data-parent-id',
];

/** Optional row `data-*` when the row is in the archive list. */
export const SIDEBAR_CHAT_ROW_ARCHIVE_ATTR = 'data-archived';

/** Structural child selectors (querySelector from the row). Must stay stable for patches. */
export const SIDEBAR_CHAT_ROW_CHILD_SELECTORS = [
  '.sidebar-chat-item-state',
  '.sidebar-chat-item-harness',
  '.sidebar-chat-item-main',
  '.sidebar-chat-item-title',
  '.sidebar-chat-item-preview',
  '.sidebar-chat-item-subchat-summary',
  '.sidebar-chat-item-awaiting',
  '.sidebar-chat-item-activity-label',
  '.sidebar-chat-action',
];

/** Row state classes toggled outside full structural rebuilds. */
export const SIDEBAR_CHAT_ROW_TRANSIENT_CLASSES = [
  'is-active',
  'has-activity-status',
  'has-pin-actions',
  'has-push-preview',
  'is-drop-nest',
  'is-drop-nest-pending',
  'is-subchat-hidden',
];

/** Source files that must keep referencing the row contract (guard test scans these). */
export const SIDEBAR_CHAT_ROW_CONTRACT_SOURCES = [
  'app_front/features/sidebar/sidebarView.js',
  'app_front/chat.js',
  'app_front/features/sidebar/sidebarChatDrag.js',
  'app_front/features/sidebar/sidebarChatOrder.js',
  'app_front/features/sidebar/sidebarChatStatus.js',
  'app_front/css/app.scss',
];
