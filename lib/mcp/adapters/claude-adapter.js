/**
 * Claude Agent SDK receives the managed Cretli bridge (including builtin-cretli).
 * Host canUseTool must not grant MCP trust by tool basename; the bridge
 * re-checks policy at execution.
 *
 * `liveUpdate: true` — the Phase 3 streaming session keeps the Query alive and
 * applies an MCP revision change through `query.setMcpServers()`, so the
 * server set can change without restarting the process.
 */
export const claudeMcpAdapter = Object.freeze({
  harness: 'claude',
  transports: Object.freeze(['stdio', 'http']),
  liveUpdate: true,
  callControl: 'bridge',
  unsupportedFeature: '',
});
