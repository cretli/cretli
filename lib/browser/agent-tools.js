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
 * - CDP debugger tools use a dedicated CDP session per tab (separate from
 *   screencast/navigation); mutations need `confirm:true` like `browser_input`;
 * - `browser_evaluate`, WebRTC streaming and persistent cookies/storageState are
 *   intentionally not part of this namespace.
 *
 * The Browser module bounds SSRF but is not a complete network boundary (see
 * SECURITY.md); tool descriptions must not promise otherwise.
 */

import {
  BrowserError,
  BROWSER_ELEMENTS_DEFAULT_LIMIT,
  BROWSER_ELEMENTS_MAX_LIMIT,
  BROWSER_INPUT_KINDS,
  BROWSER_NAVIGATION_WAIT_UNTIL,
  BROWSER_WAIT_STATES,
  BROWSER_LOAD_STATES,
} from './session-manager.js';
import { saveBrowserScreenshot } from './screenshot-file.js';
import { BROWSER_LIMITS } from './constants.js';
import { assertBrowserActionAllowed, hasExplicitBrowserTarget } from './guards.js';
import {
  classifyBrowserSessionBinding,
  isBrowserSessionVisibleToChat,
  resolveChatBindingOnFamily,
} from './chat-browser-scope.js';
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
  'browser_debugger_state',
  'browser_debugger_stack',
  'browser_debugger_scopes',
  'browser_debugger_script_source',
]);

/** Mutating tool names (plan/ask/review must never receive them). */
export const BROWSER_AGENT_MUTATION_TOOLS = Object.freeze([
  'browser_open',
  'browser_navigate',
  'browser_input',
  'browser_close',
  'browser_debugger_pause',
  'browser_debugger_resume',
  'browser_debugger_set_breakpoint',
  'browser_debugger_remove_breakpoint',
  'browser_debugger_watch',
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
 * Reserved owner id for runs with no signed-in UI attached (autopilot/watcher
 * cycles, delegations, chats after a restart before the UI reconnects). It is
 * not a Cretli login session id (48 hex chars from `createSession()`), so it
 * can never collide with a user. Sessions created under it get a fresh Chromium
 * context and are invisible to `/api/browser/sessions`, which lists by the real
 * login session id.
 *
 * The system owner is one reserved id, so its sessions share
 * `MAX_SESSIONS_PER_OWNER` (concurrent UI-less runs are bounded by that cap).
 */
export const BROWSER_SYSTEM_OWNER_ID = 'cretli-browser-system-owner';

/**
 * @param {unknown} ownerSessionId
 * @returns {boolean}
 */
export function isBrowserSystemOwner(ownerSessionId) {
  return String(ownerSessionId ?? '').trim() === BROWSER_SYSTEM_OWNER_ID;
}

/**
 * Live signed-in UI attachments per chat: chatId -> (login session -> open
 * authenticated WebSocket count). Only a live entry may pick a user as the
 * owner; a remembered-but-disconnected session would let a later UI-less run
 * act with that user's cookies, which the system owner exists to prevent.
 * @type {Map<string, Map<string, number>>}
 */
const liveChatOwners = new Map();

/**
 * chatId -> login session of the newest live attachment. Kept alongside the
 * refcounts so `resolveBrowserChatOwner` stays a cheap string lookup, and
 * bounded like the old remembered map (oldest entries dropped first).
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
  let owners = liveChatOwners.get(id);
  if (!owners) {
    owners = new Map();
    liveChatOwners.set(id, owners);
  }
  owners.set(owner, (owners.get(owner) || 0) + 1);
  // Newest attach wins, matching the previous contract.
  chatOwners.delete(id);
  chatOwners.set(id, owner);
  while (chatOwners.size > MAX_REMEMBERED_CHAT_OWNERS) {
    const oldest = chatOwners.keys().next().value;
    chatOwners.delete(oldest);
    liveChatOwners.delete(oldest);
  }
}

/**
 * Drops one live attachment. Called from the authenticated agent WebSocket
 * `close` handler, so a chat is owned by a user only while the UI is attached.
 * @param {unknown} chatId
 * @param {unknown} ownerSessionId
 */
export function forgetBrowserChatOwner(chatId, ownerSessionId) {
  const id = String(chatId ?? '').trim();
  const owner = String(ownerSessionId ?? '').trim();
  if (!id || !owner) return;
  const owners = liveChatOwners.get(id);
  if (!owners) return;
  const remaining = (owners.get(owner) || 0) - 1;
  if (remaining > 0) owners.set(owner, remaining);
  else owners.delete(owner);
  if (owners.size === 0) {
    liveChatOwners.delete(id);
    chatOwners.delete(id);
    return;
  }
  if (chatOwners.get(id) === owner) {
    chatOwners.delete(id);
    const next = [...owners.keys()].at(-1);
    if (next) chatOwners.set(id, next);
  }
}

/**
 * Signed-in owner session currently attached to a chat, or ''.
 *
 * Only a live UI attachment may select a user login session. A user-owned
 * browser binding left on the chat after disconnect does not count — callers
 * then get '' and fall back to `BROWSER_SYSTEM_OWNER_ID`. A system session
 * bound by an earlier UI-less run is returned when no user UI is live, so
 * autopilot/delegation runs keep the same isolated Chromium context until a
 * user opens the chat and live attachment moves ownership back to them.
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
  const liveOwner = String(chatOwners.get(id) || '').trim();
  if (liveOwner) return liveOwner;
  if (boundOwner && isBrowserSystemOwner(boundOwner)) return boundOwner;
  return '';
}

export function resetBrowserChatOwnersForTests() {
  chatOwners.clear();
  liveChatOwners.clear();
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
  if (boundChatId && !isBrowserSessionVisibleToChat(ctx.chatId, boundChatId)) {
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
        'List Browser sessions this chat may use in the current workspace: bound here, '
        + 'bound to a fork parent, or unbound (adoptable via browser_open). '
        + 'Returns explicit browserSessionId values for the other browser_* tools. '
        + NETWORK_BOUNDARY_NOTE,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => {
        assertAction(ctx, 'list-sessions');
        const browserSessions = [];
        for (const session of ctx.manager.listSessions(ctx.ownerSessionId, ctx.scope)) {
          const meta = classifyBrowserSessionBinding(ctx.chatId, session.chatId);
          if (!meta) continue;
          browserSessions.push({
            ...session,
            binding: meta.binding,
            ancestorChatId: meta.ancestorChatId,
          });
        }
        return { ok: true, browserSessions, count: browserSessions.length, wsPath: '/ws-browser' };
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
        + 'Read-only. Prefer this over reading screenshot pixels: drive browser_input click/fill/'
        + 'select/check/uncheck/hover with the returned role+name / text / label / placeholder, or '
        + 'with the returned selector; pass the returned `index` back as `index` to act on that '
        + 'exact match instead of the first one.',
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

    browser_debugger_state: {
      description:
        'Read CDP debugger state for an explicit Browser tab (pause reason, breakpoints). '
        + 'Read-only; uses a dedicated debugger CDP session separate from screencast.',
      inputSchema: {
        type: 'object',
        properties: {
          browserSessionId: { type: 'string' },
          browserTabId: { type: 'string' },
        },
        required: ['browserSessionId', 'browserTabId'],
        additionalProperties: false,
      },
      execute: async (args = {}) => {
        assertAction(ctx, 'debugger-state');
        const { session, tab } = requireChatScopedTab(ctx, args);
        const state = await ctx.manager.debuggerState(session.id, tab.id, ctx.ownerSessionId, ctx.scope);
        return state;
      },
    },

    browser_debugger_stack: {
      description:
        'Read redacted stack frames while the tab debugger is paused. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          browserSessionId: { type: 'string' },
          browserTabId: { type: 'string' },
          callFrameId: { type: 'string', description: 'Optional paused call frame id.' },
        },
        required: ['browserSessionId', 'browserTabId'],
        additionalProperties: false,
      },
      execute: async (args = {}) => {
        assertAction(ctx, 'debugger-stack');
        const { session, tab } = requireChatScopedTab(ctx, args);
        return ctx.manager.debuggerStack(session.id, tab.id, ctx.ownerSessionId, {
          callFrameId: args.callFrameId,
          ...ctx.scope,
        });
      },
    },

    browser_debugger_scopes: {
      description:
        'Read redacted lexical scopes for a paused call frame. Read-only; bounded depth and size.',
      inputSchema: {
        type: 'object',
        properties: {
          browserSessionId: { type: 'string' },
          browserTabId: { type: 'string' },
          callFrameId: { type: 'string' },
        },
        required: ['browserSessionId', 'browserTabId'],
        additionalProperties: false,
      },
      execute: async (args = {}) => {
        assertAction(ctx, 'debugger-scopes');
        const { session, tab } = requireChatScopedTab(ctx, args);
        return ctx.manager.debuggerScopes(session.id, tab.id, ctx.ownerSessionId, {
          callFrameId: args.callFrameId,
          ...ctx.scope,
        });
      },
    },

    browser_debugger_script_source: {
      description:
        'Fetch bounded, redacted script source for a scriptId from the debugger session. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          browserSessionId: { type: 'string' },
          browserTabId: { type: 'string' },
          scriptId: { type: 'string' },
        },
        required: ['browserSessionId', 'browserTabId', 'scriptId'],
        additionalProperties: false,
      },
      execute: async (args = {}) => {
        assertAction(ctx, 'debugger-script-source');
        const { session, tab } = requireChatScopedTab(ctx, args);
        const scriptId = requireString(args.scriptId, 'scriptId');
        return ctx.manager.debuggerScriptSource(session.id, tab.id, ctx.ownerSessionId, scriptId, ctx.scope);
      },
    },
  };
}

/**
 * @param {object} ctx
 * @param {Record<string, unknown>} args
 */
function requireMutationConfirm(args) {
  if (args.confirm !== true) {
    throw new BrowserError(
      'confirmation-required',
      'This browser debugger mutation requires confirm:true',
      400,
    );
  }
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
          const binding = resolveChatBindingOnFamily(ctx.manager, ctx.chatId);
          if (binding?.browserSessionId) {
            try {
              session = requireChatScopedSession(ctx, binding.browserSessionId);
              sessionId = session.id;
            } catch (err) {
              // A chat binding can go stale: its session was closed, swept as
              // idle, lost in a restart, or belongs to another owner/workspace.
              // Drop only this chat's pointer (never the session) and fall
              // through to the normal adopt-or-create path below, instead of
              // dead-ending the whole call on a binding that cannot be used.
              if (!(err instanceof BrowserError)) throw err;
              if (trim(binding.fromChatId) === ctx.chatId) {
                ctx.manager.clearChatBinding(ctx.chatId, binding.browserSessionId);
              }
            }
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
          waitUntil: {
            type: 'string',
            enum: [...BROWSER_NAVIGATION_WAIT_UNTIL],
            description:
              `Optional navigation wait state (${BROWSER_NAVIGATION_WAIT_UNTIL.join('|')}); `
              + 'defaults to domcontentloaded. Anything else is a 400 error.',
          },
        },
        required: ['browserSessionId', 'browserTabId', 'url'],
        additionalProperties: false,
      },
      execute: async (args = {}) => {
        assertAction(ctx, 'navigate');
        const { session, tab } = requireChatScopedTab(ctx, args);
        const url = requireString(args.url, 'url');
        const state = await ctx.manager.navigate(
          session.id,
          tab.id,
          url,
          ctx.ownerSessionId,
          ctx.scope,
          { waitUntil: args.waitUntil },
        );
        return { ok: true, state };
      },
    },

    browser_input: {
      description:
        'Send an input event to an explicit Browser tab: pointer, scroll, key, click, fill, '
        + 'select, check, uncheck, hover, drag, upload, wait or resize. Mutates '
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
              'Input event; `kind` selects which one: '
              + `${BROWSER_INPUT_KINDS.join('|')}. `
              + 'The other fields are read only by the kinds that use them. '
              + 'Locator kinds (click, fill, select, check, uncheck, hover, drag source, '
              + 'upload) target an element by `selector`, or by `role`(+`name`) / `text` / `label` '
              + '/ `placeholder`; these locators pierce open shadow roots, so they work inside Lit '
              + 'components. `nth` (alias `index`, matching what browser_elements returns) picks '
              + 'which match; without it the first match is used.',
            // `kind` is a closed enum and the executor rejects an unknown kind with
            // `unsupported-input`; the schema stays open on purpose so a key the
            // executor ignores (or a field added later) is not a client-side error.
            additionalProperties: true,
            required: ['kind'],
            properties: {
              kind: { type: 'string', enum: [...BROWSER_INPUT_KINDS] },
              selector: { type: 'string', description: 'Locator kinds: CSS/Playwright selector.' },
              role: { type: 'string', description: 'Locator kinds: ARIA role (with `name`).' },
              name: { type: 'string', description: 'Locator kinds: accessible name for `role`.' },
              text: {
                type: 'string',
                description: 'Locator kinds: text to match. `wait`: text to wait for.',
              },
              label: { type: 'string', description: 'Locator kinds: form label. Not an option label — see `optionLabel`.' },
              placeholder: { type: 'string', description: 'Locator kinds: input placeholder.' },
              nth: { type: 'integer', minimum: 0, description: 'Which match to act on (0-based). Alias: `index`.' },
              index: { type: 'integer', minimum: 0, description: 'Alias of `nth`, matching the browser_elements `index` field.' },
              action: {
                type: 'string',
                description: 'pointer: click|move|down|up|tap. key: press|type|down|up.',
              },
              key: { type: 'string', description: 'key: key name for press/down/up.' },
              value: {
                anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
                description: 'fill: text to set. select: option value (an array selects several).',
              },
              delay: {
                type: 'integer',
                minimum: 0,
                description: `key + action:"type": per-character delay in ms (max ${BROWSER_LIMITS.MAX_INPUT_DELAY_MS}).`,
              },
              point: { type: 'object', description: 'pointer/scroll: { x, y } in preview/viewport coordinates.' },
              preview: { type: 'object', description: 'pointer/scroll: screenshot size { width, height } to scale `point` by.' },
              viewport: { type: 'object', description: 'resize: { width, height }.' },
              button: { type: 'string', description: 'pointer/click: left|right|middle.' },
              clickCount: { type: 'integer', minimum: 1, description: 'pointer/click: clicks per event.' },
              deltaX: { type: 'number', description: 'scroll: horizontal wheel delta.' },
              deltaY: { type: 'number', description: 'scroll: vertical wheel delta.' },
              optionLabel: {
                anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
                description: 'select: option visible text (array = several). Separate from the `label` locator field.',
              },
              optionIndex: {
                anyOf: [
                  { type: 'integer', minimum: 0 },
                  { type: 'array', items: { type: 'integer', minimum: 0 } },
                ],
                description: 'select: option position (array = several). Wins over `optionLabel` and `value`.',
              },
              toSelector: { type: 'string', description: 'drag destination: CSS/Playwright selector.' },
              toRole: { type: 'string', description: 'drag destination: ARIA role (with `toName`).' },
              toName: { type: 'string', description: 'drag destination: accessible name for `toRole`.' },
              toText: { type: 'string', description: 'drag destination: text to match.' },
              toLabel: { type: 'string', description: 'drag destination: form label.' },
              toPlaceholder: { type: 'string', description: 'drag destination: input placeholder.' },
              toNth: { type: 'integer', minimum: 0, description: 'drag destination: which match (0-based).' },
              files: {
                anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
                description:
                  `upload: server-side file path(s), at most ${BROWSER_LIMITS.MAX_UPLOAD_FILES}. `
                  + 'Every path must stay inside the workspace root after realpath; `..`, paths outside it '
                  + 'and symlink escapes are rejected with `upload-path-forbidden`.',
              },
              state: {
                type: 'string',
                enum: [...BROWSER_WAIT_STATES],
                description: 'wait: element state for `selector`/`text` (default visible).',
              },
              loadState: {
                type: 'string',
                enum: [...BROWSER_LOAD_STATES],
                description: 'wait: page load state to wait for (load|domcontentloaded|networkidle).',
              },
              url: { type: 'string', description: 'wait: URL glob pattern to wait for. No script or predicate.' },
              timeout: {
                type: 'integer',
                minimum: 1,
                description: `wait: bound in ms, clamped to ${BROWSER_LIMITS.MAX_WAIT_TIMEOUT_MS} (input events are serialized per tab).`,
              },
            },
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

    browser_debugger_pause: {
      description:
        'Pause JavaScript on an explicit Browser tab via CDP Debugger.pause. '
        + 'Agent mode only; requires confirm:true. Auto-resumes after a timeout if not consumed.',
      inputSchema: {
        type: 'object',
        properties: {
          browserSessionId: { type: 'string' },
          browserTabId: { type: 'string' },
          confirm: { type: 'boolean', description: 'Must be true to acknowledge the mutation.' },
        },
        required: ['browserSessionId', 'browserTabId', 'confirm'],
        additionalProperties: false,
      },
      execute: async (args = {}) => {
        assertAction(ctx, 'debugger-pause');
        requireMutationConfirm(args);
        const { session, tab } = requireChatScopedTab(ctx, args);
        return ctx.manager.debuggerPause(session.id, tab.id, ctx.ownerSessionId, ctx.scope);
      },
    },

    browser_debugger_resume: {
      description:
        'Resume JavaScript after a debugger pause. Agent mode only; requires confirm:true.',
      inputSchema: {
        type: 'object',
        properties: {
          browserSessionId: { type: 'string' },
          browserTabId: { type: 'string' },
          confirm: { type: 'boolean' },
        },
        required: ['browserSessionId', 'browserTabId', 'confirm'],
        additionalProperties: false,
      },
      execute: async (args = {}) => {
        assertAction(ctx, 'debugger-resume');
        requireMutationConfirm(args);
        const { session, tab } = requireChatScopedTab(ctx, args);
        return ctx.manager.debuggerResume(session.id, tab.id, ctx.ownerSessionId, ctx.scope);
      },
    },

    browser_debugger_set_breakpoint: {
      description:
        'Set a breakpoint with Debugger.setBreakpointByUrl (url + lineNumber). '
        + 'Agent mode only; requires confirm:true.',
      inputSchema: {
        type: 'object',
        properties: {
          browserSessionId: { type: 'string' },
          browserTabId: { type: 'string' },
          confirm: { type: 'boolean' },
          url: { type: 'string' },
          lineNumber: { type: 'integer', minimum: 0 },
          columnNumber: { type: 'integer', minimum: 0 },
          condition: { type: 'string' },
        },
        required: ['browserSessionId', 'browserTabId', 'confirm', 'url', 'lineNumber'],
        additionalProperties: false,
      },
      execute: async (args = {}) => {
        assertAction(ctx, 'debugger-set-breakpoint');
        requireMutationConfirm(args);
        const { session, tab } = requireChatScopedTab(ctx, args);
        return ctx.manager.debuggerSetBreakpoint(session.id, tab.id, ctx.ownerSessionId, {
          url: args.url,
          lineNumber: args.lineNumber,
          columnNumber: args.columnNumber,
          condition: args.condition,
        }, ctx.scope);
      },
    },

    browser_debugger_remove_breakpoint: {
      description:
        'Remove a debugger breakpoint by breakpointId. Agent mode only; requires confirm:true.',
      inputSchema: {
        type: 'object',
        properties: {
          browserSessionId: { type: 'string' },
          browserTabId: { type: 'string' },
          confirm: { type: 'boolean' },
          breakpointId: { type: 'string' },
        },
        required: ['browserSessionId', 'browserTabId', 'confirm', 'breakpointId'],
        additionalProperties: false,
      },
      execute: async (args = {}) => {
        assertAction(ctx, 'debugger-remove-breakpoint');
        requireMutationConfirm(args);
        const { session, tab } = requireChatScopedTab(ctx, args);
        const breakpointId = requireString(args.breakpointId, 'breakpointId');
        return ctx.manager.debuggerRemoveBreakpoint(
          session.id,
          tab.id,
          ctx.ownerSessionId,
          breakpointId,
          ctx.scope,
        );
      },
    },

    browser_debugger_watch: {
      description:
        'Evaluate a watch expression on a paused call frame (executes page code). '
        + 'Agent mode only; requires confirm:true — not equivalent to read-only DOM pulls.',
      inputSchema: {
        type: 'object',
        properties: {
          browserSessionId: { type: 'string' },
          browserTabId: { type: 'string' },
          confirm: { type: 'boolean' },
          expression: { type: 'string' },
          callFrameId: { type: 'string' },
        },
        required: ['browserSessionId', 'browserTabId', 'confirm', 'expression'],
        additionalProperties: false,
      },
      execute: async (args = {}) => {
        assertAction(ctx, 'debugger-watch');
        requireMutationConfirm(args);
        const { session, tab } = requireChatScopedTab(ctx, args);
        const expression = requireString(args.expression, 'expression');
        return ctx.manager.debuggerWatch(session.id, tab.id, ctx.ownerSessionId, expression, {
          callFrameId: args.callFrameId,
          ...ctx.scope,
        });
      },
    },

    browser_close: {
      description:
        'Close a Browser session this chat may access (including one bound to a fork parent). '
        + 'Frees the per-user session slot and tears down Chromium for that session. Agent mode only.',
      inputSchema: {
        type: 'object',
        properties: {
          browserSessionId: { type: 'string', description: 'Session id from browser_sessions.' },
        },
        required: ['browserSessionId'],
        additionalProperties: false,
      },
      execute: async (args = {}) => {
        assertAction(ctx, 'close-session');
        const sessionId = requireString(args.browserSessionId, 'browserSessionId');
        requireChatScopedSession(ctx, sessionId);
        const result = await ctx.manager.closeSession(sessionId, ctx.ownerSessionId, {
          reason: 'agent-close',
          scope: ctx.scope,
        });
        return { ok: true, browserSessionId: sessionId, ...result };
      },
    },
  };
}
