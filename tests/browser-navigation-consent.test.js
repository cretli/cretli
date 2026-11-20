/**
 * Navigation consent: an agent's navigation to an origin outside the workspace
 * allowlist parks on a chat prompt (once / always / deny) instead of failing hard.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { subscribeChatHistoryUpdates, unsubscribeChatHistoryUpdates } from '../lib/sdk/sdk-history-updates.ts';
import {
  createNavigationConsentRegistry,
  isConsentEligibleOrigin,
  NAVIGATION_CONSENT_WAIT_MS,
} from '../lib/browser/navigation-consent.js';
import { addAllowedOrigin, getWorkspacePolicy } from '../lib/browser/policy-store.js';
import { BrowserError, BrowserSessionManager } from '../lib/browser/session-manager.js';
import { buildBrowserAgentTools, configureBrowserAgentRuntime } from '../lib/browser/agent-tools.js';
import { BRIDGE_BROWSER_NAVIGATION_TIMEOUT_MS, isBridgeBrowserNavigationToolName } from '../lib/remote-api-client.js';

const ORIGIN = 'https://shop.example.com';

test('consent tool wait remains below the bridge timeout', () => {
  assert.ok(NAVIGATION_CONSENT_WAIT_MS <= 25_000);
  assert.ok(NAVIGATION_CONSENT_WAIT_MS < 30_000);
  assert.ok(NAVIGATION_CONSENT_WAIT_MS < BRIDGE_BROWSER_NAVIGATION_TIMEOUT_MS);
  assert.ok(BRIDGE_BROWSER_NAVIGATION_TIMEOUT_MS < 60_000);
  assert.equal(isBridgeBrowserNavigationToolName('mcp__cretli_builtincretl__browser_open'), true);
  assert.equal(isBridgeBrowserNavigationToolName('mcp__cretli_builtincretl__browser_navigate'), true);
  assert.equal(isBridgeBrowserNavigationToolName('mcp__cretli_builtincretl__browser_input'), false);
});

function registry(extra = {}) {
  const changes = [];
  const persisted = [];
  const reg = createNavigationConsentRegistry({
    persistOrigin: (key, origin) => persisted.push([key, origin]),
    onChange: (event) => changes.push(event.chatId),
    ...extra,
  });
  return { reg, changes, persisted };
}

test('once grant is scoped to origin and chat and never persisted', async () => {
  const { reg, persisted, changes } = registry();
  const answer = reg.request({ chatId: 'c1', workspaceKey: '/ws', origin: ORIGIN });
  const [prompt] = reg.list('c1');
  assert.equal(prompt.origin, ORIGIN);
  assert.deepEqual(reg.list('c2'), []);
  assert.deepEqual(reg.resolve(prompt.id, 'once', { chatId: 'c2' }), { ok: false, code: 'forbidden-chat' });
  assert.equal(reg.resolve(prompt.id, 'once', { chatId: 'c1' }).ok, true);
  assert.equal(await answer, 'once');
  assert.equal(reg.hasOnceGrant('c1', ORIGIN), true);
  assert.equal(reg.hasOnceGrant('c2', ORIGIN), false);
  assert.equal(reg.hasOnceGrant('c1', 'https://other.example.com'), false);
  assert.deepEqual(persisted, []);
  assert.ok(changes.length >= 2);
  // A later request for the granted origin needs no new prompt.
  assert.equal(await reg.request({ chatId: 'c1', workspaceKey: '/ws', origin: ORIGIN }), 'once');
  reg.clearChat('c1');
  assert.equal(reg.hasOnceGrant('c1', ORIGIN), false);
});

test('allow persists the origin through the workspace policy', async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cretli-consent-'));
  try {
    const reg = createNavigationConsentRegistry({
      persistOrigin: (key, origin) => addAllowedOrigin(dataDir, key, origin, {}),
    });
    const answer = reg.request({ chatId: 'c1', workspaceKey: '/ws/a', origin: `${ORIGIN}/path` });
    reg.resolve(reg.list('c1')[0].id, 'allow');
    assert.equal(await answer, 'allow');
    assert.deepEqual(getWorkspacePolicy(dataDir, '/ws/a').allowedOrigins, [ORIGIN]);
    // Idempotent.
    addAllowedOrigin(dataDir, '/ws/a', ORIGIN, {});
    assert.deepEqual(getWorkspacePolicy(dataDir, '/ws/a').allowedOrigins, [ORIGIN]);
    assert.equal(reg.hasOnceGrant('c1', ORIGIN), false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a failed persist keeps the prompt open', async () => {
  const reg = createNavigationConsentRegistry({ persistOrigin: () => { throw new Error('disk'); } });
  void reg.request({ chatId: 'c1', workspaceKey: '/ws', origin: ORIGIN });
  const id = reg.list('c1')[0].id;
  assert.deepEqual(reg.resolve(id, 'allow'), { ok: false, code: 'persist-failed' });
  assert.equal(reg.list('c1').length, 1);
  reg.resolve(id, 'deny');
});

test('deny and invalid decisions', async () => {
  const { reg } = registry();
  const answer = reg.request({ chatId: 'c1', workspaceKey: '/ws', origin: ORIGIN });
  const id = reg.list('c1')[0].id;
  assert.equal(reg.resolve(id, 'maybe').code, 'invalid-decision');
  assert.equal(reg.resolve(id, 'deny').ok, true);
  assert.equal(await answer, 'deny');
  assert.equal(reg.hasOnceGrant('c1', ORIGIN), false);
  assert.equal(reg.resolve(id, 'deny').code, 'not-found');
});

test('an unanswered call returns pending while its prompt remains available', async () => {
  const timers = [];
  const { reg, changes } = registry({
    setTimeoutFn: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
    clearTimeoutFn: () => {},
  });
  const answer = reg.request({ chatId: 'c1', workspaceKey: '/ws', origin: ORIGIN });
  assert.equal(timers.length, 2);
  timers.find((timer) => timer.ms < 600_000).fn();
  assert.equal(await answer, 'pending');
  assert.equal(reg.list('c1').length, 1);
  const retry = reg.request({ chatId: 'c1', workspaceKey: '/ws', origin: ORIGIN });
  reg.resolve(reg.list('c1')[0].id, 'once');
  assert.equal(await retry, 'once');
  assert.deepEqual(reg.list('c1'), []);
  assert.equal(reg.hasOnceGrant('c1', ORIGIN), true);
  assert.ok(changes.length >= 2);
});

test('concurrent requests for one origin share a single prompt', async () => {
  const { reg } = registry();
  const a = reg.request({ chatId: 'c1', workspaceKey: '/ws', origin: ORIGIN });
  const b = reg.request({ chatId: 'c1', workspaceKey: '/ws', origin: ORIGIN });
  assert.equal(reg.list('c1').length, 1);
  reg.resolve(reg.list('c1')[0].id, 'once');
  assert.deepEqual(await Promise.all([a, b]), ['once', 'once']);
});

test('fork child prompt grants the parent session and clearing it removes the grant', async () => {
  const { reg } = registry();
  const answer = reg.request({ chatId: 'child', grantChatId: 'parent', workspaceKey: '/ws', origin: ORIGIN });
  assert.equal(reg.list('child').length, 1);
  reg.resolve(reg.list('child')[0].id, 'once');
  assert.equal(await answer, 'once');
  assert.equal(reg.hasOnceGrant('parent', ORIGIN), true);
  assert.equal(reg.hasOnceGrant('child', ORIGIN), false);
  reg.clearChat('parent');
  assert.equal(reg.hasOnceGrant('parent', ORIGIN), false);
});

test('pending limit has a distinct outcome', async () => {
  const { reg } = registry();
  for (let i = 0; i < 5; i += 1) void reg.request({ chatId: 'c1', workspaceKey: '/ws', origin: `https://host${i}.example.com` });
  assert.equal(await reg.request({ chatId: 'c1', workspaceKey: '/ws', origin: 'https://extra.example.com' }), 'limit');
  reg.clearChat('c1');
});

test('denial or expiry closes resources registered by a pending call', async () => {
  const timers = [];
  const closed = [];
  const { reg } = registry({
    setTimeoutFn: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
    clearTimeoutFn: () => {},
  });
  const first = reg.request({ chatId: 'c1', workspaceKey: '/ws', origin: ORIGIN, onDenied: () => closed.push('denied') });
  timers.find((timer) => timer.ms < 600_000).fn();
  assert.equal(await first, 'pending');
  reg.resolve(reg.list('c1')[0].id, 'deny');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(closed, ['denied']);

  const second = reg.request({ chatId: 'c1', workspaceKey: '/ws', origin: ORIGIN, onDenied: () => closed.push('expired') });
  timers.filter((timer) => timer.ms === 600_000).at(-1).fn();
  assert.equal(await second, 'timeout');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(closed, ['denied', 'expired']);
});

test('loopback, private and non-http origins never get a prompt', async () => {
  for (const origin of ['http://localhost:3000', 'http://127.0.0.1', 'http://192.168.1.5', 'ftp://example.com', '']) {
    assert.equal(isConsentEligibleOrigin(origin), false, origin);
    const { reg } = registry();
    assert.equal(await reg.request({ chatId: 'c1', workspaceKey: '/ws', origin }), 'deny');
    assert.deepEqual(reg.list('c1'), []);
  }
  assert.equal(isConsentEligibleOrigin(ORIGIN), true);
});

test('manager policy honours a once grant for its chat only and keeps other checks', async () => {
  const { reg } = registry();
  const manager = new BrowserSessionManager({
    consent: reg,
    resolvePolicy: () => ({ allowedOrigins: [], blockedPorts: [], unblockedPorts: [] }),
    lookup: async (host) => [{ address: host === 'rebind.example.com' ? '10.0.0.5' : '93.184.216.34' }],
  });
  const session = { chatId: 'c1', workspaceKey: '/ws', dnsPins: new Map() };
  assert.equal((await manager.evaluateRequestPolicy(session, `${ORIGIN}/x`)).code, 'origin-not-allowed');
  const answer = reg.request({ chatId: 'c1', workspaceKey: '/ws', origin: ORIGIN });
  reg.resolve(reg.list('c1')[0].id, 'once');
  await answer;
  assert.equal((await manager.evaluateRequestPolicy(session, `${ORIGIN}/x`)).allowed, true);
  assert.equal((await manager.evaluateRequestPolicy({ ...session, chatId: 'c2', dnsPins: new Map() }, `${ORIGIN}/x`)).allowed, false);
  // A granted name that resolves into the private network is still blocked.
  const rebind = reg.request({ chatId: 'c1', workspaceKey: '/ws', origin: 'https://rebind.example.com' });
  reg.resolve(reg.list('c1')[0].id, 'once');
  await rebind;
  const blocked = await manager.evaluateRequestPolicy(session, 'https://rebind.example.com/');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.code, 'dns-rebinding');
});

/** Manager stub whose navigate blocks until the origin is granted. */
function stubManager(reg) {
  const calls = [];
  const session = { id: 's1', ownerSessionId: 'o', chatId: 'c1', activeTabId: 't1', tabs: new Map([['t1', { id: 't1' }]]) };
  return {
    calls,
    requireSession: () => session,
    requireTab: () => ({ session, tab: session.tabs.get('t1') }),
    async navigate(_s, _t, url) {
      calls.push(url);
      const origin = new URL(url).origin;
      if (!reg.hasOnceGrant('c1', origin) && calls.filter((u) => u === url).length === 1) {
        const err = new BrowserError('navigation-blocked', 'Navigation blocked: not on allowlist', 403);
        err.policyCode = 'origin-not-allowed';
        err.origin = origin;
        throw err;
      }
      return { url };
    },
  };
}

function navigateTool(manager) {
  return buildBrowserAgentTools({
    manager,
    mode: 'agent',
    ownerSessionId: 'o',
    chatId: 'c1',
    scope: { cwd: '/ws' },
  }).browser_navigate;
}

test('browser_navigate retries after consent and returns a clear error on deny', async () => {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.send = () => {};
  subscribeChatHistoryUpdates('c1', ws);
  try {
  const { reg } = registry();
  configureBrowserAgentRuntime({ manager: stubManager(reg), consent: reg });
  const manager = stubManager(reg);
  const tool = navigateTool(manager);
  const args = { browserSessionId: 's1', browserTabId: 't1', url: `${ORIGIN}/a`, confirm: true };

  const pending = tool.execute(args);
  await new Promise((resolve) => setImmediate(resolve));
  reg.resolve(reg.list('c1')[0].id, 'once');
  assert.deepEqual((await pending).state, { url: `${ORIGIN}/a` });
  assert.equal(manager.calls.length, 2);

  const denied = navigateTool(stubManager(reg));
  const second = denied.execute({ ...args, url: 'https://news.example.org/' });
  await new Promise((resolve) => setImmediate(resolve));
  reg.resolve(reg.list('c1')[0].id, 'deny');
  await assert.rejects(second, (err) => err.code === 'navigation-denied' && /news\.example\.org/.test(err.message));

  // Without a registry the original hard error is kept.
  configureBrowserAgentRuntime({ manager: stubManager(reg) });
  await assert.rejects(
    navigateTool(stubManager(reg)).execute({ ...args, url: 'https://third.example.net/' }),
    (err) => err.code === 'navigation-blocked',
  );
  configureBrowserAgentRuntime(null);
  } finally {
    unsubscribeChatHistoryUpdates('c1', ws);
  }
});

test('navigation without a chat client keeps the original block and creates no prompt', async () => {
  const { reg } = registry();
  configureBrowserAgentRuntime({ manager: stubManager(reg), consent: reg });
  try {
    await assert.rejects(
      navigateTool(stubManager(reg)).execute({ browserSessionId: 's1', browserTabId: 't1', url: `${ORIGIN}/no-ui` }),
      (err) => err.code === 'navigation-blocked' && /allowlist/.test(err.message),
    );
    assert.deepEqual(reg.list('c1'), []);
  } finally {
    configureBrowserAgentRuntime(null);
  }
});

test('always allow persists under the Browser session workspace key', async () => {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.send = () => {};
  subscribeChatHistoryUpdates('c1', ws);
  const { reg, persisted } = registry();
  const manager = stubManager(reg);
  manager.requireSession().workspaceKey = '/session-workspace';
  configureBrowserAgentRuntime({ manager, consent: reg });
  try {
    const call = navigateTool(manager).execute({ browserSessionId: 's1', browserTabId: 't1', url: `${ORIGIN}/policy` });
    await new Promise((resolve) => setImmediate(resolve));
    reg.resolve(reg.list('c1')[0].id, 'allow');
    await call;
    assert.deepEqual(persisted, [['/session-workspace', ORIGIN]]);
  } finally {
    unsubscribeChatHistoryUpdates('c1', ws);
    configureBrowserAgentRuntime(null);
  }
});
