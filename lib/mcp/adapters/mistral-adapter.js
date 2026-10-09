/**
 * Mistral: MCP tools join the model catalog and execute through mcp-runtime.
 */
export const mistralMcpAdapter = Object.freeze({
  harness: 'mistral',
  transports: Object.freeze(['stdio', 'http']),
  liveUpdate: true,
  callControl: 'managed',
  unsupportedFeature: '',
});
