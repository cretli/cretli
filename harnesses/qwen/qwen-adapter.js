/**
 * Qwen receives the managed Cretli bridge (including builtin-cretli).
 * Host canUseTool must not grant MCP trust by tool basename; the bridge
 * re-checks policy at execution.
 */
export const qwenMcpAdapter = Object.freeze({
  harness: 'qwen',
  transports: Object.freeze(['stdio', 'http']),
  liveUpdate: false,
  callControl: 'bridge',
  unsupportedFeature: '',
});
