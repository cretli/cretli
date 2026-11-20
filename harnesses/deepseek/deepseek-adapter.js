/**
 * DeepSeek dsh-mcp-client plugin. One managed-bridge instance keeps Plan on the
 * Cretli side; existing runtime patches stay in place.
 */
export const deepseekMcpAdapter = Object.freeze({
  harness: 'deepseek',
  transports: Object.freeze(['stdio', 'http']),
  liveUpdate: false,
  callControl: 'bridge',
  unsupportedFeature: '',
});
