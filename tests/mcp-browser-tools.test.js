/**
 * browser_* over the builtin Cretli MCP catalog.
 *
 * Every harness gets the catalog, so these tests lock down what the MCP layer
 * adds on top of the Browser module (no Chromium is launched):
 * - the tools are listed with the right read-only / mutating split;
 * - the caller is resolved from the login session attached to the chat, and a
 *   delegated child inherits it from its fork parent;
 * - a run with no attached UI gets the dedicated system owner, which is
 *   isolated from every login session, while a widget-only chat stays
 *   fail-closed;
 * - without a runtime the call fails closed;
 * - plan mode and review assignments cannot mutate;
 * - browser_open adopts the unbound session the user opened in the panel;
 * - browser_elements passes the numbered scan through, limit included;
 * - screenshots come back as a file path, not as base64 text, and one capture
 *   never writes two files.
 */

import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { addChat } from '../lib/persist/chats-persist.js';
import { CRETILI_MCP_TOOL_DEFS, createCretliMcpToolHandlers } from '../lib/mcp/mcp-builtin-tools.js';
import { getBuiltinMcpMutatingTools, getBuiltinMcpReadTools } from '../lib/mcp/mcp-policy.js';
import {
  BROWSER_AGENT_MUTATION_TOOLS,
  BROWSER_AGENT_READ_TOOLS,
  BROWSER_SYSTEM_OWNER_ID,
  configureBrowserAgentRuntime,
  forgetBrowserChatOwner,
  rememberBrowserChatOwner,
  resetBrowserChatOwnersForTests,
  resolveBrowserChatOwner,
} from '../lib/browser/agent-tools.js';
import {
  BROWSER_ELEMENTS_SELECTOR,
  BrowserError,
} from '../lib/browser/session-manager.js';
import { BROWSER_LIMITS } from '../lib/browser/constants.js';
import { browserScreenshotDir } from '../lib/browser/screenshot-file.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = mkdtempSync(path.join(os.tmpdir(), 'mcp-browser-ws-'));
const OWNER = 'login-session-1';

/**
 * Minimal stand-in for BrowserSessionManager (same signatures the tools use).
 * The session cap is read from `BROWSER_LIMITS` instead of a hardcoded number,
 * so this fake cannot silently diverge from production.
 */
class FakeManager {
  constructor() {
    this.sessions = new Map();
    this.chatBindings = new Map();
    this.calls = [];
    this.elements = [];
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
    const owned = [...this.sessions.values()].filter((session) => session.ownerSessionId === input.ownerSessionId).length;
    if (owned >= BROWSER_LIMITS.MAX_SESSIONS_PER_OWNER) {
      throw new BrowserError(
        'session-limit',
        `Maximum ${BROWSER_LIMITS.MAX_SESSIONS_PER_OWNER} active Browser sessions per user/instance`,
        409,
      );
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

  /**
   * Mirrors the shape of the real single-pass scan: `index` numbering for
   * `browser_input`, the shared interactive selector as the query, and the
   * `scope` it was called with so a test can see what the tool layer forwarded.
   */
  async getVisibleElements(sessionId, tabId, ownerSessionId, scope = {}) {
    this.requireTab(sessionId, tabId, ownerSessionId, scope);
    this.calls.push({ method: 'getVisibleElements', scope });
    const elements = this.elements.map((element, index) => ({ index, ...element }));
    return {
      browserSessionId: sessionId,
      browserTabId: tabId,
      channel: 'elements',
      elements,
      count: elements.length,
      scanned: elements.length,
      total: elements.length,
      truncated: false,
      selectorQueries: [BROWSER_ELEMENTS_SELECTOR],
    };
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
  const browserDefs = CRETILI_MCP_TOOL_DEFS.filter((tool) => tool.name.startsWith('browser_'));
  const names = browserDefs.map((tool) => tool.name);
  assert.deepEqual(
    [...names].sort(),
    [...BROWSER_AGENT_READ_TOOLS, ...BROWSER_AGENT_MUTATION_TOOLS].sort(),
    'the catalog holds exactly the Browser module tool set, with no extras and none missing',
  );
  assert.equal(new Set(names).size, names.length, 'no tool is registered twice');

  for (const name of BROWSER_AGENT_READ_TOOLS) assert.ok(getBuiltinMcpReadTools().includes(name), name);
  for (const name of BROWSER_AGENT_MUTATION_TOOLS) assert.ok(getBuiltinMcpMutatingTools().includes(name), name);
  // The split must stay exclusive: a mutating tool can never be advertised as
  // readable, or a plan/ask run would be allowed to drive the page.
  for (const name of BROWSER_AGENT_READ_TOOLS) assert.equal(getBuiltinMcpMutatingTools().includes(name), false, name);
  for (const name of BROWSER_AGENT_MUTATION_TOOLS) assert.equal(getBuiltinMcpReadTools().includes(name), false, name);

  for (const tool of browserDefs) {
    const isRead = BROWSER_AGENT_READ_TOOLS.includes(tool.name);
    // The public def carries the split as an MCP annotation, not a bare flag.
    assert.equal(tool.annotations.readOnlyHint, isRead, `${tool.name} readOnly hint`);
    assert.equal(tool.annotations.destructiveHint, false, tool.name);
    assert.match(tool.description, /Cretli built-in Browser/, tool.name);
    const schema = tool.inputSchema;
    assert.equal(schema.type, 'object', tool.name);
    assert.equal(schema.additionalProperties, false, `${tool.name} rejects unknown fields`);
    // `browser_sessions` takes no argument, so a missing `required` is valid.
    const required = schema.required || [];
    assert.ok(Array.isArray(required), tool.name);
    assert.deepEqual(required.filter((key) => !(key in schema.properties)), [], `${tool.name} required keys exist`);
  }

  // Every listed tool is actually callable through the handler map.
  const callChat = newChat();
  const handlers = handlersFor(callChat);
  for (const tool of browserDefs) {
    assert.equal(typeof handlers[tool.name], 'function', tool.name);
  }

  const open = CRETILI_MCP_TOOL_DEFS.find((tool) => tool.name === 'browser_open');
  assert.match(open.description, /instead of launching your own Playwright/);
  assert.deepEqual(open.inputSchema.required, ['url']);
  // Every tab read needs an explicit target, so a chat can never drift onto
  // another chat's session by omitting it.
  for (const name of ['browser_elements', 'browser_screenshot', 'browser_dom', 'browser_console', 'browser_network']) {
    const tool = CRETILI_MCP_TOOL_DEFS.find((entry) => entry.name === name);
    assert.deepEqual(tool.inputSchema.required, ['browserSessionId', 'browserTabId'], name);
  }
  const elements = CRETILI_MCP_TOOL_DEFS.find((tool) => tool.name === 'browser_elements');
  assert.deepEqual(Object.keys(elements.inputSchema.properties).sort(), ['browserSessionId', 'browserTabId', 'limit']);
});

test('the live login session attached to the chat is the browser owner; the newest attach wins', () => {
  rememberBrowserChatOwner('chat-x', 'login-a');
  rememberBrowserChatOwner('chat-x', 'login-b');
  rememberBrowserChatOwner('', 'login-c');
  rememberBrowserChatOwner('chat-y', '');
  assert.equal(resolveBrowserChatOwner('chat-x', manager), 'login-b');
  assert.equal(resolveBrowserChatOwner('chat-y', manager), '');
  // A stale user binding must not outrank the live UI attachment on the same chat.
  manager.addSession({ id: 'session-bound', ownerSessionId: 'login-a', chatId: 'chat-x' });
  assert.equal(resolveBrowserChatOwner('chat-x', manager), 'login-b');
});

test('a user browser binding without live UI does not resurrect that login owner', () => {
  manager.addSession({ id: 'session-stale', ownerSessionId: 'login-a', chatId: 'chat-stale-binding' });
  assert.equal(resolveBrowserChatOwner('chat-stale-binding', manager), '');
  rememberBrowserChatOwner('chat-stale-binding', 'login-a');
  assert.equal(resolveBrowserChatOwner('chat-stale-binding', manager), 'login-a');
});

test('disconnecting the last UI socket stops the chat from being user-owned', () => {
  rememberBrowserChatOwner('chat-live', 'login-a');
  rememberBrowserChatOwner('chat-live', 'login-b');
  forgetBrowserChatOwner('chat-live', 'login-a');
  assert.equal(resolveBrowserChatOwner('chat-live', manager), 'login-b');
  forgetBrowserChatOwner('chat-live', 'login-b');
  assert.equal(resolveBrowserChatOwner('chat-live', manager), '');
  // An over-forget never invents an owner and never throws.
  forgetBrowserChatOwner('chat-live', 'login-b');
  assert.equal(resolveBrowserChatOwner('chat-live', manager), '');
});

test('a live user outranks a system session left bound to the same chat', () => {
  manager.addSession({ id: 'system-bound', ownerSessionId: BROWSER_SYSTEM_OWNER_ID, chatId: 'chat-reopened' });
  // A user-owned binding would win even without a live socket; a system one
  // must not, so reopening the chat in the UI returns to the user's session.
  assert.equal(resolveBrowserChatOwner('chat-reopened', manager), BROWSER_SYSTEM_OWNER_ID);
  rememberBrowserChatOwner('chat-reopened', 'login-a');
  assert.equal(resolveBrowserChatOwner('chat-reopened', manager), 'login-a');
  forgetBrowserChatOwner('chat-reopened', 'login-a');
  assert.equal(resolveBrowserChatOwner('chat-reopened', manager), BROWSER_SYSTEM_OWNER_ID);
});

test('ws-router marks the owner live for authenticated, non-widget sockets and forgets it on close', () => {
  const router = readFileSync(path.join(root, 'lib/ws/ws-router.js'), 'utf8');
  assert.match(router, /const sessionId = widgetAccess \? null : getSessionIdFromRequest\(req\);/);
  assert.match(router, /rememberBrowserChatOwner\(routedChat\.id, sessionId\);/);
  assert.match(router, /ws\.on\('close', \(\) => forgetBrowserChatOwner\(routedChat\.id, sessionId\)\)/);
});

test('a run with no attached UI acts as the dedicated system owner', async () => {
  const chat = newChat();
  const listed = await handlersFor(chat).browser_sessions({});
  assert.equal(listed.isError, false, listed.content[0].text);
  assert.deepEqual(listed.structuredContent.browserSessions, []);

  const opened = await handlersFor(chat).browser_open({ url: 'https://example.test/system' });
  assert.equal(opened.isError, false, opened.content[0].text);
  const created = manager.calls.find((call) => call.method === 'createSession');
  assert.equal(created.input.ownerSessionId, BROWSER_SYSTEM_OWNER_ID);
  assert.notEqual(created.input.ownerSessionId, OWNER);
  assert.equal(
    manager.sessions.get(opened.structuredContent.browserSessionId).ownerSessionId,
    BROWSER_SYSTEM_OWNER_ID,
  );

  configureBrowserAgentRuntime(null);
  const noRuntime = await handlersFor(chat).browser_sessions({});
  assert.equal(noRuntime.isError, true);
  assert.equal(noRuntime.structuredContent.code, 'HARNESS_UNAVAILABLE');
});

test('a widget-only chat stays fail-closed instead of borrowing the system owner', async () => {
  const chat = newChat({ widgetInstallationId: 'widget-1' });
  const listed = await handlersFor(chat).browser_sessions({});
  assert.equal(listed.isError, true);
  assert.equal(listed.structuredContent.code, 'OUT_OF_SCOPE');
  assert.match(listed.structuredContent.error, /open this chat in the Cretli UI/);
  assert.equal(manager.calls.some((call) => call.method === 'createSession'), false);
});

test('the system owner and a signed-in user cannot reach each other sessions', async () => {
  const uiChat = newChat();
  const systemChat = newChat();
  rememberBrowserChatOwner(uiChat.id, OWNER);
  manager.addSession({ id: 'user-session', ownerSessionId: OWNER, chatId: uiChat.id });

  const opened = await handlersFor(systemChat).browser_open({ url: 'https://example.test/private' });
  assert.equal(opened.isError, false, opened.content[0].text);
  const systemSessionId = opened.structuredContent.browserSessionId;

  // A signed-in user must not address the system session, even by id.
  const foreign = await handlersFor(uiChat).browser_tabs({ browserSessionId: systemSessionId });
  assert.equal(foreign.isError, true);
  assert.equal(foreign.structuredContent.code, 'OUT_OF_SCOPE');
  assert.match(foreign.structuredContent.error, /^forbidden-owner: /);

  // And the reverse: the system-owned chat cannot read the user's session.
  const reverse = await handlersFor(systemChat).browser_screenshot({
    browserSessionId: 'user-session',
    browserTabId: 'tab-1',
  });
  assert.equal(reverse.isError, true);
  assert.equal(reverse.structuredContent.code, 'OUT_OF_SCOPE');
  assert.match(reverse.structuredContent.error, /^forbidden-owner: /);

  // The system session stays usable for its own chat.
  const own = await handlersFor(systemChat).browser_sessions({});
  assert.equal(own.isError, false, own.content[0].text);
  assert.deepEqual(
    own.structuredContent.browserSessions.map((row) => row.browserSessionId),
    [systemSessionId],
  );
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
  // Every session the owner holds is bound to a different chat, so there is
  // nothing left to adopt and the real per-user cap is what stops the open.
  for (let index = 0; index < BROWSER_LIMITS.MAX_SESSIONS_PER_OWNER; index += 1) {
    manager.addSession({ id: `session-${index}`, chatId: `other-chat-${index}` });
  }
  assert.equal(BROWSER_LIMITS.MAX_SESSIONS_PER_OWNER, 3, 'the fake follows the production cap');

  const opened = await handlersFor(chat).browser_open({ url: 'https://example.test/' });
  assert.equal(opened.isError, true);
  assert.equal(opened.structuredContent.code, 'CONFLICT');
  assert.match(opened.structuredContent.error, /^session-limit: /);
  assert.match(opened.structuredContent.error, /per-user Browser session cap/);
  assert.equal(manager.sessions.get('session-0').chatId, 'other-chat-0');

  const foreign = await handlersFor(chat).browser_tabs({ browserSessionId: 'session-0' });
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

test('a delegated child reuses a Browser session bound to its fork parent', async () => {
  const parent = newChat();
  const child = newChat({ forkParentChatId: parent.id, forkKind: 'delegation' });
  rememberBrowserChatOwner(parent.id, OWNER);
  manager.addSession({ id: 'parent-session', chatId: parent.id });
  manager.calls.length = 0;

  const opened = await handlersFor(child).browser_open({ url: 'https://example.test/reuse' });
  assert.equal(opened.isError, false, opened.content[0].text);
  assert.equal(manager.calls.some((call) => call.method === 'createSession'), false);
  const navigate = manager.calls.find((call) => call.method === 'navigate');
  assert.equal(navigate.url, 'https://example.test/reuse');
});

test('a delegated child without a UI owner falls through to the system owner', async () => {
  const parent = newChat();
  const child = newChat({ forkParentChatId: parent.id, forkKind: 'delegation' });
  // Nobody has this chat open: the fork walk finds no user and must not stop
  // at an empty result.
  const opened = await handlersFor(child).browser_open({ url: 'https://example.test/child-system' });
  assert.equal(opened.isError, false, opened.content[0].text);
  const created = manager.calls.find((call) => call.method === 'createSession');
  assert.equal(created.input.ownerSessionId, BROWSER_SYSTEM_OWNER_ID);
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

test('browser_screenshot persists exactly one frame per capture and reuses that path', async () => {
  const chat = newChat();
  rememberBrowserChatOwner(chat.id, OWNER);
  manager.addSession({ id: 'persist-session', chatId: chat.id });
  const dir = browserScreenshotDir(chat.id);
  const frames = () => (existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.jpg')) : []);

  try {
    assert.deepEqual(frames(), [], 'this chat has no saved frames yet');
    const first = await handlersFor(chat).browser_screenshot({
      browserSessionId: 'persist-session',
      browserTabId: 'tab-1',
    });
    assert.equal(first.isError, false, first.content[0].text);
    // The tool layer already persisted the frame, so the MCP layer must pass
    // that path through instead of writing the image a second time.
    assert.deepEqual(frames(), [path.basename(first.structuredContent.frame.path)]);
    assert.equal(existsSync(first.structuredContent.frame.path), true);
    assert.ok(
      first.content[0].text.startsWith(`Screenshot saved to ${first.structuredContent.frame.path} (`),
      `the text names the saved file: ${first.content[0].text}`,
    );

    const second = await handlersFor(chat).browser_screenshot({
      browserSessionId: 'persist-session',
      browserTabId: 'tab-1',
    });
    const saved = second.structuredContent.frame;
    assert.equal(saved.data, undefined, 'no inline base64 survives into the payload');
    assert.equal(saved.width, 800);
    assert.equal(saved.height, 600);
    assert.equal(saved.mimeType, 'image/jpeg');
    assert.equal(frames().length, 2, 'each capture adds its own file');
    assert.notEqual(saved.path, first.structuredContent.frame.path);

    // The structured part mirrors the text part for harnesses that read it.
    assert.equal(second.structuredContent.frame.path, saved.path);
    assert.equal(second.structuredContent.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('browser_elements reaches the agent through the MCP surface', async () => {
  const chat = newChat();
  rememberBrowserChatOwner(chat.id, OWNER);
  manager.addSession({ id: 'elements-session', chatId: chat.id });
  manager.elements = [
    { tag: 'button', role: 'button', name: 'Save', selector: '#save' },
    { tag: 'a', role: 'link', name: 'Docs', selector: 'a.docs' },
    { tag: 'input', role: 'textbox', name: 'Email', selector: '#email' },
  ];

  const listed = await handlersFor(chat).browser_elements({
    browserSessionId: 'elements-session',
    browserTabId: 'tab-1',
    limit: 3,
  });
  assert.equal(listed.isError, false, listed.content[0].text);
  assert.equal(listed.structuredContent.channel, 'elements');
  assert.equal(listed.structuredContent.count, 3);
  assert.deepEqual(
    listed.structuredContent.elements.map((row) => row.index),
    [0, 1, 2],
    'rows are numbered from zero so `index` can be passed back to browser_input',
  );
  assert.deepEqual(listed.structuredContent.elements.map((row) => row.name), ['Save', 'Docs', 'Email']);
  assert.deepEqual(listed.structuredContent.selectorQueries, [BROWSER_ELEMENTS_SELECTOR],
    'the scan runs on the shared interactive selector, never a caller-chosen one');
  assert.equal(manager.calls.at(-1).method, 'getVisibleElements');
  assert.equal(manager.calls.at(-1).scope.limit, 3, 'the requested limit is forwarded to the scan');
  // Bridges forward the text part only, so it has to carry the whole listing.
  assert.match(listed.content[0].text, /"channel":"elements"/);
  assert.match(listed.content[0].text, /"name":"Save"/);

  await handlersFor(chat).browser_elements({ browserSessionId: 'elements-session', browserTabId: 'tab-1' });
  assert.equal(manager.calls.at(-1).scope.limit, undefined, 'no limit must not become a bogus value');

  // It is a read tool: available to a plan run, and still scoped to this chat.
  const planList = await handlersFor(chat, 'plan').browser_elements({
    browserSessionId: 'elements-session',
    browserTabId: 'tab-1',
  });
  assert.equal(planList.isError, false, planList.content[0].text);

  const otherChat = newChat();
  rememberBrowserChatOwner(otherChat.id, OWNER);
  const foreign = await handlersFor(otherChat).browser_elements({
    browserSessionId: 'elements-session',
    browserTabId: 'tab-1',
  });
  assert.equal(foreign.isError, true);
  assert.match(foreign.structuredContent.error, /^forbidden-chat: /);

  const noTarget = await handlersFor(chat).browser_elements({ browserSessionId: 'elements-session' });
  assert.equal(noTarget.isError, true);
  assert.equal(noTarget.structuredContent.code, 'VALIDATION_ERROR');
  assert.match(noTarget.structuredContent.error, /^explicit-target-required: /);
});
