/**
 * Long-lived CodeBuddy session. CLI `--resume` replays the previous assistant
 * message and ignores the new prompt; keep one process and send() each turn.
 */

import { resolvePlanModeToolDecision, resolveReadOnlyGuardUserMessage } from '../sdk/sdk-plan-guard.js';
import { SCOUT_READ_ONLY_MESSAGE, isScoutReadOnlyChatId } from '../workspace-scout-chat.js';
import { normalizeSdkMode } from '../sdk/sdk-mode.js';
import { MCP_ORCHESTRATOR_ERROR_CODES } from '../mcp/mcp-orchestrator-contract.js';
import { evaluateMcpBridgeReadySnapshot } from '../mcp/watcher-orchestrator-mcp-gate.js';

/**
 * @param {unknown} session
 * @returns {boolean}
 */
export function isCodeBuddyLiveSessionOpen(session) {
  if (!session || typeof session !== 'object') return false;
  const record = /** @type {{ closed?: boolean }} */ (session);
  return record.closed !== true;
}

/**
 * ProcessTransport reads these flags at spawn time — set them before send().
 * @param {unknown} session
 * @param {{
 *   cwd?: string,
 *   permissionMode?: string,
 *   settingSources?: string[],
 *   includePartialMessages?: boolean,
 *   executablePath?: string,
 *   mcpServers?: Record<string, unknown>,
 * }} extras
 * @returns {void}
 */
export function applyCodeBuddyTransportOptions(session, extras) {
  if (!session || typeof session !== 'object') return;
  const transport = /** @type {{ transport?: { options?: Record<string, unknown> } }} */ (session).transport;
  if (!transport || typeof transport !== 'object') return;
  if (!transport.options || typeof transport.options !== 'object') return;
  const options = transport.options;
  if (typeof extras.cwd === 'string' && extras.cwd) options.cwd = extras.cwd;
  if (typeof extras.permissionMode === 'string' && extras.permissionMode) {
    options.permissionMode = extras.permissionMode;
  }
  if (Array.isArray(extras.settingSources)) options.settingSources = extras.settingSources;
  if (typeof extras.includePartialMessages === 'boolean') {
    options.includePartialMessages = extras.includePartialMessages;
  }
  if (typeof extras.executablePath === 'string' && extras.executablePath) {
    options.executablePath = extras.executablePath;
  }
  if (extras.mcpServers && typeof extras.mcpServers === 'object') {
    options.mcpServers = extras.mcpServers;
  }
}

const MCP_READY_HOOK_ID = 'cretli_mcp_ready';

/**
 * The CLI starts connecting MCP servers when the first prompt arrives and
 * builds that model request without waiting, so the first turn would see no
 * MCP tools. A `UserPromptSubmit` hook runs in between: holding its answer
 * until `waitForMcpReady` settles gives the servers time to connect. Only the
 * first prompt of the process is held; later turns answer at once.
 *
 * `SessionImpl.initialize()` sends no hooks, so it is replaced with a request
 * that registers this one.
 *
 * For a Workspace Watcher orchestrator the caller also passes `contractTools`.
 * The gate then refuses the first prompt outright (hook output `continue:false`)
 * when the bridge never became ready or its live catalog lacks a contract tool,
 * because an orchestrator without Cretli tools must not run at all. Ordinary
 * chats keep the previous behaviour: wait, then let the prompt through.
 *
 * @param {unknown} session
 * @param {() => Promise<unknown>} waitForMcpReady
 * @param {{ contractTools?: string[], onBlock?: (info: { code: string, missing: string[], message: string }) => void }} [options]
 * @returns {boolean} whether the gate was installed
 */
export function installCodeBuddyMcpReadyGate(session, waitForMcpReady, options = {}) {
  if (!session || typeof session !== 'object' || typeof waitForMcpReady !== 'function') return false;
  const record = /** @type {{
    transport?: { sendControlRequest?: Function, sendControlResponse?: Function },
    handleControlRequest?: Function,
    initialize?: Function,
    initialized?: boolean,
  }} */ (session);
  const transport = record.transport;
  if (!transport || typeof transport.sendControlRequest !== 'function') return false;
  if (typeof record.handleControlRequest !== 'function' || typeof record.initialize !== 'function') return false;
  const contractTools = Array.isArray(options.contractTools)
    ? options.contractTools.map((name) => String(name || '').trim()).filter(Boolean)
    : [];
  const onBlock = typeof options.onBlock === 'function' ? options.onBlock : null;
  // Refusing a prompt means answering the hook ourselves, which needs the
  // response channel. Without it the gate could only hang the CLI, so the
  // caller must treat the session as unusable.
  if (contractTools.length && typeof transport.sendControlResponse !== 'function') return false;
  const handleControlRequest = record.handleControlRequest.bind(session);
  let held = false;
  let firstHookInFlight = false;
  record.initialize = async () => {
    if (record.initialized) return;
    await transport.sendControlRequest({
      subtype: 'initialize',
      hooks: { UserPromptSubmit: [{ hookCallbackIds: [MCP_READY_HOOK_ID] }] },
    });
    record.initialized = true;
  };
  record.handleControlRequest = async (request) => {
    const inner = request?.request;
    if (!held && !firstHookInFlight && inner?.subtype === 'hook_callback' && inner.callback_id === MCP_READY_HOOK_ID) {
      firstHookInFlight = true;
      let snapshot = null;
      let failure = null;
      try {
        try {
          snapshot = await waitForMcpReady();
        } catch (err) {
          failure = err;
        }
        if (!contractTools.length) {
          held = true;
          return handleControlRequest(request);
        }
        const verdict = failure
          ? {
            code: MCP_ORCHESTRATOR_ERROR_CODES.NOT_READY,
            missing: [],
            message: `Cretli MCP bridge never became ready: ${failure?.message ? String(failure.message) : String(failure)}`,
          }
          : evaluateMcpBridgeReadySnapshot(snapshot, contractTools);
        if (!verdict) {
          held = true;
          return handleControlRequest(request);
        }
        try {
          if (onBlock) onBlock(verdict);
        } catch {
          // Reporting the block must never release the prompt.
        }
        held = true;
        transport.sendControlResponse(request.request_id, {
          continue: false,
          stopReason: verdict.message,
          decision: 'block',
          reason: verdict.message,
        });
        return undefined;
      } finally {
        firstHookInFlight = false;
      }
    }
    return handleControlRequest(request);
  };
  return true;
}

/**
 * @param {{
 *   sdk: { unstable_v2_createSession?: Function },
 *   model: string,
 *   pathToCodebuddyCode: string,
 *   env: Record<string, string>,
 *   cwd: string,
 *   permissionMode: string,
 *   conversationMode?: string,
 *   mcpServers?: Record<string, unknown>,
 *   waitForMcpReady?: () => Promise<unknown>,
 *   chatId?: string,
 *   mcpContractTools?: string[],
 *   onMcpBlock?: (info: { code: string, missing: string[], message: string }) => void,
 * }} params
 * @returns {object}
 */
export function createCodeBuddyLiveSession(params) {
  if (typeof params.sdk.unstable_v2_createSession !== 'function') {
    throw new Error('CodeBuddy SDK is missing unstable_v2_createSession.');
  }
  const conversationMode = normalizeSdkMode(params.conversationMode || params.permissionMode);
  const session = params.sdk.unstable_v2_createSession({
    model: params.model,
    pathToCodebuddyCode: params.pathToCodebuddyCode,
    env: params.env,
    canUseTool: async (toolName, input) => {
      const assignment = typeof params.readAssignment === 'function'
        ? String(params.readAssignment() || '').trim()
        : String(params.assignment || '').trim();
      const scoutReadOnly = isScoutReadOnlyChatId(params.chatId);
      const decision = resolvePlanModeToolDecision({
        transport: 'codebuddy',
        mode: conversationMode,
        assignment,
        toolName,
        scoutReadOnly,
        input,
      });
      if (decision.deny) {
        return {
          behavior: 'deny',
          message: scoutReadOnly
            ? SCOUT_READ_ONLY_MESSAGE
            : resolveReadOnlyGuardUserMessage(conversationMode, assignment),
        };
      }
      return {
        behavior: 'allow',
        updatedInput: input && typeof input === 'object' ? input : {},
      };
    },
  });
  applyCodeBuddyTransportOptions(session, {
    cwd: params.cwd,
    permissionMode: params.permissionMode,
    settingSources: ['project'],
    includePartialMessages: true,
    executablePath: params.pathToCodebuddyCode,
    mcpServers: params.mcpServers,
  });
  const contractTools = (Array.isArray(params.mcpContractTools) ? params.mcpContractTools : [])
    .map((name) => String(name || '').trim())
    .filter(Boolean);
  const hasMcpServers = Boolean(params.mcpServers && Object.keys(params.mcpServers).length > 0);
  if (hasMcpServers) {
    const installed = installCodeBuddyMcpReadyGate(session, params.waitForMcpReady, {
      contractTools,
      onBlock: params.onMcpBlock,
    });
    if (contractTools.length && !installed) {
      closeCodeBuddyLiveSession(session);
      throw createMcpGateUnavailableError('the MCP readiness hook could not be installed on this session');
    }
  } else if (contractTools.length) {
    closeCodeBuddyLiveSession(session);
    throw createMcpGateUnavailableError('no Cretli MCP server was injected into this session');
  }
  return session;
}

/**
 * An orchestrator session that cannot even hold its first prompt is a readiness
 * failure, not a tool-catalog failure: nothing was ever listed.
 *
 * @param {string} detail
 * @returns {Error}
 */
function createMcpGateUnavailableError(detail) {
  const error = new Error(`Cretli MCP bridge gate unavailable (${detail}).`);
  error.code = MCP_ORCHESTRATOR_ERROR_CODES.NOT_READY;
  return error;
}

/**
 * @param {unknown} session
 * @returns {void}
 */
export function closeCodeBuddyLiveSession(session) {
  if (!session || typeof session !== 'object') return;
  const record = /** @type {{ close?: () => void, closed?: boolean }} */ (session);
  if (record.closed === true) return;
  if (typeof record.close === 'function') {
    try {
      record.close();
    } catch {
      // ignore close errors
    }
  }
}
