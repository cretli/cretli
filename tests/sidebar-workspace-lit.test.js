import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import {
  sidebarArchiveRepeatKey,
  sidebarChatRepeatKey,
  sidebarEmptyRepeatKey,
  sidebarShowMoreRepeatKey,
  sidebarSubchatGroupRepeatKey,
  buildSidebarWorkspaceHostHtml,
} from '../app_front/features/sidebar/sidebarWorkspaceModel.js';
import {
  beginSidebarWorkspacePass,
  endSidebarWorkspacePass,
  getSidebarWorkspaceRegistration,
  registerSidebarWorkspace,
  __resetSidebarWorkspacePassForTest,
} from '../app_front/features/sidebar/sidebarWorkspacePass.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readRepo(relPath) {
  return readFileSync(resolve(repoRoot, relPath), 'utf8');
}

test('stable repeat keys use chat id, group parent id, and workspace scope', () => {
  assert.equal(sidebarChatRepeatKey('abc'), 'abc');
  assert.equal(sidebarSubchatGroupRepeatKey('parent-1'), 'group:parent-1');
  assert.equal(sidebarArchiveRepeatKey('ws-key'), 'archive:ws-key');
  assert.equal(sidebarShowMoreRepeatKey('ws-key'), 'more:ws-key');
  assert.equal(sidebarEmptyRepeatKey('ws-key'), 'empty:ws-key');
});

test('workspace Lit hosts use light DOM, repeat, and display contents', () => {
  const ws = readRepo('app_front/features/sidebar/cr-sidebar-workspace.js');
  assert.match(ws, /createRenderRoot\(\)\s*\{\s*return this;\s*\}/);
  assert.match(ws, /from 'lit\/directives\/repeat\.js'/);
  assert.match(ws, /entry\.key/, 'repeat keys list entries');
  assert.doesNotMatch(ws, /attachShadow/);
  assert.ok(ws.includes("this.style.display = 'contents'"));
  assert.match(ws, /<cr-sidebar-chat-row/, 'list entries render real Lit child hosts');
  assert.doesNotMatch(ws, /buildSidebarChatRowHostHtml/, 'no static host HTML for chat rows');
  const archive = readRepo('app_front/features/sidebar/cr-sidebar-archive-group.js');
  assert.match(archive, /repeat\(/);
  assert.match(archive, /item\?\.chat\?\.id/);
});

test('sidebarView mounts workspace hosts and updates in place when signature changes', () => {
  const source = readRepo('app_front/features/sidebar/sidebarView.js');
  assert.match(source, /cr-sidebar-workspace/, 'workspace Lit host boundary');
  assert.match(source, /registerSidebarWorkspace/, 'workspace payload registration');
  assert.match(source, /requestSidebarWorkspaceUpdate/, 'in-place workspace update preserves row DOM');
  assert.match(source, /createSidebarWorkspaceHostElement/, 'reconcile mounts Lit workspace hosts directly');
  assert.doesNotMatch(source, /buildSidebarWorkspaceHostHtml/, 'no workspace host HTML strings in sidebarView');
  assert.doesNotMatch(
    source,
    /return\s*\(\s*'\<li class="sidebar-workspace/,
    'no parallel raw workspace li HTML return',
  );
});

test('status-only render skips workspace rebuild via renderSignature short-circuit', () => {
  const source = readRepo('app_front/features/sidebar/sidebarView.js');
  assert.match(source, /if \(sig === lastRenderSignature\)/);
  assert.match(source, /refreshLitWorkspaceHostsOnSignatureMatch\(body\)/);
  const refreshLit = source.slice(
    source.indexOf('function refreshLitWorkspaceHostsOnSignatureMatch'),
    source.indexOf('function patchTransientVisualStates'),
  );
  assert.doesNotMatch(refreshLit, /requestSidebarWorkspaceUpdate/, 'status-only path avoids Lit re-render');
  assert.match(source, /patchTransientVisualStates\(\)/);
  const sigBody = source.slice(
    source.indexOf('function computeWorkspaceStructureSignature'),
    source.indexOf('function renderSignature'),
  );
  assert.doesNotMatch(sigBody, /resolveChatState/, 'structure sig excludes transient status');
});

test('workspace pass registry survives end pass for async Lit hydration', () => {
  __resetSidebarWorkspacePassForTest();
  beginSidebarWorkspacePass();
  registerSidebarWorkspace('ws-1', {
    sidebarKey: 'ws-1',
    workspace: { sidebarKey: 'ws-1', workspaceFile: '/a' },
    isActive: false,
    isCollapsed: false,
    searching: false,
    serializeList: true,
    count: 1,
    preferredFolder: '',
    autopilotBadgeHtml: '',
    listEntries: [{ kind: 'chat', key: 'c1', chatId: 'c1' }],
    deps: { t: (k) => k, escapeHtml: (v) => v },
  });
  endSidebarWorkspacePass();
  const reg = getSidebarWorkspaceRegistration('ws-1');
  assert.ok(reg);
  assert.equal(reg.listEntries[0].key, 'c1');
  __resetSidebarWorkspacePassForTest();
});

test('workspace host html is a single custom element', () => {
  const html = buildSidebarWorkspaceHostHtml('key-1', (v) => String(v));
  assert.match(html, /^<cr-sidebar-workspace sidebar-key="key-1"><\/cr-sidebar-workspace>$/);
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
async function withSidebarWorkspaceDomServer(run) {
  const port = Number.parseInt(process.env.SIDEBAR_WORKSPACE_DOM_PORT || '3399', 10);
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverPath = resolve(repoRoot, 'tests/sidebar-workspace-dom/server.mjs');
  const child = spawn(process.execPath, [serverPath], {
    cwd: repoRoot,
    env: { ...process.env, SIDEBAR_WORKSPACE_DOM_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ready = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('sidebar workspace dom server timeout')), 120_000);
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

test('workspace DOM keeps row host identity and updates title without double escape', { timeout: 180_000 }, async () => {
  const executablePath = resolveChromiumExecutable();
  await withSidebarWorkspaceDomServer(async (baseUrl) => {
    const browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    try {
      const page = await browser.newPage();
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.__runSidebarWorkspaceIdentityHarness === 'function');
      const result = await page.evaluate(async () => window.__runSidebarWorkspaceIdentityHarness());
      assert.equal(result.sameRowHost, true, 'chat row Lit host preserved across registry update');
      assert.equal(result.workspaceTitle, 'Workspace & Co <x>');
      assert.equal(result.dataSidebarKey, '/ws/one');
      assert.equal(result.chatTitleText, 'Renamed title');
    } finally {
      await browser.close();
    }
  });
});

test('workspace DOM archive section fills after open toggle', { timeout: 180_000 }, async () => {
  const executablePath = resolveChromiumExecutable();
  await withSidebarWorkspaceDomServer(async (baseUrl) => {
    const browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    try {
      const page = await browser.newPage();
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.__runSidebarWorkspaceArchiveHarness === 'function');
      const result = await page.evaluate(async () => window.__runSidebarWorkspaceArchiveHarness());
      assert.equal(result.archiveHostPresent, true);
      assert.equal(result.closedCount, 0);
      assert.equal(result.openCount, 1);
    } finally {
      await browser.close();
    }
  });
});

test('workspace DOM drag reorders cr-sidebar-workspace hosts', { timeout: 180_000 }, async () => {
  const executablePath = resolveChromiumExecutable();
  await withSidebarWorkspaceDomServer(async (baseUrl) => {
    const browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    try {
      const page = await browser.newPage();
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.__runSidebarWorkspaceDragHarness === 'function');
      const result = await page.evaluate(async () => window.__runSidebarWorkspaceDragHarness());
      assert.equal(result.ok, true, result.reason || 'drag harness failed');
      assert.deepEqual(result.order, ['/ws/b', '/ws/a', '/ws/c']);
      assert.equal(result.allDirectHosts, true);
    } finally {
      await browser.close();
    }
  });
});
