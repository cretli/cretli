/**
 * Claude Agent SDK receives the managed Cretli bridge (including builtin-cretli).
 * Host canUseTool must not grant MCP trust by tool basename; the bridge
 * re-checks policy at execution.
 *
 * `liveUpdate: true` — declarative flag only. Nothing currently consumes it;
 * MCP changes apply at the next turn via `query.setMcpServers()` (see
 * `lib/claude/claude-agent-ws.js`), which keeps the Query process and its MCP
 * connections alive.
 */
export const claudeMcpAdapter = Object.freeze({
  harness: 'claude',
  transports: Object.freeze(['stdio', 'http']),
  liveUpdate: true,
  callControl: 'bridge',
  unsupportedFeature: '',
});
