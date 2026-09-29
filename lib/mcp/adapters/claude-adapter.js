/**
 * Claude Agent SDK receives the managed Cretli bridge (including builtin-cretli).
 * Host canUseTool must not grant MCP trust by tool basename; the bridge
 * re-checks policy at execution.
 */
export const claudeMcpAdapter = Object.freeze({
  harness: 'claude',
  transports: Object.freeze(['stdio', 'http']),
  liveUpdate: false,
  callControl: 'bridge',
  unsupportedFeature: '',
});
