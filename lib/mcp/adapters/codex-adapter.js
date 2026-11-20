/**
 * Codex MCP adapter. Config is passed as constructor `config.mcp_servers`.
 * Codex Plan is prompt-only in the host; the managed bridge still blocks writes.
 */
export const codexMcpAdapter = Object.freeze({
  harness: 'codex',
  transports: Object.freeze(['stdio', 'http']),
  liveUpdate: false,
  callControl: 'bridge',
  unsupportedFeature: '',
});
