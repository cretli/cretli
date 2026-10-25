/**
 * OpenCode MCP adapter. Cretli-managed entries are added via client.mcp.add
 * (local command = managed bridge). User MCP entries are left untouched.
 */
export const opencodeMcpAdapter = Object.freeze({
  harness: 'opencode',
  transports: Object.freeze(['stdio', 'http']),
  liveUpdate: true,
  callControl: 'bridge',
  unsupportedFeature: '',
});
