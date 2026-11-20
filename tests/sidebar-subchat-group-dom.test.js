import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function resolveChromiumExecutable() {
  return [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
  ].filter(Boolean).find((path) => existsSync(path));
}

async function withHarnessServer(run) {
  const port = Number.parseInt(process.env.SIDEBAR_SUBCHAT_DOM_PORT || '3397', 10);
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [resolve(repoRoot, 'tests/sidebar-workspace-dom/server.mjs')], {
    cwd: repoRoot,
    env: { ...process.env, SIDEBAR_WORKSPACE_DOM_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => reject(new Error('harness server timeout')), 120_000);
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
          resolvePromise(undefined);
          return;
        }
      } catch (_) {
        // still starting
      }
      setTimeout(poll, 200);
    };
    poll();
  });
  try {
    await run(baseUrl);
  } finally {
    child.kill('SIGTERM');
  }
}

async function runParity(payload) {
  const executablePath = resolveChromiumExecutable();
  let result;
  await withHarnessServer(async (baseUrl) => {
    const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    try {
      const page = await browser.newPage();
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.__runSidebarSubchatGroupParityHarness === 'function');
      result = await page.evaluate((p) => window.__runSidebarSubchatGroupParityHarness(p), payload);
    } finally {
      await browser.close();
    }
  });
  return result;
}

const basePayload = {
  sidebarKey: '/ws/a',
  parentTitle: 'Parent chat',
  continuationLevels: [1, 2, 99],
  canArchive: true,
  canPin: true,
  group: {
    parentId: 'p1',
    childIds: ['c1', 'c2'],
    allChildIds: ['c1', 'c2'],
    expanded: false,
    isLastChild: true,
    level: 2,
    summary: { total: 2, completed: 1, failed: 1, interrupted: 0, idle: 0 },
  },
};

test('Lit subchat group markup matches the legacy renderer (pin actions, continuation, a11y)', { timeout: 180_000 }, async () => {
  const { lit, legacy } = await runParity(basePayload);
  assert.deepEqual(lit, legacy);
  const joined = lit.join('\n');
  assert.match(joined, /has-pin-actions/, 'canPin adds has-pin-actions');
  assert.match(joined, /--sidebar-continuation-level:2/, 'continuation style is set');
  assert.match(joined, /aria-description/, 'toggle exposes the summary description');
  assert.match(joined, /sidebar-subchat-group-summary"\],\["title"/, 'summary span has a title');
});

test('Lit subchat group without pin/summary drops those attributes like the legacy renderer', { timeout: 180_000 }, async () => {
  const payload = {
    ...basePayload,
    canPin: false,
    canArchive: false,
    continuationLevels: [],
    group: { ...basePayload.group, expanded: true, isLastChild: false, summary: { total: 2 } },
  };
  const { lit, legacy } = await runParity(payload);
  assert.deepEqual(lit, legacy);
  assert.doesNotMatch(lit.join('\n'), /has-pin-actions|aria-description/);
});

test('a click on a pinned watcher row is dispatched through the .sidebar-pinned-chat selector', () => {
  const sidebar = resolve(repoRoot, 'app_front/features/sidebar/views');
  const events = readFileSync(resolve(sidebar, 'sidebarBodyEvents.js'), 'utf8');
  const section = readFileSync(resolve(sidebar, 'sidebarPinnedSection.js'), 'utf8');
  const keyboard = readFileSync(resolve(sidebar, 'sidebarBodyKeyboard.js'), 'utf8');
  assert.match(section, /<li class="sidebar-pinned-chat/, 'pinned rows are emitted with this class');
  assert.match(
    events,
    /const pinnedRow = target\.closest\('\.sidebar-pinned-chat'\);\s*if \(pinnedRow\) \{\s*openPinnedChatRow\(pinnedRow\);/,
    'click on the row reaches openPinnedChatRow',
  );
  assert.match(keyboard, /\.sidebar-pinned-chat,/, 'Enter/Space activation covers the pinned row');
  assert.doesNotMatch(events, /sidebar-state\.pinned-chat/);
});
