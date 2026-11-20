/** Xiaomi MiMo: MCP function tools run through the shared host tool executor. */
export const mimoMcpAdapter = Object.freeze({
  harness: 'mimo',
  transports: Object.freeze(['stdio', 'http']),
  liveUpdate: true,
  callControl: 'managed',
  unsupportedFeature: '',
});
