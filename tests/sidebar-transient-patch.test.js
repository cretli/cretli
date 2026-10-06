import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const viewSource = readFileSync(resolve(here, '../app_front/features/sidebar/sidebarView.js'), 'utf8');

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
  await new Promise((resolvePromise, reject) => {
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

test('mounted Lit rows toggle active state in place and preserve chip nodes', { timeout: 180_000 }, async () => {
  const executablePath = resolveChromiumExecutable();
  await withSidebarChatRowDomServer(async (baseUrl) => {
    const browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    try {
      const page = await browser.newPage();
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.__runSidebarChatRowActiveIdentityHarness === 'function');
      const result = await page.evaluate(async () => window.__runSidebarChatRowActiveIdentityHarness());
      assert.equal(result.ok, true, result.reason || 'harness failed');
      assert.equal(result.li1Same, true, 'row li node identity preserved');
      assert.equal(result.li2Active, true, 'new active row highlighted');
      assert.equal(result.chipPreserved, true, 'awaiting chip node identity preserved');
      assert.equal(result.rowCount, 2, 'no extra rows from in-place patch');
    } finally {
      await browser.close();
    }
  });
});

test('mounted cr-sidebar-chat-row paints status-patch data attributes on the li', { timeout: 180_000 }, async () => {
  const executablePath = resolveChromiumExecutable();
  await withSidebarChatRowDomServer(async (baseUrl) => {
    const browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    try {
      const page = await browser.newPage();
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.__runSidebarChatRowStatusAttrsHarness === 'function');
      const result = await page.evaluate(async () => window.__runSidebarChatRowStatusAttrsHarness());
      assert.equal(result.liPresent, true);
      assert.equal(result.hasContractClass, true);
      assert.equal(result.tone, 'attention');
      assert.equal(result.label, 'Needs action');
      assert.equal(result.activityKey, 'act-1');
      assert.equal(result.outcome, 'completed');
      assert.ok(result.visualKey.length > 0, 'data-visual-key contract');
    } finally {
      await browser.close();
    }
  });
});

test('cr-sidebar-chat-row mount/unmount/re-render does not multiply status bus listeners', { timeout: 180_000 }, async () => {
  const executablePath = resolveChromiumExecutable();
  await withSidebarChatRowDomServer(async (baseUrl) => {
    const browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    try {
      const page = await browser.newPage();
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.__runSidebarChatRowListenerHarness === 'function');
      const result = await page.evaluate(async () => window.__runSidebarChatRowListenerHarness());
      assert.equal(result.addedOnMount, 2, 'one bus listener per mounted row host');
      assert.equal(result.sameAfterRerender, true, 'requestUpdate does not re-subscribe');
      assert.equal(result.backToBaseline, true, 'disconnect removes listeners');
    } finally {
      await browser.close();
    }
  });
});

test('reopening the sidebar repaints the active row after it changed while hidden', { timeout: 180_000 }, async () => {
  const executablePath = resolveChromiumExecutable();
  await withSidebarChatRowDomServer(async (baseUrl) => {
    const browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    try {
      const page = await browser.newPage();
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.__runSidebarActiveHighlightHarness === 'function');
      const result = await page.evaluate(async () => window.__runSidebarActiveHighlightHarness());
      assert.deepEqual(result.childActiveBefore, ['child-1'], 'the child starts active');
      assert.deepEqual(result.parentActiveAfter, ['parent-1'], 'selecting the parent moves the highlight');
      assert.deepEqual(
        result.staleWhileHidden,
        ['child-1'],
        'the queued render cannot patch the highlight while the aside is hidden',
      );
      assert.deepEqual(
        result.reopenedActive,
        ['parent-1'],
        'opening the drawer repaints the row that is actually active',
      );
    } finally {
      await browser.close();
    }
  });
});

test('the inert 5s sidebar poll is gone and the status/active marker is out of the signature', () => {
  assert.doesNotMatch(viewSource, /function startPoll\s*\(/, 'startPoll removed');
  assert.doesNotMatch(viewSource, /function stopPoll\s*\(/, 'stopPoll removed');
  assert.doesNotMatch(viewSource, /setInterval\s*\([\s\S]*?,\s*5000\s*\)/, 'no 5s interval');
  const start = viewSource.indexOf('function renderSignature(partsOut)');
  assert.ok(start >= 0, 'renderSignature located');
  const end = viewSource.indexOf('function refreshLitWorkspaceHostsOnSignatureMatch', start);
  assert.ok(end > start, 'renderSignature body bounded by the next helper');
  const sigBody = viewSource.slice(start, end);
  assert.doesNotMatch(sigBody, /statusSig/, 'no status segment in the structural signature');
  assert.doesNotMatch(sigBody, /=== activeChatId \? 'A'/, "no 'A' active marker in the signature");
  assert.doesNotMatch(sigBody, /getTerminalStateMeta/, 'signature does not read chat tone');
});

function sliceFunction(source, signature, nextSignature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `located ${signature}`);
  const end = nextSignature ? source.indexOf(nextSignature, start) : -1;
  assert.ok(end > start, `bounded ${signature} by ${nextSignature}`);
  return source.slice(start, end);
}

const chatSource = readFileSync(resolve(here, '../app_front/chat.js'), 'utf8');
const transportSource = readFileSync(
  resolve(here, '../app_front/features/chat/chatTransport.js'),
  'utf8',
);

test('scheduleChatListStateRefresh never marks the whole list dirty from ids', () => {
  const body = sliceFunction(
    chatSource,
    'function scheduleChatListStateRefresh(ids)',
    'export function scheduleChatListStateRefreshAll',
  );
  assert.match(body, /if \(!Array\.isArray\(ids\) \|\| ids\.length === 0\) return;/, 'no/empty array is a no-op');
  assert.match(body, /if \(!added\) return;\s*\n\s*chatListStateRefresh\.schedule\(\);/, 'no valid id => no rAF');
  assert.doesNotMatch(body, /add\('\*'\)/, 'the per-id scheduler never injects the wildcard');
});

test("the wildcard is produced only by scheduleChatListStateRefreshAll (drawer open)", () => {
  const all = sliceFunction(
    chatSource,
    'export function scheduleChatListStateRefreshAll()',
    '/** In-place chat status update',
  );
  assert.match(all, /pendingSidebarDirtyIds\.add\('\*'\);/, 'the wildcard lives in the All variant');
  assert.match(all, /chatListStateRefresh\.schedule\(\);/, 'and plans the frame');
  const occurrences = chatSource.match(/pendingSidebarDirtyIds\.add\('\*'\)/g) || [];
  assert.equal(occurrences.length, 1, 'exactly one place marks the whole list dirty');
  assert.match(
    chatSource,
    /export function refreshSidebarChatStates\(\) \{[\s\S]{0,60}?scheduleChatListStateRefreshAll\(\);/,
    'refreshSidebarChatStates triggers the full patch',
  );
});

test('updateSidebarChatStates ends an empty dirty set before querySelectorAll', () => {
  const body = sliceFunction(
    chatSource,
    'function updateSidebarChatStates(chatById = null)',
    'export function refreshSidebarChatStates',
  );
  const bailIdx = body.indexOf('if (dirty.size === 0) return;');
  const walkIdx = body.indexOf("querySelectorAll('.sidebar-chat-item')");
  assert.ok(bailIdx >= 0, 'empty set ends the patcher');
  assert.ok(walkIdx > bailIdx, 'the full walk only happens after the empty bail');
  assert.doesNotMatch(body, /dirty\.size === 0 \|\| dirty\.has\('\*'\)/, 'empty no longer forces a full patch');
  assert.match(body, /if \(dirty\.has\('\*'\)\)/, 'the full branch is driven only by the wildcard');
});

test('a status frame repaints the sidebar transient state even with the chat-list modal closed', () => {
  const body = sliceFunction(
    chatSource,
    'function updateChatListModalStates()',
    'const chatListStateRefresh = createRafDebouncer',
  );
  const hookIdx = body.indexOf('sidebarTransientPatchHook()');
  const bailIdx = body.indexOf('if (!modal || modal.hidden || !listEl) return;');
  assert.ok(hookIdx >= 0, 'the active-row/summary hook is wired');
  assert.ok(bailIdx > hookIdx, 'the hook must run before the modal short-circuit');
});

test('opening the drawer repaints the transient active-row state', () => {
  const body = sliceFunction(viewSource, 'function openSidebar()', 'function closeSidebar()');
  assert.match(body, /applyVisibility\(\);/, 'the drawer becomes visible first');
  assert.match(body, /patchTransientVisualStates\(\);/, 'and the stale active row is repainted before refreshStates');
});

test('no sidebar call-site still schedules a wildcard with bare parentheses', () => {
  assert.doesNotMatch(
    chatSource,
    /scheduleChatListStateRefresh\(\)/,
    'every refresh is per-id; the only wildcard path is scheduleChatListStateRefreshAll()',
  );
});

test('renderChatTerminalState repaints the active chat own row, per-id', () => {
  const body = sliceFunction(chatSource, 'function renderChatTerminalState(chat', 'function renderChatList()');
  assert.match(body, /scheduleChatListStateRefresh\(chat\?\.id \? \[chat\.id\] : \[\]\);/, 'no-bar branch schedules [chat.id]');
  assert.match(body, /scheduleChatListStateRefresh\(\[chat\.id\]\);[\s\S]*?if \(isPendingHarnessSwitch/, 'active-with-bar schedules the row');
});

test('presence, background-sync and stabilizer callbacks forward chat ids', () => {
  assert.match(chatSource, /onExpire: \(chatId\) => scheduleChatListStateRefresh\(chatId \? \[chatId\] : \[\]\)/, 'stabilizer onExpire passes [chatId]');
  assert.match(chatSource, /onBackgroundSyncComplete: \(ids\) => scheduleChatListStateRefresh\(ids\)/, 'background sync passes ids');
  assert.match(chatSource, /onAgentStatesChange: \(dirtyIds\) => \{[\s\S]{0,60}?scheduleChatListStateRefresh\(dirtyIds\);/, 'agent-states change forwards dirtyIds');
  assert.match(chatSource, /if \(applied\.changed\) scheduleChatListStateRefresh\(applied\.dirtyIds\);/, 'HTTP gap/push-inbox repaint only changed rows');
});

test('performSelectChat dirties prev + next row and drops the full refresh', () => {
  const body = sliceFunction(chatSource, 'function performSelectChat(id)', 'export function loadWorkspaces');
  assert.match(body, /scheduleChatListStateRefresh\(\[prevActiveChatId, id\]\);/, 'selection dirties [prevId, nextId]');
  assert.doesNotMatch(body, /refreshSidebarChatStates\(\)/, 'delegation ack no longer full-refreshes the sidebar');
  assert.match(body, /scheduleChatListStateRefresh\(\[chat\.id\]\);/, 'delegation ack repaints only its chat row');
});

test('syncBackgroundChatConnections reports the rows it actually changed', () => {
  const body = sliceFunction(transportSource, 'function syncBackgroundChatConnections()', 'function scheduleBackgroundSyncCoalesced');
  assert.match(body, /const dirtyBackgroundIds = \[\];/, 'collects changed ids');
  assert.match(body, /chat\._backgroundMonitorMode !== prevMode/, 'mode flip dirties the row');
  assert.match(body, /chat\._connectionStatus !== prevConnection/, 'no-socket disconnect flip dirties the row');
  assert.match(body, /onBackgroundSyncComplete\(dirtyBackgroundIds\);/, 'forwards the id list (empty => no patch)');
  assert.doesNotMatch(body, /onBackgroundSyncComplete\(\);/, 'never calls the old zero-arg completion');
});

test('a visible socket close repaints the row even when reconnect early-returns', () => {
  const body = sliceFunction(transportSource, 'socket.onclose = (event) =>', 'socket.onopen =');
  const reconnectIdx = body.indexOf('scheduleChatReconnect(chat);');
  const renderIdx = body.indexOf('renderChatTerminalState(chat);', reconnectIdx);
  assert.ok(reconnectIdx >= 0, 'visible close schedules a reconnect');
  assert.ok(renderIdx > reconnectIdx, 'and repaints the row directly for the guard-return paths');
});
