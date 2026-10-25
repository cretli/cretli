/**
 * Stable denial codes for the Cretli MCP orchestrator contract.
 *
 * Kept in a dependency-free leaf so a caller that only needs the codes (the
 * shared model-pick hard-gate validator) does not pull in the whole builtin
 * tool catalog through `mcp-orchestrator-contract.js`. That import would close
 * a cycle `model-role-profiles -> model-pick-hard-gates -> mcp contract ->
 * builtin catalog -> delegation tools -> ... -> model-role-profiles`, which
 * JavaScript resolves as a temporal-dead-zone error on `DELEGATION_MCP_TOOLS`.
 */

/**
 * Why a harness was rejected before the cycle started. The three reasons are
 * deliberately distinct so the operator sees what to fix.
 */
export const MCP_CAPABILITY_DENIED = Object.freeze({
  ADAPTER: 'mcp_adapter_unavailable',
  CONFIG: 'mcp_config_unavailable',
  TOOLS: 'mcp_tools_unavailable',
});
