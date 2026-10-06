/**
 * Builtin Cretli MCP Browser tools.
 *
 * Exposes the `browser_*` namespace of `lib/browser/agent-tools.js` to every
 * harness that receives the builtin Cretli MCP catalog, so an agent previews a
 * page in the Cretli Browser panel instead of launching its own Chromium.
 *
 * The security contract stays in the Browser module: each call rebuilds the
 * tools for the calling chat, so owner / workspace / chat scoping, the
 * plan/ask/review read-only split and the URL policy are enforced there. This
 * file only resolves the caller, names the tools and shapes the result:
 * - the owner is the login session attached to the chat (or to a fork parent,
 *   for delegated children); without one the call fails closed;
 * - screenshots are written to a private temp file and returned as a path,
 *   because most harnesses only receive the text part of an MCP result.
 */

import {
  BROWSER_AGENT_READ_TOOLS,
  buildBrowserAgentTools,
  getBrowserAgentRuntime,
  resolveBrowserChatOwner,
} from '../../browser/agent-tools.js';
import { BrowserError } from '../../browser/session-manager.js';
import { saveBrowserScreenshot } from '../../browser/screenshot-file.js';
import { redactText } from '../../browser/redaction.js';
import { loadChats } from '../../persist/chats-persist.js';
import { resolveCretliToolContext } from './tool-context.js';
import { mcpToolResult } from './result.js';
import { CretliMcpToolError, MCP_BUILTIN_ERROR_CODES } from './errors.js';

/** Default DOM snapshot size over MCP; the caller may raise it up to the module cap. */
const MCP_DOM_DEFAULT_BYTES = 48 * 1024;

/** How far up the fork chain a delegated child may look for its owner. */
const MAX_OWNER_PARENT_DEPTH = 4;

/** Lead-ins that tell an agent this is the Browser panel of the Cretli UI. */
const MCP_DESCRIPTION_PREFIX = Object.freeze({
  browser_open:
    'Preview a web page in the Cretli built-in Browser (the Browser panel of the Cretli UI, visible to the user). '
    + 'Use this instead of launching your own Playwright/Chromium or looking for credentials: '
    + 'the session keeps what the user did in the panel, including a sign-in. '
    + 'Returns browserSessionId + browserTabId for the other browser_* tools. ',
  browser_sessions:
    'Cretli built-in Browser: find the session this chat already uses. '
    + 'An empty list means none is bound yet; call browser_open with a URL to adopt or create one. ',
  browser_screenshot:
    'Cretli built-in Browser: the image is saved to a temp file and its path is returned; open that file to see the page. ',
  browser_elements:
    'Cretli built-in Browser: visible interactive elements (including inside Lit shadow roots) so the page can be driven by role/name/text instead of screenshot pixel guessing. ',
});

/** Extra guidance appended to Browser errors an agent can act on. */
const BROWSER_ERROR_HINTS = Object.freeze({
  'session-limit':
    'The user already has a Browser session bound to another chat. Ask them to close it in the Browser panel, or continue in that chat.',
  'forbidden-chat':
    'That Browser session belongs to another chat. Call browser_open in this chat instead.',
});

/**
 * Tool descriptions and schemas come from the Browser module itself, so the MCP
 * surface cannot drift from the SDK one. The placeholder context is never used:
 * only `description` and `inputSchema` are read.
 */
const TOOL_TEMPLATES = buildBrowserAgentTools({
  manager: /** @type {any} */ ({}),
  mode: 'agent',
  ownerSessionId: 'template',
  chatId: 'template',
  scope: { cwd: 'template' },
});

/**
 * @param {string} chatId
 * @param {object[]} chats
 * @param {import('../../browser/session-manager.js').BrowserSessionManager} manager
 * @returns {string}
 */
function resolveOwnerForChat(chatId, chats, manager) {
  let id = chatId;
  for (let depth = 0; id && depth <= MAX_OWNER_PARENT_DEPTH; depth += 1) {
    const owner = resolveBrowserChatOwner(id, manager);
    if (owner) return owner;
    const current = id;
    id = String(chats.find((chat) => chat?.id === current)?.forkParentChatId || '').trim();
  }
  return '';
}

/**
 * @param {unknown} err
 * @returns {CretliMcpToolError}
 */
function toBrowserToolError(err) {
  const status = Number(err?.status) || 0;
  const browserCode = String(err?.code || 'browser-error');
  const hint = BROWSER_ERROR_HINTS[browserCode];
  const message = `${browserCode}: ${redactText(err?.message || 'Browser error')}${hint ? ` ${hint}` : ''}`;
  if (status === 404) return new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.NOT_FOUND, message);
  if (status === 409) return new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.CONFLICT, message);
  if (status === 401 || status === 403) return new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.OUT_OF_SCOPE, message);
  return new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, message);
}

/**
 * Formats a saved screenshot as a temp-file path. `agent-tools.js` already
 * persists the frame for every harness, so this only falls back to saving when
 * a manager returns inline base64 (defensive; keeps the MCP surface stable).
 * @param {string} chatId
 * @param {{ data?: string, path?: string }} frame
 * @returns {{ path: string, frame: object }}
 */
function screenshotResult(chatId, frame) {
  if (frame.path) return { path: frame.path, frame };
  const saved = saveBrowserScreenshot(chatId, frame);
  return { path: saved.path, frame: saved };
}

/**
 * @param {string} name
 * @param {Record<string, any>} args
 * @param {object} session
 */
async function runBrowserTool(name, args, session) {
  const ctx = resolveCretliToolContext(session);
  const manager = getBrowserAgentRuntime()?.manager;
  if (!manager) {
    throw new CretliMcpToolError(
      MCP_BUILTIN_ERROR_CODES.HARNESS_UNAVAILABLE,
      'The Cretli Browser runtime is not available here. It only runs inside the Cretli server (not in standalone stdio).',
    );
  }
  if (!ctx.chatId) {
    throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.OUT_OF_SCOPE, 'browser_* tools need the calling chat.');
  }
  const chats = loadChats();
  const ownerSessionId = resolveOwnerForChat(ctx.chatId, chats, manager);
  if (!ownerSessionId) {
    throw new CretliMcpToolError(
      MCP_BUILTIN_ERROR_CODES.OUT_OF_SCOPE,
      'No signed-in Cretli user is attached to this chat, so there is no Browser to act for. '
      + 'Ask the user to open this chat in the Cretli UI, then retry.',
    );
  }
  const liveMode = typeof session?.getMode === 'function' ? session.getMode() : ctx.mode;
  const tools = buildBrowserAgentTools({
    manager,
    // An unknown mode must never fall through to the agent default.
    mode: String(liveMode || '').trim() || 'plan',
    assignment: chats.find((chat) => chat?.id === ctx.chatId)?.delegationAssignment,
    ownerSessionId,
    chatId: ctx.chatId,
    scope: { workspaceFile: ctx.workspaceFile, workspaceFolder: ctx.workspaceFolder, cwd: ctx.workspaceFolder },
  });
  const tool = tools[name];
  if (!tool) {
    throw new CretliMcpToolError(
      MCP_BUILTIN_ERROR_CODES.PLAN_MODE_DENIED,
      `${name} changes browser state and is not available in a plan, ask or review run.`,
    );
  }

  const callArgs = name === 'browser_dom' && args.maxBytes == null
    ? { ...args, maxBytes: MCP_DOM_DEFAULT_BYTES }
    : args;
  let result;
  try {
    result = await tool.execute(callArgs);
  } catch (err) {
    if (err instanceof BrowserError) throw toBrowserToolError(err);
    throw err;
  }

  if (name === 'browser_screenshot' && result?.frame) {
    const { path: file, frame } = screenshotResult(ctx.chatId, result.frame);
    const structured = { ok: true, frame: { ...frame, path: file } };
    return mcpToolResult(
      `Screenshot saved to ${file} (${frame.width}x${frame.height}, ${frame.bytes} bytes, ${frame.mimeType}). Open the file to view it.`,
      structured,
    );
  }
  // Harness bridges forward the text part only, so it carries the whole payload.
  return mcpToolResult(JSON.stringify(result), result);
}

export const BROWSER_MCP_TOOLS = Object.freeze(
  Object.entries(TOOL_TEMPLATES).map(([name, template]) => ({
    name,
    readOnly: BROWSER_AGENT_READ_TOOLS.includes(name),
    description: `${MCP_DESCRIPTION_PREFIX[name] || 'Cretli built-in Browser: '}${template.description}`,
    inputSchema: template.inputSchema,
    async handler(args, { session }) {
      return runBrowserTool(name, args && typeof args === 'object' ? args : {}, session);
    },
  })),
);
