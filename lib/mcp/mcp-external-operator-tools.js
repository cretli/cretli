/**
 * Operator tools for external MCP clients in `operator` mode
 * (lib/mcp/mcp-external-clients.js): the actions a user otherwise does in the
 * UI — approve a plan, send a message to a chat, stop a run, read run state.
 *
 * They are answered by `/mcp` (lib/routes/mcp-external-routes.js) before the
 * builtin catalog and are never part of it, so chats, delegations and the
 * Watcher inside Cretli cannot see or call them. The "plan is approved by a
 * human only" invariant therefore still holds for every agent Cretli runs; an
 * operator client acts for the user who created its token in Settings.
 */

import { loadChats } from '../persist/chats-persist.js';
import { listTodos, updateTodo } from '../persist/todos-store.js';
import { cancelChatRun, getChatRunStateForChat, startChatRun } from '../chat-run-service.js';
import { normalizeSdkMode } from '../sdk/sdk-mode.ts';
import { getChatAgentTransport } from '../agent-transport.js';
import { buildTodoReviewReadModel } from '../todo-review-read.js';
import { findChatByRef } from '../remote-api-client.js';
import { isChatInWorkspace } from './builtin/tool-context.js';
import { getBuiltinMcpRuntimeDeps } from './builtin/runtime-deps.js';
import { resolveDataPath } from '../runtime-paths.js';
import {
  applyWorkspaceWatcherPatch,
  getWorkspaceWatcherView,
  releaseDoingWorkspaceWatcherTodoForOperator,
} from '../workspace-watcher-control.js';
import { mutateWorkspaceWatcherRow } from '../persist/workspace-watchers-persist.js';
import { broadcastWorkspaceWatcherChanged } from '../workspace-watcher-live.js';
import { readOperatorPlaybook } from './mcp-external-guide.js';
import { MCP_OPERATOR_PROMPT_PROPOSAL_TOOL, callMcpOperatorPromptProposalTool } from './mcp-operator-prompt-proposal-tool.js';
import { createModelPickOverride, readModelPickOverrides, revokeModelPickOverride } from '../persist/model-pick-overrides-persist.js';
import { readModelRoleConfig, writeModelRoleConfig, ModelRoleConfigError } from '../model-role-config-store.js';
import { loadSettings, saveSettings } from '../persist/settings.js';
import { normalizeChatEnabledModels } from '../model-catalog.js';
import { getBuiltinHarnessBackend } from '../agent-harness/builtin-harness-backends.ts';
import { MODEL_PICK_ROLES } from '../model-role-profiles.js';
import { buildHarnessDiagnosticsReport } from '../routes/harness-diagnostics-routes.js';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { listUnclassifiedSignatures, redactUnclassifiedText } from '../usage/unclassified-errors.js';
import { addOperatorNote, assertOperatorLease, operatorHandoff, recordOperatorEvent, resolveOperatorNote } from '../persist/operator-journal-persist.js';

const TODO_ID_MIN_PREFIX = 8;

/**
 * Throughput limits an operator may tune. Everything else in the Watcher policy
 * (plan approval, review gate, autoIntegrate/autoRestart, phases, harness
 * allowlists, mode, stop reason) stays a Settings decision of the human.
 * Bounds mirror normalizeWorkspaceWatcherPolicy so a bad value is refused here
 * instead of being silently clamped.
 */
const OPERATOR_WATCHER_LIMITS = Object.freeze({
  maxParallel: { min: 1, max: 5 },
  maxParallelWorktree: { min: 0, max: 5 },
  maxParallelProject: { min: 0, max: 5 },
  maxCyclesPerDay: { min: 1, max: 1000 },
  maxConsecutiveFailures: { min: 1, max: 100 },
  maxSameFindings: { min: 1, max: 100 },
  cooldownMs: { min: 0, max: 3_600_000 },
  backoffBaseMs: { min: 1_000, max: 24 * 3_600_000 },
  backoffCapMs: { min: 1_000, max: 7 * 24 * 3_600_000 },
});

/** @typedef {{ id: string, title?: string, agentTransport?: string, sdkMode?: string }} OperatorChat */
/** @typedef {{ id: string, updatedAt?: string, plan?: { markdown?: string, approvedAt?: string } }} OperatorTodo */
const WAIT_DEFAULT_MS = 30_000;
const WAIT_MAX_MS = 55_000;
const WAIT_POLL_MS = 1_000;

export const EXTERNAL_OPERATOR_TOOLS = Object.freeze([
  MCP_OPERATOR_PROMPT_PROPOSAL_TOOL,
  {
    name: 'operator_note',
    description: 'Add or resolve a durable workspace-scoped operator journal entry.',
    inputSchema: { type: 'object', properties: {
      operation: { type: 'string', enum: ['add', 'resolve'] }, id: { type: 'string' },
      kind: { type: 'string', enum: ['decision', 'question', 'in_progress', 'temporary_setting', 'lesson'] },
      text: { type: 'string' }, todo_id: { type: 'string' }, expires_at: { type: 'string' },
    }, required: ['operation'] },
  },
  {
    name: 'operator_handoff',
    description: 'Start or heartbeat this operator session. Returns the active lease, open workspace notes, operator sessions and events since this session last visited. Pass takeover=true to explicitly replace another unexpired operator lease.',
    inputSchema: { type: 'object', properties: { takeover: { type: 'boolean' } } },
  },
  {
    name: 'operator_model_overrides',
    description: 'List, create or revoke audited model-pick overrides. Writes require if_match from list; TTL is bounded to 30 days.',
    inputSchema: { type: 'object', properties: {
      operation: { type: 'string', enum: ['list', 'create', 'revoke'] },
      if_match: { type: 'string' }, id: { type: 'string' },
      action: { type: 'string', enum: ['prefer', 'exclude', 'explicit-orchestrator'] },
      harness: { type: 'string' }, model: { type: 'string' }, role: { type: 'string' },
      scope: { type: 'string', enum: ['workspace', 'global'] },
      reason: { type: 'string' }, expires_at: { type: 'string' },
    }, required: ['operation'] },
  },
  {
    name: 'operator_model_profiles',
    description: 'Read or patch rotation and role score weights. Patches require if_match from get and use the Settings validator.',
    inputSchema: { type: 'object', properties: {
      operation: { type: 'string', enum: ['get', 'patch'] }, if_match: { type: 'string' },
      rotation: { type: 'object', properties: { band: { type: 'number' }, mode: { type: 'string' } } },
      weights: { type: 'object' },
    }, required: ['operation'] },
  },
  {
    name: 'operator_favorites',
    description: 'List or set Settings favorite model IDs for one harness and optionally one delegation role. A role-specific list replaces the harness default for that role. Set requires if_match.',
    inputSchema: { type: 'object', properties: {
      operation: { type: 'string', enum: ['list', 'set'] }, harness: { type: 'string' },
      role: { type: 'string' }, models: { type: 'array', items: { type: 'string' } }, if_match: { type: 'string' },
    }, required: ['operation'] },
  },
  {
    name: 'operator_model_stats',
    description: 'Read model candidate scores, in-band state, filters, penalties and 5h/7d plan pace for a role. No pick is persisted.',
    inputSchema: { type: 'object', properties: { role: { type: 'string' } }, required: ['role'] },
  },
  {
    name: 'unclassified_errors',
    description: 'Operator: unclassified provider error signatures (redacted message, counts, first/last seen, ack state) with the last chat that hit each one. last_context.same_workspace tells whether that chat ran in this workspace; paths are never returned. Read only; acknowledging stays in the UI.',
    inputSchema: { type: 'object', properties: {
      limit: { type: 'number', description: 'Default 20, max 100.' },
      since: { type: 'string', description: 'ISO time; only signatures last seen at or after it.' },
      include_acked: { type: 'boolean', description: 'Include acknowledged signatures (default false).' },
    } },
  },
  {
    name: 'operator_guide',
    description: 'Operator: the full playbook for steering Cretli over MCP (monitoring loop, restarts and resuming, integrating worktree leaves, known traps, building todo trees, load). Read it once at the start of an operator session. Read only.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'operator_chat_status',
    description: 'Operator: run state of one chat in this workspace (busy, waiting for input, run id). Read only.',
    inputSchema: {
      type: 'object',
      properties: { chat: { type: 'string', description: 'Chat id (prefix ok) or title substring.' } },
      required: ['chat'],
    },
  },
  {
    name: 'operator_chat_wait',
    description: 'Operator: wait until a chat is idle (not busy) or the timeout passes, then return its run state. Max 55 s per call.',
    inputSchema: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: 'Chat id (prefix ok) or title substring.' },
        timeout_ms: { type: 'number', description: `Default ${WAIT_DEFAULT_MS}, max ${WAIT_MAX_MS}.` },
      },
      required: ['chat'],
    },
  },
  {
    name: 'operator_chat_send',
    description: 'Operator: send a user message to a chat and start its run, like typing in the UI. A busy chat refuses with recipient_busy unless wait_idle_ms lets the call wait for it to go idle. Replay with the same idempotency_key never sends twice.',
    inputSchema: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: 'Chat id (prefix ok) or title substring.' },
        text: { type: 'string' },
        idempotency_key: { type: 'string' },
        selected_skill_ids: { type: 'array', items: { type: 'string' }, maxItems: 32, description: 'Optional explicit skill IDs to activate for this message. Names inside the text never activate a skill.' },
        wait_idle_ms: { type: 'number', description: `Wait up to this long (max ${WAIT_MAX_MS}) for a busy chat to go idle before sending. Default 0 (refuse at once).` },
      },
      required: ['chat', 'text', 'idempotency_key'],
    },
  },
  {
    name: 'operator_chat_stop',
    description: 'Operator: stop the current run of a chat (User Stop; no auto-resume).',
    inputSchema: {
      type: 'object',
      properties: { chat: { type: 'string', description: 'Chat id (prefix ok) or title substring.' } },
      required: ['chat'],
    },
  },
  {
    name: 'operator_plan_approve',
    description: 'Operator: approve a TODO plan on behalf of the user, like the Approve button in the Todo panel. Requires expected_updated_at from todo_show. Refused while the plan review round is pending or when the todo has no plan.',
    inputSchema: {
      type: 'object',
      properties: {
        todo_id: { type: 'string', description: `Full todo id or unique prefix (>= ${TODO_ID_MIN_PREFIX} chars).` },
        expected_updated_at: { type: 'string' },
        note: { type: 'string', description: 'Optional reason recorded in the todo changelog.' },
      },
      required: ['todo_id', 'expected_updated_at'],
    },
  },
  {
    name: 'operator_plan_review_start',
    description: 'Operator: start the plan review loop for a TODO, like "Plan review" in the Todo panel. Creates a fresh read-only [Todo plan] coordinator chat in the project folder, opens its plan-reviewer session and sends it the server-built refine prompt; the coordinator then picks and starts the reviewers (for example Claude + Codex) and records their verdicts. Use this instead of reviewer_session / delegation_start, which need a calling chat that an external client does not have. Follow the coordinator with operator_chat_status / operator_chat_wait; approving stays a separate step (operator_plan_approve, after the reviewers pass). Every call creates a new chat; a retry with the same idempotency_key returns the first result.',
    inputSchema: {
      type: 'object',
      properties: {
        todo_id: { type: 'string', description: `Full todo id or unique prefix (>= ${TODO_ID_MIN_PREFIX} chars). The todo must already have a draft plan.` },
        harness: { type: 'string', description: 'Harness for the coordinator chat (for example claude or codex).' },
        model: { type: 'string', description: 'Model for the coordinator chat. Omitted or auto selects the harness default (the Cursor default for sdk); the result reports the stored model.' },
        cooperation_mode: { type: 'string', description: 'Optional plan-reviewer cooperation mode, as in the Todo panel.' },
        idempotency_key: { type: 'string', description: 'Stable key for this start request.' },
      },
      required: ['todo_id', 'harness', 'idempotency_key'],
    },
  },
  {
    name: 'operator_watcher_status',
    description: 'Operator: compact Workspace Watcher state for this workspace — mode, pause/stop, backoff, failure counts, active cycles and the last decisions. Read only.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'operator_watcher_reset',
    description: 'Operator: clear the Workspace Watcher failure counts, backoff timer and per-todo blocked backoff (only when `all_blocked: true` is passed, or only for `todo_ids`; without either flag per-todo blocked backoff is left untouched), like "Clear backoff" in Settings → Workspace Watcher. Clear a todo\'s blocked backoff only after its cause is fixed. Does not change mode, policy, pause or stop reason. Requires confirm: true.',
    inputSchema: {
      type: 'object',
      properties: {
        confirm: { type: 'boolean', description: 'Must be true.' },
        todo_ids: { type: 'array', items: { type: 'string' }, description: `Optional: clear the blocked backoff of these todos only (full ids or unique prefixes >= ${TODO_ID_MIN_PREFIX} chars). Without it (and without all_blocked) blocked backoff is left untouched.` },
        all_blocked: { type: 'boolean', description: "Clear every todo's blocked backoff. Cannot be combined with `todo_ids`." },
        reason: { type: 'string', description: 'Why the reset is needed (logged by the /mcp audit with the call).' },
      },
      required: ['confirm'],
    },
  },
  {
    name: 'operator_watcher_pause',
    description: 'Operator: pause or resume the Workspace Watcher, like the pause switch in Settings → Workspace Watcher. A paused watcher starts no new cycles; running cycles continue and failures, backoff and the active cycles are kept. Requires confirm: true.',
    inputSchema: {
      type: 'object',
      properties: {
        paused: { type: 'boolean', description: 'true pauses, false resumes.' },
        confirm: { type: 'boolean', description: 'Must be true.' },
        reason: { type: 'string', description: 'Why (logged by the /mcp audit with the call).' },
      },
      required: ['paused', 'confirm'],
    },
  },
  {
    name: 'operator_watcher_limits',
    description: 'Operator: read or change the Workspace Watcher throughput limits of this workspace, like the number fields in Settings → Workspace Watcher: maxParallel (1-5), maxParallelWorktree/maxParallelProject (0-5, 0 = inherit maxParallel), maxCyclesPerDay, maxConsecutiveFailures, maxSameFindings, cooldownMs, backoffBaseMs, backoffCapMs. Without `limits` it only returns the current values. Plan approval, review gate, autoIntegrate/autoRestart, phases, harness lists, mode and stop reason are not available here (Settings only). A change needs the operator lease and confirm: true; running cycles are not interrupted.',
    inputSchema: {
      type: 'object',
      properties: {
        limits: {
          type: 'object',
          description: 'Partial patch of the limits above; unknown keys and out-of-range or non-integer values are refused.',
          additionalProperties: { type: 'integer' },
        },
        confirm: { type: 'boolean', description: 'Must be true when `limits` is given.' },
        reason: { type: 'string', description: 'Why (logged by the /mcp audit with the call).' },
      },
    },
  },
  {
    name: 'operator_scout_enable',
    description: 'Operator: enable or disable Workspace Watcher scouts for this workspace. Requires an active operator lease and confirm: true.',
    inputSchema: { type: 'object', properties: { enabled: { type: 'boolean' }, confirm: { type: 'boolean' }, reason: { type: 'string' } }, required: ['enabled', 'confirm'] },
  },
  {
    name: 'operator_watcher_release_unknown',
    description: 'Operator: release a `doing` todo whose executor liveness is unknown (for example a cycle killed by a server restart) back to ready, like "Release to ready" on the Todo card. Uses the same guarded path (integration/worktree guards still apply). Requires expected_updated_at and confirm: true.',
    inputSchema: {
      type: 'object',
      properties: {
        todo_id: { type: 'string', description: `Full todo id or unique prefix (>= ${TODO_ID_MIN_PREFIX} chars).` },
        expected_updated_at: { type: 'string' },
        confirm: { type: 'boolean', description: 'Must be true: you accept abandoning the unknown run.' },
        message: { type: 'string', description: 'Why the release is safe (recorded with the release).' },
      },
      required: ['todo_id', 'expected_updated_at', 'confirm'],
    },
  },
]);

/** First result of each operator_plan_review_start, keyed by client id + idempotency key (process lifetime). */
const planReviewStarts = new Map();

const OPERATOR_TOOL_NAMES = new Set(EXTERNAL_OPERATOR_TOOLS.map((tool) => tool.name));

/** @param {string} name */
export function isExternalOperatorTool(name) {
  return OPERATOR_TOOL_NAMES.has(name);
}

/**
 * Canonical form for workspace equivalence: resolved, symlinks followed when the path
 * exists, trailing separators trimmed. Empty for an empty input.
 *
 * @param {unknown} value
 */
function canonicalPath(value) {
  const raw = text(value);
  if (!raw) return '';
  let resolved = path.resolve(raw);
  try { resolved = fs.realpathSync(resolved); } catch { /* path may no longer exist */ }
  return resolved.length > 1 ? resolved.replace(/[\\/]+$/, '') : resolved;
}

class OperatorToolError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** @param {unknown} value */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function requireIfMatch(value) {
  const etag = text(value);
  if (!etag) throw new OperatorToolError('VALIDATION_ERROR', 'if_match is required; read the current etag first');
  return etag;
}

function checkedWrite(result) {
  if (!result.ok) throw new OperatorToolError(result.conflict ? 'CONFLICT' : (result.code || 'VALIDATION_ERROR'), `${result.error}; current etag: ${result.etag}`);
  return result;
}

function favoritesEtag(settings) {
  return createHash('sha256').update(JSON.stringify(settings)).digest('hex');
}

/**
 * @param {import('./mcp-external-clients.js').ExternalMcpClientInfo} client
 * @param {unknown} ref
 * @returns {OperatorChat}
 */
function resolveChat(client, ref) {
  const value = text(ref);
  if (!value) throw new OperatorToolError('VALIDATION_ERROR', 'chat is required');
  /** @type {OperatorChat[]} */
  const chats = loadChats().filter((chat) => isChatInWorkspace(chat, client.workspaceFolder));
  const exact = chats.find((chat) => chat.id === value);
  if (exact) return exact;
  const found = findChatByRef(chats, value);
  if ('chat' in found) return /** @type {OperatorChat} */ (found.chat);
  const matches = /** @type {OperatorChat[]} */ (found.matches);
  if (matches.length === 0) throw new OperatorToolError('NOT_FOUND', `Chat not found in this workspace: ${value}`);
  if (matches.length > 1) {
    const ids = matches.slice(0, 5).map((chat) => chat.id.slice(0, 8)).join(', ');
    throw new OperatorToolError('AMBIGUOUS', `Chat reference matches ${matches.length} chats (${ids}); pass a longer id`);
  }
  return matches[0];
}

/**
 * @param {string} workspaceFolder
 */
function describeWatcher(workspaceFolder) {
  const view = /** @type {any} */ (getWorkspaceWatcherView({ dataDir: dataDir(), workspaceFolder }));
  const watcher = view?.watcher || {};
  const decisions = Array.isArray(watcher.decisions) ? watcher.decisions
    : Array.isArray(view?.decisions) ? view.decisions : [];
  return {
    mode: watcher.mode || '',
    paused: watcher.paused === true,
    stop_reason: watcher.stopReason || '',
    backoff_until: watcher.backoffUntil || '',
    failures: watcher.failures && typeof watcher.failures === 'object' ? /** @type {any} */ (watcher.failures) : {},
    // Per-todo backoff after blocked cycles: a ready todo listed here is skipped until `until`.
    blocked_backoff: watcher.blockedBackoff && typeof watcher.blockedBackoff === 'object'
      ? /** @type {Record<string, { count?: number, until?: string }>} */ (watcher.blockedBackoff) : {},
    active_cycles: (Array.isArray(watcher.activeCycles) ? watcher.activeCycles : []).map((cycle) => ({
      cycle_id: cycle?.cycleId || '',
      chat_id: cycle?.chatId || '',
      todo_ids: Array.isArray(cycle?.todoIds) ? cycle.todoIds : [],
      started_at: cycle?.startedAt || '',
    })),
    ready_todo_count: Number(view?.snapshot?.readyTodoCount) || 0,
    limits: Object.fromEntries(Object.keys(OPERATOR_WATCHER_LIMITS).map((key) => [key, watcher.policy?.[key] ?? null])),
    // `doing` todos that are not confirmed active: `unknown` ones hold back every
    // new cycle, `recoverable` ones can be recovered, `user_action` ones wait for a human.
    doing_attention: (Array.isArray(view?.snapshot?.doingStates) ? view.snapshot.doingStates : [])
      .filter((row) => ['unknown', 'recoverable', 'user_action'].includes(String(row?.state || '')))
      .map((row) => ({
        todo_id: row.todoId || '',
        state: row.state || '',
        reason: row.reason || '',
        source: row.source || '',
        chat_id: row.chatId || '',
        revision: row.revision || '',
      })),
    last_decisions: decisions.slice(-8).map((row) => ({
      at: row?.at || '',
      kind: row?.kind || row?.decision || '',
      reason: String(row?.reason || '').slice(0, 160),
      todo_id: row?.todoId || '',
    })),
  };
}

/** @param {OperatorChat} chat */
function describeRun(chat) {
  const state = getChatRunStateForChat(chat);
  return {
    chat_id: chat.id,
    title: chat.title || '',
    harness: getChatAgentTransport(chat),
    busy: state?.busy === true,
    waiting_for_input: state?.waitingForInput === true,
    run_id: state?.runId || '',
    state_known: Boolean(state),
  };
}

/**
 * @param {string} workspaceFolder
 * @param {string} ref
 * @returns {Promise<OperatorTodo>}
 */
async function resolveTodo(workspaceFolder, ref) {
  const value = text(ref);
  if (value.length < TODO_ID_MIN_PREFIX) {
    throw new OperatorToolError('VALIDATION_ERROR', `todo_id needs at least ${TODO_ID_MIN_PREFIX} characters`);
  }
  const items = /** @type {OperatorTodo[]} */ ((await listTodos(dataDir(), workspaceFolder)).items || []);
  const exact = items.find((item) => item.id === value);
  if (exact) return exact;
  const matches = items.filter((item) => String(item.id).startsWith(value));
  if (matches.length === 0) throw new OperatorToolError('NOT_FOUND', `Todo not found in this workspace: ${value}`);
  if (matches.length > 1) throw new OperatorToolError('AMBIGUOUS', `Todo id prefix is ambiguous: ${value}`);
  return matches[0];
}

function dataDir() {
  return getBuiltinMcpRuntimeDeps().dataDir || resolveDataPath();
}

/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 */
function delay(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve(undefined);
    }, { once: true });
  });
}

/**
 * Polls the run state until the chat is not busy, the timeout passes or the request is aborted.
 *
 * @param {OperatorChat} chat
 * @param {number} timeoutMs Capped at WAIT_MAX_MS.
 * @param {{ signal?: AbortSignal, now?: () => number }} options
 */
async function waitForIdle(chat, timeoutMs, { signal, now = Date.now }) {
  const deadline = now() + Math.min(timeoutMs, WAIT_MAX_MS);
  let run = describeRun(chat);
  while (run.busy && now() < deadline && !signal?.aborted) {
    await delay(Math.min(WAIT_POLL_MS, Math.max(0, deadline - now())), signal);
    run = describeRun(chat);
  }
  return run;
}

/**
 * @param {import('./mcp-external-clients.js').ExternalMcpClientInfo} client
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {{ signal?: AbortSignal, now?: () => number }} [options]
 */
async function runTool(client, name, args, { signal, now = Date.now } = /** @type {any} */ ({})) {
  const journalOptions = { now: now(), dataDir: dataDir() };
  switch (name) {
    case 'unclassified_errors': {
      const limit = args.limit === undefined ? 20 : Number(args.limit);
      if (!Number.isFinite(limit) || limit < 1) throw new OperatorToolError('VALIDATION_ERROR', 'limit must be a positive number');
      let sinceMs = 0;
      if (args.since !== undefined && args.since !== '') {
        sinceMs = typeof args.since === 'string' ? Date.parse(args.since) : NaN;
        if (!Number.isFinite(sinceMs)) throw new OperatorToolError('VALIDATION_ERROR', 'since must be an ISO date-time');
      }
      const rows = await listUnclassifiedSignatures({ dataDir: dataDir(), includeAcked: args.include_acked === true, includeContext: true, sync: false });
      const mine = canonicalPath(client.workspaceFolder);
      return {
        items: rows
          .filter((row) => !sinceMs || Date.parse(row.lastSeenAt) >= sinceMs)
          .slice(0, Math.min(Math.floor(limit), 100))
          .map((row) => ({
            signature_id: row.id,
            category: row.category,
            harness: row.harness,
            model: row.model,
            count: row.count,
            first_seen: row.firstSeenAt,
            last_seen: row.lastSeenAt,
            acked: row.ack.state === 'acked',
            message: redactUnclassifiedText(row.message),
            last_context: row.lastContext
              ? { chat_id: redactUnclassifiedText(row.lastContext.chatId, 128), same_workspace: Boolean(mine) && canonicalPath(row.lastContext.workspaceFolder) === mine }
              : null,
          })),
      };
    }
    case 'operator_handoff': {
      const result = operatorHandoff({ workspaceFolder: client.workspaceFolder, clientId: client.id, clientName: client.name, sessionId: client.sessionId || client.id }, { takeover: args.takeover === true }, journalOptions);
      if (!result.ok) throw new OperatorToolError('OPERATOR_LEASE_HELD', `Workspace is operated by ${result.lease.client_name} until ${result.lease.expires_at}; pass takeover=true to take over explicitly`);
      return result;
    }

    case 'operator_note': {
      const scope = { workspaceFolder: client.workspaceFolder, clientId: client.id, clientName: client.name, sessionId: client.sessionId || client.id };
      if (args.operation === 'add') return addOperatorNote(scope, { kind: args.kind, text: args.text, todoId: args.todo_id, expiresAt: args.expires_at }, journalOptions);
      if (args.operation === 'resolve') return resolveOperatorNote(client.workspaceFolder, text(args.id), journalOptions);
      throw new OperatorToolError('VALIDATION_ERROR', 'operation must be add or resolve');
    }
    case 'operator_model_overrides': {
      const operation = text(args.operation);
      if (operation === 'list') {
        const snapshot = readModelPickOverrides();
        const overrides = snapshot.overrides.filter((row) => row.scope === 'global' || row.workspaceFolder === client.workspaceFolder.toLowerCase());
        const visibleIds = new Set(overrides.map((row) => row.id));
        return { state: snapshot.state, error: snapshot.error, etag: snapshot.etag, overrides, audit: snapshot.audit.filter((row) => visibleIds.has(row.id)) };
      }
      const ifMatch = requireIfMatch(args.if_match);
      if (operation === 'create') return checkedWrite(createModelPickOverride({
        override: { action: args.action, scope: args.scope || 'workspace', workspaceFolder: args.scope === 'global' ? '' : client.workspaceFolder, targetHarness: args.harness, targetModel: args.model, targetRole: args.role, reason: args.reason, expiresAt: args.expires_at },
        createdBy: `mcp-operator:${client.id}`, source: 'external-operator', ifMatch, now: now(),
      }));
      if (operation === 'revoke') {
        const snapshot = readModelPickOverrides();
        const row = snapshot.overrides.find((item) => item.id === text(args.id));
        if (!row || (row.scope === 'workspace' && row.workspaceFolder !== client.workspaceFolder.toLowerCase())) throw new OperatorToolError('NOT_FOUND', 'override not found in this workspace');
        return checkedWrite(revokeModelPickOverride({ id: row.id, ifMatch, now: now(), by: `mcp-operator:${client.id}`, reason: text(args.reason) }));
      }
      throw new OperatorToolError('VALIDATION_ERROR', 'operation must be list, create or revoke');
    }

    case 'operator_model_profiles': {
      const operation = text(args.operation);
      if (operation === 'get') {
        const snapshot = readModelRoleConfig();
        return { state: snapshot.state, error: snapshot.error, etag: snapshot.etag, rotation: snapshot.rotation, weights: snapshot.weights };
      }
      if (operation !== 'patch') throw new OperatorToolError('VALIDATION_ERROR', 'operation must be get or patch');
      const ifMatch = requireIfMatch(args.if_match);
      const delta = {};
      if (args.rotation !== undefined) delta.rotation = args.rotation;
      if (args.weights !== undefined) delta.weights = args.weights;
      if (!Object.keys(delta).length) throw new OperatorToolError('VALIDATION_ERROR', 'rotation or weights is required');
      try { return checkedWrite(writeModelRoleConfig({ delta, ifMatch })); }
      catch (err) { if (err instanceof ModelRoleConfigError) throw new OperatorToolError('VALIDATION_ERROR', err.message); throw err; }
    }

    case 'operator_favorites': {
      const operation = text(args.operation);
      const harness = text(args.harness);
      const role = text(args.role);
      if (role && !MODEL_PICK_ROLES.includes(role)) throw new OperatorToolError('VALIDATION_ERROR', 'role must be plan, implement, review or fix');
      const backend = harness ? getBuiltinHarnessBackend(harness) : null;
      if (harness && !backend) throw new OperatorToolError('VALIDATION_ERROR', 'unknown harness');
      const settings = loadSettings();
      const etag = favoritesEtag(settings);
      if (operation === 'list') {
        const rows = backend ? [backend] : ['sdk', 'claude', 'codex', 'opencode', 'openrouter', 'deepseek', 'qwen', 'mistral', 'codebuddy', 'zai', 'mimo'].map(getBuiltinHarnessBackend).filter(Boolean);
        return { etag, favorites: Object.fromEntries(rows.map((row) => [row.id, normalizeChatEnabledModels(role && Object.prototype.hasOwnProperty.call(settings.delegationRoleFavorites?.[row.id] || {}, role)
          ? settings.delegationRoleFavorites[row.id][role]
          : settings[row.enabledModelsKey])])), role: role || null,
          role_overrides: settings.delegationRoleFavorites || {} };
      }
      if (operation !== 'set' || !backend) throw new OperatorToolError('VALIDATION_ERROR', 'set requires a harness');
      if (!Array.isArray(args.models) || args.models.some((model) => typeof model !== 'string')) throw new OperatorToolError('VALIDATION_ERROR', 'models must be an array of strings');
      if (requireIfMatch(args.if_match) !== etag) throw new OperatorToolError('CONFLICT', 'Settings favorites changed; list again');
      const models = backend.normalizeEnabledModels ? backend.normalizeEnabledModels(normalizeChatEnabledModels(args.models)) : normalizeChatEnabledModels(args.models);
      if (role) {
        const current = settings.delegationRoleFavorites && typeof settings.delegationRoleFavorites === 'object' ? settings.delegationRoleFavorites : {};
        settings.delegationRoleFavorites = { ...current, [backend.id]: { ...(current[backend.id] || {}), [role]: models } };
      } else if (models.length) settings[backend.enabledModelsKey] = models;
      else delete settings[backend.enabledModelsKey];
      saveSettings(settings);
      return { harness: backend.id, models, etag: favoritesEtag(settings) };
    }

    case 'operator_model_stats': {
      const role = text(args.role);
      if (!MODEL_PICK_ROLES.includes(role)) throw new OperatorToolError('VALIDATION_ERROR', 'role must be plan, implement, review or fix');
      const report = await buildHarnessDiagnosticsReport({ role, workspaceFolder: client.workspaceFolder, dataDir: dataDir(), range: { from: new Date(now() - 7 * 86400000).toISOString(), to: new Date(now()).toISOString() } });
      return { role, generated_at: report.generated_at, selection: report.selection, plan_pace: report.plan_pace, models: report.models };
    }
    case 'operator_chat_status':
      return describeRun(resolveChat(client, args.chat));

    case 'operator_chat_wait': {
      const chat = resolveChat(client, args.chat);
      const requested = Number(args.timeout_ms);
      const timeoutMs = Number.isFinite(requested) && requested > 0 ? requested : WAIT_DEFAULT_MS;
      const run = await waitForIdle(chat, timeoutMs, { signal, now });
      return { ...run, timed_out: run.busy };
    }

    case 'operator_chat_send': {
      const chat = resolveChat(client, args.chat);
      const message = text(args.text);
      const key = text(args.idempotency_key);
      if (!message) throw new OperatorToolError('VALIDATION_ERROR', 'text is required');
      if (!key) throw new OperatorToolError('VALIDATION_ERROR', 'idempotency_key is required');
      const waitMs = Number(args.wait_idle_ms);
      if (Number.isFinite(waitMs) && waitMs > 0) await waitForIdle(chat, waitMs, { signal, now });
      const started = await startChatRun({
        chatId: chat.id,
        prompt: message,
        mode: normalizeSdkMode(chat.sdkMode),
        requestId: `external:${client.id}:${key}`,
        displayText: message,
        selectedSkillIds: Array.isArray(args.selected_skill_ids) ? args.selected_skill_ids : [],
      });
      return { chat_id: chat.id, run_id: started.runId, accepted: started.accepted };
    }

    case 'operator_chat_stop': {
      const chat = resolveChat(client, args.chat);
      const before = describeRun(chat);
      if (!before.busy && !before.waiting_for_input) return { ...before, stopped: false };
      await cancelChatRun(/** @type {{ chatId: string, runId?: string }} */ ({
        chatId: chat.id,
        runId: before.run_id,
        reason: 'external_operator_stop',
      }));
      return { ...describeRun(chat), stopped: true };
    }

    case 'operator_guide':
      return { markdown: readOperatorPlaybook(client.workspaceFolder) };

    case 'operator_prompt_change_propose':
      return callMcpOperatorPromptProposalTool(client, args);

    case 'operator_watcher_status':
      return describeWatcher(client.workspaceFolder);

    case 'operator_watcher_reset': {
      if (args.confirm !== true) throw new OperatorToolError('VALIDATION_ERROR', 'confirm must be true');
      const before = describeWatcher(client.workspaceFolder);
      if (args.all_blocked === true && Array.isArray(args.todo_ids)) {
        throw new OperatorToolError('VALIDATION_ERROR', 'all_blocked and todo_ids are mutually exclusive');
      }
      const todoIds = Array.isArray(args.todo_ids)
        ? await Promise.all(args.todo_ids.map(async (ref) => (await resolveTodo(client.workspaceFolder, text(ref))).id))
        : null;
      // Locked read-modify-write: the blockedBackoff entries are filtered from the
      // row read under the store lock, so a concurrent cycle close is never lost.
      const result = mutateWorkspaceWatcherRow(client.workspaceFolder, ({ row }) => {
        const patch = { failures: {}, backoffUntil: '' };
        if (args.all_blocked === true) patch.blockedBackoff = {};
        else if (todoIds) {
          patch.blockedBackoff = Object.fromEntries(
            Object.entries(row.blockedBackoff || {}).filter(([id]) => !todoIds.includes(id)),
          );
        }
        return patch;
      }, { dataDir: dataDir() });
      if (!result.ok) throw new OperatorToolError('CONFLICT', `watcher reset failed: ${result.reason || 'unknown'}`);
      // Same live refresh the Settings "Clear backoff" path sends via applyWorkspaceWatcherPatch.
      broadcastWorkspaceWatcherChanged();
      return {
        before: { backoff_until: before.backoff_until, failures: before.failures, blocked_backoff: before.blocked_backoff },
        after: describeWatcher(client.workspaceFolder),
      };
    }

    case 'operator_watcher_pause': {
      assertOperatorLease({ workspaceFolder: client.workspaceFolder, sessionId: client.sessionId || client.id, clientId: client.id, clientName: client.name }, journalOptions);
      if (args.confirm !== true) throw new OperatorToolError('VALIDATION_ERROR', 'confirm must be true');
      if (typeof args.paused !== 'boolean') throw new OperatorToolError('VALIDATION_ERROR', 'paused must be a boolean');
      applyWorkspaceWatcherPatch({
        dataDir: dataDir(),
        workspaceFolder: client.workspaceFolder,
        patch: { paused: args.paused },
      });
      recordOperatorEvent(client.workspaceFolder, 'watcher_pause', args.paused ? 'Workspace Watcher paused' : 'Workspace Watcher resumed', journalOptions);
      return describeWatcher(client.workspaceFolder);
    }

    case 'operator_watcher_limits': {
      if (args.limits === undefined) return describeWatcher(client.workspaceFolder).limits;
      assertOperatorLease({ workspaceFolder: client.workspaceFolder, sessionId: client.sessionId || client.id, clientId: client.id, clientName: client.name }, journalOptions);
      if (args.confirm !== true) throw new OperatorToolError('VALIDATION_ERROR', 'confirm must be true');
      const limits = args.limits;
      if (!limits || typeof limits !== 'object' || Array.isArray(limits) || Object.keys(limits).length === 0) {
        throw new OperatorToolError('VALIDATION_ERROR', 'limits must be a non-empty object');
      }
      /** @type {Record<string, number>} */
      const patch = {};
      for (const [key, value] of Object.entries(limits)) {
        const bounds = /** @type {Record<string, { min: number, max: number }>} */ (OPERATOR_WATCHER_LIMITS)[key];
        if (!bounds) {
          throw new OperatorToolError('VALIDATION_ERROR', `limit "${key}" is not operator-tunable (allowed: ${Object.keys(OPERATOR_WATCHER_LIMITS).join(', ')})`);
        }
        if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
          throw new OperatorToolError('VALIDATION_ERROR', `${key} must be an integer ${bounds.min}..${bounds.max}`);
        }
        patch[key] = /** @type {number} */ (value);
      }
      const before = describeWatcher(client.workspaceFolder).limits;
      applyWorkspaceWatcherPatch({ dataDir: dataDir(), workspaceFolder: client.workspaceFolder, patch: { policy: patch } });
      const after = describeWatcher(client.workspaceFolder).limits;
      recordOperatorEvent(client.workspaceFolder, 'watcher_limits', `Watcher limits changed: ${Object.keys(patch).map((key) => `${key} ${before[key]}->${after[key]}`).join(', ')}`, journalOptions);
      return { before, after };
    }

    case 'operator_scout_enable': {
      assertOperatorLease({ workspaceFolder: client.workspaceFolder, sessionId: client.sessionId || client.id, clientId: client.id, clientName: client.name }, journalOptions);
      if (args.confirm !== true) throw new OperatorToolError('VALIDATION_ERROR', 'confirm must be true');
      if (typeof args.enabled !== 'boolean') throw new OperatorToolError('VALIDATION_ERROR', 'enabled must be a boolean');
      applyWorkspaceWatcherPatch({ dataDir: dataDir(), workspaceFolder: client.workspaceFolder, patch: { policy: { scoutEnabled: args.enabled } } });
      recordOperatorEvent(client.workspaceFolder, 'scout_enable', args.enabled ? 'Scouts enabled' : 'Scouts disabled', journalOptions);
      return describeWatcher(client.workspaceFolder);
    }

    case 'operator_watcher_release_unknown': {
      if (args.confirm !== true) throw new OperatorToolError('VALIDATION_ERROR', 'confirm must be true');
      const item = await resolveTodo(client.workspaceFolder, text(args.todo_id));
      const expectedUpdatedAt = text(args.expected_updated_at);
      if (!expectedUpdatedAt) throw new OperatorToolError('VALIDATION_ERROR', 'expected_updated_at is required');
      const result = /** @type {any} */ (releaseDoingWorkspaceWatcherTodoForOperator({
        dataDir: dataDir(),
        workspaceFolder: client.workspaceFolder,
        todoId: item.id,
        expectedUpdatedAt,
        confirmUnknownRelease: true,
        operatorMessage: text(args.message) || `external MCP client "${client.name}"`,
        idempotencyKey: `external:${client.id}:release:${item.id}:${expectedUpdatedAt}`,
      }));
      if (!result?.ok) {
        const why = result?.error?.message || result?.state?.reason || '';
        throw new OperatorToolError('CONFLICT', `Release refused: ${result?.outcome || 'unknown'}${why ? ` (${why})` : ''}`);
      }
      const saved = await resolveTodo(client.workspaceFolder, item.id);
      return { todo_id: item.id, outcome: result.outcome || 'released', status: /** @type {any} */ (saved).status || '' };
    }

    case 'operator_plan_review_start': {
      const item = await resolveTodo(client.workspaceFolder, text(args.todo_id));
      const harness = text(args.harness);
      const key = text(args.idempotency_key);
      if (!harness) throw new OperatorToolError('VALIDATION_ERROR', 'harness is required');
      if (!key) throw new OperatorToolError('VALIDATION_ERROR', 'idempotency_key is required');
      if (!text(item.plan?.markdown)) {
        throw new OperatorToolError('CONFLICT', 'Todo has no plan to review; write the draft into the plan field first (todo_update patch.plan.markdown)');
      }
      const memoKey = `${client.id}:${key}`;
      const replay = planReviewStarts.get(memoKey);
      if (replay) return { ...replay, replayed: true };
      const cooperationMode = text(args.cooperation_mode);
      /** @type {any} */
      let started;
      try {
        started = await getBuiltinMcpRuntimeDeps().startTodoAgent({
          workspaceFolder: client.workspaceFolder,
          todoId: item.id,
          body: {
            mode: 'refine',
            model: text(args.model),
            agentTransport: harness,
            workspaceFolder: client.workspaceFolder,
            ...(cooperationMode ? { cooperationMode } : {}),
          },
        });
      } catch (error) {
        const failure = /** @type {any} */ (error);
        throw new OperatorToolError(
          failure?.status === 409 ? 'CONFLICT' : 'VALIDATION_ERROR',
          String(failure?.message || failure?.code || failure?.key || 'Plan review start failed'),
        );
      }
      const chat = started?.chat;
      const prompt = text(started?.initialPrompt);
      if (!chat?.id || !prompt) throw new OperatorToolError('CONFLICT', 'The plan review chat was not created');
      const run = await startChatRun({
        chatId: chat.id,
        prompt,
        mode: normalizeSdkMode(chat.sdkMode),
        requestId: `external:${client.id}:${key}`,
        displayText: prompt,
      });
      const result = {
        todo_id: item.id,
        chat_id: chat.id,
        run_id: run.runId,
        accepted: run.accepted,
        model: text(chat.model),
        plan_reviewer_session_id: text(started.planReviewerSession?.id),
      };
      planReviewStarts.set(memoKey, result);
      return result;
    }

    case 'operator_plan_approve': {
      const item = await resolveTodo(client.workspaceFolder, text(args.todo_id));
      const expectedUpdatedAt = text(args.expected_updated_at);
      if (!expectedUpdatedAt) throw new OperatorToolError('VALIDATION_ERROR', 'expected_updated_at is required');
      if (!text(item.plan?.markdown)) throw new OperatorToolError('CONFLICT', 'Todo has no plan to approve');
      // CAS first: a stale revision must not pass as a no-op replay.
      if (text(item.updatedAt) !== expectedUpdatedAt) {
        throw new OperatorToolError('CONFLICT', 'expected_updated_at does not match the current todo revision; re-read the todo');
      }
      if (text(item.plan?.approvedAt)) {
        return { todo_id: item.id, plan_approved_at: item.plan.approvedAt, already_approved: true };
      }
      const planReview = /** @type {{ plan?: { state?: string } }} */ (buildTodoReviewReadModel(item)).plan;
      if (planReview?.state === 'pending') {
        throw new OperatorToolError('CONFLICT', 'Plan review is still pending; wait for the reviewers first');
      }
      const approvedAt = new Date(now()).toISOString();
      const note = text(args.note);
      await updateTodo(dataDir(), client.workspaceFolder, item.id, {
        expectedUpdatedAt,
        plan: { approvedAt, approvedBy: { kind: 'mcp-operator', clientId: client.id, clientName: client.name } },
        appendChangelog: {
          kind: 'note',
          text: `Plan approved by external MCP client "${client.name}" (${client.id.slice(0, 8)})${note ? `: ${note}` : ''}`,
        },
      });
      const { scheduleWorkspaceWatcherAutopilot } = await import('../workspace-watcher-event-schedule.js');
      scheduleWorkspaceWatcherAutopilot({ workspaceFolder: client.workspaceFolder, dataDir: dataDir() });
      const saved = await resolveTodo(client.workspaceFolder, item.id);
      return { todo_id: item.id, plan_approved_at: saved.plan?.approvedAt || '', updated_at: saved.updatedAt || '' };
    }

    default:
      throw new OperatorToolError('NOT_FOUND', `Unknown operator tool: ${name}`);
  }
}

/**
 * @param {import('./mcp-external-clients.js').ExternalMcpClientInfo} client
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {{ signal?: AbortSignal, now?: () => number }} [options]
 * @returns {Promise<{ content: { type: 'text', text: string }[], isError: boolean }>}
 */
export async function callExternalOperatorTool(client, name, args, options = {}) {
  if (client.mode !== 'operator') {
    return { content: [{ type: 'text', text: 'FORBIDDEN: operator tools need an operator-mode client token' }], isError: true };
  }
  try {
    const result = await runTool(client, name, args || {}, options);
    return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : 'ERROR';
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `${code}: ${message}` }], isError: true };
  }
}
