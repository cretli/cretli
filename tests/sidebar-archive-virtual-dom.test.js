import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { computeSidebarArchiveMountedRowLimit } from '../app_front/features/sidebar/sidebarArchiveVirtualizer.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mountedLimit = computeSidebarArchiveMountedRowLimit(400);

function resolveChromiumExecutable() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
  ].filter(Boolean);
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return undefined;
}

async function withSidebarWorkspaceDomServer(run) {
  const port = Number.parseInt(process.env.SIDEBAR_WORKSPACE_DOM_PORT || '3398', 10);
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

test('archive group source uses virtual spacers and repeat keys', () => {
  const source = readFileSync(
    resolve(repoRoot, 'app_front/features/sidebar/cr-sidebar-archive-group.js'),
    'utf8',
  );
  assert.match(source, /sidebar-archive-virtual-spacer/);
  assert.match(source, /item\?\.chat\?\.id/);
  assert.match(source, /selectArchiveVisibleWindow/);
});

test('1500 archived chats mount at most the viewport row budget', { timeout: 180_000 }, async () => {
  const executablePath = resolveChromiumExecutable();
  await withSidebarWorkspaceDomServer(async (baseUrl) => {
    const browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    try {
      const page = await browser.newPage();
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.__runSidebarArchiveVirtualHarness === 'function');
      const result = await page.evaluate(async () => window.__runSidebarArchiveVirtualHarness(1500, 0));
      assert.ok(result.mountedRows <= mountedLimit, `mounted ${result.mountedRows} > ${mountedLimit}`);
      assert.equal(result.uniqueKeys, true);
    } finally {
      await browser.close();
    }
  });
});

test('archive scroll steps track user scroll without double spacer jumps', { timeout: 180_000 }, async () => {
  const executablePath = resolveChromiumExecutable();
  await withSidebarWorkspaceDomServer(async (baseUrl) => {
    const browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    try {
      const page = await browser.newPage();
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.__runSidebarArchiveScrollSeriesHarness === 'function');
      const result = await page.evaluate(async () =>
        window.__runSidebarArchiveScrollSeriesHarness(10000, [400, 400, 400, -200]),
      );
      assert.ok(result.maxMounted <= mountedLimit, `mounted ${result.maxMounted} > ${mountedLimit}`);
      assert.ok(result.maxJump <= 64, `scroll drift ${result.maxJump}px`);
      for (const step of result.steps) {
        assert.ok(step.scrollTop >= 0);
      }
    } finally {
      await browser.close();
    }
  });
});

test('active archived chat opens with anchor row visible', { timeout: 180_000 }, async () => {
  const executablePath = resolveChromiumExecutable();
  await withSidebarWorkspaceDomServer(async (baseUrl) => {
    const browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    try {
      const page = await browser.newPage();
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.__runSidebarArchiveActiveAnchorHarness === 'function');
      const result = await page.evaluate(async () => window.__runSidebarArchiveActiveAnchorHarness(500, 150));
      assert.ok(result.scrollTop > 0, 'scrollTop should reveal anchored row');
      assert.equal(result.activeVisible, true);
      assert.ok(result.mountedRows <= mountedLimit);
    } finally {
      await browser.close();
    }
  });
});

test('shrinking archive viewport re-clips mounted rows', { timeout: 180_000 }, async () => {
  const executablePath = resolveChromiumExecutable();
  const smallLimit = computeSidebarArchiveMountedRowLimit(200);
  await withSidebarWorkspaceDomServer(async (baseUrl) => {
    const browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    try {
      const page = await browser.newPage();
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.__runSidebarArchiveResizeHarness === 'function');
      const result = await page.evaluate(async () => window.__runSidebarArchiveResizeHarness(2000));
      assert.ok(result.afterResize <= smallLimit, `after resize ${result.afterResize} > ${smallLimit}`);
    } finally {
      await browser.close();
    }
  });
});

test('keyboard reveal targets last archive row with correct aria', { timeout: 180_000 }, async () => {
  const executablePath = resolveChromiumExecutable();
  await withSidebarWorkspaceDomServer(async (baseUrl) => {
    const browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    try {
      const page = await browser.newPage();
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.__runSidebarArchiveKeyboardEndHarness === 'function');
      const result = await page.evaluate(async () => window.__runSidebarArchiveKeyboardEndHarness(120));
      assert.equal(result.revealed, true);
      assert.ok(result.mountedRows <= mountedLimit);
      assert.equal(result.includesLastId, true);
      assert.equal(result.setsize, '120');
      assert.equal(result.posinset, '120');
      assert.equal(result.focusedId, 'arch-119');
      assert.equal(result.lastVisible, true);
    } finally {
      await browser.close();
    }
  });
});

test('scroll unmount transfers focus to archive listbox', { timeout: 180_000 }, async () => {
  const executablePath = resolveChromiumExecutable();
  await withSidebarWorkspaceDomServer(async (baseUrl) => {
    const browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    try {
      const page = await browser.newPage();
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.__runSidebarArchiveFocusUnmountHarness === 'function');
      const result = await page.evaluate(async () => window.__runSidebarArchiveFocusUnmountHarness(400));
      assert.ok(result.mountedRows <= mountedLimit);
      assert.equal(result.listHasTabindex, true);
      assert.equal(result.activeTag, 'ul');
    } finally {
      await browser.close();
    }
  });
});

test('1500 archive tree exposes aria-setsize and posinset on mounted DOM', { timeout: 180_000 }, async () => {
  const executablePath = resolveChromiumExecutable();
  await withSidebarWorkspaceDomServer(async (baseUrl) => {
    const browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    try {
      const page = await browser.newPage();
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.__runSidebarArchiveAria1500Harness === 'function');
      const result = await page.evaluate(async () => window.__runSidebarArchiveAria1500Harness());
      assert.equal(result.matches, true);
      assert.equal(result.setsize, '1500');
      assert.ok(result.mountedRows <= mountedLimit);
    } finally {
      await browser.close();
    }
  });
});

test('archive keyboard ArrowDown reaches off-window row via keydown', { timeout: 180_000 }, async () => {
  const executablePath = resolveChromiumExecutable();
  await withSidebarWorkspaceDomServer(async (baseUrl) => {
    const browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    try {
      const page = await browser.newPage();
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.__runSidebarArchiveKeyboardArrowHarness === 'function');
      const result = await page.evaluate(async () => window.__runSidebarArchiveKeyboardArrowHarness());
      assert.equal(result.ok, true);
      assert.equal(result.focusedId, result.expectedId);
      assert.ok(result.mountedRows <= mountedLimit);
    } finally {
      await browser.close();
    }
  });
});

test('second workspace archive chat resolves correct sidebar key after rebuild', { timeout: 180_000 }, async () => {
  const executablePath = resolveChromiumExecutable();
  await withSidebarWorkspaceDomServer(async (baseUrl) => {
    const browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    try {
      const page = await browser.newPage();
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.__runSidebarArchiveSecondWorkspaceFocusHarness === 'function');
      const result = await page.evaluate(async () => window.__runSidebarArchiveSecondWorkspaceFocusHarness());
      assert.equal(result.sidebarKey, result.expectedKey);
      assert.equal(result.rowFound, true);
      assert.equal(result.focusedAfter, 'arch-second-only');
    } finally {
      await browser.close();
    }
  });
});

test('favorite reorder with same length keeps arrow navigation on chatId', { timeout: 180_000 }, async () => {
  const executablePath = resolveChromiumExecutable();
  await withSidebarWorkspaceDomServer(async (baseUrl) => {
    const browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    try {
      const page = await browser.newPage();
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.__runSidebarArchiveReorderFocusHarness === 'function');
      const result = await page.evaluate(async () => window.__runSidebarArchiveReorderFocusHarness());
      assert.equal(result.focusedId, result.expectedId);
      assert.notEqual(result.focusedId, result.staleWouldBe);
    } finally {
      await browser.close();
    }
  });
});

test('gesture flush does not steal focus when composer had focus before gesture', { timeout: 180_000 }, async () => {
  const executablePath = resolveChromiumExecutable();
  await withSidebarWorkspaceDomServer(async (baseUrl) => {
    const browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    try {
      const page = await browser.newPage();
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.__runSidebarArchiveGestureNoStealHarness === 'function');
      const result = await page.evaluate(async () => window.__runSidebarArchiveGestureNoStealHarness());
      assert.equal(result.composerFocused, true);
      assert.equal(result.storedCleared, true);
      assert.equal(result.noArchiveFocusAfterFlush, true);
    } finally {
      await browser.close();
    }
  });
});

test('archive toggle and End key use production keyboard delegation', { timeout: 180_000 }, async () => {
  const executablePath = resolveChromiumExecutable();
  await withSidebarWorkspaceDomServer(async (baseUrl) => {
    const browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    try {
      const page = await browser.newPage();
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.__runSidebarArchiveToggleFocusHarness === 'function');
      const result = await page.evaluate(async () => window.__runSidebarArchiveToggleFocusHarness());
      assert.equal(result.ok, true);
      assert.equal(result.clearedOnClose, true);
      assert.equal(result.endFocusedId, result.expectedLast);
      assert.equal(result.listRole, 'listbox');
    } finally {
      await browser.close();
    }
  });
});

test('ensureArchivedChatRowMounted reveals off-window archive chat', { timeout: 180_000 }, async () => {
  const executablePath = resolveChromiumExecutable();
  await withSidebarWorkspaceDomServer(async (baseUrl) => {
    const browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    try {
      const page = await browser.newPage();
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.__runSidebarArchiveOffWindowClickHarness === 'function');
      const result = await page.evaluate(async () => window.__runSidebarArchiveOffWindowClickHarness());
      assert.equal(result.ok, true);
      assert.equal(result.includesTarget, true);
      assert.ok(result.mountedAfter <= mountedLimit);
    } finally {
      await browser.close();
    }
  });
});

test('archive open records sidebar.archive.render span for freeze counters', { timeout: 180_000 }, async () => {
  const executablePath = resolveChromiumExecutable();
  await withSidebarWorkspaceDomServer(async (baseUrl) => {
    const browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    try {
      const page = await browser.newPage();
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.__runSidebarArchiveOpenPerfHarness === 'function');
      const result = await page.evaluate(async () => window.__runSidebarArchiveOpenPerfHarness(2500));
      assert.equal(result.measured, true);
      assert.ok(result.spanMaxMs >= 0);
      assert.ok(result.mountedRows <= mountedLimit);
      if (result.spanMaxMs > result.longTaskBudgetMs) {
        assert.ok(result.spanWithinBudget, 'perf harness records span; budget is informational in CI');
      }
    } finally {
      await browser.close();
    }
  });
});

test('gesture blocks virtual unmount and flush restores archive keyboard focus', { timeout: 180_000 }, async () => {
  const executablePath = resolveChromiumExecutable();
  await withSidebarWorkspaceDomServer(async (baseUrl) => {
    const browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    try {
      const page = await browser.newPage();
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.__runSidebarArchiveGestureFocusHarness === 'function');
      const result = await page.evaluate(async () => window.__runSidebarArchiveGestureFocusHarness());
      assert.equal(result.windowUnchangedDuringGesture, true);
      assert.equal(result.storedChatDuring, result.focusId);
      assert.equal(result.focusedAfter, result.focusId);
      assert.equal(result.keyboardContinues, true);
    } finally {
      await browser.close();
    }
  });
});

test('10000 archived chats mount at most the viewport row budget after scroll', { timeout: 180_000 }, async () => {
  const executablePath = resolveChromiumExecutable();
  await withSidebarWorkspaceDomServer(async (baseUrl) => {
    const browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    try {
      const page = await browser.newPage();
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.__runSidebarArchiveVirtualHarness === 'function');
      const result = await page.evaluate(async () => window.__runSidebarArchiveVirtualHarness(10000, 8000));
      assert.ok(result.mountedRows <= mountedLimit, `mounted ${result.mountedRows} > ${mountedLimit}`);
      assert.equal(result.uniqueKeys, true);
      assert.ok(result.hasTopSpacer || result.firstId.startsWith('arch-'), 'scroll window shows non-zero slice');
    } finally {
      await browser.close();
    }
  });
});
