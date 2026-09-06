/**
 * In-process Cretli MCP tools. Shared by stdio and runtime.
 */

export { mcpTextResult, mcpToolResult } from './builtin/result.js';
export {
  CRETILI_MCP_TOOL_DEFS,
  createCretliMcpToolHandlers,
  listBuiltinMcpReadToolNames,
  listBuiltinMcpMutatingToolNames,
} from './builtin/catalog.js';
export { BUILTIN_MCP_MUTATING_TOOLS, BUILTIN_MCP_READ_TOOLS } from './mcp-policy.js';
