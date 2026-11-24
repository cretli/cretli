/** Pinned watcher ("Workspace") section HTML and its incremental application. */

import { t } from '../../../i18n/index.js';
import { listWorkspaceWatcherPinnedChats, resolveWorkspaceWatcherBadge } from '../workspaceAutopilotBadge.js';
import { getWorkspaceWatcherRuntimeControl, isWorkspaceWatcherStartsEnabled } from '../workspaceWatcherToggle.js';
import { readSidebarOnlyActiveWorkspaceFlag } from '../sidebarOnlyActiveFilter.js';
import { workspaceDisplayNameForFolder } from '../workspaceChatMatch.js';
import { renderWorkspaceMarkerHtml } from '../sidebarWorkspaceMarker.js';
import { readViewMode, normalizePath } from '../state/sidebarPersistence.js';
import { findOperatorChat, getOperatorStatus, onOperatorStatusChange, refreshOperatorStatus, renderOperatorSectionHtml } from '../../chat/operatorChat.js';

/**
 * @param {Record<string, any>} ctx shared sidebar closure: deps, state and sibling modules
 */
export function createSidebarPinnedSection(ctx) {
  const { getWorkspaces, getChats, getActiveWorkspaceFolder, getPreferredWorkspaceFolder, escapeHtml, state } = ctx;
  const parseSidebarMarkup = (...args) => ctx.parseSidebarMarkup(...args);
  const isSearchActive = (...args) => ctx.isSearchActive(...args);

  /**
   * Small pill switch used by the Workspace section: one master gate in the
   * header and one per pinned workspace. Rendered as a real
   * `<button role="switch">` so the delegated sidebar click handler can dispatch
   * it by class like every other row control.
   *
   * @param {{ scope: 'all' | 'workspace', workspaceFolder?: string, checked: boolean, title: string }} input
   * @returns {string}
   */
  function renderWatcherToggleHtml(input) {
    const scope = input.scope === 'all' ? 'all' : 'workspace';
    const folder = String(input.workspaceFolder || '');
    const checked = input.checked === true;
    return (
      '<button type="button" class="sidebar-watcher-toggle" role="switch"' +
      ' aria-checked="' + (checked ? 'true' : 'false') + '"' +
      ' data-watcher-scope="' + escapeHtml(scope) + '"' +
      (folder ? ' data-workspace-folder="' + escapeHtml(folder) + '"' : '') +
      ' aria-label="' + escapeHtml(input.title) + '"' +
      ' title="' + escapeHtml(input.title) + '">' +
      '<span class="sidebar-watcher-toggle-knob" aria-hidden="true"></span>' +
      '</button>'
    );
  }

  /**
   * The dedicated "Workspace" section: one pinned watcher chat per workspace,
   * rendered outside the normal chat list. It is fed by the coalesced
   * `agentPresence` frame (no extra socket), so a newly materialized pinned chat
   * appears live. Each row (and the section header) carries a watcher toggle.
   *
   * @param {string} activeChatId
   * @returns {string}
   */
  /**
   * One row of the Workspace section. `pinnedChatId` is empty for a workspace
   * that has no pinned watcher chat yet (only reachable in "show all" mode); such
   * a row is a plain entry whose switch alone is interactive.
   */
  function renderPinnedWatcherRow(row) {
    const active = !!row.pinnedChatId && row.pinnedChatId === row.activeChatId;
    const toggleTitle = t('sidebar.watcherToggleRowTitle', {
      name: row.name,
      state: row.enabled ? row.stateOn : row.stateOff,
    }) + (row.gated ? ` ${t('sidebar.watcherToggleGated')}` : '');
    return (
      '<li class="sidebar-pinned-chat' + (active ? ' is-active' : '') +
      (row.pinnedChatId ? '' : ' sidebar-pinned-chat--no-chat') +
      '" role="option" aria-selected="' + (active ? 'true' : 'false') +
      (row.pinnedChatId ? '" data-pinned-chat-id="' + escapeHtml(row.pinnedChatId) : '') +
      '" tabindex="' + (active ? '0' : '-1') +
      '" title="' + escapeHtml(row.sub || row.name) + '">' +
      (row.markerHtml || '<span class="mdi mdi-robot-outline sidebar-pinned-chat-icon" aria-hidden="true"></span>') +
      '<span class="sidebar-pinned-chat-main">' +
      '<span class="sidebar-pinned-chat-title">' + escapeHtml(row.name) + '</span>' +
      '<span class="sidebar-pinned-chat-sub">' + escapeHtml(row.sub) + '</span>' +
      '</span>' +
      (row.status
        ? '<span class="sidebar-pinned-chat-status">' + escapeHtml(row.status) + '</span>'
        : '') +
      renderWatcherToggleHtml({
        scope: 'workspace',
        workspaceFolder: row.folder,
        checked: row.enabled,
        title: toggleTitle,
      }) +
      '</li>'
    );
  }

  function renderPinnedWorkspaceSection(activeChatId) {
    // The watcher agents live in their own view mode; the Agents tab lists every
    // workspace so a watcher can be switched on from there.
    if (readViewMode() !== 'agents') return '';
    const entries = listWorkspaceWatcherPinnedChats();
    // The "active workspace only" filter also applies here: watcher rows of
    // other workspaces must not leak past the filtered chat list.
    const onlyActive = readSidebarOnlyActiveWorkspaceFlag() && !isSearchActive();
    const activeFolder = normalizePath(getActiveWorkspaceFolder());
    const chats = getChats();
    // Workspaces holding the open chat or its fork ancestors stay visible too.
    const chainFolders = new Set();
    if (onlyActive) {
      const chain = ctx.activeChainIds();
      for (const chat of chats) {
        if (chain.has(chat?.id)) chainFolders.add(normalizePath(chat.workspaceFolder || ''));
      }
    }
    const matchesActive = (folder) => !onlyActive || !activeFolder
      || normalizePath(folder) === activeFolder || chainFolders.has(normalizePath(folder));
    const wsList = getWorkspaces();
    const nameFor = (folder) => workspaceDisplayNameForFolder(wsList, folder, getPreferredWorkspaceFolder);
    // Global start gate: off means every workspace's cycles/scout are blocked.
    const allOn = isWorkspaceWatcherStartsEnabled();
    const gated = !allOn && getWorkspaceWatcherRuntimeControl().known;
    const stateOn = t('sidebar.watcherToggleOn');
    const stateOff = t('sidebar.watcherToggleOff');
    const entryByFolder = new Map(
      entries.map((entry) => [normalizePath(entry.workspaceFolder), entry]),
    );
    const rows = [];
    // One row per workspace group (clones included), so a watcher can be turned
    // on for a workspace that has never had one.
    const seenFolders = new Set();
    for (const workspace of wsList) {
      const sidebarKey = workspace.sidebarKey || workspace.workspaceFile || '';
      const folder = String(
        getPreferredWorkspaceFolder(sidebarKey)
        || workspace.workspaceFolder
        || workspace.workspaceDir
        || '',
      ).trim();
      if (!folder) continue;
      const norm = normalizePath(folder);
      if (seenFolders.has(norm)) continue;
      if (!matchesActive(norm)) continue;
      seenFolders.add(norm);
      const entry = entryByFolder.get(norm) || null;
      const chat = entry ? chats.find((item) => item.id === entry.pinnedChatId) : null;
      rows.push(renderPinnedWatcherRow({
        name: workspace.name || nameFor(folder),
        sub: chat?.title || folder,
        folder,
        pinnedChatId: entry?.pinnedChatId || '',
        enabled: !!resolveWorkspaceWatcherBadge(workspace, folder),
        status: entry?.stopReason || (entry?.paused ? t('sidebar.watcherAutopilotPaused') : ''),
        // The workspace's own colour / emoji identifies its agent.
        markerHtml: renderWorkspaceMarkerHtml(workspace, escapeHtml),
        gated,
        activeChatId,
        stateOn,
        stateOff,
      }));
    }
    if (!rows.length && !entries.length) return '';
    const allTitle = t('sidebar.watcherToggleAllTitle', {
      state: allOn ? stateOn : stateOff,
    });
    return (
      '<div class="sidebar-pinned-section' + (gated ? ' is-gated' : '') +
      '" aria-label="' + escapeHtml(t('sidebar.workspaceSection')) + '">' +
      // Master "kill switch": one framed control that stops every workspace agent.
      '<div class="sidebar-agents-master' + (allOn ? '' : ' is-off') + '">' +
      '<span class="mdi mdi-power sidebar-agents-master-icon" aria-hidden="true"></span>' +
      '<span class="sidebar-agents-master-text">' +
      '<span class="sidebar-agents-master-title">' + escapeHtml(t('sidebar.agentsMasterTitle')) + '</span>' +
      '<span class="sidebar-agents-master-hint">' +
      escapeHtml(allOn ? t('sidebar.agentsMasterOn') : t('sidebar.agentsMasterOff')) + '</span>' +
      '</span>' +
      renderWatcherToggleHtml({ scope: 'all', checked: allOn, title: allTitle }) +
      '</div>' +
      '<ul class="sidebar-pinned-chats" role="listbox">' + rows.join('') + '</ul>' +
      '</div>'
    );
  }

  /** Rebuild the (small) pinned watcher section only when its HTML changed. */
  function applyPinnedSection(body, activeChatId) {
    const html = renderPinnedWorkspaceSection(activeChatId);
    const existing = body.querySelector('.sidebar-pinned-section');
    if (!html) {
      if (existing) existing.remove();
      state.lastPinnedSectionHtml = '';
      return;
    }
    if (existing && state.lastPinnedSectionHtml === html) return;
    const node = parseSidebarMarkup(html);
    if (!node) return;
    if (existing) existing.replaceWith(node);
    else body.insertBefore(node, body.firstChild);
    state.lastPinnedSectionHtml = html;
  }

  /**
   * The internal operator's owner thread, pinned above everything else. It has
   * no archive/delete controls; the chip shows `running|queued N|idle|paused|budget|off`.
   */
  function applyOperatorSection(body, activeChatId) {
    const chat = findOperatorChat(getChats());
    const html = chat ? renderOperatorSectionHtml({ chat, status: getOperatorStatus(), activeChatId, escapeHtml }) : '';
    const existing = body.querySelector('.sidebar-operator-section');
    if (chat) {
      void refreshOperatorStatus();
      if (!state.operatorStatusSubscribed && typeof ctx.forceRerender === 'function') {
        state.operatorStatusSubscribed = true;
        onOperatorStatusChange(() => ctx.forceRerender());
      }
    }
    if (!html) {
      if (existing) existing.remove();
      state.lastOperatorSectionHtml = '';
      return;
    }
    if (existing && state.lastOperatorSectionHtml === html) return;
    const node = parseSidebarMarkup(html);
    if (!node) return;
    if (existing) existing.replaceWith(node);
    else body.insertBefore(node, body.firstChild);
    state.lastOperatorSectionHtml = html;
  }

  return { renderWatcherToggleHtml, renderPinnedWatcherRow, renderPinnedWorkspaceSection, applyPinnedSection, applyOperatorSection };
}
