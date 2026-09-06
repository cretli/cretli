/**
 * OpenRouter: MCP tools join the model catalog and execute through mcp-runtime.
 */
export const openrouterMcpAdapter = Object.freeze({
  harness: 'openrouter',
  transports: Object.freeze(['stdio', 'http']),
  liveUpdate: true,
  callControl: 'managed',
  unsupportedFeature: '',
});
