import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import {
  SIDEBAR_CHAT_ROW_CHILD_SELECTORS,
  SIDEBAR_CHAT_ROW_ROOT_CLASS,
  SIDEBAR_CHAT_ROW_SELECTOR,
} from '../app_front/features/sidebar/sidebarLitMigrationContract.js';
import { buildSidebarChatRowHtml } from '../app_front/features/sidebar/sidebarChatRowModel.js';
import {
  dispatchSidebarChatRowStatusPatch,
  subscribeSidebarChatRowStatusPatch,
} from '../app_front/features/sidebar/sidebarChatRowRefreshBus.js';
import { patchSidebarChatRowVisualState } from '../app_front/features/sidebar/sidebarChatRowVisualPatch.js';
import {
  beginSidebarChatRowPass,
  endSidebarChatRowPass,
  registerSidebarChatRow,
  getSidebarChatRowRegistration,
  __resetSidebarChatRowPassForTest,
} from '../app_front/features/sidebar/sidebarChatRowPass.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readRepo(relPath) {
  return readFileSync(resolve(repoRoot, relPath), 'utf8');
}

function makeLi(chatId) {
  const attrs = new Map([['data-chat-id', chatId], ['data-visual-key', 'idle\0idle\0Idle']]);
  const classes = new Set(['sidebar-chat-item']);
  const children = [];
  const state = {
    tag: 'li',
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, force) => {
        if (force === true) classes.add(c);
        else if (force === false) classes.delete(c);
        else if (classes.has(c)) classes.delete(c);
        else classes.add(c);
      },
    },
    dataset: { visualKey: 'idle\0idle\0Idle', chatId },
    getAttribute: (n) => attrs.get(n) ?? null,
    setAttribute: (n, v) => attrs.set(n, String(v)),
    querySelector: (sel) => {
      if (sel === '.sidebar-chat-item-state') {
        return state._stateEl || null;
      }
      if (sel === '.sidebar-chat-item-awaiting') {
        return state._awaitingEl || null;
      }
      return null;
    },
    children,
    _classes: classes,
    _attrs: attrs,
  };
  state._stateEl = {
    className: 'sidebar-chat-item-state sidebar-chat-item-state--idle',
    setAttribute: () => {},
  };
  const awaitingAttrs = new Map([
    ['data-status-tone', 'idle'],
    ['data-status-label', 'Idle'],
    ['data-activity-key', ''],
    ['data-status-outcome', ''],
  ]);
  state._awaitingEl = {
    className: 'sidebar-chat-item-awaiting sidebar-chat-item-awaiting--idle',
    hidden: true,
    textContent: 'Idle',
    getAttribute: (n) => awaitingAttrs.get(n) ?? null,
    setAttribute: (n, v) => awaitingAttrs.set(n, String(v)),
    querySelector: () => null,
  };
  return state;
}

test('cr-sidebar-chat-row uses light DOM and cleans up status subscriptions', () => {
  const source = readRepo('app_front/features/sidebar/cr-sidebar-chat-row.js');
  assert.match(source, /createRenderRoot\(\)\s*\{\s*return this;\s*\}/, 'light DOM render root');
  assert.match(source, /subscribeSidebarChatRowStatusPatch/, 'subscribes to dirty ids');
  assert.match(source, /applyRowVisualPatchFromRegistration/, 'initial status applied after Lit commit');
  assert.match(source, /disconnectedCallback[\s\S]*_statusUnsub\(\)/, 'unsubscribes on unmount');
  assert.ok(source.includes("this.style.display = 'contents'"), 'host is layout-transparent');
  assert.doesNotMatch(source, /attachShadow/, 'no shadow root');
});

test('sidebarView registers row payloads and mounts Lit hosts from workspace repeat', () => {
  const source = readRepo('app_front/features/sidebar/sidebarView.js');
  assert.match(source, /registerChatRowEntry/, 'row payload registered in render pass');
  assert.match(source, /createSidebarWorkspaceHostElement/, 'workspace reconcile creates Lit host elements');
  assert.match(source, /hydrateSidebarWorkspaceHosts/, 'hydrate workspace hosts after mount');
  assert.doesNotMatch(source, /buildSidebarChatRowHostHtml/, 'no host HTML string builder in sidebarView');
  assert.doesNotMatch(
    source,
    /return\s*\(\s*'\<li class="sidebar-chat-item/,
    'no parallel raw li HTML in sidebarView',
  );
});

test('buildSidebarChatRowHtml matches row contract selectors', () => {
  const chat = {
    id: 'chat-a',
    title: 'Alpha',
    agentTransport: 'sdk',
  };
  const html = buildSidebarChatRowHtml(chat, 'chat-a', { level: 0, parentId: '' }, {
    t: (key) => key,
    escapeHtml: (v) => String(v ?? ''),
    resolveChatState: () => 'idle',
    getTerminalStateMeta: () => ({ tone: 'idle', label: 'Idle' }),
    canPinChatToUrl: () => false,
    resolveSidebarHarnessIcon: () => 'cursor.svg',
    renderChatActionButtonsHtml: () => '',
  });
  assert.match(html, new RegExp(SIDEBAR_CHAT_ROW_ROOT_CLASS));
  assert.match(html, /data-chat-id="chat-a"/);
  assert.doesNotMatch(html, /data-visual-key=/, 'visual key is status-patch only');
  assert.match(html, /data-status-tone="idle"/, 'structural shell only');
  assert.match(html, /sidebar-chat-item-awaiting[^>]*hidden/, 'awaiting hidden until patch');
  const optionalWhenEmpty = new Set([
    '.sidebar-chat-item-preview',
    '.sidebar-chat-item-subchat-summary',
    '.sidebar-chat-item-activity-label',
    '.sidebar-chat-action', // omitted when renderChatActionButtonsHtml returns ''
  ]);
  for (const sel of SIDEBAR_CHAT_ROW_CHILD_SELECTORS) {
    if (optionalWhenEmpty.has(sel)) continue;
    const cls = sel.replace(/^\./, '').split(/[\[#]/)[0];
    assert.match(html, new RegExp(cls), `html includes ${sel}`);
  }
});

test('dirty status patch updates one row and preserves li node identity', () => {
  const li = makeLi('c1');
  const liRef = li;
  const getSidebarChatStateMeta = () => ({ tone: 'active', label: 'Working', activityKey: 'run' });
  patchSidebarChatRowVisualState(li, { id: 'c1' }, {
    t: (key) => key,
    escapeHtml: (v) => String(v ?? ''),
    getSidebarChatStateMeta,
  });
  assert.equal(li, liRef, 'row element identity preserved');
  assert.equal(li._classes.has('has-activity-status'), true, 'activity class toggled in place');
  assert.notEqual(li.dataset.visualKey, 'idle\0idle\0Idle', 'visual key updated');
});

test('status bus notifies only matching chat id subscribers', () => {
  let hitsA = 0;
  let hitsB = 0;
  const offA = subscribeSidebarChatRowStatusPatch((ev) => {
    if (ev.dirty.has('a')) hitsA += 1;
  });
  const offB = subscribeSidebarChatRowStatusPatch((ev) => {
    if (ev.dirty.has('b')) hitsB += 1;
  });
  try {
    dispatchSidebarChatRowStatusPatch({
      dirty: new Set(['a']),
      all: false,
      chatById: new Map([['a', { id: 'a' }]]),
    });
    assert.equal(hitsA, 1);
    assert.equal(hitsB, 0);
  } finally {
    offA();
    offB();
  }
});

test('mount/unmount does not multiply bus listeners', () => {
  let count = 0;
  const off = subscribeSidebarChatRowStatusPatch(() => {
    count += 1;
  });
  off();
  off();
  dispatchSidebarChatRowStatusPatch({ dirty: new Set(['x']), all: false, chatById: new Map() });
  assert.equal(count, 0, 'unsubscribed listener is not invoked');
});

test('chat.js does not refresh model picker from updateSidebarChatStates', () => {
  const chatSource = readRepo('app_front/chat.js');
  const body = chatSource.slice(
    chatSource.indexOf('function updateSidebarChatStates'),
    chatSource.indexOf('export function refreshSidebarChatStates'),
  );
  assert.doesNotMatch(body, /refreshModelSelectLabels/, 'sidebar patch path skips model picker');
});

test('render pass registry keeps payload after pass ends for async Lit', () => {
  __resetSidebarChatRowPassForTest();
  beginSidebarChatRowPass();
  registerSidebarChatRow('id-1', {
    chat: { id: 'id-1', title: 'T' },
    activeChatId: 'id-1',
    opts: {},
    deps: {
      t: (k) => k,
      escapeHtml: (v) => v,
      resolveChatState: () => 'idle',
      getTerminalStateMeta: () => ({ tone: 'idle', label: 'I' }),
      canPinChatToUrl: () => false,
      renderChatActionButtonsHtml: () => '',
    },
  });
  endSidebarChatRowPass();
  const reg = getSidebarChatRowRegistration('id-1');
  assert.ok(reg, 'payload survives endSidebarChatRowPass');
  assert.equal(reg.chat.id, 'id-1');
  __resetSidebarChatRowPassForTest();
});

function resolveChromiumExecutable() {
  const fromEnv = String(process.env.CHAT_E2E_CHROMIUM_EXECUTABLE_PATH || '').trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const candidates = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ];
  return candidates.find((file) => existsSync(file));
}

/**
 * @param {(baseUrl: string) => Promise<void>} run
 */
async function withSidebarChatRowDomServer(run) {
  const port = Number.parseInt(process.env.SIDEBAR_CHAT_ROW_DOM_PORT || '3398', 10);
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverPath = resolve(repoRoot, 'tests/sidebar-chat-row-dom/server.mjs');
  const child = spawn(process.execPath, [serverPath], {
    cwd: repoRoot,
    env: { ...process.env, SIDEBAR_CHAT_ROW_DOM_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ready = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('sidebar chat row dom server timeout')), 120_000);
    const fail = (chunk) => {
      const text = String(chunk || '');
      if (/Error|missing bundle/i.test(text)) {
        clearTimeout(timeout);
        reject(new Error(text.trim()));
      }
    };
    child.stderr.on('data', fail);
    child.stdout.on('data', fail);
    const poll = async () => {
      try {
        const res = await fetch(`${baseUrl}/health`);
        if (res.ok) {
          clearTimeout(timeout);
          resolve(undefined);
          return;
        }
      } catch (_) {
        // server still starting
      }
      setTimeout(poll, 200);
    };
    poll();
  });
  await ready;
  try {
    await run(baseUrl);
  } finally {
    child.kill('SIGTERM');
  }
}

test('insertSidebarChatBlockAt moves Lit hosts before another row and to list end', { timeout: 180_000 }, async () => {
  const executablePath = resolveChromiumExecutable();
  await withSidebarChatRowDomServer(async (baseUrl) => {
    const browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    try {
      const page = await browser.newPage();
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.__runSidebarChatDragMoveHarness === 'function');
      const result = await page.evaluate(async () => window.__runSidebarChatDragMoveHarness());
      assert.equal(result.ok, true, result.reason || result.message || 'harness failed');
      assert.equal(result.threw, false);
      assert.equal(result.movedBefore, true, 'row-c moved before row-a');
      assert.deepEqual(result.orderAfterMoveBefore, ['row-c', 'row-a', 'row-b']);
      assert.equal(result.movedEnd, true, 'row-a moved to end');
      assert.deepEqual(result.orderAfterMoveEnd, ['row-c', 'row-b', 'row-a']);
      assert.equal(result.allListChildrenAreHosts, true);
      assert.equal(result.liStillInsideHosts, true);
      assert.equal(result.patchViaHost, true, 'status patch hits li after host move');
    } finally {
      await browser.close();
    }
  });
});

test('mounted cr-sidebar-chat-row paints li after pass ends and drag block spans hosts', { timeout: 180_000 }, async () => {
  const executablePath = resolveChromiumExecutable();
  await withSidebarChatRowDomServer(async (baseUrl) => {
    const browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    try {
      const page = await browser.newPage();
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.__runSidebarChatRowDomHarness === 'function');
      const result = await page.evaluate(async () => window.__runSidebarChatRowDomHarness());
      assert.equal(result.parentLiPresent, true, 'parent li exists after async Lit update');
      assert.equal(result.parentHasContractClass, true);
      assert.equal(result.parentDataChatId, 'parent-row');
      assert.ok(result.parentVisualKey.length > 0, 'data-visual-key contract');
      assert.equal(result.childLiPresent, true);
      assert.equal(result.siblingLiPresent, true);
      assert.deepEqual(result.dragBlockIds, ['parent-row', 'child-row'], 'nested drag block crosses hosts');
    } finally {
      await browser.close();
    }
  });
});

test('row selector still matches contract after Lit host wrapper', () => {
  assert.equal(SIDEBAR_CHAT_ROW_SELECTOR, '.sidebar-chat-item[data-chat-id]');
});
