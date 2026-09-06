/**
 * CodeBuddy receives the managed Cretli bridge (including builtin-cretli).
 * Host canUseTool must not grant MCP trust by tool basename.
 */
export const codebuddyMcpAdapter = Object.freeze({
  harness: 'codebuddy',
  transports: Object.freeze(['stdio', 'http']),
  liveUpdate: false,
  callControl: 'bridge',
  unsupportedFeature: '',
});
