/** Z.AI SDK: MCP function tools run through the shared host tool executor. */
export const zaiMcpAdapter = Object.freeze({
  harness: 'zai',
  transports: Object.freeze(['stdio', 'http']),
  liveUpdate: true,
  callControl: 'managed',
  unsupportedFeature: '',
});
