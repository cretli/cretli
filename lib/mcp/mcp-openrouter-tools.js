/**
 * Extra OpenRouter function tools from the resolved MCP catalog.
 */

import { isMcpPlanCallDenied } from './mcp-policy.js';
import { listTools } from './mcp-runtime.js';
import { encodeMcpToolName } from './mcp-tool-names.js';
import { listResolvedMcpServers } from './mcp-session.js';
import { createInProcessMcpClient } from './mcp-inprocess-client.js';
import { isReadOnlySdkMode } from '../sdk/sdk-mode.js';

/**
 * @param {object} context
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function loadOpenRouterMcpTools(context) {
  const servers = listResolvedMcpServers(context);
  const runtimeContext = { ...context, builtinClient: createInProcessMcpClient(context) };
  /** @type {Array<Record<string, unknown>>} */
  const tools = [];
  for (const server of servers) {
    let listed = [];
    try {
      listed = await listTools(runtimeContext, server);
    } catch {
      continue;
    }
    for (const tool of listed) {
      if (isReadOnlySdkMode(context.mode) && isMcpPlanCallDenied({ server, toolName: tool.name, mode: context.mode })) {
        continue;
      }
      tools.push({
        type: 'function',
        function: {
          name: encodeMcpToolName(server.id, tool.name),
          description: `[MCP ${server.name}] ${tool.description || tool.name}`,
          parameters: tool.inputSchema && typeof tool.inputSchema === 'object'
            ? tool.inputSchema
            : { type: 'object' },
        },
      });
    }
  }
  return tools;
}
