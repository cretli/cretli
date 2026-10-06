/**
 * browser_* SDK agent tools.
 *
 * These tests lock down the P1 contract without launching Chromium:
 * - the namespace is separate from the widget `page_*` tools;
 * - construction is fail-closed when runtime/owner/chat/workspace is unknown;
 * - plan/ask and review assignments get read tools only;
 * - every tab tool requires explicit browserSessionId + browserTabId;
 * - owner/workspace/chat scoping is enforced on each call;
 * - Console/Network pulls stay bounded and cursor-based (no live bodies/HAR);
 * - browser_input needs an explicit confirm:true;
 * - server.js registers the runtime and the SDK merges the tools.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BROWSER_AGENT_MUTATION_TOOLS,
  BROWSER_AGENT_PULL_LIMIT,
  BROWSER_AGENT_READ_TOOLS,
  buildBrowserAgentTools,
  configureBrowserAgentRuntime,
  getBrowserAgentRuntime,
} from '../lib/browser/agent-tools.js';
import { BrowserError } from '../lib/browser/session-manager.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

const OWNER = 'owner-1';
const CHAT = 'chat-1';
const SCOPE = { workspaceFile: '/ws/cretli', cwd: '/ws/cretli' };

/**
 * Minimal in-memory stand-in for BrowserSessionManager. It mirrors the real
 * signatures the agent tools rely on and records every call so the tests can
 * assert what was forwarded (scope, cursor, clamped limit, ...).
 */
class FakeManager {
  constructor() {
    this.sessions = new Map();
    this.chatBindings = new Map();
    this.calls = [];
    this.nextSession = 0;
  }

  addSession({ id, ownerSessionId = OWNER, workspaceKey = '/ws/cretli', chatId = '', tabIds = ['tab-1'] }) {
    const tabs = new Map();
    for (const tabId of tabIds) {
      tabs.set(tabId, {
        id: tabId,
        url: 'https://example.test/',
        console: { entries: [] },
        network: { entries: [] },
      });
    }
    const session = {
      id,
      ownerSessionId,
      workspaceKey,
      chatId,
      activeTabId: tabIds[0] || null,
      tabs,
    };
    this.sessions.set(id, session);
    if (chatId) this.chatBindings.set(chatId, id);
    return session;
  }

  requireSession(sessionId, ownerSessionId, scope = {}) {
    const session = this.sessions.get(String(sessionId || ''));
    if (!session) throw new BrowserError('not-found', 'Browser session not found', 404);
    if (!ownerSessionId || session.ownerSessionId !== ownerSessionId) {
      throw new BrowserError('forbidden-owner', 'Browser session belongs to another Cretli session', 403);
    }
    const reqKey = scope.workspaceFile || scope.cwd || '';
    if (session.workspaceKey && !reqKey) {
      throw new BrowserError('forbidden-workspace', 'Browser session requires an explicit workspace scope', 403);
    }
    if (session.workspaceKey && reqKey !== session.workspaceKey) {
      throw new BrowserError('forbidden-workspace', 'Browser session belongs to another workspace', 403);
    }
    return session;
  }

  requireTab(sessionId, tabId, ownerSessionId, scope = {}) {
    const session = this.requireSession(sessionId, ownerSessionId, scope);
    const tab = session.tabs.get(String(tabId || ''));
    if (!tab) throw new BrowserError('tab-not-found', 'Browser tab not found', 404);
    return { session, tab };
  }

  summarizeSession(session) {
    return { browserSessionId: session.id, chatId: session.chatId, workspaceKey: session.workspaceKey };
  }

  bindChat(sessionId, ownerSessionId, input = {}, scope = {}) {
    const session = this.requireSession(sessionId, ownerSessionId, scope);
    const chatId = String(input.chatId || '').trim();
    if (!chatId) throw new BrowserError('invalid-chat', 'Missing chatId', 400);
    if (session.chatId && session.chatId !== chatId) {
      throw new BrowserError('chat-bind-conflict', 'Browser session is bound to another chat', 409);
    }
    session.chatId = chatId;
    this.chatBindings.set(chatId, session.id);
    this.calls.push({ method: 'bindChat', sessionId, chatId });
    return this.summarizeSession(session);
  }

  resolveChatBinding(chatId) {
    const id = this.chatBindings.get(String(chatId || '').trim());
    if (!id || !this.sessions.has(id)) return null;
    return { browserSessionId: id, chatId };
  }

  listSessions(ownerSessionId, scope = {}) {
    const reqKey = scope.workspaceFile || scope.cwd || '';
    if (!reqKey) return [];
    return [...this.sessions.values()]
      .filter((session) => session.ownerSessionId === ownerSessionId && session.workspaceKey === reqKey)
      .map((session) => this.summarizeSession(session));
  }

  listTabs(sessionId, ownerSessionId, scope = {}) {
    const session = this.requireSession(sessionId, ownerSessionId, scope);
    return [...session.tabs.values()].map((tab) => ({ browserTabId: tab.id, url: tab.url }));
  }

  async screenshot(sessionId, tabId, ownerSessionId, options = {}) {
    this.requireTab(sessionId, tabId, ownerSessionId, options);
    this.calls.push({ method: 'screenshot', sessionId, tabId, options });
    return {
      browserSessionId: sessionId,
      browserTabId: tabId,
      mimeType: 'image/jpeg',
      bytes: 3,
      width: 390,
      height: 844,
      dpr: 2,
      data: Buffer.from('jpeg').toString('base64'),
      at: 1,
    };
  }

  pullConsole(sessionId, tabId, ownerSessionId, options = {}, scope = {}) {
    this.requireTab(sessionId, tabId, ownerSessionId, scope);
    this.calls.push({ method: 'pullConsole', sessionId, tabId, options, scope });
    return { entries: [], nextSince: Number(options.since || 0), truncated: false };
  }

  pullNetwork(sessionId, tabId, ownerSessionId, options = {}, scope = {}) {
    this.requireTab(sessionId, tabId, ownerSessionId, scope);
    this.calls.push({ method: 'pullNetwork', sessionId, tabId, options, scope });
    return { entries: [], nextSince: Number(options.since || 0), truncated: false };
  }

  async getDom(sessionId, tabId, ownerSessionId, scope = {}) {
    this.requireTab(sessionId, tabId, ownerSessionId, scope);
    this.calls.push({ method: 'getDom', sessionId, tabId, scope });
    return { browserSessionId: sessionId, browserTabId: tabId, html: '<html></html>', truncated: false, bytes: 13 };
  }

  async getVisibleElements(sessionId, tabId, ownerSessionId, scope = {}) {
    this.requireTab(sessionId, tabId, ownerSessionId, scope);
    this.calls.push({ method: 'getVisibleElements', sessionId, tabId, scope });
    return {
      browserSessionId: sessionId,
      browserTabId: tabId,
      channel: 'elements',
      elements: [{ index: 0, role: 'button', name: 'Save', text: 'Save', selector: '#save' }],
      count: 1,
      scanned: 1,
      total: 1,
      truncated: false,
    };
  }

  async createSession(input) {
    this.nextSession += 1;
    const id = `session-${this.nextSession}`;
    this.addSession({ id, ownerSessionId: input.ownerSessionId, workspaceKey: input.workspaceFile || input.cwd, chatId: '' });
    this.calls.push({ method: 'createSession', id, input });
    return { browserSessionId: id, chatId: input.chatId || '', tabs: [{ browserTabId: 'tab-1' }] };
  }

  async createTab(sessionId, ownerSessionId, input = {}, options = {}) {
    const session = this.requireSession(sessionId, ownerSessionId, options.scope || {});
    const tabId = `tab-${session.tabs.size + 1}`;
    session.tabs.set(tabId, { id: tabId, url: input.url || 'about:blank', console: { entries: [] }, network: { entries: [] } });
    if (input.activate !== false) session.activeTabId = tabId;
    this.calls.push({ method: 'createTab', sessionId, tabId, input });
    return { browserTabId: tabId };
  }

  async navigate(sessionId, tabId, url, ownerSessionId, scope = {}) {
    const { tab } = this.requireTab(sessionId, tabId, ownerSessionId, scope);
    tab.url = url;
    this.calls.push({ method: 'navigate', sessionId, tabId, url, scope });
    return { browserSessionId: sessionId, browserTabId: tabId, url };
  }

  async getState(sessionId, tabId, ownerSessionId, scope = {}) {
    const { tab } = this.requireTab(sessionId, tabId, ownerSessionId, scope);
    return { browserSessionId: sessionId, browserTabId: tabId, url: tab.url };
  }

  async dispatchInput(sessionId, tabId, ownerSessionId, event, scope = {}) {
    this.requireTab(sessionId, tabId, ownerSessionId, scope);
    this.calls.push({ method: 'dispatchInput', sessionId, tabId, event, scope });
    return { applied: true };
  }
}

/** @param {{ manager?: any, mode?: string, assignment?: string, ownerSessionId?: string, chatId?: string, scope?: object }} overrides */
function toolsFor(manager, overrides = {}) {
  return buildBrowserAgentTools({
    manager,
    mode: 'agent',
    ownerSessionId: OWNER,
    chatId: CHAT,
    scope: SCOPE,
    ...overrides,
  });
}

test('namespace stays separate from the widget page_* tools', () => {
  const names = [...BROWSER_AGENT_READ_TOOLS, ...BROWSER_AGENT_MUTATION_TOOLS];
  for (const name of names) assert.match(name, /^browser_/);
  assert.equal(names.includes('browser_evaluate'), false);
  // The overlap between read and mutation tools must stay empty.
  assert.deepEqual(
    BROWSER_AGENT_READ_TOOLS.filter((name) => BROWSER_AGENT_MUTATION_TOOLS.includes(name)),
    [],
  );
});

test('construction is fail-closed without runtime, owner, chat or workspace', () => {
  const manager = new FakeManager();
  assert.deepEqual(buildBrowserAgentTools({}), {});
  assert.deepEqual(buildBrowserAgentTools({ ownerSessionId: OWNER, chatId: CHAT, scope: SCOPE }), {});
  assert.deepEqual(toolsFor(null), {});
  assert.deepEqual(toolsFor(manager, { ownerSessionId: '' }), {});
  assert.deepEqual(toolsFor(manager, { chatId: '' }), {});
  assert.deepEqual(toolsFor(manager, { scope: {} }), {});
});

test('plan and ask modes expose read tools only', () => {
  const manager = new FakeManager();
  for (const mode of ['plan', 'ask']) {
    const tools = toolsFor(manager, { mode });
    for (const name of BROWSER_AGENT_READ_TOOLS) assert.ok(tools[name], `${mode}: ${name} missing`);
    for (const name of BROWSER_AGENT_MUTATION_TOOLS) assert.equal(tools[name], undefined, `${mode}: ${name} leaked`);
  }
});

test('agent mode exposes read and mutation tools', () => {
  const manager = new FakeManager();
  const tools = toolsFor(manager, { mode: 'agent' });
  for (const name of [...BROWSER_AGENT_READ_TOOLS, ...BROWSER_AGENT_MUTATION_TOOLS]) {
    assert.ok(tools[name], `${name} missing in agent mode`);
  }
});

test('review assignment is read-only even in agent mode', () => {
  const manager = new FakeManager();
  const tools = toolsFor(manager, { mode: 'agent', assignment: 'review' });
  for (const name of BROWSER_AGENT_MUTATION_TOOLS) assert.equal(tools[name], undefined, `${name} leaked to review`);
  assert.ok(tools.browser_dom);
});

test('tab tools require explicit browserSessionId + browserTabId', async () => {
  const manager = new FakeManager();
  manager.addSession({ id: 'session-A', chatId: CHAT });
  const tools = toolsFor(manager);
  await assert.rejects(
    () => tools.browser_dom.execute({ browserSessionId: 'session-A' }),
    (err) => err.code === 'explicit-target-required' && err.status === 400,
  );
  await assert.rejects(
    () => tools.browser_screenshot.execute({}),
    (err) => err.code === 'explicit-target-required',
  );
  assert.equal(manager.calls.filter((call) => call.method === 'getDom').length, 0);
});

test('a session bound to another chat is rejected', async () => {
  const manager = new FakeManager();
  manager.addSession({ id: 'session-A', chatId: 'chat-other' });
  const tools = toolsFor(manager);
  await assert.rejects(
    () => tools.browser_dom.execute({ browserSessionId: 'session-A', browserTabId: 'tab-1' }),
    (err) => err.code === 'forbidden-chat' && err.status === 403,
  );
  await assert.rejects(
    () => tools.browser_tabs.execute({ browserSessionId: 'session-A' }),
    (err) => err.code === 'forbidden-chat',
  );
});

test('an unbound session is claimed for the calling chat', async () => {
  const manager = new FakeManager();
  manager.addSession({ id: 'session-A', chatId: '' });
  const tools = toolsFor(manager);
  const result = await tools.browser_tabs.execute({ browserSessionId: 'session-A' });
  assert.equal(result.ok, true);
  assert.equal(manager.sessions.get('session-A').chatId, CHAT);
  assert.equal(manager.calls.some((call) => call.method === 'bindChat'), true);
});

test('another owner/workspace never sees the session', async () => {
  const manager = new FakeManager();
  manager.addSession({ id: 'session-A', chatId: CHAT, workspaceKey: '/ws/other' });
  const tools = toolsFor(manager);
  await assert.rejects(
    () => tools.browser_dom.execute({ browserSessionId: 'session-A', browserTabId: 'tab-1' }),
    (err) => err.code === 'forbidden-workspace' && err.status === 403,
  );
  const otherOwner = toolsFor(manager, { ownerSessionId: 'owner-2' });
  await assert.rejects(
    () => otherOwner.browser_tabs.execute({ browserSessionId: 'session-A' }),
    (err) => err.code === 'forbidden-owner',
  );
});

test('browser_sessions only lists sessions bound to the calling chat', async () => {
  const manager = new FakeManager();
  manager.addSession({ id: 'session-A', chatId: CHAT });
  manager.addSession({ id: 'session-B', chatId: 'chat-other' });
  manager.addSession({ id: 'session-C', chatId: '' });
  const tools = toolsFor(manager);
  const result = await tools.browser_sessions.execute();
  assert.deepEqual(result.browserSessions.map((session) => session.browserSessionId), ['session-A']);
});

test('console/network pulls are bounded and cursor-based', async () => {
  const manager = new FakeManager();
  manager.addSession({ id: 'session-A', chatId: CHAT });
  const tools = toolsFor(manager);
  await tools.browser_console.execute({ browserSessionId: 'session-A', browserTabId: 'tab-1', since: 7, limit: 9999 });
  await tools.browser_network.execute({ browserSessionId: 'session-A', browserTabId: 'tab-1', limit: 5 });
  const consoleCall = manager.calls.find((call) => call.method === 'pullConsole');
  const networkCall = manager.calls.find((call) => call.method === 'pullNetwork');
  assert.equal(consoleCall.options.since, 7);
  assert.equal(consoleCall.options.limit, BROWSER_AGENT_PULL_LIMIT);
  assert.deepEqual(consoleCall.scope, { workspaceFile: SCOPE.workspaceFile, workspaceFolder: '', cwd: SCOPE.cwd });
  assert.equal(networkCall.options.limit, 5);
  // Pull tools expose metadata only: no live push, body or HAR channel.
  assert.deepEqual(Object.keys(tools.browser_network.inputSchema.properties).sort(), ['browserSessionId', 'browserTabId', 'limit', 'since']);
  assert.equal(manager.calls.some((call) => call.method === 'pullNetwork' && 'body' in call.options), false);
});

test('browser_input requires confirm:true before any dispatch', async () => {
  const manager = new FakeManager();
  manager.addSession({ id: 'session-A', chatId: CHAT });
  const tools = toolsFor(manager);
  await assert.rejects(
    () => tools.browser_input.execute({ browserSessionId: 'session-A', browserTabId: 'tab-1', event: { kind: 'key' } }),
    (err) => err.code === 'confirmation-required',
  );
  await assert.rejects(
    () => tools.browser_input.execute({ browserSessionId: 'session-A', browserTabId: 'tab-1', confirm: false, event: {} }),
    (err) => err.code === 'confirmation-required',
  );
  const result = await tools.browser_input.execute({
    browserSessionId: 'session-A',
    browserTabId: 'tab-1',
    confirm: true,
    event: { kind: 'key', key: 'Enter' },
  });
  assert.equal(result.ok, true);
  assert.equal(manager.calls.filter((call) => call.method === 'dispatchInput').length, 1);
});

test('browser_open reuses the chat binding and creates a session only when needed', async () => {
  const manager = new FakeManager();
  const tools = toolsFor(manager);

  const created = await tools.browser_open.execute({ url: 'https://example.test/a' });
  assert.equal(created.ok, true);
  const sessionId = created.browserSessionId;
  assert.equal(manager.sessions.get(sessionId).chatId, CHAT);
  assert.equal(manager.calls.some((call) => call.method === 'createSession'), true);

  manager.calls.length = 0;
  const reused = await tools.browser_open.execute({ url: 'https://example.test/b' });
  assert.equal(reused.browserSessionId, sessionId);
  assert.equal(manager.calls.some((call) => call.method === 'createSession'), false);
  const navigation = manager.calls.find((call) => call.method === 'navigate');
  assert.equal(navigation.url, 'https://example.test/b');
});

test('runtime registration round-trips and clears', () => {
  const manager = new FakeManager();
  configureBrowserAgentRuntime({ manager });
  assert.equal(getBrowserAgentRuntime().manager, manager);
  configureBrowserAgentRuntime(null);
  assert.equal(getBrowserAgentRuntime(), null);
});

test('server.js registers the runtime and the SDK merges the browser tools', () => {
  const server = read('server.js');
  assert.match(server, /import \{ configureBrowserAgentRuntime \} from '\.\/lib\/browser\/agent-tools\.js'/);
  assert.match(server, /configureBrowserAgentRuntime\(\{\s*manager:\s*browserManager\s*\}\)/);

  const sdk = read('lib/sdk/cursor-agent-sdk-ws.js');
  assert.match(sdk, /buildBrowserAgentTools\(/);
  assert.match(sdk, /\.\.\.browserTools/);
});

test('browser_elements is a read tool bounded by the caller limit', async () => {
  const manager = new FakeManager();
  manager.addSession({ id: 'session-A', chatId: CHAT });
  const plan = toolsFor(manager, { mode: 'plan' });
  assert.ok(plan.browser_elements, 'browser_elements must be available in plan mode');
  assert.equal(toolsFor(manager, { mode: 'agent', assignment: 'review' }).browser_elements !== undefined, true);

  const result = await plan.browser_elements.execute({ browserSessionId: 'session-A', browserTabId: 'tab-1', limit: 25 });
  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
  assert.equal(result.elements[0].name, 'Save');
  const call = manager.calls.find((entry) => entry.method === 'getVisibleElements');
  assert.equal(call.scope.limit, 25);
  await assert.rejects(
    () => plan.browser_elements.execute({ browserSessionId: 'session-A' }),
    (err) => err.code === 'explicit-target-required',
  );
});

test('browser_screenshot returns a temp file path instead of inline base64', async () => {
  const manager = new FakeManager();
  manager.addSession({ id: 'session-A', chatId: CHAT });
  const tools = toolsFor(manager);
  const shot = await tools.browser_screenshot.execute({ browserSessionId: 'session-A', browserTabId: 'tab-1' });
  assert.equal(shot.ok, true);
  assert.equal(shot.frame.data, undefined);
  assert.equal(shot.frame.width, 390);
  assert.match(shot.frame.path, /\.jpg$/);
  try {
    assert.equal(readFileSync(shot.frame.path, 'utf8'), 'jpeg');
  } finally {
    rmSync(path.dirname(shot.frame.path), { recursive: true, force: true });
  }
});

test('browser_input forwards click and fill locator events to the manager', async () => {
  const manager = new FakeManager();
  manager.addSession({ id: 'session-A', chatId: CHAT });
  const tools = toolsFor(manager);
  const event = { kind: 'click', role: 'button', name: 'Save' };
  const result = await tools.browser_input.execute({
    browserSessionId: 'session-A',
    browserTabId: 'tab-1',
    confirm: true,
    event,
  });
  assert.equal(result.ok, true);
  const call = manager.calls.find((entry) => entry.method === 'dispatchInput');
  assert.deepEqual(call.event, event);
  assert.match(tools.browser_input.inputSchema.properties.event.description, /click\|fill/);
});

