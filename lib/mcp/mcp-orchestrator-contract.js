/**
 * The Cretli MCP tool contract a Workspace Watcher orchestrator needs before it
 * may run at all.
 *
 * An orchestrator chat without these tools cannot delegate, cannot report its
 * cycle and falls back to editing files itself (incident 2d2900a5: a cycle on a
 * harness whose CLI never connected the bridge). Two guards use this contract:
 * executor selection rejects a harness that cannot deliver it, and the harness
 * adapter refuses to release the first model request until the live tool
 * catalog of the current run actually contains it.
 */

import { CRETILI_MCP_TOOL_DEFS } from './builtin/catalog.js';
import { resolveCretliBuiltinToolName } from './mcp-tool-names.js';
import { getHarnessMcpAdapter } from './adapters/index.js';
import { listResolvedMcpServers } from './mcp-session.js';
import { BUILTIN_CRETILI_SERVER_ID } from './mcp-config.js';

/** Chat marker (`addChat` extras) of a chat created as a watcher orchestrator. */
export const WORKSPACE_WATCHER_ORCHESTRATOR_PICK_PURPOSE = 'watcher-orchestrator';

/**
 * Readiness/contract failures surfaced as a run error code, so a cycle close
 * can name the concrete cause instead of a generic missing report.
 */
export const MCP_ORCHESTRATOR_ERROR_CODES = Object.freeze({
  NOT_READY: 'mcp_not_ready',
  TOOLS_MISSING: 'mcp_tools_missing',
});

/** @type {readonly string[]} */
export const MCP_ORCHESTRATOR_ERROR_CODE_LIST = Object.freeze([
  MCP_ORCHESTRATOR_ERROR_CODES.NOT_READY,
  MCP_ORCHESTRATOR_ERROR_CODES.TOOLS_MISSING,
]);

/**
 * The concrete MCP failure of an orchestrator run, read from the live chat-run
 * state. Only the known bridge codes qualify: a generic harness error must not
 * replace the `missing_report` reason, and a cycle that already has a durable
 * report never needs this.
 *
 * @param {{ chatId?: string, runId?: string, reportedOutcome?: string }} cycle
 * @param {(input: { chatId?: string, runId?: string }) => object | null} probe
 * @returns {string}
 */
export function readMcpOrchestratorRunErrorCode(cycle, probe) {
  if (typeof probe !== 'function') return '';
  const chatId = String(cycle?.chatId || '').trim();
  if (!chatId || String(cycle?.reportedOutcome || '').trim()) return '';
  try {
    const live = probe({ chatId, runId: String(cycle?.runId || '').trim() });
    const code = String(live?.errorCode || '').trim();
    return MCP_ORCHESTRATOR_ERROR_CODE_LIST.includes(code) ? code : '';
  } catch {
    return '';
  }
}

/**
 * Why a harness was rejected before the cycle started. The three reasons are
 * deliberately distinct so the operator sees what to fix.
 */
export const MCP_CAPABILITY_DENIED = Object.freeze({
  ADAPTER: 'mcp_adapter_unavailable',
  CONFIG: 'mcp_config_unavailable',
  TOOLS: 'mcp_tools_unavailable',
});

/**
 * Required tools grouped by the contract step they serve. Every group must be
 * present: a bridge that lists only the read tools still cannot close a cycle.
 */
export const ORCHESTRATOR_MCP_CONTRACT = Object.freeze({
  snapshot: ['watcher_show', 'todo_show'],
  modelPick: ['model_pick'],
  delegation: ['delegation_start', 'delegation_show', 'delegation_inbox'],
  workflow: ['workflow_update'],
  cycleReport: ['watcher_update'],
});

/** @type {string[]} */
export const ORCHESTRATOR_MCP_CONTRACT_TOOLS = Object.freeze(
  Array.from(new Set(Object.values(ORCHESTRATOR_MCP_CONTRACT).flat())),
);

/**
 * The orchestrator chat is identified by the durable `pickPurpose` stamped when
 * the cycle created it, never by the harness or the model name.
 *
 * @param {unknown} chat
 * @returns {boolean}
 */
export function isWorkspaceWatcherOrchestratorChat(chat) {
  const row = chat && typeof chat === 'object' ? chat : null;
  if (!row) return false;
  return String(row.pickPurpose || '').trim() === WORKSPACE_WATCHER_ORCHESTRATOR_PICK_PURPOSE;
}

/**
 * Canonical Cretli tool names as a harness presents them (bare, encoded, or
 * under a hashed bridge alias) mapped to the current catalog name. Foreign MCP
 * servers are dropped, so an external `todo_list` never satisfies the contract.
 *
 * @param {unknown} toolNames
 * @returns {Set<string>}
 */
export function canonicalCretliToolNames(toolNames) {
  const names = Array.isArray(toolNames) ? toolNames : [];
  /** @type {Set<string>} */
  const out = new Set();
  for (const name of names) {
    const canonical = resolveCretliBuiltinToolName(name);
    if (canonical) out.add(canonical);
  }
  return out;
}

/**
 * @param {unknown} toolNames
 * @returns {string[]} contract tools missing from that catalog, in contract order
 */
export function missingWorkspaceWatcherOrchestratorMcpTools(toolNames) {
  const present = canonicalCretliToolNames(toolNames);
  return ORCHESTRATOR_MCP_CONTRACT_TOOLS.filter((name) => !present.has(name));
}

/**
 * @param {unknown} toolNames
 * @returns {boolean}
 */
export function hasWorkspaceWatcherOrchestratorMcpTools(toolNames) {
  return missingWorkspaceWatcherOrchestratorMcpTools(toolNames).length === 0;
}

/**
 * The builtin Cretli catalog is the upper bound of what any bridge can expose;
 * a tool removed from it must never be handed out as "ready".
 *
 * @returns {string[]}
 */
export function listBuiltinCretliCatalogToolNames() {
  return CRETILI_MCP_TOOL_DEFS.map((tool) => String(tool?.name || '').trim()).filter(Boolean);
}

/**
 * Build the pre-start capability probe used by executor selection. It answers
 * what is statically knowable about one harness in this workspace; the live
 * tool catalog of the actual run is still verified by the adapter gate.
 *
 * @param {{
 *   listServers?: (context: object) => object[],
 *   catalogToolNames?: () => string[],
 * }} [deps]
 * @returns {(input: { harness?: string, workspaceFolder?: string }) => { ok: boolean, reason?: string, missing?: string[] }}
 */
export function createMcpCapabilityProbe(deps = {}) {
  const listServers = typeof deps.listServers === 'function' ? deps.listServers : listResolvedMcpServers;
  const catalog = typeof deps.catalogToolNames === 'function'
    ? deps.catalogToolNames
    : listBuiltinCretliCatalogToolNames;
  /** @type {Map<string, object>} */
  const memo = new Map();
  return ({ harness, workspaceFolder } = {}) => {
    const id = String(harness || '').trim();
    if (!id) return { ok: false, reason: MCP_CAPABILITY_DENIED.ADAPTER };
    const cached = memo.get(id);
    if (cached) return cached;
    const verdict = probeOneHarness({ id, workspaceFolder, listServers, catalog });
    memo.set(id, verdict);
    return verdict;
  };
}

/**
 * @param {{ id: string, workspaceFolder: string, listServers: Function, catalog: Function }} input
 * @returns {{ ok: boolean, reason?: string, missing?: string[] }}
 */
function probeOneHarness({ id, workspaceFolder, listServers, catalog }) {
  if (!getHarnessMcpAdapter(id)) {
    return { ok: false, reason: MCP_CAPABILITY_DENIED.ADAPTER };
  }
  let servers = [];
  try {
    servers = listServers({
      harness: id,
      workspaceFolder: String(workspaceFolder || '').trim(),
      workspaceId: '',
      workspaceFile: '',
    }) || [];
  } catch {
    return { ok: false, reason: MCP_CAPABILITY_DENIED.CONFIG };
  }
  const bridge = servers.find((server) => String(server?.id || '') === BUILTIN_CRETILI_SERVER_ID)
    || servers.find((server) => String(server?.kind || '') === 'builtin-cretli');
  if (!bridge) {
    return { ok: false, reason: MCP_CAPABILITY_DENIED.CONFIG };
  }
  const missing = missingWorkspaceWatcherOrchestratorMcpTools(catalog());
  if (missing.length) {
    return { ok: false, reason: MCP_CAPABILITY_DENIED.TOOLS, missing };
  }
  return { ok: true };
}
