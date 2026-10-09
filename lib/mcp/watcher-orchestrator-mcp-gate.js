/**
 * Shared first-prompt MCP contract gate for Workspace Watcher orchestrator chats.
 *
 * Executor selection only proves static config; this module verifies the live
 * tool catalog of the current run before the harness sends the first model
 * request. A harness whose transport is already running (`session` strategy)
 * waits on {@link waitForMcpBridgeToolsListed}; a harness that spawns its CLI
 * together with the first prompt (`preflight` strategy) asks the server for the
 * bridge catalog through {@link probeMcpBridgeCatalog} instead, because its own
 * mark can only appear after the gate. Managed harnesses list tools in-process.
 */

import { createInProcessMcpClient } from './mcp-inprocess-client.js';
import {
  MCP_ORCHESTRATOR_ERROR_CODES,
  ORCHESTRATOR_MCP_CONTRACT_TOOLS,
  isWorkspaceWatcherOrchestratorChat,
  missingWorkspaceWatcherOrchestratorMcpTools,
} from './mcp-orchestrator-contract.js';
import { listTools } from './mcp-runtime.js';
import { listResolvedMcpServers } from './mcp-session.js';
import { encodeMcpToolName } from './mcp-tool-names.js';
import {
  MCP_BRIDGE_READY_TIMEOUT_MS,
  waitForMcpBridgeToolsListed,
} from './mcp-bridge-ready.js';
import { probeMcpBridgeCatalog } from './mcp-bridge-preflight.js';

/**
 * A `null` snapshot means no catalog was ever listed (the bridge never became
 * ready), which is a readiness failure, not a missing-tool failure. Only a
 * listed catalog that lacks contract tools is `mcp_tools_missing`.
 *
 * @param {unknown} snapshot
 * @param {string[]} _contractTools Kept for the public call signature; the
 *   missing list is always computed against the canonical contract.
 * @returns {{ code: string, missing: string[], message: string } | null}
 */
export function evaluateMcpBridgeReadySnapshot(snapshot, _contractTools) {
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.toolNames)) {
    return {
      code: MCP_ORCHESTRATOR_ERROR_CODES.NOT_READY,
      missing: [],
      message: 'Cretli MCP bridge did not list a tool catalog for this run, so the orchestrator contract could not be verified.',
    };
  }
  const missing = missingWorkspaceWatcherOrchestratorMcpTools(snapshot.toolNames);
  if (missing.length) {
    return {
      code: MCP_ORCHESTRATOR_ERROR_CODES.TOOLS_MISSING,
      missing,
      message: `Cretli MCP bridge is missing orchestrator tools: ${missing.join(', ')}.`,
    };
  }
  return null;
}

/**
 * @param {unknown} toolNames
 * @param {string[]} _contractTools Kept for the public call signature; the
 *   missing list is always computed against the canonical contract.
 * @returns {{ code: string, missing: string[], message: string } | null}
 */
export function evaluateOrchestratorMcpToolNames(toolNames, _contractTools = ORCHESTRATOR_MCP_CONTRACT_TOOLS) {
  const missing = missingWorkspaceWatcherOrchestratorMcpTools(toolNames);
  if (!missing.length) return null;
  return {
    code: MCP_ORCHESTRATOR_ERROR_CODES.TOOLS_MISSING,
    missing,
    message: `Cretli MCP bridge is missing orchestrator tools: ${missing.join(', ')}.`,
  };
}

/**
 * @param {object | null | undefined} chat
 * @param {object | null | undefined} room
 * @returns {boolean}
 */
export function isWatcherOrchestratorChat(chat, room) {
  if (room?.watcherOrchestrator === true) return true;
  return isWorkspaceWatcherOrchestratorChat(chat);
}

/**
 * Stamp the orchestrator marker and the cycle stamp on a room.
 *
 * `room.watcherCycleId` is set (and cleared) on every start from the run deps,
 * so a later manual run in the same chat cannot inherit a previous cycle's id
 * and its usage is not correlated into that cycle.
 *
 * @param {object | null | undefined} room
 * @param {object | null | undefined} chat
 * @param {{ watcherCycleId?: unknown }} [deps]
 * @returns {void}
 */
export function stampWatcherOrchestratorRoom(room, chat, deps = {}) {
  if (!room || typeof room !== 'object') return;
  room.watcherOrchestrator = isWorkspaceWatcherOrchestratorChat(chat);
  room.watcherCycleId = String(deps?.watcherCycleId ?? '').trim();
}

/**
 * @param {object} context
 * @returns {Promise<string[]>}
 */
export async function listManagedHarnessMcpToolNames(context) {
  const servers = listResolvedMcpServers(context);
  const runtimeContext = { ...context, builtinClient: createInProcessMcpClient(context) };
  /** @type {string[]} */
  const names = [];
  for (const server of servers) {
    let listed = [];
    try {
      listed = await listTools(runtimeContext, server);
    } catch {
      continue;
    }
    for (const tool of listed) {
      names.push(encodeMcpToolName(server.id, tool.name));
    }
  }
  return names;
}

/**
 * @param {{ code?: string }} block
 * @returns {Error}
 */
export function createWatcherOrchestratorMcpGateError(block) {
  const message = String(block?.message || 'Cretli MCP bridge is not ready for orchestrator work.');
  const error = new Error(message);
  error.code = String(block?.code || MCP_ORCHESTRATOR_ERROR_CODES.NOT_READY);
  return error;
}

/**
 * @param {string} code
 * @returns {boolean}
 */
export function isMcpOrchestratorErrorCode(code) {
  const normalized = String(code || '').trim();
  return normalized === MCP_ORCHESTRATOR_ERROR_CODES.NOT_READY
    || normalized === MCP_ORCHESTRATOR_ERROR_CODES.TOOLS_MISSING;
}

/**
 * How the live bridge catalog of an orchestrator run is verified.
 *
 * `session` — the harness transport is already running, so wait for its own
 * bridge to report (and fall back to a server-side probe if it never does).
 * `preflight` — the harness process only starts with the first prompt, so ask
 * the server for the bridge catalog before that prompt.
 */
export const MCP_BRIDGE_GATE_STRATEGY = Object.freeze({
  SESSION: 'session',
  PREFLIGHT: 'preflight',
});

/**
 * @param {unknown} strategy
 * @returns {'session' | 'preflight'}
 */
export function normalizeMcpBridgeGateStrategy(strategy) {
  return String(strategy || '').trim() === MCP_BRIDGE_GATE_STRATEGY.PREFLIGHT
    ? MCP_BRIDGE_GATE_STRATEGY.PREFLIGHT
    : MCP_BRIDGE_GATE_STRATEGY.SESSION;
}

/**
 * Before the first model request of an orchestrator run, verify the live MCP
 * catalog. Returns a block payload or `null` when the contract is satisfied.
 *
 * @param {{
 *   chat?: object,
 *   room?: object,
 *   mcpPrep?: { bridge?: object | null },
 *   mcpContext?: object,
 *   sessionStartedAt?: number,
 *   timeoutMs?: number,
 *   liveToolNames?: unknown,
 *   bridgeStrategy?: 'session' | 'preflight',
 *   bridgeCatalogProbe?: (bridge: object, options: { timeoutMs: number }) => Promise<unknown>,
 * }} input
 * @returns {Promise<{ code: string, missing: string[], message: string } | null>}
 */
export async function enforceWatcherOrchestratorMcpGate(input) {
  if (!isWatcherOrchestratorChat(input.chat, input.room)) return null;
  const contractTools = ORCHESTRATOR_MCP_CONTRACT_TOOLS;
  const chatId = String(input.room?.chatId || input.chat?.id || '').trim();
  const since = Number.isFinite(input.sessionStartedAt) ? Number(input.sessionStartedAt) : Date.now();
  const timeoutMs = Number.isFinite(input.timeoutMs) && Number(input.timeoutMs) >= 0
    ? Number(input.timeoutMs)
    : MCP_BRIDGE_READY_TIMEOUT_MS;
  const hasBridge = Boolean(input.mcpPrep?.bridge);
  if (hasBridge) {
    if (!chatId) {
      return {
        code: MCP_ORCHESTRATOR_ERROR_CODES.NOT_READY,
        missing: [],
        message: 'Cretli MCP bridge gate could not identify the orchestrator chat.',
      };
    }
    const probe = typeof input.bridgeCatalogProbe === 'function'
      ? input.bridgeCatalogProbe
      : probeMcpBridgeCatalog;
    const strategy = normalizeMcpBridgeGateStrategy(input.bridgeStrategy);
    try {
      if (strategy === MCP_BRIDGE_GATE_STRATEGY.PREFLIGHT) {
        const probed = await probe(input.mcpPrep.bridge, { timeoutMs });
        return evaluateMcpBridgeReadySnapshot(probed, contractTools);
      }
      const marked = await waitForMcpBridgeToolsListed(chatId, { since, timeoutMs });
      if (marked) return evaluateMcpBridgeReadySnapshot(marked, contractTools);
      // A harness whose transport starts with the first prompt never reports a
      // mark before it. Probe the server-side bridge catalog so a working bridge
      // is not misread as a missing catalog.
      const probed = await probe(input.mcpPrep.bridge, { timeoutMs });
      return evaluateMcpBridgeReadySnapshot(probed, contractTools);
    } catch (err) {
      return {
        code: MCP_ORCHESTRATOR_ERROR_CODES.NOT_READY,
        missing: [],
        message: `Cretli MCP bridge never became ready: ${err?.message ? String(err.message) : String(err)}`,
      };
    }
  }
  if (Array.isArray(input.liveToolNames)) {
    return evaluateOrchestratorMcpToolNames(input.liveToolNames, contractTools);
  }
  if (input.mcpContext && typeof input.mcpContext === 'object') {
    try {
      const names = await listManagedHarnessMcpToolNames(input.mcpContext);
      return evaluateOrchestratorMcpToolNames(names, contractTools);
    } catch (err) {
      return {
        code: MCP_ORCHESTRATOR_ERROR_CODES.NOT_READY,
        missing: [],
        message: `Cretli MCP tools could not be listed: ${err?.message ? String(err.message) : String(err)}`,
      };
    }
  }
  return {
    code: MCP_ORCHESTRATOR_ERROR_CODES.NOT_READY,
    missing: [],
    message: 'Cretli MCP bridge was not configured for this orchestrator run.',
  };
}
