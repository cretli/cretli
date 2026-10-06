/**
 * Real DOM harness for `<cr-sidebar-chat-row>` (Lit async first paint + drag block).
 */
import '../../app_front/features/sidebar/cr-sidebar-chat-row.js';
import { buildSidebarChatRowHostHtml } from '../../app_front/features/sidebar/sidebarChatRowModel.js';
import {
  beginSidebarChatRowPass,
  endSidebarChatRowPass,
  registerSidebarChatRow,
} from '../../app_front/features/sidebar/sidebarChatRowPass.js';
import { hydrateSidebarChatRowHosts } from '../../app_front/features/sidebar/sidebarChatRowMount.js';
import {
  collectSidebarChatBlock,
  insertSidebarChatBlockAt,
} from '../../app_front/features/sidebar/sidebarChatDragBlock.js';
import {
  dispatchSidebarChatRowStatusPatch,
  __getSidebarChatRowStatusPatchListenerCountForTest,
} from '../../app_front/features/sidebar/sidebarChatRowRefreshBus.js';
import { createSidebarView } from '../../app_front/features/sidebar/sidebarView.js';

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
  };
}

function registerRow(chatId, activeChatId, opts) {
  registerSidebarChatRow(chatId, {
    chat: { id: chatId, title: chatId, agentTransport: 'sdk' },
    activeChatId,
    opts,
    deps: sidebarDeps(),
  });
}

async function waitForLitPaint() {
  await new Promise((resolve) => queueMicrotask(resolve));
  await new Promise((resolve) => requestAnimationFrame(resolve));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * @param {string[]} chatIds
 */
async function mountFlatRowsAfterPassEnds(chatIds) {
  const ul = document.createElement('ul');
  ul.className = 'sidebar-chat-list';
  document.body.appendChild(ul);
  const deps = sidebarDeps();
  beginSidebarChatRowPass();
  for (const id of chatIds) {
    registerRow(id, '', { level: 0, parentId: '' });
  }
  const html = chatIds.map((id) => buildSidebarChatRowHostHtml(id, deps.escapeHtml)).join('');
  endSidebarChatRowPass();
  ul.innerHTML = html;
  hydrateSidebarChatRowHosts(ul);
  await waitForLitPaint();
  /** @type {Record<string, HTMLLIElement | null>} */
  const liById = {};
  for (const id of chatIds) {
    const li = ul.querySelector(`li.sidebar-chat-item[data-chat-id="${CSS.escape(id)}"]`);
    liById[id] = li instanceof HTMLLIElement ? li : null;
  }
  return { ul, liById };
}

async function mountRowsAfterPassEnds() {
  const ul = document.createElement('ul');
  ul.className = 'sidebar-chat-list';
  document.body.appendChild(ul);
  const deps = sidebarDeps();
  beginSidebarChatRowPass();
  registerRow('parent-row', 'parent-row', { level: 0, parentId: '' });
  registerRow('child-row', '', { level: 1, parentId: 'parent-row', isLastChild: true });
  registerRow('sibling-row', '', { level: 0, parentId: '' });
  const html = [
    buildSidebarChatRowHostHtml('parent-row', deps.escapeHtml),
    buildSidebarChatRowHostHtml('child-row', deps.escapeHtml),
    buildSidebarChatRowHostHtml('sibling-row', deps.escapeHtml),
  ].join('');
  endSidebarChatRowPass();
  ul.innerHTML = html;
  hydrateSidebarChatRowHosts(ul);
  await waitForLitPaint();
  const parentLi = ul.querySelector('li.sidebar-chat-item[data-chat-id="parent-row"]');
  const childLi = ul.querySelector('li.sidebar-chat-item[data-chat-id="child-row"]');
  const siblingLi = ul.querySelector('li.sidebar-chat-item[data-chat-id="sibling-row"]');
  return { ul, parentLi, childLi, siblingLi };
}

function hostChatIds(ul) {
  return [...ul.children].map((node) => {
    if (node instanceof HTMLElement && node.tagName === 'CR-SIDEBAR-CHAT-ROW') {
      return node.getAttribute('chat-id') || '';
    }
    const li = node.querySelector?.('li.sidebar-chat-item');
    return li?.dataset?.chatId || '';
  });
}

window.__runSidebarChatRowDomHarness = async () => {
  const mount = await mountRowsAfterPassEnds();
  const block = mount.parentLi ? collectSidebarChatBlock(mount.parentLi) : [];
  return {
    parentLiPresent: mount.parentLi instanceof HTMLElement,
    parentHasContractClass: mount.parentLi?.classList.contains('sidebar-chat-item') === true,
    parentDataChatId: mount.parentLi?.dataset?.chatId || '',
    parentVisualKey: mount.parentLi?.getAttribute('data-visual-key') || '',
    childLiPresent: mount.childLi instanceof HTMLElement,
    siblingLiPresent: mount.siblingLi instanceof HTMLElement,
    dragBlockIds: block.map((node) => node.dataset?.chatId || ''),
  };
};

window.__runSidebarChatRowStatusAttrsHarness = async () => {
  document.body.innerHTML = '';
  const chatId = 'c-status';
  const ul = document.createElement('ul');
  ul.className = 'sidebar-chat-list';
  document.body.appendChild(ul);
  const deps = {
    ...sidebarDeps(),
    getTerminalStateMeta: () => ({
      tone: 'attention',
      label: 'Needs action',
      activityKey: 'act-1',
      status: 'completed',
    }),
  };
  beginSidebarChatRowPass();
  registerSidebarChatRow(chatId, {
    chat: { id: chatId, title: 'Status row', agentTransport: 'sdk' },
    activeChatId: '',
    opts: { level: 0, parentId: '' },
    deps,
  });
  const html = buildSidebarChatRowHostHtml(chatId, deps.escapeHtml);
  endSidebarChatRowPass();
  ul.innerHTML = html;
  hydrateSidebarChatRowHosts(ul);
  await waitForLitPaint();
  const li = ul.querySelector(`li.sidebar-chat-item[data-chat-id="${CSS.escape(chatId)}"]`);
  const chip = li?.querySelector('.sidebar-chat-item-awaiting');
  return {
    liPresent: li instanceof HTMLLIElement,
    hasContractClass: li?.classList.contains('sidebar-chat-item') === true,
    tone: chip?.getAttribute('data-status-tone') || '',
    label: chip?.getAttribute('data-status-label') || '',
    activityKey: chip?.getAttribute('data-activity-key') || '',
    outcome: chip?.getAttribute('data-status-outcome') || '',
    visualKey: li?.getAttribute('data-visual-key') || '',
  };
};

window.__runSidebarChatRowActiveIdentityHarness = async () => {
  document.body.innerHTML = '';
  const { ul, liById } = await mountFlatRowsAfterPassEnds(['c1', 'c2']);
  const li1 = liById['c1'];
  const li2 = liById['c2'];
  if (!(li1 instanceof HTMLLIElement) || !(li2 instanceof HTMLLIElement)) {
    return { ok: false, reason: 'missing-li' };
  }
  const chip1 = li1.querySelector('.sidebar-chat-item-awaiting');
  li1.classList.add('is-active');
  li1.setAttribute('aria-selected', 'true');
  li1.classList.remove('is-active');
  li1.setAttribute('aria-selected', 'false');
  li2.classList.add('is-active');
  li2.setAttribute('aria-selected', 'true');
  return {
    ok: true,
    li1Same: ul.querySelector(`li.sidebar-chat-item[data-chat-id="c1"]`) === li1,
    li2Active: li2.classList.contains('is-active'),
    chipPreserved: li1.querySelector('.sidebar-chat-item-awaiting') === chip1,
    rowCount: ul.querySelectorAll('li.sidebar-chat-item').length,
  };
};

window.__runSidebarChatRowListenerHarness = async () => {
  document.body.innerHTML = '';
  const baseline = __getSidebarChatRowStatusPatchListenerCountForTest();
  const { ul } = await mountFlatRowsAfterPassEnds(['listen-a', 'listen-b']);
  const afterMount = __getSidebarChatRowStatusPatchListenerCountForTest();
  const hosts = [...ul.querySelectorAll('cr-sidebar-chat-row')];
  for (const host of hosts) {
    if (typeof host.requestUpdate === 'function') host.requestUpdate();
  }
  await waitForLitPaint();
  const afterRerender = __getSidebarChatRowStatusPatchListenerCountForTest();
  ul.remove();
  await waitForLitPaint();
  const afterUnmount = __getSidebarChatRowStatusPatchListenerCountForTest();
  return {
    baseline,
    afterMount,
    afterRerender,
    afterUnmount,
    addedOnMount: afterMount - baseline,
    sameAfterRerender: afterRerender === afterMount,
    backToBaseline: afterUnmount === baseline,
  };
};

window.__runSidebarChatDragMoveHarness = async () => {
  document.body.innerHTML = '';
  const { ul, liById } = await mountFlatRowsAfterPassEnds(['row-a', 'row-b', 'row-c']);
  const liA = liById['row-a'];
  const liB = liById['row-b'];
  const liC = liById['row-c'];
  if (!liA || !liB || !liC) {
    return { ok: false, reason: 'missing-li' };
  }
  let threw = false;
  try {
    const movedBefore = insertSidebarChatBlockAt(ul, [liC], liA);
    const orderAfterMoveBefore = hostChatIds(ul);
    const movedEnd = insertSidebarChatBlockAt(ul, [liA], null);
    const orderAfterMoveEnd = hostChatIds(ul);
    const allListChildrenAreHosts = [...ul.children].every(
      (node) => node instanceof HTMLElement && node.tagName === 'CR-SIDEBAR-CHAT-ROW',
    );
    const liStillInsideHosts = ['row-a', 'row-b', 'row-c'].every((id) => {
      const li = ul.querySelector(`li.sidebar-chat-item[data-chat-id="${CSS.escape(id)}"]`);
      if (!(li instanceof HTMLLIElement)) return false;
      const host = li.closest('cr-sidebar-chat-row');
      return host instanceof HTMLElement && ul.contains(host);
    });
    const hostC = liC.closest('cr-sidebar-chat-row');
    const getRowLi = hostC instanceof HTMLElement
      ? hostC.querySelector('li.sidebar-chat-item')
      : null;
    const visualKeyBefore = liC.getAttribute('data-visual-key') || '';
    dispatchSidebarChatRowStatusPatch({
      dirty: new Set(['row-c']),
      all: false,
      chatById: new Map([['row-c', { id: 'row-c', title: 'row-c' }]]),
      getSidebarChatStateMeta: () => ({ tone: 'active', label: 'Working', activityKey: 'run-1' }),
    });
    const visualKeyAfter = liC.getAttribute('data-visual-key') || '';
    const patchViaHost = getRowLi === liC && visualKeyBefore !== visualKeyAfter;
    return {
      ok: true,
      movedBefore,
      movedEnd,
      orderAfterMoveBefore,
      orderAfterMoveEnd,
      allListChildrenAreHosts,
      liStillInsideHosts,
      patchViaHost,
      threw: false,
    };
  } catch (err) {
    threw = true;
    return { ok: false, threw, message: err instanceof Error ? err.message : String(err) };
  }
};

/**
 * Reproduces "opening a parent chat leaves the previous active (settled) child
 * highlighted": drives the real sidebar render pass against a real DOM.
 */
window.__runSidebarActiveHighlightHarness = async () => {
  const waitLit = async () => {
    await new Promise((resolve) => queueMicrotask(resolve));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const activeIds = () => [...document.querySelectorAll('#app-sidebar .sidebar-chat-item.is-active')]
    .map((el) => el.dataset.chatId);
  const hasRow = (id) =>
    !!document.querySelector(`#app-sidebar .sidebar-chat-item[data-chat-id="${CSS.escape(id)}"]`);

  document.body.innerHTML = '';
  const aside = document.createElement('aside');
  aside.id = 'app-sidebar';
  aside.hidden = false;
  const body = document.createElement('div');
  body.className = 'sidebar-body';
  aside.appendChild(body);
  document.body.appendChild(aside);

  const now = Date.now();
  const stale = new Date(now - 3 * 60 * 60 * 1000).toISOString();
  const parentId = 'parent-1';
  const childId = 'child-1';
  const chats = [
    { id: parentId, title: 'Parent', workspaceFile: '/w', workspaceFolder: '/f', updatedAt: new Date(now).toISOString() },
    { id: childId, title: 'Child review', workspaceFile: '/w', workspaceFolder: '/f', forkParentChatId: parentId, updatedAt: stale, _serverRunState: { state: 'busy' } },
  ];
  let activeId = childId;

  const view = createSidebarView({
    getWorkspaces: () => [{ name: 'WS', workspaceFile: '/w' }],
    getChats: () => chats,
    getActiveWorkspaceFile: () => '/w',
    getActiveWorkspaceFolder: () => '/f',
    getActiveChatId: () => activeId,
    getArchivedCounts: () => ({}),
    chatFavorites: { isFavorite: () => false },
    resolveChatState: () => 'idle',
    getTerminalStateMeta: () => ({ tone: 'idle', label: 'Idle' }),
    escapeHtml: (v) => String(v ?? ''),
    canPinChatToUrl: () => false,
    selectChat: () => {},
    switchWorkspace: () => Promise.resolve(true),
  });

  view.render();
  await waitLit();
  const childActiveBefore = activeIds();
  const childRowBefore = hasRow(childId);

  activeId = parentId;
  view.render();
  await waitLit();
  const parentActiveAfter = activeIds();
  const childRowAfter = hasRow(childId);
  const parentClass = document
    .querySelector(`#app-sidebar .sidebar-chat-item[data-chat-id="${CSS.escape(parentId)}"]`)
    ?.className || '';

  // Mobile flow: the drawer is open while the child is active, the user taps the
  // parent (which closes the drawer), the queued render runs while the aside is
  // hidden, then the user reopens the drawer. Reopening must repaint the active
  // row, not leave the previously active child highlighted.
  activeId = childId;
  view.render();
  await waitLit();
  aside.hidden = true;
  activeId = parentId;
  view.render();
  await waitLit();
  const staleWhileHidden = activeIds();
  view.open();
  await waitLit();
  const reopenedActive = activeIds();

  return {
    childActiveBefore,
    childRowBefore,
    parentActiveAfter,
    childRowAfter,
    parentClass,
    staleWhileHidden,
    reopenedActive,
  };
};
