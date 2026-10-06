/**
 * Browser agent tools — the `browser_*` namespace for SDK agents.
 *
 * This namespace is deliberately separate from the widget `page_*` tools:
 * `page_*` inspects the host page through the embedded widget, while `browser_*`
 * drives isolated server-side Chromium sessions owned by the Browser module.
 *
 * Security contract (P1 vertical slice):
 * - every tab operation needs explicit `browserSessionId` + `browserTabId`;
 * - every call is scoped to the calling owner session, workspace and chat, so an
 *   empty id list can never widen the scope to other sessions/workspaces;
 * - plan/ask mode and review assignments expose read-only tools only and the
 *   executor re-checks the guard on every mutation (defense in depth);
 * - DOM snapshots are bounded/redacted by the session manager; Console/Network
 *   use the bounded cursor pull (`since`/`limit`), never raw bodies or HAR;
 * - `browser_evaluate`, the full CDP debugger, WebRTC streaming and persistent
 *   cookies/storageState are intentionally not part of this namespace.
 *
 * The Browser module bounds SSRF but is not a complete network boundary (see
 * SECURITY.md); tool descriptions must not promise otherwise.
 */

import {
  BrowserError,
  BROWSER_ELEMENTS_DEFAULT_LIMIT,
  BROWSER_ELEMENTS_MAX_LIMIT,
} from './session-manager.js';
import { saveBrowserScreenshot } from './screenshot-file.js';
import { assertBrowserActionAllowed, hasExplicitBrowserTarget } from './guards.js';
import { isReadOnlySdkMode } from '../sdk/sdk-mode.js';
import { isReviewReadOnlyAssignment } from '../delegation-review-policy.js';

/** Hard cap for Console/Network pulls per agent call (buffers clamp too). */
export const BROWSER_AGENT_PULL_LIMIT = 200;

/** Read-only tool names (available in every mode). */
export const BROWSER_AGENT_READ_TOOLS = Object.freeze([
  'browser_sessions',
  'browser_tabs',
  'browser_screenshot',
  'browser_console',
  'browser_network',
  'browser_dom',
  'browser_elements',
]);

/** Mutating tool names (plan/ask/review must never receive them). */
export const BROWSER_AGENT_MUTATION_TOOLS = Object.freeze([
  'browser_open',
  'browser_navigate',
  'browser_input',
]);

/**
 * The manager is registered once by the server so the SDK room builder can add
 * the browser_* tools without threading the manager through every harness.
 * Kept as an explicit getter so tests can build tools with their own manager.
 * @type {{ manager: import('./session-manager.js').BrowserSessionManager } | null}
 */
let browserAgentRuntime = null;

/**
 * @param {{ manager?: import('./session-manager.js').BrowserSessionManager } | null} runtime
 */
export function configureBrowserAgentRuntime(runtime = null) {
  browserAgentRuntime = runtime && runtime.manager ? { manager: runtime.manager } : null;
}

/** @returns {{ manager: import('./session-manager.js').BrowserSessionManager } | null} */
export function getBrowserAgentRuntime() {
  return browserAgentRuntime;
}

/** Upper bound for remembered chat owners (oldest entries are dropped first). */
const MAX_REMEMBERED_CHAT_OWNERS = 2000;

/**
 * chatId -> Cretli login session that last attached to the chat over an
 * authenticated (non-widget) WebSocket. Harness runs have no request of their
 * own, so this is how a browser_* call finds the user it acts for.
 * @type {Map<string, string>}
 */
const chatOwners = new Map();

/**
 * @param {unknown} chatId
 * @param {unknown} ownerSessionId
 */
export function rememberBrowserChatOwner(chatId, ownerSessionId) {
  const id = String(chatId ?? '').trim();
  const owner = String(ownerSessionId ?? '').trim();
  if (!id || !owner) return;
  chatOwners.delete(id);
  chatOwners.set(id, owner);
  while (chatOwners.size > MAX_REMEMBERED_CHAT_OWNERS) {
    chatOwners.delete(chatOwners.keys().next().value);
  }
}

/**
 * Owner session for a chat. The owner of the Browser session already bound to
 * the chat wins (the chat may be open on several devices); otherwise the last
 * login session that attached to the chat. '' keeps the tools fail-closed.
 * @param {unknown} chatId
 * @param {import('./session-manager.js').BrowserSessionManager | null} [manager]
 * @returns {string}
 */
export function resolveBrowserChatOwner(chatId, manager = browserAgentRuntime?.manager || null) {
  const id = String(chatId ?? '').trim();
  if (!id) return '';
  const boundSessionId = typeof manager?.resolveChatBinding === 'function'
    ? String(manager.resolveChatBinding(id)?.browserSessionId || '')
    : '';
  const boundOwner = boundSessionId && manager.sessions instanceof Map
    ? String(manager.sessions.get(boundSessionId)?.ownerSessionId || '').trim()
    : '';
  return boundOwner || chatOwners.get(id) || '';
}

export function resetBrowserChatOwnersForTests() {
  chatOwners.clear();
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string}
 */
function requireString(value, name) {
  const text = String(value ?? '').trim();
  if (!text) throw new BrowserError('invalid-argument', `${name} must be a non-empty string`, 400);
  return text;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function trim(value) {
  return String(value ?? '').trim();
}

/**
 * @param {number | string | undefined} value
 * @param {number} fallback
 * @returns {number}
 */
function clampLimit(value, fallback = BROWSER_AGENT_PULL_LIMIT) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(1, Math.floor(numeric)), BROWSER_AGENT_PULL_LIMIT);
}

/**
 * Builds the browser_* custom tools for one SDK run.
 *
 * Returns an empty object when the runtime, owner, chat or workspace is unknown:
 * the tools are fail-closed rather than silently widen the scope.
 *
 * @param {{
 *   manager?: import('./session-manager.js').BrowserSessionManager,
 *   mode?: string,
 *   assignment?: string,
 *   ownerSessionId?: string,
 *   chatId?: string,
 *   scope?: { workspaceFile?: string, workspaceFolder?: string, cwd?: string },
 * }} [input]
 * @returns {Record<string, { description: string, inputSchema: object, execute: (args?: any) => Promise<any> }>}
 */
export function buildBrowserAgentTools(input = {}) {
  const manager = input.manager;
  const mode = trim(input.mode) || 'agent';
  const ownerSessionId = trim(input.ownerSessionId);
  const chatId = trim(input.chatId);
  const scope = {
    workspaceFile: trim(input.scope?.workspaceFile),
    workspaceFolder: trim(input.scope?.workspaceFolder),
    cwd: trim(input.scope?.cwd),
  };
  const workspaceKey = scope.workspaceFile || scope.cwd;
  if (!manager || !ownerSessionId || !chatId || !workspaceKey) return {};

  const ctx = {
    manager,
    mode,
    assignment: trim(input.assignment),
    ownerSessionId,
    chatId,
    scope,
  };
  const readOnly = isReadOnlySdkMode(mode) || isReviewReadOnlyAssignment(ctx.assignment);

  const tools = buildReadTools(ctx);
  if (!readOnly) Object.assign(tools, buildMutationTools(ctx));
  return tools;
}

/**
 * @param {object} ctx
 * @param {string} action
 */
function assertAction(ctx, action) {
  assertBrowserActionAllowed({
    action,
    mode: ctx.mode,
    chatId: ctx.chatId,
    assignment: ctx.assignment,
  });
}

/**
 * @param {object} ctx
 * @param {string} sessionId
 * @returns {any}
 */
function requireChatScopedSession(ctx, sessionId) {
  const session = ctx.manager.requireSession(sessionId, ctx.ownerSessionId, ctx.scope);
  const boundChatId = trim(session.chatId);
  if (boundChatId && boundChatId !== ctx.chatId) {
    throw new BrowserError('forbidden-chat', 'Browser session belongs to another chat', 403);
  }
  if (!boundChatId) {
    // An unbound session from this owner/workspace is claimed for the calling
    // chat so a later read cannot drift into another chat scope.
    ctx.manager.bindChat(session.id, ctx.ownerSessionId, { chatId: ctx.chatId }, ctx.scope);
  }
  return session;
}

/**
 * @param {object} ctx
 * @param {Record<string, any>} args
 * @returns {{ session: any, tab: any }}
 */
function requireChatScopedTab(ctx, args = {}) {
  if (!hasExplicitBrowserTarget(args)) {
    throw new BrowserError(
      'explicit-target-required',
      'browserSessionId and browserTabId are required for this tool',
      400,
    );
  }
  const sessionId = requireString(args.browserSessionId, 'browserSessionId');
  const tabId = requireString(args.browserTabId, 'browserTabId');
  const session = requireChatScopedSession(ctx, sessionId);
  const tab = session.tabs instanceof Map ? session.tabs.get(tabId) : null;
  if (!tab) throw new BrowserError('tab-not-found', 'Browser tab not found', 404);
  return { session, tab };
}

/** Browser is not a full network boundary; keep the wording honest in every tool. */
const NETWORK_BOUNDARY_NOTE =
  'Browser enforces the workspace URL/SSRF policy but is not a complete network boundary (no egress proxy yet).';

/**
 * @param {object} ctx
 */
function buildReadTools(ctx) {
  return {
    browser_sessions: {
      description:
        'List server-side Browser sessions bound to the current chat and workspace. '
        + 'Returns explicit browserSessionId values for the other browser_* tools. '
        + NETWORK_BOUNDARY_NOTE,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => {
        assertAction(ctx, 'list-sessions');
        const sessions = ctx.manager
          .listSessions(ctx.ownerSessionId, ctx.scope)
          .filter((session) => trim(session.chatId) === ctx.chatId);
        return { ok: true, browserSessions: sessions, count: sessions.length, wsPath: '/ws-browser' };
      },
    },

    browser_tabs: {
      description:
        'List tabs of one chat-bound Browser session. Requires an explicit browserSessionId; '
        + 'tabs from another owner, workspace or chat are never returned.',
      inputSchema: {
        type: 'object',
        properties: {
          browserSessionId: { type: 'string', description: 'Browser session id from browser_sessions.' },
        },
        required: ['browserSessionId'],
        additionalProperties: false,
      },
      execute: async (args = {}) => {
        assertAction(ctx, 'list-tabs');
        const sessionId = requireString(args.browserSessionId, 'browserSessionId');
        requireChatScopedSession(ctx, sessionId);
        const tabs = ctx.manager.listTabs(sessionId, ctx.ownerSessionId, ctx.scope);
        return { ok: true, browserSessionId: sessionId, tabs };
      },
    },

    browser_screenshot: {
      description:
        'Capture a bounded JPEG screenshot of an explicit Browser tab. Read-only; rate limited '
        + 'to the same per-tab cap as the panel and never cached by the service worker.',
      inputSchema: {
        type: 'object',
        properties: {
          browserSessionId: { type: 'string' },
          browserTabId: { type: 'string' },
          quality: { type: 'number', description: 'JPEG quality 10-100 (default 84).' },
        },
        required: ['browserSessionId', 'browserTabId'],
        additionalProperties: false,
      },
      execute: async (args = {}) => {
        assertAction(ctx, 'screenshot');
        const { session, tab } = requireChatScopedTab(ctx, args);
        const frame = await ctx.manager.screenshot(session.id, tab.id, ctx.ownerSessionId, {
          quality: args.quality,
          ...ctx.scope,
        });
        // Keep the image out of the model context: every harness (SDK or MCP)
        // gets a private temp file path instead of an inline base64 blob.
        return { ok: true, frame: saveBrowserScreenshot(ctx.chatId, frame) };
      },
    },

    browser_console: {
      description:
        'Pull bounded, redacted Console entries for an explicit Browser tab using a since cursor. '
        + 'No live push here: call again with the returned nextSince to resume without duplicates.',
      inputSchema: {
        type: 'object',
        properties: {
          browserSessionId: { type: 'string' },
          browserTabId: { type: 'string' },
          since: { type: 'number', description: 'Last seen seq; omit for the oldest retained entries.' },
          limit: { type: 'number', description: `Max entries to return (<= ${BROWSER_AGENT_PULL_LIMIT}).` },
        },
        required: ['browserSessionId', 'browserTabId'],
        additionalProperties: false,
      },
      execute: async (args = {}) => {
        assertAction(ctx, 'console');
        const { session, tab } = requireChatScopedTab(ctx, args);
        const payload = ctx.manager.pullConsole(
          session.id,
          tab.id,
          ctx.ownerSessionId,
          { since: args.since, limit: clampLimit(args.limit) },
          ctx.scope,
        );
        return { ok: true, browserSessionId: session.id, browserTabId: tab.id, channel: 'console', ...payload };
      },
    },

    browser_network: {
      description:
        'Pull bounded, redacted Network metadata (no bodies, no HAR) for an explicit Browser tab '
        + 'using a since cursor. Call again with the returned nextSince to resume.',
      inputSchema: {
        type: 'object',
        properties: {
          browserSessionId: { type: 'string' },
          browserTabId: { type: 'string' },
          since: { type: 'number', description: 'Last seen seq; omit for the oldest retained entries.' },
          limit: { type: 'number', description: `Max entries to return (<= ${BROWSER_AGENT_PULL_LIMIT}).` },
        },
        required: ['browserSessionId', 'browserTabId'],
        additionalProperties: false,
      },
      execute: async (args = {}) => {
        assertAction(ctx, 'network');
        const { session, tab } = requireChatScopedTab(ctx, args);
        const payload = ctx.manager.pullNetwork(
          session.id,
          tab.id,
          ctx.ownerSessionId,
          { since: args.since, limit: clampLimit(args.limit) },
          ctx.scope,
        );
        return { ok: true, browserSessionId: session.id, browserTabId: tab.id, channel: 'network', ...payload };
      },
    },

    browser_dom: {
      description:
        'Read a bounded, redacted DOM snapshot of an explicit Browser tab. Read-only inspection '
        + '(no script evaluation, no selector execution beyond what the page already rendered).',
      inputSchema: {
        type: 'object',
        properties: {
          browserSessionId: { type: 'string' },
          browserTabId: { type: 'string' },
          maxBytes: { type: 'number', description: 'Upper bound for the returned HTML (1 KiB - 256 KiB).' },
        },
        required: ['browserSessionId', 'browserTabId'],
        additionalProperties: false,
      },
      execute: async (args = {}) => {
        assertAction(ctx, 'dom');
        const { session, tab } = requireChatScopedTab(ctx, args);
        const dom = await ctx.manager.getDom(session.id, tab.id, ctx.ownerSessionId, {
          ...ctx.scope,
          maxBytes: args.maxBytes,
        });
        return { ok: true, browserSessionId: session.id, browserTabId: tab.id, channel: 'dom', dom };
      },
    },

    browser_elements: {
      description:
        'List the visible interactive elements of an explicit Browser tab (links, buttons, inputs, '
        + 'selects, ARIA roles), including elements inside open shadow roots such as Lit components. '
        + 'Read-only. Prefer this over reading screenshot pixels: drive browser_input click/fill with '
        + 'the returned role+name / text / label / placeholder, or with the returned selector.',
      inputSchema: {
        type: 'object',
        properties: {
          browserSessionId: { type: 'string' },
          browserTabId: { type: 'string' },
          limit: {
            type: 'number',
            description: `Max elements to return (1-${BROWSER_ELEMENTS_MAX_LIMIT}, default ${BROWSER_ELEMENTS_DEFAULT_LIMIT}).`,
          },
        },
        required: ['browserSessionId', 'browserTabId'],
        additionalProperties: false,
      },
      execute: async (args = {}) => {
        assertAction(ctx, 'elements');
        const { session, tab } = requireChatScopedTab(ctx, args);
        const payload = await ctx.manager.getVisibleElements(session.id, tab.id, ctx.ownerSessionId, {
          ...ctx.scope,
          limit: args.limit,
        });
        return { ok: true, ...payload };
      },
    },
  };
}

/**
 * @param {object} ctx
 */
function buildMutationTools(ctx) {
  return {
    browser_open: {
      description:
        'Open an http(s) URL in the chat-bound Browser session, creating the session and/or a new '
        + 'tab when needed. Mutates browser state, so it is only available in agent mode. '
        + NETWORK_BOUNDARY_NOTE,
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute http(s) URL to open.' },
          browserSessionId: {
            type: 'string',
            description: 'Existing chat-bound session; omit to use or create the chat session.',
          },
          newTab: { type: 'boolean', description: 'Open the URL in a new tab instead of the active tab.' },
          activate: { type: 'boolean', description: 'Activate a newly created tab (default true).' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      execute: async (args = {}) => {
        assertAction(ctx, 'create-session');
        const url = requireString(args.url, 'url');

        let session = null;
        let sessionId = trim(args.browserSessionId);
        if (sessionId) {
          session = requireChatScopedSession(ctx, sessionId);
        } else {
          const binding = ctx.manager.resolveChatBinding(ctx.chatId);
          if (binding?.browserSessionId) {
            session = requireChatScopedSession(ctx, binding.browserSessionId);
            sessionId = session.id;
          }
        }

        if (!session) {
          // The panel creates unbound sessions and an owner may hold only a few
          // of them, so adopt the caller's unbound workspace session (keeping
          // the page state the user prepared there) before creating a new one.
          const unbound = ctx.manager
            .listSessions(ctx.ownerSessionId, ctx.scope)
            .find((candidate) => !trim(candidate.chatId));
          if (unbound?.browserSessionId) {
            session = requireChatScopedSession(ctx, unbound.browserSessionId);
            sessionId = session.id;
          }
        }

        if (!session) {
          const created = await ctx.manager.createSession({
            ownerSessionId: ctx.ownerSessionId,
            workspaceFile: ctx.scope.workspaceFile,
            workspaceFolder: ctx.scope.workspaceFolder,
            cwd: ctx.scope.cwd,
            chatId: ctx.chatId,
          });
          sessionId = created.browserSessionId;
          ctx.manager.bindChat(sessionId, ctx.ownerSessionId, { chatId: ctx.chatId }, ctx.scope);
          session = requireChatScopedSession(ctx, sessionId);
        }

        let tabId = '';
        if (args.newTab === true || !session.activeTabId) {
          const tab = await ctx.manager.createTab(
            sessionId,
            ctx.ownerSessionId,
            { url, activate: args.activate !== false },
            { scope: ctx.scope },
          );
          tabId = tab.browserTabId;
        } else {
          tabId = session.activeTabId;
          await ctx.manager.navigate(sessionId, tabId, url, ctx.ownerSessionId, ctx.scope);
        }

        const state = await ctx.manager.getState(sessionId, tabId, ctx.ownerSessionId, ctx.scope);
        return { ok: true, browserSessionId: sessionId, browserTabId: tabId, state };
      },
    },

    browser_navigate: {
      description:
        'Navigate an explicit Browser tab to an http(s) URL allowed by the workspace policy. '
        + 'Mutates browser state; agent mode only.',
      inputSchema: {
        type: 'object',
        properties: {
          browserSessionId: { type: 'string' },
          browserTabId: { type: 'string' },
          url: { type: 'string' },
        },
        required: ['browserSessionId', 'browserTabId', 'url'],
        additionalProperties: false,
      },
      execute: async (args = {}) => {
        assertAction(ctx, 'navigate');
        const { session, tab } = requireChatScopedTab(ctx, args);
        const url = requireString(args.url, 'url');
        const state = await ctx.manager.navigate(session.id, tab.id, url, ctx.ownerSessionId, ctx.scope);
        return { ok: true, state };
      },
    },

    browser_input: {
      description:
        'Send a pointer, scroll, key or resize input event to an explicit Browser tab. Mutates '
        + 'browser state; agent mode only and requires an explicit confirm:true acknowledgment.',
      inputSchema: {
        type: 'object',
        properties: {
          browserSessionId: { type: 'string' },
          browserTabId: { type: 'string' },
          confirm: {
            type: 'boolean',
            description: 'Must be true: acknowledges that this mutates the live page.',
          },
          event: {
            type: 'object',
            description:
              'Input event: { kind: pointer|scroll|key|resize|click|fill, ... }. Pointer points use '
              + 'preview/viewport coordinates. `click` and `fill` (fill takes `value`) target an '
              + 'element by `selector`, or by `role`+`name` / `text` / `label` / `placeholder`; '
              + 'these locators pierce open shadow roots, so they work inside Lit components.',
          },
        },
        required: ['browserSessionId', 'browserTabId', 'confirm', 'event'],
        additionalProperties: false,
      },
      execute: async (args = {}) => {
        assertAction(ctx, 'input');
        if (args.confirm !== true) {
          throw new BrowserError(
            'confirmation-required',
            'browser_input requires confirm:true to acknowledge the page mutation',
            400,
          );
        }
        const { session, tab } = requireChatScopedTab(ctx, args);
        const event = args.event && typeof args.event === 'object' ? args.event : {};
        const result = await ctx.manager.dispatchInput(
          session.id,
          tab.id,
          ctx.ownerSessionId,
          event,
          ctx.scope,
        );
        return { ok: true, browserSessionId: session.id, browserTabId: tab.id, result };
      },
    },
  };
}
