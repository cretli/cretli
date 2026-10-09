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

import './helpers/isolated-data-dir.js';
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
import {
  BrowserError,
  BROWSER_INPUT_KINDS,
  BROWSER_NAVIGATION_WAIT_UNTIL,
} from '../lib/browser/session-manager.js';
import { BROWSER_LIMITS } from '../lib/browser/constants.js';
import { saveChats } from '../lib/persist/chats-persist.js';

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

  clearChatBinding(chatId, sessionId = '') {
    const id = String(chatId || '').trim();
    if (!id) return false;
    const pointer = this.chatBindings.get(id);
    if (!pointer) return false;
    if (sessionId && pointer !== String(sessionId)) return false;
    this.chatBindings.delete(id);
    const session = this.sessions.get(pointer);
    if (session && session.chatId === id) session.chatId = '';
    this.calls.push({ method: 'clearChatBinding', chatId: id, sessionId: pointer });
    return true;
  }

  async closeSession(sessionId, ownerSessionId, options = {}) {
    const session = this.requireSession(sessionId, ownerSessionId, options.scope || {});
    this.sessions.delete(sessionId);
    if (session.chatId) this.chatBindings.delete(session.chatId);
    this.calls.push({ method: 'closeSession', sessionId, reason: options.reason });
    return { closed: true, reason: options.reason || 'closed' };
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

  async navigate(sessionId, tabId, url, ownerSessionId, scope = {}, options = {}) {
    const { tab } = this.requireTab(sessionId, tabId, ownerSessionId, scope);
    tab.url = url;
    this.calls.push({ method: 'navigate', sessionId, tabId, url, scope, options });
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

test('browser_sessions lists own and unbound sessions, not foreign chats', async () => {
  const manager = new FakeManager();
  manager.addSession({ id: 'session-A', chatId: CHAT });
  manager.addSession({ id: 'session-B', chatId: 'chat-other' });
  manager.addSession({ id: 'session-C', chatId: '' });
  const tools = toolsFor(manager);
  const result = await tools.browser_sessions.execute();
  assert.deepEqual(
    result.browserSessions.map((session) => session.browserSessionId).sort(),
    ['session-A', 'session-C'],
  );
  const own = result.browserSessions.find((session) => session.browserSessionId === 'session-A');
  const unbound = result.browserSessions.find((session) => session.browserSessionId === 'session-C');
  assert.equal(own.binding, 'own');
  assert.equal(unbound.binding, 'unbound');
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

test('browser_open clears a stale chat binding instead of dead-ending on an unusable session', async () => {
  const manager = new FakeManager();
  // The chat points at a session the calling owner can no longer use: it is
  // still live but belongs to another Cretli session, so requireSession throws.
  // Pre-fix browser_open surfaced that 403 as a dead-end; it must drop the
  // pointer and fall through to the normal adopt-or-create path.
  manager.addSession({ id: 'session-foreign', ownerSessionId: 'owner-2', chatId: CHAT });
  const tools = toolsFor(manager);

  const result = await tools.browser_open.execute({ url: 'https://example.test/stale-binding' });

  assert.equal(result.ok, true);
  assert.notEqual(result.browserSessionId, 'session-foreign');
  assert.equal(
    manager.calls.some((call) => call.method === 'clearChatBinding' && call.sessionId === 'session-foreign'),
    true,
    'the stale pointer must be cleared before continuing',
  );
  // The binding now resolves to the fresh, usable session the tool just created.
  assert.equal(manager.resolveChatBinding(CHAT)?.browserSessionId, result.browserSessionId);
  assert.equal(manager.calls.some((call) => call.method === 'createSession'), true);
  // Scope never widened: the foreign session was neither adopted nor reused, only unbound.
  assert.equal(manager.sessions.get('session-foreign').chatId, '');
});

test('browser_open does not clear an ancestor binding when that session is forbidden to the child', async () => {
  const ancestorChatId = 'chat-ancestor';
  const childChatId = 'chat-child';
  saveChats([
    { id: childChatId, forkParentChatId: ancestorChatId },
    { id: ancestorChatId },
  ]);
  const manager = new FakeManager();
  manager.addSession({
    id: 'session-foreign',
    ownerSessionId: 'owner-2',
    chatId: ancestorChatId,
  });
  const tools = toolsFor(manager, { chatId: childChatId });

  const result = await tools.browser_open.execute({ url: 'https://example.test/child-adopt' });

  assert.equal(result.ok, true);
  assert.notEqual(result.browserSessionId, 'session-foreign');
  assert.equal(
    manager.resolveChatBinding(ancestorChatId)?.browserSessionId,
    'session-foreign',
    'ancestor chat binding must remain untouched',
  );
  assert.equal(manager.sessions.get('session-foreign').chatId, ancestorChatId);
  assert.equal(
    manager.calls.some((call) => call.method === 'clearChatBinding' && call.chatId === ancestorChatId),
    false,
    'must not clear another chat pointer',
  );
  assert.equal(manager.calls.some((call) => call.method === 'createSession'), true);
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
  // A room with no live user must act as the system owner, not as the last
  // login session that attached to the chat.
  assert.match(sdk, /resolveBrowserChatOwner\(browserChatId, runtime\?\.manager\)/);
  assert.match(sdk, /chat\?\.widgetInstallationId \? '' : BROWSER_SYSTEM_OWNER_ID/);
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

test('browser_close tears down an accessible session', async () => {
  const manager = new FakeManager();
  manager.addSession({ id: 'session-A', chatId: CHAT });
  const tools = toolsFor(manager);
  const result = await tools.browser_close.execute({ browserSessionId: 'session-A' });
  assert.equal(result.ok, true);
  assert.equal(result.closed, true);
  assert.equal(manager.sessions.has('session-A'), false);
  assert.equal(manager.calls.some((call) => call.method === 'closeSession'), true);
});

test('browser_close is not exposed in plan or review mode', () => {
  const manager = new FakeManager();
  assert.equal(toolsFor(manager, { mode: 'plan' }).browser_close, undefined);
  assert.equal(toolsFor(manager, { mode: 'agent', assignment: 'review' }).browser_close, undefined);
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

test('browser_input declares every kind and its fields on the event schema', () => {
  const manager = new FakeManager();
  manager.addSession({ id: 'session-A', chatId: CHAT });
  const event = toolsFor(manager).browser_input.inputSchema.properties.event;

  // A schema-driven harness must be able to discover the shape without reading code.
  assert.equal(event.type, 'object');
  assert.ok(event.properties && typeof event.properties === 'object', 'event needs properties');
  assert.deepEqual([...event.properties.kind.enum], [...BROWSER_INPUT_KINDS]);
  for (const kind of ['pointer', 'scroll', 'key', 'resize', 'click', 'fill', 'select', 'check',
    'uncheck', 'hover', 'drag', 'upload', 'wait']) {
    assert.ok(event.properties.kind.enum.includes(kind), `kind ${kind} is enumerated`);
  }

  const fields = Object.keys(event.properties);
  for (const field of [
    'selector', 'role', 'name', 'text', 'label', 'placeholder', 'nth', 'index',
    'action', 'key', 'value', 'delay', 'point', 'preview', 'viewport', 'button', 'clickCount',
    'deltaX', 'deltaY',
    'optionLabel', 'optionIndex',
    'toSelector', 'toRole', 'toName', 'toText', 'toLabel', 'toPlaceholder', 'toNth',
    'files',
    'state', 'loadState', 'url', 'timeout',
  ]) {
    assert.ok(fields.includes(field), `event field ${field} is documented`);
  }

  // The option label is a separate field because `label` already names a locator.
  assert.notEqual(event.properties.optionLabel, undefined);
  assert.match(event.properties.label.description, /optionLabel/);
  // The documented caps come from the shared constants, not from prose.
  assert.match(event.properties.files.description, new RegExp(String(BROWSER_LIMITS.MAX_UPLOAD_FILES)));
  assert.match(event.properties.timeout.description, new RegExp(String(BROWSER_LIMITS.MAX_WAIT_TIMEOUT_MS)));
  assert.match(event.properties.delay.description, new RegExp(String(BROWSER_LIMITS.MAX_INPUT_DELAY_MS)));
  assert.match(event.properties.state.enum.join('|'), /attached\|detached\|visible\|hidden/);
  assert.match(event.properties.loadState.enum.join('|'), /load\|domcontentloaded\|networkidle/);
  // There is no field that would evaluate script.
  assert.equal(event.properties.expression, undefined);
  assert.equal(event.properties.function, undefined);
  assert.equal(event.properties.eval, undefined);

  // `index` is the alias `browser_elements` hands back, so it must be documented.
  assert.match(event.properties.index.description, /browser_elements/);

  // The tool description names the new kinds too.
  const description = toolsFor(manager).browser_input.description;
  for (const kind of ['select', 'check', 'uncheck', 'hover', 'drag', 'upload', 'wait']) {
    assert.match(description, new RegExp(kind));
  }
  assert.match(description, /pointer, scroll, key/);
});

test('browser_navigate exposes and forwards the closed waitUntil allowlist', async () => {
  const manager = new FakeManager();
  manager.addSession({ id: 'session-A', chatId: CHAT });
  const tools = toolsFor(manager);
  const waitUntil = tools.browser_navigate.inputSchema.properties.waitUntil;
  assert.equal(waitUntil.type, 'string');
  assert.deepEqual([...waitUntil.enum], [...BROWSER_NAVIGATION_WAIT_UNTIL]);
  assert.ok(!tools.browser_navigate.inputSchema.required.includes('waitUntil'), 'waitUntil is optional');

  await tools.browser_navigate.execute({
    browserSessionId: 'session-A',
    browserTabId: 'tab-1',
    url: 'https://example.test/done',
    waitUntil: 'networkidle',
  });
  const call = manager.calls.find((entry) => entry.method === 'navigate');
  assert.deepEqual(call.options, { waitUntil: 'networkidle' });

  // Omitted: the manager keeps its default, so nothing extra is forwarded.
  await tools.browser_navigate.execute({ browserSessionId: 'session-A', browserTabId: 'tab-1', url: 'https://example.test/x' });
  const second = manager.calls.filter((entry) => entry.method === 'navigate').at(-1);
  assert.deepEqual(second.options, { waitUntil: undefined });
});

