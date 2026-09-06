/**
 * Single catalog of builtin Cretli MCP tools (stdio + in-process).
 */

import { CHAT_MCP_TOOLS } from './chat-tools.js';
import { TODO_MCP_TOOLS } from './todo-tools.js';
import { DELEGATION_MCP_TOOLS } from './delegation-tools.js';
import { CATALOG_MCP_TOOLS } from './catalog-tools.js';
import { mcpErrorResult } from './result.js';
import { CretliMcpToolError, MCP_BUILTIN_ERROR_CODES, toCretliMcpToolError } from './errors.js';
import { isAskSdkMode } from '../../sdk/sdk-mode.js';

const BUILTIN_TOOLS = Object.freeze([
  ...CHAT_MCP_TOOLS,
  ...TODO_MCP_TOOLS,
  ...DELEGATION_MCP_TOOLS,
  ...CATALOG_MCP_TOOLS,
]);

/**
 * Mutating builtin tools need a live Agent mode before the handler runs.
 *
 * @param {{ readOnly?: boolean, name?: string }} tool
 * @param {object} session
 */
function denyMutatingBuiltinTool(tool, session) {
  if (tool.readOnly === true) return null;
  const mode = String(session?.mode || '').trim().toLowerCase();
  if (mode === 'agent') return null;
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
    handlers[tool.name] = async (args) => {
      try {
        const denied = denyMutatingBuiltinTool(tool, session);
        if (denied) return mcpErrorResult(denied);
        return await tool.handler(args && typeof args === 'object' ? args : {}, { client, session });
      } catch (err) {
        return mcpErrorResult(toCretliMcpToolError(err));
      }
    };
  }
  return handlers;
}

export { BUILTIN_TOOLS };
