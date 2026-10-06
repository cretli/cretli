/**
 * Real DOM harness for `<cr-sidebar-workspace>` (Lit children, archive, drag, escaping).
 */
import '../../app_front/features/sidebar/cr-sidebar-workspace.js';
import '../../app_front/features/sidebar/cr-sidebar-subchat-group.js';
import '../../app_front/features/sidebar/cr-sidebar-archive-group.js';
import {
  beginSidebarWorkspacePass,
  endSidebarWorkspacePass,
  registerSidebarWorkspace,
} from '../../app_front/features/sidebar/sidebarWorkspacePass.js';
import {
  beginSidebarChatRowPass,
  endSidebarChatRowPass,
  registerSidebarChatRow,
} from '../../app_front/features/sidebar/sidebarChatRowPass.js';
import {
  beginSidebarArchiveGroupPass,
  endSidebarArchiveGroupPass,
  registerSidebarArchiveGroup,
} from '../../app_front/features/sidebar/sidebarArchiveGroupPass.js';
import {
  createSidebarWorkspaceHostElement,
  requestSidebarWorkspaceUpdate,
  waitForSidebarLitHostsCommit,
} from '../../app_front/features/sidebar/sidebarWorkspaceMount.js';
import {
  __getSidebarChatRowStatusPatchListenerCountForTest,
  dispatchSidebarChatRowStatusPatch,
} from '../../app_front/features/sidebar/sidebarChatRowRefreshBus.js';
import { collectWorkspaceHostsFromList } from '../../app_front/features/sidebar/sidebarWorkspaceOrder.js';
import {
  getSidebarArchiveVirtualFocus,
  registerSidebarArchiveGestureEndFlush,
  registerSidebarArchiveGestureGuard,
  runSidebarArchiveGestureEndFlush,
  setSidebarArchiveVirtualFocus,
  tickSidebarArchiveGestureFocusSnapshot,
} from '../../app_front/features/sidebar/sidebarArchiveVirtualFocus.js';
import {
  captureSidebarFocusInfo,
  ensureArchivedChatRowMounted,
  findArchiveGroupForChatId,
  handleSidebarArchiveKeydown,
  restoreSidebarFocus,
  wireArchiveVirtualFocusTracking,
} from '../../app_front/features/sidebar/sidebarArchiveSidebarFocus.js';
import { createUiFreezeCounters } from '../../app_front/lib/uiFreezeCounters.js';
import {
  beginSidebarSubchatGroupPass,
  endSidebarSubchatGroupPass,
  registerSidebarSubchatGroup,
} from '../../app_front/features/sidebar/sidebarSubchatGroupPass.js';
function sidebarDeps() {
  return {
    t: (key) => key,
    escapeHtml: (value) => String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/"/g, '&quot;'),
    resolveChatState: () => 'idle',
    getTerminalStateMeta: () => ({ tone: 'idle', label: 'Idle' }),
    canPinChatToUrl: () => false,
    resolveSidebarHarnessIcon: () => 'cursor.svg',
    renderChatActionButtonsHtml: () => '',
    getSidebarChatStateMeta: () => ({ tone: 'idle', label: 'Idle', activityKey: '' }),
  };
}

async function waitForLitPaint() {
  await new Promise((resolve) => queueMicrotask(resolve));
  await new Promise((resolve) => requestAnimationFrame(resolve));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * @param {string} wsKey
 * @param {object} workspace
 * @param {import('../../app_front/features/sidebar/sidebarWorkspaceModel.js').SidebarListEntry[]} listEntries
 */
function registerWorkspace(wsKey, workspace, listEntries) {
  registerSidebarWorkspace(wsKey, {
    sidebarKey: wsKey,
    workspace,
    isActive: false,
    isCollapsed: false,
    searching: false,
    serializeList: true,
    count: listEntries.filter((e) => e.kind === 'chat').length,
    preferredFolder: '',
    autopilotBadgeHtml: '',
    listEntries,
    deps: sidebarDeps(),
  });
}

/**
 * @param {string} chatId
 * @param {string} title
 * @param {object} [extra]
 */
function registerChat(chatId, title, extra = {}) {
  registerSidebarChatRow(chatId, {
    chat: { id: chatId, title, agentTransport: 'sdk', ...extra },
    activeChatId: '',
    opts: { level: 0, parentId: '' },
    deps: sidebarDeps(),
  });
}

/**
 * @param {string} wsKey
 * @param {boolean} openSection
 * @param {object[]} archiveTree
 */
function registerArchive(wsKey, openSection, archiveTree, activeChatId = '') {
  registerSidebarArchiveGroup(wsKey, {
    sidebarKey: wsKey,
    openSection,
    count: archiveTree.length,
    activeChatId: String(activeChatId || ''),
    archiveTree: archiveTree.map((chat) => ({
      chat,
      level: 0,
      isLastChild: true,
      parentId: '',
      continuationLevels: [],
    })),
    deps: sidebarDeps(),
  });
}

async function mountWorkspaceHost(wsKey, listEntries, workspaceExtra = {}) {
  beginSidebarWorkspacePass();
  beginSidebarChatRowPass();
  beginSidebarArchiveGroupPass();
  for (const entry of listEntries) {
    if (entry.kind === 'chat' && entry.chatId) {
      registerChat(entry.chatId, entry.chatId);
    }
    if (entry.kind === 'archive') {
      registerArchive(wsKey, false, []);
    }
  }
  registerWorkspace(wsKey, { sidebarKey: wsKey, workspaceFile: wsKey, ...workspaceExtra }, listEntries);
  endSidebarArchiveGroupPass();
  endSidebarChatRowPass();
  endSidebarWorkspacePass();
  const host = createSidebarWorkspaceHostElement(wsKey);
  if (!host) throw new Error('host-create-failed');
  document.body.appendChild(host);
  await waitForLitPaint();
  return host;
}

window.__runSidebarWorkspaceIdentityHarness = async () => {
  document.body.innerHTML = '';
  const wsKey = '/ws/one';
  const host = await mountWorkspaceHost(wsKey, [
    { kind: 'chat', key: 'c1', chatId: 'c1' },
    { kind: 'chat', key: 'c2', chatId: 'c2' },
  ]);
  const rowHostBefore = host.querySelector('cr-sidebar-chat-row[chat-id="c1"]');
  const titleBefore = host.querySelector('.sidebar-workspace-title')?.textContent || '';
  beginSidebarWorkspacePass();
  beginSidebarChatRowPass();
  registerChat('c1', 'Renamed title');
  registerWorkspace(wsKey, {
    sidebarKey: wsKey,
    workspaceFile: wsKey,
    name: 'Workspace & Co <x>',
  }, [
    { kind: 'chat', key: 'c1', chatId: 'c1' },
    { kind: 'chat', key: 'c2', chatId: 'c2' },
  ]);
  endSidebarChatRowPass();
  endSidebarWorkspacePass();
  requestSidebarWorkspaceUpdate(host);
  await waitForLitPaint();
  const rowHostAfter = host.querySelector('cr-sidebar-chat-row[chat-id="c1"]');
  const titleEl = host.querySelector('.sidebar-workspace-title');
  const li = host.querySelector('li.sidebar-workspace');
  const chatTitle = host.querySelector('li.sidebar-chat-item[data-chat-id="c1"] .sidebar-chat-item-title');
  return {
    sameRowHost: rowHostBefore === rowHostAfter,
    workspaceTitle: titleEl?.textContent || '',
    titleChangedFromBefore: titleBefore !== (titleEl?.textContent || ''),
    dataSidebarKey: li?.getAttribute('data-sidebar-key') || '',
    chatTitleText: chatTitle?.textContent || '',
  };
};

window.__runSidebarWorkspaceArchiveHarness = async () => {
  document.body.innerHTML = '';
  const wsKey = '/ws/arch';
  beginSidebarWorkspacePass();
  beginSidebarChatRowPass();
  beginSidebarArchiveGroupPass();
  registerChat('arch-1', 'Archived one');
  registerArchive(wsKey, false, [{ id: 'arch-1', title: 'Archived one', agentTransport: 'sdk' }]);
  registerWorkspace(wsKey, { sidebarKey: wsKey, workspaceFile: wsKey }, [
    { kind: 'archive', key: `archive:${wsKey}`, sidebarKey: wsKey },
  ]);
  endSidebarArchiveGroupPass();
  endSidebarChatRowPass();
  endSidebarWorkspacePass();
  const host = createSidebarWorkspaceHostElement(wsKey);
  document.body.appendChild(host);
  await waitForLitPaint();
  const closedCount = host.querySelectorAll('.sidebar-archive-list li.sidebar-chat-item').length;
  beginSidebarArchiveGroupPass();
  registerArchive(wsKey, true, [{ id: 'arch-1', title: 'Archived one', agentTransport: 'sdk' }]);
  endSidebarArchiveGroupPass();
  requestSidebarWorkspaceUpdate(host);
  await waitForLitPaint();
  const openCount = host.querySelectorAll('.sidebar-archive-list li.sidebar-chat-item').length;
  const archiveHost = host.querySelector('cr-sidebar-archive-group');
  return {
    closedCount,
    openCount,
    archiveHostPresent: archiveHost instanceof HTMLElement,
  };
};

window.__runSidebarWorkspaceSubchatHarness = async () => {
  document.body.innerHTML = '';
  const wsKey = '/ws/sub';
  const parentId = 'parent-sub';
  const groupPayload = (langLabel) => ({
    sidebarKey: wsKey,
    parentTitle: 'Parent',
    continuationLevels: [],
    group: {
      parentId,
      childIds: ['c-sub-1'],
      expanded: false,
      summary: { total: 1, completed: 1, failed: 0, interrupted: 0, idle: 0 },
    },
    deps: {
      t: (key) => (key === 'sidebar.settledSubchats' ? langLabel : key),
      escapeHtml: (v) => String(v ?? ''),
      lang: langLabel.endsWith('pl') ? 'pl' : 'en',
      canArchive: true,
      canPin: false,
    },
  });
  beginSidebarSubchatGroupPass();
  registerSidebarSubchatGroup(parentId, groupPayload('Settled (pl)'));
  endSidebarSubchatGroupPass();
  const host = document.createElement('cr-sidebar-subchat-group');
  host.setAttribute('parent-id', parentId);
  document.body.appendChild(host);
  await waitForLitPaint();
  const toggleBefore = host.querySelector('.sidebar-subchat-group-toggle');
  beginSidebarSubchatGroupPass();
  registerSidebarSubchatGroup(parentId, groupPayload('Settled (en)'));
  endSidebarSubchatGroupPass();
  if (typeof host.requestUpdate === 'function') host.requestUpdate();
  await waitForLitPaint();
  const titleEl = host.querySelector('.sidebar-subchat-group-title');
  const toggleAfter = host.querySelector('.sidebar-subchat-group-toggle');
  return {
    hostSame: host.isConnected,
    titleText: titleEl?.textContent || '',
    toggleTag: toggleAfter?.tagName || '',
    toggleExpanded: toggleAfter?.getAttribute('aria-expanded') || '',
    toggleSameNode: toggleBefore === toggleAfter,
  };
};

window.__runSidebarWorkspaceStatusDuringUpdateHarness = async () => {
  document.body.innerHTML = '';
  const wsKey = '/ws/status';
  const chatId = 'row-status';
  const host = await mountWorkspaceHost(wsKey, [
    { kind: 'chat', key: chatId, chatId },
  ]);
  const wsHostBefore = host;
  const rowHostBefore = host.querySelector('cr-sidebar-chat-row[chat-id="row-status"]');
  const liBefore = host.querySelector(`li.sidebar-chat-item[data-chat-id="${CSS.escape(chatId)}"]`);
  const visualKeyBefore = liBefore?.getAttribute('data-visual-key') || '';
  beginSidebarWorkspacePass();
  beginSidebarChatRowPass();
  registerChat(chatId, 'Title during update');
  registerWorkspace(wsKey, { sidebarKey: wsKey, workspaceFile: wsKey, name: 'Remote name' }, [
    { kind: 'chat', key: chatId, chatId },
  ]);
  endSidebarChatRowPass();
  endSidebarWorkspacePass();
  dispatchSidebarChatRowStatusPatch({
    dirty: new Set([chatId]),
    all: false,
    chatById: new Map([[chatId, { id: chatId, title: 'Title during update' }]]),
    getSidebarChatStateMeta: () => ({ tone: 'active', label: 'Working', activityKey: 'run-x' }),
  });
  await waitForLitPaint();
  const liAfter = host.querySelector(`li.sidebar-chat-item[data-chat-id="${CSS.escape(chatId)}"]`);
  const rowHostAfter = host.querySelector('cr-sidebar-chat-row[chat-id="row-status"]');
  const chip = liAfter?.querySelector('.sidebar-chat-item-awaiting');
  const visualKeyAfter = liAfter?.getAttribute('data-visual-key') || '';
  return {
    wsHostSame: wsHostBefore === host,
    rowHostSame: rowHostBefore === rowHostAfter,
    liSame: liBefore === liAfter,
    visualKeyChanged: visualKeyBefore !== visualKeyAfter && visualKeyAfter.length > 0,
    tone: chip?.getAttribute('data-status-tone') || '',
    label: chip?.getAttribute('data-status-label') || '',
    workspaceTitle: host.querySelector('.sidebar-workspace-title')?.textContent || '',
  };
};

window.__runSidebarWorkspaceFocusAfterUpdateHarness = async () => {
  document.body.innerHTML = '';
  const wsKey = '/ws/focus';
  const chatId = 'focus-chat';
  const deps = {
    ...sidebarDeps(),
    canPinChatToUrl: () => true,
    renderChatActionButtonsHtml: (chat) => (
      '<button type="button" class="sidebar-chat-action sidebar-chat-fav-btn mdi mdi-star-outline" aria-pressed="false"></button>'
      + '<button type="button" class="sidebar-chat-action sidebar-chat-pin-btn mdi mdi-pin-outline"></button>'
    ),
  };
  beginSidebarWorkspacePass();
  beginSidebarChatRowPass();
  registerSidebarChatRow(chatId, {
    chat: { id: chatId, title: 'Focus row', agentTransport: 'sdk' },
    activeChatId: '',
    opts: { level: 0, parentId: '' },
    deps,
  });
  registerWorkspace(wsKey, { sidebarKey: wsKey, workspaceFile: wsKey }, [
    { kind: 'chat', key: chatId, chatId },
    { kind: 'more', key: 'more', sidebarKey: wsKey, hiddenCount: 3 },
  ]);
  endSidebarChatRowPass();
  endSidebarWorkspacePass();
  const host = createSidebarWorkspaceHostElement(wsKey);
  document.body.appendChild(host);
  await waitForLitPaint();
  const favBtn = host.querySelector('.sidebar-chat-fav-btn');
  if (!(favBtn instanceof HTMLElement)) {
    return { ok: false, reason: 'missing-fav' };
  }
  favBtn.focus();
  const liBefore = host.querySelector(`li.sidebar-chat-item[data-chat-id="${CSS.escape(chatId)}"]`);
  beginSidebarChatRowPass();
  registerSidebarChatRow(chatId, {
    chat: { id: chatId, title: 'Focus row renamed', agentTransport: 'sdk' },
    activeChatId: '',
    opts: { level: 0, parentId: '' },
    deps,
  });
  endSidebarChatRowPass();
  requestSidebarWorkspaceUpdate(host);
  await waitForSidebarLitHostsCommit(host);
  const liAfter = host.querySelector(`li.sidebar-chat-item[data-chat-id="${CSS.escape(chatId)}"]`);
  const favAfter = liAfter?.querySelector('.sidebar-chat-fav-btn');
  return {
    ok: true,
    favPresentAfterUpdate: favAfter instanceof HTMLElement,
    liReplaced: liBefore !== liAfter,
  };
};

window.__runSidebarWorkspaceListenerHarness = async () => {
  document.body.innerHTML = '';
  const baseline = __getSidebarChatRowStatusPatchListenerCountForTest();
  const wsKey = '/ws/listeners';
  const host = await mountWorkspaceHost(wsKey, [
    { kind: 'chat', key: 'l1', chatId: 'l1' },
  ]);
  const afterMount = __getSidebarChatRowStatusPatchListenerCountForTest();
  for (let i = 0; i < 3; i += 1) {
    requestSidebarWorkspaceUpdate(host);
    await waitForSidebarLitHostsCommit(host);
  }
  const afterUpdates = __getSidebarChatRowStatusPatchListenerCountForTest();
  host.remove();
  await waitForLitPaint();
  const afterUnmount = __getSidebarChatRowStatusPatchListenerCountForTest();
  return {
    baseline,
    afterMount,
    afterUpdates,
    afterUnmount,
    addedOnMount: afterMount - baseline,
    stableAcrossUpdates: afterUpdates === afterMount,
    backToBaseline: afterUnmount === baseline,
  };
};

window.__runSidebarWorkspaceDragHarness = async () => {
  document.body.innerHTML = '';
  const ul = document.createElement('ul');
  ul.className = 'sidebar-workspaces';
  document.body.appendChild(ul);
  const keys = ['/ws/a', '/ws/b', '/ws/c'];
  for (const key of keys) {
    beginSidebarWorkspacePass();
    registerWorkspace(key, { sidebarKey: key, workspaceFile: key, name: key }, [
      { kind: 'empty', key: `empty:${key}`, sidebarKey: key },
    ]);
    endSidebarWorkspacePass();
    const host = createSidebarWorkspaceHostElement(key);
    if (host) ul.appendChild(host);
  }
  await waitForLitPaint();
  const hosts = collectWorkspaceHostsFromList(ul);
  const hostB = hosts[1];
  const hostA = hosts[0];
  if (!(hostB instanceof HTMLElement) || !(hostA instanceof HTMLElement)) {
    return { ok: false, reason: 'missing-hosts' };
  }
  ul.insertBefore(hostB, hostA);
  const order = collectWorkspaceHostsFromList(ul).map(
    (node) => node.getAttribute('sidebar-key') || '',
  );
  const allDirectHosts = [...ul.children].every(
    (node) => node instanceof HTMLElement && node.localName === 'cr-sidebar-workspace',
  );
  return { ok: true, order, allDirectHosts };
};

/**
 * @param {number} count
 * @returns {object[]}
 */
function syntheticArchiveChats(count) {
  const total = Math.max(0, Math.round(Number(count) || 0));
  return Array.from({ length: total }, (_, index) => ({
    id: `arch-${index}`,
    title: `Archived ${index}`,
    agentTransport: 'sdk',
  }));
}

/**
 * @param {number} count
 * @param {number} [scrollTopPx]
 */
window.__runSidebarArchiveVirtualHarness = async (count, scrollTopPx = 0) => {
  document.body.innerHTML = '';
  const wsKey = '/ws/archive-virtual';
  const chats = syntheticArchiveChats(count);
  const archiveTree = chats.map((chat) => ({
    chat,
    level: 0,
    isLastChild: true,
    parentId: '',
    continuationLevels: [],
  }));
  const shell = document.createElement('div');
  shell.innerHTML =
    '<aside class="app-sidebar"><div class="sidebar-body" style="height:400px;overflow-y:auto;"></div></aside>';
  const body = shell.querySelector('.sidebar-body');
  document.body.appendChild(shell);
  beginSidebarArchiveGroupPass();
  beginSidebarChatRowPass();
  for (const chat of chats.slice(0, 30)) {
    registerChat(chat.id, chat.title);
  }
  registerArchive(wsKey, true, chats);
  endSidebarArchiveGroupPass();
  endSidebarChatRowPass();
  const group = document.createElement('cr-sidebar-archive-group');
  group.setAttribute('sidebar-key', wsKey);
  const workspaceList = document.createElement('ul');
  workspaceList.className = 'sidebar-chat-list';
  workspaceList.appendChild(group);
  body.appendChild(workspaceList);
  await waitForLitPaint();
  if (scrollTopPx > 0 && body instanceof HTMLElement) {
    body.scrollTop = scrollTopPx;
    body.dispatchEvent(new Event('scroll'));
    await waitForLitPaint();
  }
  const mountedRows = group.querySelectorAll('cr-sidebar-chat-row').length;
  const chatItems = group.querySelectorAll('li.sidebar-chat-item').length;
  const topSpacer = group.querySelector('.sidebar-archive-virtual-spacer');
  const ids = [...group.querySelectorAll('cr-sidebar-chat-row')].map(
    (node) => node.getAttribute('chat-id') || '',
  );
  const uniqueIds = new Set(ids);
  return {
    mountedRows,
    chatItems,
    hasTopSpacer: topSpacer instanceof HTMLElement,
    uniqueKeys: uniqueIds.size === ids.length,
    firstId: ids[0] || '',
    scrollTop: body instanceof HTMLElement ? body.scrollTop : 0,
  };
};

/**
 * Scroll archive list in steps; returns scroll positions and mounted budget checks.
 *
 * @param {number} count
 * @param {number[]} scrollDeltasPx
 */
window.__runSidebarArchiveScrollSeriesHarness = async (count, scrollDeltasPx) => {
  document.body.innerHTML = '';
  const wsKey = '/ws/archive-scroll-series';
  const chats = syntheticArchiveChats(count);
  const shell = document.createElement('div');
  shell.innerHTML =
    '<aside class="app-sidebar"><div class="sidebar-body" style="height:400px;overflow-y:auto;"></div></aside>';
  const body = shell.querySelector('.sidebar-body');
  document.body.appendChild(shell);
  beginSidebarArchiveGroupPass();
  beginSidebarChatRowPass();
  registerArchive(wsKey, true, chats);
  endSidebarArchiveGroupPass();
  endSidebarChatRowPass();
  const group = document.createElement('cr-sidebar-archive-group');
  group.setAttribute('sidebar-key', wsKey);
  const workspaceList = document.createElement('ul');
  workspaceList.className = 'sidebar-chat-list';
  workspaceList.appendChild(group);
  body.appendChild(workspaceList);
  await waitForLitPaint();
  const steps = [];
  let expectedScroll = 0;
  const deltas = Array.isArray(scrollDeltasPx) ? scrollDeltasPx : [];
  for (const delta of deltas) {
    expectedScroll += Number(delta) || 0;
    if (body instanceof HTMLElement) {
      body.scrollTop = Math.max(0, body.scrollTop + (Number(delta) || 0));
      body.dispatchEvent(new Event('scroll'));
    }
    await waitForLitPaint();
    const mountedRows = group.querySelectorAll('cr-sidebar-chat-row').length;
    const scrollTop = body instanceof HTMLElement ? body.scrollTop : 0;
    const jumpFromExpected = Math.abs(scrollTop - expectedScroll);
    steps.push({ scrollTop, expectedScroll, mountedRows, jumpFromExpected });
  }
  const maxJump = steps.reduce((max, step) => Math.max(max, step.jumpFromExpected), 0);
  const maxMounted = steps.reduce((max, step) => Math.max(max, step.mountedRows), 0);
  return { steps, maxJump, maxMounted };
};

/**
 * @param {number} count
 * @param {number} activeIndex
 */
window.__runSidebarArchiveActiveAnchorHarness = async (count, activeIndex) => {
  document.body.innerHTML = '';
  const wsKey = '/ws/archive-active-anchor';
  const chats = syntheticArchiveChats(count);
  const activeId = `arch-${activeIndex}`;
  const shell = document.createElement('div');
  shell.innerHTML =
    '<aside class="app-sidebar"><div class="sidebar-body" style="height:400px;overflow-y:auto;"></div></aside>';
  const body = shell.querySelector('.sidebar-body');
  document.body.appendChild(shell);
  beginSidebarArchiveGroupPass();
  beginSidebarChatRowPass();
  registerChat(activeId, `Archived ${activeIndex}`);
  registerArchive(wsKey, true, chats, activeId);
  endSidebarArchiveGroupPass();
  endSidebarChatRowPass();
  const group = document.createElement('cr-sidebar-archive-group');
  group.setAttribute('sidebar-key', wsKey);
  const workspaceList = document.createElement('ul');
  workspaceList.className = 'sidebar-chat-list';
  workspaceList.appendChild(group);
  body.appendChild(workspaceList);
  await waitForLitPaint();
  const scrollTop = body instanceof HTMLElement ? body.scrollTop : 0;
  const ids = [...group.querySelectorAll('cr-sidebar-chat-row')].map(
    (node) => node.getAttribute('chat-id') || '',
  );
  return {
    scrollTop,
    activeVisible: ids.includes(activeId),
    mountedRows: ids.length,
  };
};

/**
 * @param {number} count
 */
window.__runSidebarArchiveResizeHarness = async (count) => {
  document.body.innerHTML = '';
  const wsKey = '/ws/archive-resize';
  const chats = syntheticArchiveChats(count);
  const shell = document.createElement('div');
  shell.innerHTML =
    '<aside class="app-sidebar"><div class="sidebar-body" style="height:400px;overflow-y:auto;"></div></aside>';
  const body = shell.querySelector('.sidebar-body');
  document.body.appendChild(shell);
  beginSidebarArchiveGroupPass();
  beginSidebarChatRowPass();
  registerArchive(wsKey, true, chats);
  endSidebarArchiveGroupPass();
  endSidebarChatRowPass();
  const group = document.createElement('cr-sidebar-archive-group');
  group.setAttribute('sidebar-key', wsKey);
  const workspaceList = document.createElement('ul');
  workspaceList.className = 'sidebar-chat-list';
  workspaceList.appendChild(group);
  body.appendChild(workspaceList);
  await waitForLitPaint();
  if (body instanceof HTMLElement) {
    body.scrollTop = 4000;
    body.dispatchEvent(new Event('scroll'));
  }
  await waitForLitPaint();
  const beforeResize = group.querySelectorAll('cr-sidebar-chat-row').length;
  if (body instanceof HTMLElement) {
    body.style.height = '200px';
  }
  await waitForLitPaint();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const afterResize = group.querySelectorAll('cr-sidebar-chat-row').length;
  return { beforeResize, afterResize };
};

/**
 * Keyboard End from first row should reveal last archive option with correct aria.
 *
 * @param {number} count
 */
window.__runSidebarArchiveKeyboardEndHarness = async (count) => {
  document.body.innerHTML = '';
  const wsKey = '/ws/archive-keyboard-end';
  const chats = syntheticArchiveChats(count);
  const shell = document.createElement('div');
  shell.innerHTML =
    '<aside class="app-sidebar"><div class="sidebar-body" style="height:400px;overflow-y:auto;"></div></aside>';
  const body = shell.querySelector('.sidebar-body');
  document.body.appendChild(shell);
  beginSidebarArchiveGroupPass();
  beginSidebarChatRowPass();
  registerArchive(wsKey, true, chats);
  endSidebarArchiveGroupPass();
  endSidebarChatRowPass();
  const group = document.createElement('cr-sidebar-archive-group');
  group.setAttribute('sidebar-key', wsKey);
  body.appendChild(group);
  await waitForLitPaint();
  const lastIndex = count - 1;
  const lastId = `arch-${lastIndex}`;
  const revealed = await group.revealLogicalIndex(lastIndex, { focus: true });
  let mountedIds = [];
  for (let attempt = 0; attempt < 24; attempt += 1) {
    await waitForLitPaint();
    mountedIds = [...group.querySelectorAll('cr-sidebar-chat-row')].map(
      (node) => node.getAttribute('chat-id') || '',
    );
    if (mountedIds.includes(lastId)) break;
  }
  const mountedRows = mountedIds.length;
  const lastRow = group.querySelector(`li.sidebar-chat-item[data-chat-id="${lastId}"]`);
  const posinset = lastRow?.getAttribute('aria-posinset') || '';
  const setsize = lastRow?.getAttribute('aria-setsize') || '';
  const focusedId = document.activeElement?.getAttribute?.('data-chat-id') || '';
  return {
    revealed,
    mountedRows,
    posinset,
    setsize,
    focusedId,
    lastVisible: lastRow instanceof HTMLElement,
    includesLastId: mountedIds.includes(lastId),
  };
};

/**
 * Scroll away from focused row; listbox should keep logical focus target.
 *
 * @param {number} count
 */
window.__runSidebarArchiveFocusUnmountHarness = async (count) => {
  document.body.innerHTML = '';
  const wsKey = '/ws/archive-focus-unmount';
  const chats = syntheticArchiveChats(count);
  const shell = document.createElement('div');
  shell.innerHTML =
    '<aside class="app-sidebar"><div class="sidebar-body" style="height:400px;overflow-y:auto;"></div></aside>';
  const body = shell.querySelector('.sidebar-body');
  document.body.appendChild(shell);
  beginSidebarArchiveGroupPass();
  beginSidebarChatRowPass();
  registerArchive(wsKey, true, chats);
  endSidebarArchiveGroupPass();
  endSidebarChatRowPass();
  const group = document.createElement('cr-sidebar-archive-group');
  group.setAttribute('sidebar-key', wsKey);
  body.appendChild(group);
  await waitForLitPaint();
  await group.revealLogicalIndex(5, { focus: true });
  await waitForLitPaint();
  await new Promise((resolve) => setTimeout(resolve, 120));
  if (body instanceof HTMLElement) {
    body.scrollTop = 2000;
    body.dispatchEvent(new Event('scroll'));
  }
  await waitForLitPaint();
  const list = group.querySelector('.sidebar-archive-list');
  const mountedRows = group.querySelectorAll('cr-sidebar-chat-row').length;
  return {
    mountedRows,
    listHasTabindex: list?.getAttribute('tabindex') === '0',
    activeTag: document.activeElement?.tagName?.toLowerCase() || '',
    activeClass: document.activeElement?.className || '',
  };
};

/**
 * Production archive focus tracking + keyboard delegation on `.sidebar-body`.
 *
 * @param {Element} body
 */
function wireSidebarBodyArchiveHarness(body) {
  wireArchiveVirtualFocusTracking(body);
  body.addEventListener('keydown', (ev) => {
    if (ev.target instanceof Element && ev.target.closest('button, .sidebar-chat-action')) return;
    handleSidebarArchiveKeydown(ev, body);
  });
  registerSidebarArchiveGestureEndFlush(() => {
    body.querySelectorAll('cr-sidebar-archive-group').forEach((host) => {
      host.flushVirtualWindowAfterGesture?.();
    });
  });
}

/**
 * @param {Element} body
 * @param {boolean} active
 */
function setHarnessSidebarGestureActive(body, active) {
  registerSidebarArchiveGestureGuard(() => active);
  tickSidebarArchiveGestureFocusSnapshot(active);
}

window.__runSidebarArchiveAria1500Harness = async () => {
  document.body.innerHTML = '';
  const wsKey = '/ws/archive-aria-1500';
  const chats = syntheticArchiveChats(1500);
  const shell = document.createElement('div');
  shell.innerHTML =
    '<aside class="app-sidebar"><div class="sidebar-body" style="height:400px;overflow-y:auto;"></div></aside>';
  const body = shell.querySelector('.sidebar-body');
  document.body.appendChild(shell);
  beginSidebarArchiveGroupPass();
  beginSidebarChatRowPass();
  registerArchive(wsKey, true, chats);
  endSidebarArchiveGroupPass();
  endSidebarChatRowPass();
  const group = document.createElement('cr-sidebar-archive-group');
  group.setAttribute('sidebar-key', wsKey);
  body.appendChild(group);
  await waitForLitPaint();
  if (body instanceof HTMLElement) {
    body.scrollTop = 12000;
    body.dispatchEvent(new Event('scroll'));
  }
  await waitForLitPaint();
  await new Promise((resolve) => setTimeout(resolve, 80));
  const sample = group.querySelector('li.sidebar-chat-item[data-chat-id]');
  const setsize = sample?.getAttribute('aria-setsize') || '';
  const posinset = sample?.getAttribute('aria-posinset') || '';
  const logical = sample?.getAttribute('data-archive-logical-index') || '';
  const expectedPos = logical !== '' ? String(Number(logical) + 1) : '';
  return {
    setsize,
    posinset,
    expectedPos,
    mountedRows: group.querySelectorAll('cr-sidebar-chat-row').length,
    matches: setsize === '1500' && posinset === expectedPos && expectedPos !== '',
  };
};

window.__runSidebarArchiveKeyboardArrowHarness = async () => {
  document.body.innerHTML = '';
  const wsKey = '/ws/archive-keyboard-arrow';
  const count = 180;
  const chats = syntheticArchiveChats(count);
  const shell = document.createElement('div');
  shell.innerHTML =
    '<aside class="app-sidebar"><div class="sidebar-body" style="height:400px;overflow-y:auto;" tabindex="-1"></div></aside>';
  const body = shell.querySelector('.sidebar-body');
  document.body.appendChild(shell);
  wireSidebarBodyArchiveHarness(body);
  beginSidebarArchiveGroupPass();
  beginSidebarChatRowPass();
  registerArchive(wsKey, true, chats);
  endSidebarArchiveGroupPass();
  endSidebarChatRowPass();
  const group = document.createElement('cr-sidebar-archive-group');
  group.setAttribute('sidebar-key', wsKey);
  body.appendChild(group);
  await waitForLitPaint();
  const firstRow = group.querySelector('li.sidebar-chat-item');
  if (!(firstRow instanceof HTMLElement)) return { ok: false, reason: 'no-first-row' };
  firstRow.focus();
  const targetIndex = 95;
  for (let step = 0; step < targetIndex; step += 1) {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) break;
    active.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    await waitForLitPaint();
  }
  await new Promise((resolve) => setTimeout(resolve, 120));
  const focusedId = document.activeElement?.getAttribute?.('data-chat-id') || '';
  const mountedRows = group.querySelectorAll('cr-sidebar-chat-row').length;
  return {
    ok: true,
    focusedId,
    expectedId: `arch-${targetIndex}`,
    mountedRows,
  };
};

window.__runSidebarArchiveSecondWorkspaceFocusHarness = async () => {
  document.body.innerHTML = '';
  const wsFirst = '/ws/first';
  const wsSecond = '/ws/second';
  const targetId = 'arch-second-only';
  const shell = document.createElement('div');
  shell.innerHTML =
    '<aside class="app-sidebar"><div class="sidebar-body" style="height:400px;overflow-y:auto;"></div></aside>';
  const body = shell.querySelector('.sidebar-body');
  document.body.appendChild(shell);
  wireSidebarBodyArchiveHarness(body);
  beginSidebarArchiveGroupPass();
  beginSidebarChatRowPass();
  registerArchive(wsFirst, true, syntheticArchiveChats(40));
  registerArchive(wsSecond, true, [{ id: targetId, title: 'Second ws', agentTransport: 'sdk' }]);
  endSidebarArchiveGroupPass();
  endSidebarChatRowPass();
  const groupFirst = document.createElement('cr-sidebar-archive-group');
  groupFirst.setAttribute('sidebar-key', wsFirst);
  const groupSecond = document.createElement('cr-sidebar-archive-group');
  groupSecond.setAttribute('sidebar-key', wsSecond);
  body.appendChild(groupFirst);
  body.appendChild(groupSecond);
  await waitForLitPaint();
  await groupSecond.revealLogicalIndex(0, { focus: true });
  await waitForLitPaint();
  const located = findArchiveGroupForChatId(body, targetId);
  const focusBefore = captureSidebarFocusInfo(body);
  beginSidebarArchiveGroupPass();
  registerArchive(wsFirst, true, syntheticArchiveChats(40));
  registerArchive(wsSecond, true, [{ id: targetId, title: 'Second ws renamed', agentTransport: 'sdk' }]);
  endSidebarArchiveGroupPass();
  groupFirst.requestUpdate?.();
  groupSecond.requestUpdate?.();
  await waitForLitPaint();
  restoreSidebarFocus(body, focusBefore);
  await waitForLitPaint();
  await new Promise((resolve) => setTimeout(resolve, 120));
  const row = body.querySelector('li.sidebar-chat-item[data-chat-id="' + targetId + '"]');
  return {
    sidebarKey: located?.sidebarKey || '',
    expectedKey: wsSecond,
    focusedAfter: document.activeElement?.getAttribute?.('data-chat-id') || '',
    rowFound: row instanceof HTMLElement,
  };
};

window.__runSidebarArchiveReorderFocusHarness = async () => {
  document.body.innerHTML = '';
  const wsKey = '/ws/archive-reorder';
  const chats = [
    { id: 'fav-a', title: 'A', agentTransport: 'sdk', favorite: true },
    { id: 'fav-b', title: 'B', agentTransport: 'sdk', favorite: true },
    { id: 'fav-c', title: 'C', agentTransport: 'sdk', favorite: true },
  ];
  const reordered = [
    { id: 'fav-c', title: 'C', agentTransport: 'sdk', favorite: true },
    { id: 'fav-a', title: 'A', agentTransport: 'sdk', favorite: true },
    { id: 'fav-b', title: 'B', agentTransport: 'sdk', favorite: true },
  ];
  const shell = document.createElement('div');
  shell.innerHTML =
    '<aside class="app-sidebar"><div class="sidebar-body" style="height:400px;overflow-y:auto;"></div></aside>';
  const body = shell.querySelector('.sidebar-body');
  document.body.appendChild(shell);
  wireSidebarBodyArchiveHarness(body);
  beginSidebarArchiveGroupPass();
  beginSidebarChatRowPass();
  registerArchive(wsKey, true, chats);
  endSidebarArchiveGroupPass();
  endSidebarChatRowPass();
  const group = document.createElement('cr-sidebar-archive-group');
  group.setAttribute('sidebar-key', wsKey);
  body.appendChild(group);
  await waitForLitPaint();
  setSidebarArchiveVirtualFocus(wsKey, { chatId: 'fav-b', logicalIndex: 1 });
  const list = group.querySelector('.sidebar-archive-list');
  if (list instanceof HTMLElement) {
    list.setAttribute('tabindex', '0');
    list.focus();
  }
  beginSidebarArchiveGroupPass();
  registerArchive(wsKey, true, reordered);
  endSidebarArchiveGroupPass();
  group.requestUpdate?.();
  await waitForLitPaint();
  if (list instanceof HTMLElement) {
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
  }
  await waitForLitPaint();
  await new Promise((resolve) => setTimeout(resolve, 80));
  const focusedId = document.activeElement?.getAttribute?.('data-chat-id') || '';
  return {
    focusedId,
    expectedId: 'fav-a',
    staleWouldBe: 'fav-c',
  };
};

window.__runSidebarArchiveGestureFocusHarness = async () => {
  document.body.innerHTML = '';
  const wsKey = '/ws/archive-gesture';
  const chats = syntheticArchiveChats(300);
  const shell = document.createElement('div');
  shell.innerHTML =
    '<aside class="app-sidebar"><div class="sidebar-body" style="height:400px;overflow-y:auto;"></div></aside>';
  const body = shell.querySelector('.sidebar-body');
  document.body.appendChild(shell);
  wireSidebarBodyArchiveHarness(body);
  beginSidebarArchiveGroupPass();
  beginSidebarChatRowPass();
  registerArchive(wsKey, true, chats);
  endSidebarArchiveGroupPass();
  endSidebarChatRowPass();
  const group = document.createElement('cr-sidebar-archive-group');
  group.setAttribute('sidebar-key', wsKey);
  body.appendChild(group);
  await waitForLitPaint();
  const focusIndex = 12;
  await group.revealLogicalIndex(focusIndex, { focus: true });
  await waitForLitPaint();
  const focusId = `arch-${focusIndex}`;
  setHarnessSidebarGestureActive(body, true);
  const mountedBeforeScroll = group.querySelectorAll('cr-sidebar-chat-row').length;
  if (body instanceof HTMLElement) {
    body.scrollTop = 5000;
    body.dispatchEvent(new Event('scroll'));
  }
  beginSidebarArchiveGroupPass();
  registerArchive(wsKey, true, syntheticArchiveChats(280));
  endSidebarArchiveGroupPass();
  group.requestUpdate?.();
  await waitForLitPaint();
  const mountedDuringGesture = group.querySelectorAll('cr-sidebar-chat-row').length;
  const storedDuring = getSidebarArchiveVirtualFocus(wsKey);
  setHarnessSidebarGestureActive(body, false);
  runSidebarArchiveGestureEndFlush();
  await waitForLitPaint();
  await new Promise((resolve) => setTimeout(resolve, 120));
  const focusedAfter = document.activeElement?.getAttribute?.('data-chat-id') || '';
  const keyTarget = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : group.querySelector('li.sidebar-chat-item');
  keyTarget?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  await waitForLitPaint();
  await new Promise((resolve) => setTimeout(resolve, 120));
  const focusedAfterArrow = document.activeElement?.getAttribute?.('data-chat-id') || '';
  return {
    focusId,
    focusedAfter,
    focusedAfterArrow,
    storedChatDuring: storedDuring?.chatId || '',
    mountedBeforeScroll,
    mountedDuringGesture,
    windowUnchangedDuringGesture: mountedDuringGesture === mountedBeforeScroll,
    keyboardContinues: focusedAfterArrow === `arch-${focusIndex + 1}`,
  };
};

window.__runSidebarArchiveGestureNoStealHarness = async () => {
  document.body.innerHTML = '';
  const wsKey = '/ws/archive-gesture-no-steal';
  const chats = syntheticArchiveChats(200);
  const shell = document.createElement('div');
  shell.innerHTML =
    '<aside class="app-sidebar"><div class="sidebar-body" style="height:400px;overflow-y:auto;"></div></aside>';
  const body = shell.querySelector('.sidebar-body');
  document.body.appendChild(shell);
  wireSidebarBodyArchiveHarness(body);
  beginSidebarArchiveGroupPass();
  beginSidebarChatRowPass();
  registerArchive(wsKey, true, chats);
  endSidebarArchiveGroupPass();
  endSidebarChatRowPass();
  const group = document.createElement('cr-sidebar-archive-group');
  group.setAttribute('sidebar-key', wsKey);
  body.appendChild(group);
  await waitForLitPaint();
  await group.revealLogicalIndex(40, { focus: true });
  await waitForLitPaint();
  const composer = document.createElement('textarea');
  composer.id = 'harness-composer';
  document.body.appendChild(composer);
  composer.focus();
  await waitForLitPaint();
  const storedAfterBlur = getSidebarArchiveVirtualFocus(wsKey);
  setHarnessSidebarGestureActive(body, true);
  if (body instanceof HTMLElement) {
    body.scrollTop = 3000;
    body.dispatchEvent(new Event('scroll'));
  }
  await waitForLitPaint();
  setHarnessSidebarGestureActive(body, false);
  runSidebarArchiveGestureEndFlush();
  await waitForLitPaint();
  return {
    composerFocused: document.activeElement === composer,
    storedCleared: !storedAfterBlur?.chatId,
    noArchiveFocusAfterFlush: !document.activeElement?.closest?.('.sidebar-archive-group'),
  };
};

window.__runSidebarArchiveToggleFocusHarness = async () => {
  document.body.innerHTML = '';
  const wsKey = '/ws/archive-toggle';
  const chats = syntheticArchiveChats(80);
  const shell = document.createElement('div');
  shell.innerHTML =
    '<aside class="app-sidebar"><div class="sidebar-body" style="height:400px;overflow-y:auto;"></div></aside>';
  const body = shell.querySelector('.sidebar-body');
  document.body.appendChild(shell);
  wireSidebarBodyArchiveHarness(body);
  beginSidebarArchiveGroupPass();
  beginSidebarChatRowPass();
  registerArchive(wsKey, true, chats);
  endSidebarArchiveGroupPass();
  endSidebarChatRowPass();
  const group = document.createElement('cr-sidebar-archive-group');
  group.setAttribute('sidebar-key', wsKey);
  body.appendChild(group);
  await waitForLitPaint();
  const firstRow = group.querySelector('li.sidebar-chat-item');
  if (!(firstRow instanceof HTMLElement)) return { ok: false };
  firstRow.focus();
  await waitForLitPaint();
  const outside = document.createElement('button');
  outside.type = 'button';
  outside.textContent = 'Outside';
  document.body.appendChild(outside);
  outside.focus();
  await waitForLitPaint();
  const storedWhenClosed = getSidebarArchiveVirtualFocus(wsKey);
  beginSidebarArchiveGroupPass();
  registerArchive(wsKey, false, chats);
  endSidebarArchiveGroupPass();
  group.requestUpdate?.();
  await waitForLitPaint();
  beginSidebarArchiveGroupPass();
  registerArchive(wsKey, true, chats);
  endSidebarArchiveGroupPass();
  group.requestUpdate?.();
  await waitForLitPaint();
  const firstRowAgain = group.querySelector('li.sidebar-chat-item');
  if (!(firstRowAgain instanceof HTMLElement)) return { ok: false };
  firstRowAgain.focus();
  await waitForLitPaint();
  firstRowAgain.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
  const list = group.querySelector('.sidebar-archive-list');
  await waitForLitPaint();
  await new Promise((resolve) => setTimeout(resolve, 120));
  const lastId = 'arch-79';
  return {
    ok: true,
    clearedOnClose: !storedWhenClosed?.chatId,
    endFocusedId: document.activeElement?.getAttribute?.('data-chat-id') || '',
    expectedLast: lastId,
    listRole: list?.getAttribute('role') || '',
  };
};

window.__runSidebarArchiveOffWindowClickHarness = async () => {
  document.body.innerHTML = '';
  const wsKey = '/ws/archive-click-off';
  const chats = syntheticArchiveChats(400);
  const targetIndex = 250;
  const targetId = `arch-${targetIndex}`;
  const shell = document.createElement('div');
  shell.innerHTML =
    '<aside class="app-sidebar"><div class="sidebar-body" style="height:400px;overflow-y:auto;"></div></aside>';
  const body = shell.querySelector('.sidebar-body');
  document.body.appendChild(shell);
  wireSidebarBodyArchiveHarness(body);
  beginSidebarArchiveGroupPass();
  beginSidebarChatRowPass();
  registerChat(targetId, targetId);
  registerArchive(wsKey, true, chats);
  endSidebarArchiveGroupPass();
  endSidebarChatRowPass();
  const group = document.createElement('cr-sidebar-archive-group');
  group.setAttribute('sidebar-key', wsKey);
  body.appendChild(group);
  await waitForLitPaint();
  const mountedBefore = group.querySelectorAll('cr-sidebar-chat-row').length;
  const mountedRow = await ensureArchivedChatRowMounted(body, targetId);
  await waitForLitPaint();
  return {
    ok: mountedRow instanceof HTMLElement,
    mountedBefore,
    mountedAfter: group.querySelectorAll('cr-sidebar-chat-row').length,
    includesTarget: [...group.querySelectorAll('cr-sidebar-chat-row')].some(
      (node) => node.getAttribute('chat-id') === targetId,
    ),
  };
};

window.__runSidebarArchiveOpenPerfHarness = async (count = 2000) => {
  document.body.innerHTML = '';
  const wsKey = '/ws/archive-open-perf';
  const chats = syntheticArchiveChats(count);
  const counters = createUiFreezeCounters({ active: () => true });
  const shell = document.createElement('div');
  shell.innerHTML =
    '<aside class="app-sidebar"><div class="sidebar-body" style="height:400px;overflow-y:auto;"></div></aside>';
  const body = shell.querySelector('.sidebar-body');
  document.body.appendChild(shell);
  beginSidebarArchiveGroupPass();
  beginSidebarChatRowPass();
  registerArchive(wsKey, false, chats);
  endSidebarArchiveGroupPass();
  endSidebarChatRowPass();
  const group = document.createElement('cr-sidebar-archive-group');
  group.setAttribute('sidebar-key', wsKey);
  body.appendChild(group);
  await waitForLitPaint();
  const t0 = performance.now();
  beginSidebarArchiveGroupPass();
  registerArchive(wsKey, true, chats);
  endSidebarArchiveGroupPass();
  group.requestUpdate?.();
  await waitForLitPaint();
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const openMs = performance.now() - t0;
  counters.recordSpan('sidebar.archive.render', openMs);
  const snap = counters.snapshot();
  const spanMaxMs = Number(snap?.spans?.['sidebar.archive.render']?.maxMs) || openMs;
  return {
    openMs,
    spanMaxMs,
    mountedRows: group.querySelectorAll('cr-sidebar-chat-row').length,
    measured: openMs >= 0,
    longTaskBudgetMs: 50,
    spanWithinBudget: spanMaxMs <= 5000,
  };
};
