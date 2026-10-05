/**
 * browser_* over the builtin Cretli MCP catalog.
 *
 * Every harness gets the catalog, so these tests lock down what the MCP layer
 * adds on top of the Browser module (no Chromium is launched):
 * - the tools are listed with the right read-only / mutating split;
 * - the caller is resolved from the login session attached to the chat, and a
 *   delegated child inherits it from its fork parent;
 * - without an owner or a runtime the call fails closed;
 * - plan mode and review assignments cannot mutate;
 * - browser_open adopts the unbound session the user opened in the panel;
 * - screenshots come back as a file path, not as base64 text.
 */

import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { addChat } from '../lib/persist/chats-persist.js';
import { CRETILI_MCP_TOOL_DEFS, createCretliMcpToolHandlers } from '../lib/mcp/mcp-builtin-tools.js';
import { getBuiltinMcpMutatingTools, getBuiltinMcpReadTools } from '../lib/mcp/mcp-policy.js';
import {
  BROWSER_AGENT_MUTATION_TOOLS,
  BROWSER_AGENT_READ_TOOLS,
  configureBrowserAgentRuntime,
  rememberBrowserChatOwner,
  resetBrowserChatOwnersForTests,
  resolveBrowserChatOwner,
} from '../lib/browser/agent-tools.js';
import { BrowserError } from '../lib/browser/session-manager.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = mkdtempSync(path.join(os.tmpdir(), 'mcp-browser-ws-'));
const OWNER = 'login-session-1';

/** Minimal stand-in for BrowserSessionManager (same signatures the tools use). */
class FakeManager {
  constructor() {
    this.sessions = new Map();
    this.chatBindings = new Map();
    this.calls = [];
  }

  addSession({ id, ownerSessionId = OWNER, chatId = '' }) {
    const tabs = new Map([['tab-1', { id: 'tab-1', url: 'about:blank' }]]);
    this.sessions.set(id, { id, ownerSessionId, workspaceKey: workspace, chatId, activeTabId: 'tab-1', tabs });
    if (chatId) this.chatBindings.set(chatId, id);
  }

  requireSession(sessionId, ownerSessionId, scope = {}) {
    const session = this.sessions.get(String(sessionId || ''));
    if (!session) throw new BrowserError('not-found', 'Browser session not found', 404);
    if (!ownerSessionId || session.ownerSessionId !== ownerSessionId) {
      throw new BrowserError('forbidden-owner', 'Browser session belongs to another Cretli session', 403);
    }
    if ((scope.workspaceFile || scope.cwd || '') !== session.workspaceKey) {
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
    return { browserSessionId: session.id, chatId: session.chatId || null };
  }

  listSessions(ownerSessionId, scope = {}) {
    return [...this.sessions.values()]
      .filter((session) => session.ownerSessionId === ownerSessionId
        && session.workspaceKey === (scope.workspaceFile || scope.cwd || ''))
      .map((session) => this.summarizeSession(session));
  }

  bindChat(sessionId, ownerSessionId, input = {}, scope = {}) {
    const session = this.requireSession(sessionId, ownerSessionId, scope);
    session.chatId = String(input.chatId || '');
    this.chatBindings.set(session.chatId, session.id);
    return this.summarizeSession(session);
  }

  resolveChatBinding(chatId) {
    const id = this.chatBindings.get(String(chatId || ''));
    return id && this.sessions.has(id) ? { browserSessionId: id, chatId } : null;
  }

  async createSession(input) {
    this.calls.push({ method: 'createSession', input });
    if ([...this.sessions.values()].some((session) => session.ownerSessionId === input.ownerSessionId)) {
      throw new BrowserError('session-limit', 'Maximum 1 active Browser session per user/instance', 409);
    }
    const id = `session-${this.sessions.size + 1}`;
    this.addSession({ id, ownerSessionId: input.ownerSessionId });
    return { browserSessionId: id };
  }

  async navigate(sessionId, tabId, url, ownerSessionId, scope = {}) {
    const { tab } = this.requireTab(sessionId, tabId, ownerSessionId, scope);
    tab.url = url;
    this.calls.push({ method: 'navigate', sessionId, tabId, url });
    return { url };
  }

  async getState(sessionId, tabId, ownerSessionId, scope = {}) {
    const { tab } = this.requireTab(sessionId, tabId, ownerSessionId, scope);
    return { url: tab.url };
  }

  async getDom(sessionId, tabId, ownerSessionId, scope = {}) {
    this.requireTab(sessionId, tabId, ownerSessionId, scope);
    this.calls.push({ method: 'getDom', scope });
    return { html: '<html></html>', truncated: false, bytes: 13 };
  }

  async screenshot(sessionId, tabId, ownerSessionId, options = {}) {
    this.requireTab(sessionId, tabId, ownerSessionId, options);
    return {
      browserSessionId: sessionId,
      browserTabId: tabId,
      mimeType: 'image/jpeg',
      bytes: 4,
      width: 800,
      height: 600,
      data: Buffer.from('jpeg').toString('base64'),
      at: 1700000000000,
    };
  }
}

let chatCounter = 0;
/** @param {Record<string, unknown>} [extras] */
function newChat(extras = {}) {
  chatCounter += 1;
  return addChat(`browser-sess-${chatCounter}`, `Browser chat ${chatCounter}`, null, workspace, 'model', {
    agentTransport: 'codex',
    sdkMode: 'agent',
    ...extras,
  });
}

/** @param {{ id: string, sdkMode?: string }} chat */
function handlersFor(chat, mode = chat.sdkMode || 'agent') {
  return createCretliMcpToolHandlers({}, {
    chatId: chat.id,
    workspaceFolder: workspace,
    workspaceFile: '',
    harness: 'codex',
    mode,
  });
}

/** @type {FakeManager} */
let manager;

beforeEach(() => {
  manager = new FakeManager();
  configureBrowserAgentRuntime({ manager });
  resetBrowserChatOwnersForTests();
});

after(() => {
  configureBrowserAgentRuntime(null);
  resetBrowserChatOwnersForTests();
  rmSync(workspace, { recursive: true, force: true });
  removeIsolatedDataDir();
});

test('catalog lists every browser_* tool with the read-only split of the Browser module', () => {
  const names = CRETILI_MCP_TOOL_DEFS.map((tool) => tool.name);
  for (const name of [...BROWSER_AGENT_READ_TOOLS, ...BROWSER_AGENT_MUTATION_TOOLS]) {
    assert.ok(names.includes(name), name);
  }
  for (const name of BROWSER_AGENT_READ_TOOLS) assert.ok(getBuiltinMcpReadTools().includes(name), name);
  for (const name of BROWSER_AGENT_MUTATION_TOOLS) assert.ok(getBuiltinMcpMutatingTools().includes(name), name);
  const open = CRETILI_MCP_TOOL_DEFS.find((tool) => tool.name === 'browser_open');
  assert.match(open.description, /Cretli built-in Browser/);
  assert.match(open.description, /instead of launching your own Playwright/);
  assert.deepEqual(open.inputSchema.required, ['url']);
});

test('the login session attached to the chat is the browser owner; the newest attach wins', () => {
  rememberBrowserChatOwner('chat-x', 'login-a');
  rememberBrowserChatOwner('chat-x', 'login-b');
  rememberBrowserChatOwner('', 'login-c');
  rememberBrowserChatOwner('chat-y', '');
  assert.equal(resolveBrowserChatOwner('chat-x', manager), 'login-b');
  assert.equal(resolveBrowserChatOwner('chat-y', manager), '');
  // A session already bound to the chat keeps its own owner (other device).
  manager.addSession({ id: 'session-bound', ownerSessionId: 'login-a', chatId: 'chat-x' });
  assert.equal(resolveBrowserChatOwner('chat-x', manager), 'login-a');
});

test('ws-router remembers the owner only for an authenticated, non-widget socket', () => {
  const router = readFileSync(path.join(root, 'lib/ws/ws-router.js'), 'utf8');
  assert.match(router, /const sessionId = widgetAccess \? null : getSessionIdFromRequest\(req\);/);
  assert.match(router, /if \(sessionId && routedChat\?\.id\) rememberBrowserChatOwner\(routedChat\.id, sessionId\);/);
});

test('calls fail closed without an owner or without the runtime', async () => {
  const chat = newChat();
  const noOwner = await handlersFor(chat).browser_sessions({});
  assert.equal(noOwner.isError, true);
  assert.equal(noOwner.structuredContent.code, 'OUT_OF_SCOPE');
  assert.match(noOwner.structuredContent.error, /open this chat in the Cretli UI/);

  rememberBrowserChatOwner(chat.id, OWNER);
  configureBrowserAgentRuntime(null);
  const noRuntime = await handlersFor(chat).browser_sessions({});
  assert.equal(noRuntime.isError, true);
  assert.equal(noRuntime.structuredContent.code, 'HARNESS_UNAVAILABLE');
});

test('browser_open adopts the unbound panel session instead of hitting the session limit', async () => {
  const chat = newChat();
  rememberBrowserChatOwner(chat.id, OWNER);
  manager.addSession({ id: 'panel-session' });

  const opened = await handlersFor(chat).browser_open({ url: 'https://example.test/app' });
  assert.equal(opened.isError, false, opened.content[0].text);
  assert.equal(opened.structuredContent.browserSessionId, 'panel-session');
  assert.equal(opened.structuredContent.browserTabId, 'tab-1');
  assert.equal(manager.calls.some((call) => call.method === 'createSession'), false);
  assert.equal(manager.sessions.get('panel-session').chatId, chat.id);
  // Bridges forward only the text part, so it must carry the ids.
  assert.match(opened.content[0].text, /"browserSessionId":"panel-session"/);

  const listed = await handlersFor(chat).browser_sessions({});
  assert.deepEqual(listed.structuredContent.browserSessions.map((row) => row.browserSessionId), ['panel-session']);
});

test('a session bound to another chat is not adopted and the limit error explains why', async () => {
  const chat = newChat();
  rememberBrowserChatOwner(chat.id, OWNER);
  manager.addSession({ id: 'other-chat-session', chatId: 'another-chat' });

  const opened = await handlersFor(chat).browser_open({ url: 'https://example.test/' });
  assert.equal(opened.isError, true);
  assert.equal(opened.structuredContent.code, 'CONFLICT');
  assert.match(opened.structuredContent.error, /^session-limit: /);
  assert.match(opened.structuredContent.error, /bound to another chat/);
  assert.equal(manager.sessions.get('other-chat-session').chatId, 'another-chat');

  const foreign = await handlersFor(chat).browser_tabs({ browserSessionId: 'other-chat-session' });
  assert.equal(foreign.isError, true);
  assert.equal(foreign.structuredContent.code, 'OUT_OF_SCOPE');
  assert.match(foreign.structuredContent.error, /^forbidden-chat: /);
});

test('plan mode and review assignments read but never mutate', async () => {
  const planChat = newChat({ sdkMode: 'plan' });
  rememberBrowserChatOwner(planChat.id, OWNER);
  manager.addSession({ id: 'plan-session', chatId: planChat.id });
  const planHandlers = handlersFor(planChat, 'plan');
  const planOpen = await planHandlers.browser_open({ url: 'https://example.test/' });
  assert.equal(planOpen.structuredContent.code, 'PLAN_MODE_DENIED');
  const planDom = await planHandlers.browser_dom({ browserSessionId: 'plan-session', browserTabId: 'tab-1' });
  assert.equal(planDom.isError, false, planDom.content[0].text);
  assert.equal(manager.calls.find((call) => call.method === 'getDom').scope.maxBytes, 48 * 1024);

  const reviewChat = newChat({ delegationAssignment: 'review' });
  rememberBrowserChatOwner(reviewChat.id, OWNER);
  const reviewOpen = await handlersFor(reviewChat).browser_open({ url: 'https://example.test/' });
  assert.equal(reviewOpen.isError, true);
  assert.equal(reviewOpen.structuredContent.code, 'PLAN_MODE_DENIED');
  assert.equal(manager.calls.some((call) => call.method === 'navigate'), false);
});

test('a delegated child acts for the owner of its fork parent', async () => {
  const parent = newChat();
  const child = newChat({ forkParentChatId: parent.id, forkKind: 'delegation' });
  rememberBrowserChatOwner(parent.id, OWNER);

  const opened = await handlersFor(child).browser_open({ url: 'https://example.test/child' });
  assert.equal(opened.isError, false, opened.content[0].text);
  const created = manager.calls.find((call) => call.method === 'createSession');
  assert.equal(created.input.ownerSessionId, OWNER);
  assert.equal(created.input.chatId, child.id);
});

test('browser_screenshot returns a private file path instead of base64 text', async () => {
  const chat = newChat();
  rememberBrowserChatOwner(chat.id, OWNER);
  manager.addSession({ id: 'shot-session', chatId: chat.id });

  const shot = await handlersFor(chat).browser_screenshot({ browserSessionId: 'shot-session', browserTabId: 'tab-1' });
  assert.equal(shot.isError, false, shot.content[0].text);
  const file = shot.structuredContent.frame.path;
  try {
    assert.ok(existsSync(file), file);
    assert.equal(readFileSync(file, 'utf8'), 'jpeg');
    assert.equal(shot.structuredContent.frame.data, undefined);
    assert.match(shot.content[0].text, /Screenshot saved to .*\.jpg \(800x600/);
    assert.doesNotMatch(shot.content[0].text, /anBlZw==/);
  } finally {
    rmSync(path.dirname(file), { recursive: true, force: true });
  }
});
