/**
 * Cursor SDK MCP adapter. Agent.create/resume accept mcpServers; Plan has no
 * pre-call hook, so Cretli injects a managed bridge that enforces policy.
 */
export const sdkMcpAdapter = Object.freeze({
  harness: 'sdk',
  transports: Object.freeze(['stdio', 'http']),
  liveUpdate: false,
  callControl: 'bridge',
  unsupportedFeature: '',
});
