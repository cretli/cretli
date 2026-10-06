/**
 * Sidebar chat row DOM model (Lit migration stage 6.3).
 * Builds the `<li class="sidebar-chat-item">` contract HTML for Lit row render().
 */

import { MAX_SIDEBAR_NEST_INDENT } from './sidebarChatDragBlock.js';
import { resolvePersistedLocalChatHarnessDisplay } from '../chat/persistedLocalChatState.js';
import { renderTreeContinuationHtml } from './sidebarSubchatGroups.js';

/**
 * @param {object} chat
 * @param {string} activeChatId
 * @param {object} opts
 * @param {object} deps
 * @returns {string}
 */
export function buildSidebarChatRowHtml(chat, activeChatId, opts, deps) {
  if (!chat?.id) return '';
  const level = Math.max(0, Number(opts.level) || 0);
  const indentLevel = Math.min(MAX_SIDEBAR_NEST_INDENT, level);
  const isLastChild = level > 0 && opts.isLastChild === true;
  const parentId = typeof opts.parentId === 'string' ? opts.parentId : '';
  const subchatSummary = opts.subchatSummary || null;
  const archived = opts.archived === true;
  const inArchiveList = opts.inArchiveList === true;
  const hasPinAction = !archived && deps.canPinChatToUrl();
  const escapeHtml = deps.escapeHtml;
  const t = deps.t;
  const localHarnessDisplay = resolvePersistedLocalChatHarnessDisplay(chat);
  const pushPreview = chat._pushPreview && typeof chat._pushPreview.text === 'string'
    ? chat._pushPreview.text.trim()
    : '';
  const harness = String(chat.agentTransport || 'sdk').trim().toLowerCase();
  const resolveHarnessIcon = deps.resolveSidebarHarnessIcon;
  const harnessIcon = typeof resolveHarnessIcon === 'function' ? resolveHarnessIcon(chat) : '';
  const harnessIconHtml = harnessIcon
    ? '<img src="/harness-icons/' + harnessIcon + '" alt="" loading="lazy" decoding="async">'
    : '';
  const harnessLabel = localHarnessDisplay.blocked
    ? localHarnessDisplay.label
    : ({
      sdk: 'Cursor SDK',
      'cursor-sdk': 'Cursor SDK',
      openrouter: 'OpenRouter',
      opencode: 'OpenCode',
      codebuddy: 'CodeBuddy',
      deepseek: 'DeepSeek',
      codex: 'Codex',
      qwen: 'Qwen',
      claude: 'Claude',
    })[harness] || 'Cursor SDK';
  const harnessModifier = localHarnessDisplay.blocked
    ? 'local'
    : (harness === 'cursor-sdk' ? 'sdk' : (['sdk', 'openrouter', 'opencode', 'codebuddy', 'deepseek', 'codex', 'qwen', 'claude'].includes(harness) ? harness : 'sdk'));
  const harnessTitle = localHarnessDisplay.blocked ? t(localHarnessDisplay.messageKey) : harnessLabel;
  const actionHtml = typeof deps.renderChatActionButtonsHtml === 'function'
    ? deps.renderChatActionButtonsHtml(chat, { archived })
    : '';
  const ariaSetSize = Number.isFinite(Number(opts.ariaSetSize)) && Number(opts.ariaSetSize) > 0
    ? Math.round(Number(opts.ariaSetSize))
    : 0;
  const ariaPosInSet = Number.isFinite(Number(opts.ariaPosInSet)) && Number(opts.ariaPosInSet) > 0
    ? Math.round(Number(opts.ariaPosInSet))
    : 0;
  const archiveLogicalIndex = Number.isFinite(Number(opts.archiveLogicalIndex))
    ? Math.max(0, Math.round(Number(opts.archiveLogicalIndex)))
    : -1;
  return (
    '<li class="sidebar-chat-item'
    + (chat.id === activeChatId ? ' is-active' : '')
    + (level > 0 ? ' is-child' : '')
    + (isLastChild ? ' is-last-child' : '')
    + (archived ? ' is-archived' : '')
    + (hasPinAction ? ' has-pin-actions' : '')
    + (pushPreview ? ' has-push-preview' : '')
    + '" role="option" aria-selected="'
    + (chat.id === activeChatId ? 'true' : 'false')
    + '" data-chat-id="'
    + escapeHtml(chat.id)
    + '" data-nest-level="'
    + String(level)
    + '" data-parent-id="'
    + escapeHtml(parentId)
    + '"'
    + (inArchiveList ? ' data-archived="1"' : '')
    + (inArchiveList && archiveLogicalIndex >= 0
      ? ' data-archive-logical-index="' + String(archiveLogicalIndex) + '"'
      : '')
    + (inArchiveList && ariaSetSize > 0 ? ' aria-setsize="' + String(ariaSetSize) + '"' : '')
    + (inArchiveList && ariaPosInSet > 0 ? ' aria-posinset="' + String(ariaPosInSet) + '"' : '')
    + (indentLevel > 0 ? ' style="--sidebar-nest-level:' + String(indentLevel) + '"' : '')
    + ' tabindex="'
    + (chat.id === activeChatId ? '0' : '-1')
    + '">'
    + renderTreeContinuationHtml(opts.continuationLevels)
    + '<span class="sidebar-chat-item-state sidebar-chat-item-state--idle" title="" aria-hidden="true"></span>'
    + '<span class="sidebar-chat-item-harness sidebar-chat-item-harness--'
    + harnessModifier
    + '" title="'
    + escapeHtml(harnessTitle)
    + '" aria-hidden="true">'
    + harnessIconHtml
    + '</span>'
    + '<span class="sidebar-chat-item-main">'
    + '<span class="sidebar-chat-item-title">'
    + escapeHtml(chat.title)
    + (archived
      ? '<span class="sidebar-chat-item-temp-badge" title="'
        + escapeHtml(t('chatUi.archivedChat'))
        + '">'
        + escapeHtml(t('chatUi.archivedBadge'))
        + '</span>'
      : '')
    + (chat.isTemporary
      ? '<span class="sidebar-chat-item-temp-badge" title="' + escapeHtml(t('sidebar.tempAgentTitle')) + '">'
        + escapeHtml(t('sidebar.tempBadge')) + '</span>'
      : '')
    + (chat.todoId
      ? '<span class="sidebar-chat-item-todo-badge" title="' + escapeHtml(t('sidebar.todoTitle')) + '">Todo</span>'
      : '')
    + (chat.widgetPinnedUrl
      ? '<span class="sidebar-chat-item-pin-badge" title="' + escapeHtml(t('sidebar.pinnedUrlTitle')) + '">URL</span>'
      : '')
    + '</span>'
    + (pushPreview && !archived
      ? '<span class="sidebar-chat-item-preview" title="'
        + escapeHtml(pushPreview)
        + '">'
        + escapeHtml(pushPreview)
        + '</span>'
      : '')
    + '</span>'
    + (subchatSummary && !archived
      ? '<span class="sidebar-chat-item-subchat-summary" data-summary-label="'
        + escapeHtml(subchatSummary.label)
        + '" title="'
        + escapeHtml(subchatSummary.title)
        + '" aria-label="'
        + escapeHtml(subchatSummary.title)
        + '">'
        + escapeHtml(subchatSummary.label)
        + '</span>'
      : '')
    + '<span class="sidebar-chat-item-awaiting sidebar-chat-item-awaiting--idle" hidden'
    + ' data-status-tone="idle" data-status-label="" data-activity-key="" data-status-outcome="">'
    + '</span>'
    + actionHtml
    + '</li>'
  );
}

/**
 * @param {string} chatId
 * @param {(value: string) => string} escapeHtml
 * @returns {string}
 */
export function buildSidebarChatRowHostHtml(chatId, escapeHtml) {
  const id = String(chatId || '').trim();
  if (!id) return '';
  return '<cr-sidebar-chat-row chat-id="' + escapeHtml(id) + '"></cr-sidebar-chat-row>';
}
