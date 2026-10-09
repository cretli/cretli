/**
 * Single catalog of builtin Cretli MCP tools (stdio + in-process).
 */

import { CHAT_MCP_TOOLS } from './chat-tools.js';
import { TODO_MCP_TOOLS } from './todo-tools.js';
import { DELEGATION_MCP_TOOLS } from './delegation-tools.js';
import { CATALOG_MCP_TOOLS } from './catalog-tools.js';
import { WATCHER_MCP_TOOLS } from './watcher-tools.js';
import { MEMORY_MCP_TOOLS } from './memory-tools.js';
import { BROWSER_MCP_TOOLS } from './browser-tools.js';
import { mcpErrorResult } from './result.js';
import { CretliMcpToolError, MCP_BUILTIN_ERROR_CODES, toCretliMcpToolError } from './errors.js';
import { isAskSdkMode } from '../../sdk/sdk-mode.js';
import {
  SCOUT_READ_ONLY_MESSAGE,
  isScoutProtocolToolCall,
} from '../../workspace-scout-chat.js';
import { BUILTIN_CRETILI_SERVER_ID } from '../mcp-config.js';
import { MCP_TOOL_LEGACY_NAMES, resolveCretliBuiltinToolName } from '../mcp-tool-names.js';

const BUILTIN_TOOLS = Object.freeze([
  ...CHAT_MCP_TOOLS,
  ...TODO_MCP_TOOLS,
  ...DELEGATION_MCP_TOOLS,
  ...CATALOG_MCP_TOOLS,
  ...WATCHER_MCP_TOOLS,
  ...MEMORY_MCP_TOOLS,
  ...BROWSER_MCP_TOOLS,
]);

/**
 * Mutating builtin tools need a live Agent mode before the handler runs.
 *
 * Two read-only exceptions:
 * - A Scout chat (technical agent transport) may only call read-only tools and
 *   its own `scout_findings` list/submit protocol. The host enforces
 *   this here before the handler, independent of the transport mode.
 * - The job-protocol actions a read-only run must be able to call. `accept` and
 *   `reject` stay denied in Plan because they are the user's decision.
 *
 * @param {{ readOnly?: boolean, name?: string }} tool
 * @param {object} session
 * @param {object} [args]
 * @param {{ isWorkspaceScoutChat?: () => boolean } | null} [client]
 */
function denyMutatingBuiltinTool(tool, session, args = {}, client = null) {
  // This dispatch only ever serves the builtin catalog, so ownership is known
  // from context rather than parsed from the name.
  const builtinIdentity = { id: BUILTIN_CRETILI_SERVER_ID, kind: 'builtin-cretli' };
  if (client && typeof client.isWorkspaceScoutChat === 'function' && client.isWorkspaceScoutChat() === true) {
    if (tool.readOnly === true) return null;
    if (isScoutProtocolToolCall(tool?.name, args, builtinIdentity)) return null;
    return new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.PLAN_MODE_DENIED, SCOUT_READ_ONLY_MESSAGE);
  }
  if (tool.readOnly === true) return null;
  const mode = String(session?.mode || '').trim().toLowerCase();
  if (mode === 'agent') return null;
  const protocolActions = PLAN_PROTOCOL_TOOL_ACTIONS.get(
    resolveCretliBuiltinToolName(tool?.name || '', builtinIdentity),
  );
  if (protocolActions && (mode === 'plan' || isAskSdkMode(mode))) {
    const action = String(args?.action || 'list').trim().toLowerCase() || 'list';
    if (protocolActions.has(action)) return null;
  }
  if (mode === 'plan' || isAskSdkMode(mode)) {
    return new CretliMcpToolError(
      MCP_BUILTIN_ERROR_CODES.PLAN_MODE_DENIED,
      isAskSdkMode(mode)
        ? 'Ask mode blocked this MCP tool. Switch to Agent mode to apply changes.'
        : 'Plan mode blocked this MCP tool. Switch to Agent mode to apply changes.',
    );
  }
  return new CretliMcpToolError(
    MCP_BUILTIN_ERROR_CODES.PLAN_MODE_DENIED,
    'MCP tool call blocked because the live session mode is unavailable.',
  );
}

/**
 * Read-only job-protocol actions allowed in Plan/Ask. Only `list` (read) and
 * `submit` (the scan's own channel) qualify; resolution stays Agent-only.
 */
export const PLAN_PROTOCOL_TOOL_ACTIONS = new Map([
  ['scout_findings', new Set(['list', 'submit'])],
]);

/**
 * @param {object} tool
 */
function toPublicToolDef(tool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: {
      readOnlyHint: tool.readOnly === true,
      destructiveHint: tool.name === 'chat_delete',
    },
  };
}

export const CRETILI_MCP_TOOL_DEFS = Object.freeze(BUILTIN_TOOLS.map(toPublicToolDef));

export function listBuiltinMcpReadToolNames() {
  return BUILTIN_TOOLS.filter((tool) => tool.readOnly === true).map((tool) => tool.name);
}

export function listBuiltinMcpMutatingToolNames() {
  return BUILTIN_TOOLS.filter((tool) => tool.readOnly !== true).map((tool) => tool.name);
}

/**
 * @param {object} client
 * @param {object} [session]
 */
export function createCretliMcpToolHandlers(client, session = {}) {
  /** @type {Record<string, Function>} */
  const handlers = {};
  for (const tool of BUILTIN_TOOLS) {
    handlers[tool.name] = async (args, extra = {}) => {
      try {
        const denied = denyMutatingBuiltinTool(tool, session, args, client);
        if (denied) return mcpErrorResult(denied);
        return await tool.handler(args && typeof args === 'object' ? args : {}, {
          client,
          session,
          signal: extra?.signal,
        });
      } catch (err) {
        return mcpErrorResult(toCretliMcpToolError(err));
      }
    };
  }
  for (const [legacyName, canonicalName] of Object.entries(MCP_TOOL_LEGACY_NAMES)) {
    if (handlers[canonicalName] && !handlers[legacyName]) {
      handlers[legacyName] = handlers[canonicalName];
    }
  }
  return handlers;
}

export { BUILTIN_TOOLS };
