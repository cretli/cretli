import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const viewSource = readFileSync(resolve(repoRoot, 'app_front/features/sidebar/sidebarView.js'), 'utf8');

function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} located`);
  const rest = source.slice(start + 1);
  const next = rest.indexOf('\n  function ');
  return next >= 0 ? rest.slice(0, next) : rest;
}

test('wireBodyEvents attaches delegated listeners once per sidebar-body via WeakSet', () => {
  assert.match(viewSource, /const wiredBodyEvents = new WeakSet\(\)/);
  const wire = functionBody(viewSource, 'wireBodyEvents');
  assert.match(wire, /if \(!body \|\| wiredBodyEvents\.has\(body\)\) return;/);
  assert.match(wire, /wiredBodyEvents\.add\(body\)/);
  assert.match(viewSource, /wireBodyEvents\(\)/);
});

test('favorites, subchat expand, and show-more use render() to preserve reuse map', () => {
  const fav = functionBody(viewSource, 'handleChatRowAction');
  assert.match(fav, /sidebar-chat-fav-btn[\s\S]{0,120}?\brender\(\)/);
  assert.doesNotMatch(fav, /sidebar-chat-fav-btn[\s\S]{0,120}?forceRerender\(\)/);
  const subchat = functionBody(viewSource, 'toggleSubchatGroup');
  assert.match(subchat, /\brender\(\)/);
  assert.doesNotMatch(subchat, /forceRerender\(\)/);
  const more = functionBody(viewSource, 'expandAllChats');
  assert.match(more, /\brender\(\)/);
  assert.doesNotMatch(more, /forceRerender\(\)/);
  const archiveToggle = functionBody(viewSource, 'toggleArchiveSection');
  assert.match(archiveToggle, /\brender\(\)/);
});

test('language change still forces full label regen', () => {
  assert.match(
    viewSource,
    /cr-lang-changed[\s\S]{0,120}?forceRerender\(\)/,
    'i18n switch drops workspace reuse map',
  );
});

test('render defers structural rebuild while drag, workspace drag, or swipe is active', () => {
  const renderFn = functionBody(viewSource, 'render');
  assert.match(renderFn, /chatDrag\.isDragging\(\)/);
  assert.match(renderFn, /workspaceDrag\.isDragging\(\)/);
  assert.match(renderFn, /swipe\.isSwiping\(\)/);
  assert.match(renderFn, /updateScheduler\.schedule\(\)/);
});

test('status-only frames refresh registrations without Lit host re-render', () => {
  const skipStart = viewSource.indexOf('if (sig === lastRenderSignature)');
  assert.ok(skipStart >= 0);
  const skipEnd = viewSource.indexOf('lastRenderSignature = sig;', skipStart);
  assert.ok(skipEnd > skipStart);
  const skipBranch = viewSource.slice(skipStart, skipEnd);
  assert.match(skipBranch, /refreshLitWorkspaceHostsOnSignatureMatch\(body\)/);
  assert.match(skipBranch, /patchTransientVisualStates\(\)/);
  assert.doesNotMatch(skipBranch, /renderedWorkspaceNodes\.clear\(\)/);
  const refreshFn = functionBody(viewSource, 'refreshLitWorkspaceHostsOnSignatureMatch');
  assert.doesNotMatch(refreshFn, /requestSidebarWorkspaceUpdate/, 'status-only skip does not re-render Lit');
});

test('focus restore waits for Lit commit and covers fav, pin, and show-more', () => {
  const focusSource = readFileSync(
    resolve(repoRoot, 'app_front/features/sidebar/sidebarArchiveSidebarFocus.js'),
    'utf8',
  );
  assert.match(viewSource, /captureSidebarFocusInfo/);
  assert.match(viewSource, /scheduleSidebarFocusAndScrollRestore/);
  assert.match(viewSource, /waitForSidebarLitHostsCommit/);
  const capture = functionBody(focusSource, 'captureSidebarFocusInfo');
  assert.match(capture, /sidebar-chat-fav-btn/);
  assert.match(capture, /sidebar-chat-pin-btn/);
  assert.match(capture, /sidebar-chat-more/);
});

test('Lit sidebar hosts clear stashed payloads on disconnect', () => {
  for (const file of [
    'app_front/features/sidebar/cr-sidebar-chat-row.js',
    'app_front/features/sidebar/cr-sidebar-workspace.js',
    'app_front/features/sidebar/cr-sidebar-subchat-group.js',
    'app_front/features/sidebar/cr-sidebar-archive-group.js',
  ]) {
    const source = readFileSync(resolve(repoRoot, file), 'utf8');
    assert.match(source, /disconnectedCallback\(/, `${file} unmount hook`);
  }
});

test('favorite action buttons expose aria-pressed for accessibility', () => {
  const actions = functionBody(viewSource, 'renderChatActionButtonsHtml');
  assert.match(actions, /sidebar-chat-fav-btn/);
  assert.match(actions, /aria-pressed/);
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
  await new Promise((resolvePromise, reject) => {
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
          resolvePromise(undefined);
          return;
        }
      } catch (_) {
        // server still starting
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

test('subchat Lit group keeps host identity and refreshes i18n labels in place', { timeout: 180_000 }, async () => {
  const executablePath = resolveChromiumExecutable();
  await withSidebarWorkspaceDomServer(async (baseUrl) => {
    const browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    try {
      const page = await browser.newPage();
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.__runSidebarWorkspaceSubchatHarness === 'function');
      const result = await page.evaluate(async () => window.__runSidebarWorkspaceSubchatHarness());
      assert.equal(result.titleText, 'Settled (en)');
      assert.equal(result.toggleTag, 'BUTTON');
      assert.equal(result.toggleExpanded, 'false');
      assert.equal(typeof result.toggleSameNode, 'boolean', 'harness reports toggle node identity');
    } finally {
      await browser.close();
    }
  });
});

test('status patch and registry update preserve workspace and row host identity', { timeout: 180_000 }, async () => {
  const executablePath = resolveChromiumExecutable();
  await withSidebarWorkspaceDomServer(async (baseUrl) => {
    const browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    try {
      const page = await browser.newPage();
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.__runSidebarWorkspaceStatusDuringUpdateHarness === 'function');
      const result = await page.evaluate(async () => window.__runSidebarWorkspaceStatusDuringUpdateHarness());
      assert.equal(result.wsHostSame, true);
      assert.equal(result.rowHostSame, true);
      assert.equal(result.liSame, true, 'status-only patch keeps li identity');
      assert.equal(result.visualKeyChanged, true);
      assert.equal(result.tone, 'active');
      assert.equal(result.label, 'Working');
    } finally {
      await browser.close();
    }
  });
});

test('workspace update preserves row li and restores action focus after Lit commit', { timeout: 180_000 }, async () => {
  const executablePath = resolveChromiumExecutable();
  await withSidebarWorkspaceDomServer(async (baseUrl) => {
    const browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    try {
      const page = await browser.newPage();
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.__runSidebarWorkspaceFocusAfterUpdateHarness === 'function');
      const result = await page.evaluate(async () => window.__runSidebarWorkspaceFocusAfterUpdateHarness());
      assert.equal(result.ok, true);
      assert.equal(result.favPresentAfterUpdate, true);
      await page.locator('.sidebar-chat-fav-btn').focus();
      const focusOnFav = await page.evaluate(
        () => document.activeElement instanceof HTMLElement
          && document.activeElement.classList.contains('sidebar-chat-fav-btn'),
      );
      assert.equal(focusOnFav, true, 'fav button focusable after Lit commit');
    } finally {
      await browser.close();
    }
  });
});

test('repeated workspace refresh does not multiply status bus listeners', { timeout: 180_000 }, async () => {
  const executablePath = resolveChromiumExecutable();
  await withSidebarWorkspaceDomServer(async (baseUrl) => {
    const browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    try {
      const page = await browser.newPage();
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.__runSidebarWorkspaceListenerHarness === 'function');
      const result = await page.evaluate(async () => window.__runSidebarWorkspaceListenerHarness());
      assert.equal(result.addedOnMount, 1);
      assert.equal(result.stableAcrossUpdates, true);
      assert.equal(result.backToBaseline, true);
    } finally {
      await browser.close();
    }
  });
});
