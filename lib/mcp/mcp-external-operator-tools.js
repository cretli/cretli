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

import { readTodoExecutionState } from '../todo-tree.js';
import { findWorkspaceWatcherStaleDoing } from '../workspace-watcher-guardrails.js';
import { readSupervisorStatus } from '../autostart/supervisor-status.js';
import { getAutoBackupStatus } from '../backup/auto-backup.js';
import { loadChatsAsync } from '../persist/chats-persist.js';
import { listTodos, updateTodo } from '../persist/todos-store.js';
import { getTodoRepository } from '../persist/todo-repository.js';
import { cancelChatRun, getChatRunStateForChat, startChatRun } from '../chat-run-service.js';
import { normalizeSdkMode } from '../sdk/sdk-mode.ts';
import { getChatAgentTransport } from '../agent-transport.js';
import { buildTodoReviewReadModel, findTodoReviewerForDelegation } from '../todo-review-read.js';
import { getDelegationById, listDelegationsForWorkspace } from '../persist/delegations-persist.js';
import { workspaceIndexKey } from '../persist/delegation-index-fields.js';
import { resolveDelegationRecordVerdict } from '../delegation-verdict.js';
import { parseReviewFindings, summarizeParsedReviewFindings } from '../review-findings-parse.js';
import { paginateDetail } from './builtin/paging.js';
import { findChatByRef } from '../remote-api-client.js';
import { isChatInWorkspace } from './builtin/tool-context.js';
import { getBuiltinMcpRuntimeDeps } from './builtin/runtime-deps.js';
import { resolveDataPath } from '../runtime-paths.js';
import {
  TODO_BLOCKED_REASON_INSUFFICIENT_REVIEWERS,
  blockTodoForInsufficientReviewers,
  clearInsufficientReviewersBlock,
  runPlanReviewerPreflight,
} from '../plan-review-preflight.js';
import {
  applyWorkspaceWatcherPatch,
  clearWorkspaceWatcherStop,
  getWorkspaceWatcherView,
  releaseDoingWorkspaceWatcherTodoForOperator,
} from '../workspace-watcher-control.js';
import { resolveExecutionSettingsView } from '../execution-settings.js';
import { mutateWorkspaceWatcherRow } from '../persist/workspace-watchers-persist.js';
import { broadcastWorkspaceWatcherChanged } from '../workspace-watcher-live.js';
import { enqueueMailboxMessage } from '../delegation-mailbox.js';
import { findMailboxByIdempotencyKey } from '../persist/delegation-mailbox-persist.js';
import { readOperatorPlaybook } from './mcp-external-guide.js';
import { MCP_OPERATOR_PROMPT_PROPOSAL_TOOL, callMcpOperatorPromptProposalTool } from './mcp-operator-prompt-proposal-tool.js';
import { createModelPickOverride, readModelPickOverrides, revokeModelPickOverride } from '../persist/model-pick-overrides-persist.js';
import { readModelRoleConfig, writeModelRoleConfig, ModelRoleConfigError } from '../model-role-config-store.js';
import { loadSettings, saveSettings } from '../persist/settings.js';
import { operatorSettingsWriteFields, readOperatorSettingsSection, OPERATOR_SETTINGS_SECTIONS } from './operator-settings-sections.js';
import { applySettingsPatch } from '../routes/settings-routes.js';
import { broadcastChatListChanged } from '../chat-list-updates.js';
import { normalizeChatEnabledModels } from '../model-catalog.js';
import { getBuiltinHarnessBackend } from '../agent-harness/builtin-harness-backends.ts';
import { MODEL_PICK_ROLES } from '../model-role-profiles.js';
import { buildHarnessDiagnosticsReport } from '../routes/harness-diagnostics-routes.js';
import { listIntegrateBatches, readIntegrateBatch } from '../integrate-batch.js';
import { acceptWorkspaceWatcherScopeRequest } from '../workspace-watcher-cycle-close.js';
import { parseScopeRequest } from '../todo-parallel-scope.js';
import { confirmWorkspaceTodoIntegration } from '../workspace-watcher-integration.js';
import { getIntegrationLock } from '../integration-lock.js';
import { listRegisteredWorkspacesForFolder } from '../workspace-registry-service.js';
import { sanitizeWorkspaces, toPosixPath } from '../persist/workspace-registry.js';
import { createHash } from 'node:crypto';
import { readServerMetrics } from '../server-health/server-metrics.js';
import fs from 'node:fs';
import path from 'node:path';
import { listUnclassifiedSignatures, redactUnclassifiedText } from '../usage/unclassified-errors.js';
import { addOperatorNote, assertOperatorLease, operatorHandoff, readLatestOperatorEventsByLeaf, recordOperatorEvent, resolveOperatorNote } from '../persist/operator-journal-persist.js';

const TODO_ID_MIN_PREFIX = 8;

/**
 * Throughput limits an operator may tune. Everything else in the Watcher policy
 * (plan approval, review gate, autoIntegrate/autoRestart, phases, harness
 * allowlists, mode, stop reason) stays a Settings decision of the human.
 * Bounds mirror normalizeWorkspaceWatcherPolicy so a bad value is refused here
 * instead of being silently clamped.
 */
const OPERATOR_WATCHER_LIMITS = Object.freeze({
  maxParallel: { min: 1, max: 12 },
  maxParallelCeiling: { min: 5, max: 12 },
  maxParallelWorktree: { min: 0, max: 12 },
  maxParallelProject: { min: 0, max: 12 },
  maxCyclesPerDay: { min: 1, max: 1000 },
  maxConsecutiveFailures: { min: 1, max: 100 },
  maxSameFindings: { min: 1, max: 100 },
  cooldownMs: { min: 0, max: 3_600_000 },
  backoffBaseMs: { min: 1_000, max: 24 * 3_600_000 },
  backoffCapMs: { min: 1_000, max: 7 * 24 * 3_600_000 },
});


/** Policy fields an operator may patch; `sensitive` ones need a reason. */
const OPERATOR_WATCHER_POLICY_FIELDS = Object.freeze({
  executionMode: { sensitive: false }, requirePlanApproval: { sensitive: true }, planApprovalScope: { sensitive: true },
  requireReviewForDone: { sensitive: true }, requireIndependentReview: { sensitive: true }, reviewGateMaxAttempts: { sensitive: false },
  phases: { sensitive: false }, autoIntegrate: { sensitive: true }, autoRestart: { sensitive: true },
  allowedHarnesses: { sensitive: false }, pickRoles: { sensitive: false }, proactivePlanning: { sensitive: false },
  feedbackTriage: { sensitive: false },
});
const OPERATOR_WATCHER_WORKTREE_FIELDS = Object.freeze({ dirtyPolicy: true, prepareCommand: true });

/** @param {Record<string, any>} policy */
function pickOperatorPolicy(policy) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const key of Object.keys(OPERATOR_WATCHER_POLICY_FIELDS)) out[key] = policy?.[key];
  out.worktree = { dirtyPolicy: policy?.worktree?.dirtyPolicy, prepareCommand: policy?.worktree?.prepareCommand };
  return out;
}

/**
 * Workspace a watcher/handoff call targets: the client's own, or an optional
 * `workspace` argument that must be in the registry. Mutations still go through
 * the per-workspace operator lease, so this never bypasses it.
 *
 * @param {{ workspaceFolder?: string }} client
 * @param {Record<string, any>} args
 * @returns {string}
 */
function targetWorkspace(client, args) {
  const raw = args.workspace;
  if (raw === undefined || raw === null || raw === '') return String(client.workspaceFolder || '');
  if (typeof raw !== 'string') throw new OperatorToolError('VALIDATION_ERROR', 'workspace must be a string');
  const wanted = canonicalPath(raw);
  if (!wanted) throw new OperatorToolError('NOT_FOUND', 'Workspace is not registered');
  if (wanted === canonicalPath(client.workspaceFolder)) return client.workspaceFolder;
  const settings = loadSettings();
  const posix = toPosixPath(wanted);
  const known = sanitizeWorkspaces(settings?.workspaces).some((entry) => entry.id === posix || canonicalPath(entry.id) === wanted)
    || listRegisteredWorkspacesForFolder(settings, wanted).length > 0;
  if (!known) throw new OperatorToolError('NOT_FOUND', 'Workspace is not registered');
  return wanted;
}

/** @param {string} workspaceFolder */
async function readOperatorPolicy(workspaceFolder) {
  const view = /** @type {any} */ (await getWorkspaceWatcherView({ dataDir: dataDir(), workspaceFolder }));
  const picked = pickOperatorPolicy(view?.watcher?.policy || {});
  // executionMode and worktree live in the execution-settings store; report the effective values.
  const { effective } = resolveExecutionSettingsView({ workspaceFolder, dataDir: dataDir() });
  picked.executionMode = effective.executionMode;
  picked.worktree = { dirtyPolicy: effective.worktree?.dirtyPolicy, prepareCommand: effective.worktree?.prepareCommand };
  return picked;
}

/** @typedef {{ id: string, title?: string, agentTransport?: string, sdkMode?: string }} OperatorChat */
/** @typedef {{ id: string, updatedAt?: string, plan?: { markdown?: string, approvedAt?: string }, reservedBy?: Record<string, any> | null }} OperatorTodo */
const WAIT_DEFAULT_MS = 30_000;
const WAIT_MAX_MS = 55_000;
const WAIT_POLL_MS = 1_000;

export const HANDOFF_DEFAULT_NOTES_LIMIT = 20;
export const HANDOFF_DEFAULT_EVENTS_LIMIT = 20;
export const HANDOFF_NOTE_WINDOW_HOURS = 48;

export const EXTERNAL_OPERATOR_TOOLS = Object.freeze([
  { name: 'operator_settings_get', description: 'List safe Settings sections or read one allowlisted section. Sensitive fields are redacted.', inputSchema: { type: 'object', properties: { section: { type: 'string', enum: OPERATOR_SETTINGS_SECTIONS.map(({ id }) => id) } } } },
  { name: 'operator_settings_set', description: 'Patch fields in a safe Settings section using the same validators and persistence as PATCH /api/settings. Requires operator_handoff, confirm:true and a reason.', inputSchema: { type: 'object', properties: { section: { type: 'string', enum: OPERATOR_SETTINGS_SECTIONS.map(({ id }) => id) }, patch: { type: 'object' }, confirm: { type: 'boolean' }, reason: { type: 'string' } }, required: ['section', 'patch', 'confirm', 'reason'] } },
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
    inputSchema: { type: 'object', properties: { takeover: { type: 'boolean' }, workspace: { type: 'string', description: 'Optional registered workspace folder to target instead of this client\'s own. Must be in the workspace registry; mutations need the operator lease on that workspace (call operator_handoff with the same workspace first).' }, notes_limit: { type: 'integer', minimum: 0, maximum: 500, description: `Max unresolved notes returned (default ${HANDOFF_DEFAULT_NOTES_LIMIT}, newest first). By default only notes from the last ${HANDOFF_NOTE_WINDOW_HOURS} h are listed; the rest is counted in notes_older_count.` }, events_limit: { type: 'integer', minimum: 0, maximum: 1000, description: `Max raw events since the last handoff (default ${HANDOFF_DEFAULT_EVENTS_LIMIT}, newest kept). Every event is still counted in event_groups ("17x integration").` }, include_all: { type: 'boolean', description: 'Legacy full payload: every unresolved note, every event since the last visit and every session. Can exceed 50k characters.' } } },
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
      rolesDelta: { type: 'object', description: 'Role matcher changes. Requires confirm:true and reason.' },
      confirm: { type: 'boolean' }, reason: { type: 'string' },
    }, required: ['operation'] },
  },
  {
    name: 'operator_todo_reserve',
    description: 'Reserve a todo for the human operator so Watcher scheduling and recovery leave it alone. Requires the active operator lease; defaults to four hours, max 24 hours.',
    inputSchema: { type: 'object', properties: { todo_id: { type: 'string' }, hours: { type: 'number' }, reason: { type: 'string' } }, required: ['todo_id'] },
  },
  {
    name: 'operator_todo_release',
    description: 'Release a todo reserved by this operator client. Requires the active operator lease.',
    inputSchema: { type: 'object', properties: { todo_id: { type: 'string' } }, required: ['todo_id'] },
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
    name: 'operator_delegation_show',
    description: 'Operator: read one delegation of this workspace by delegation_id (full id or prefix of at least 8 characters) or todo_id (its newest review delegation, other delegations listed briefly): role, executor, the verdict the reviewer wrote (raw_verdict) next to the verdict the server recorded on the todo (server_verdict, from todo.review), the report (paged with cursor) and parsed findings. Use it instead of delegation_show, which needs a calling chat. Read only; delegations of other workspaces are refused.',
    inputSchema: {
      type: 'object',
      properties: {
        delegation_id: { type: 'string', description: 'Full delegation id or a unique prefix (at least 8 characters).' },
        todo_id: { type: 'string', description: 'Todo id or prefix; selects its newest review delegation. Ignored when delegation_id is given.' },
        cursor: { type: 'string', description: 'next_cursor of a previous call; pages the report.' },
      },
    },
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
    description: 'Operator: send a user message to a chat and start its run, like typing in the UI. A busy chat queues the message in its mailbox (status queued + message_id; delivered at its next delegation_wait or when the run ends) unless deliver is "start" (refuse with recipient_busy) or wait_idle_ms lets the call wait for it to go idle. Replay with the same idempotency_key never sends twice.',
    inputSchema: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: 'Chat id (prefix ok) or title substring.' },
        text: { type: 'string' },
        idempotency_key: { type: 'string' },
        selected_skill_ids: { type: 'array', items: { type: 'string' }, maxItems: 32, description: 'Optional explicit skill IDs to activate for this message. Names inside the text never activate a skill.' },
        deliver: { type: 'string', enum: ['auto', 'queue', 'start'], description: 'auto (default): start now, queue when the chat is busy. queue: always go through the chat mailbox. start: never queue, refuse a busy chat with recipient_busy.' },
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
    name: 'operator_scope_accept',
    description: 'Operator: accept the scope proposal a needs_rescope report left on a TODO (watcher_report scope_request, shown as the "## Scope request" body section). Appends the files to "## Leaf scope", drops the proposal, clears the leaf\'s blocked backoff and failure counters and re-opens a parked (idea) leaf as ready, so the next Watcher cycle resumes from the existing worktree diff (fix round). files (optional) accepts only a subset; the rest stays proposed. The Watcher does not retry a leaf while its proposal is open.',
    inputSchema: {
      type: 'object',
      properties: {
        todo_id: { type: 'string', description: `Full todo id or unique prefix (>= ${TODO_ID_MIN_PREFIX} chars).` },
        files: { type: 'array', items: { type: 'string' }, description: 'Optional subset of the proposed files; default all.' },
        expected_updated_at: { type: 'string', description: 'Optional CAS token from todo_show.' },
      },
      required: ['todo_id'],
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
    name: 'operator_todo_integrated',
    description: 'Operator attestation: the task changes are integrated in commit (full or abbreviated SHA) on the workspace current local branch. Verifies git branch --contains, derives task/tree evidence, and sets done atomically. Supports squash and commits shared by several leaves. Tree descendants must already be done. Requires the operator lease. Never commits or merges.',
    inputSchema: { type: 'object', properties: {
      todo_id: { type: 'string' }, commit: { type: 'string' },
    }, required: ['todo_id', 'commit'] },
  },
  {
    name: 'operator_integrate_tree',
    description: 'Operator: integrate a finished todo subtree with one agent chat, like "Integrate subtree with agent" in the Todo panel. The server queues the eligible leaves under todo_id in tree order (smart merge for live worktree results, verify for finished todos without one; already integrated leaves are left out), takes the workspace integration lock, creates the [Integrate] chat and starts it. The agent merges and confirms entry by entry; nothing is pushed. Follow it with operator_integrate_status or operator_chat_wait. A retry with the same idempotency_key returns the first result.',
    inputSchema: {
      type: 'object',
      properties: {
        todo_id: { type: 'string', description: `Subtree root: full todo id or unique prefix (>= ${TODO_ID_MIN_PREFIX} chars).` },
        harness: { type: 'string', description: 'Harness for the integration chat (for example claude or codex).' },
        model: { type: 'string', description: 'Model for the integration chat. Omitted or auto selects the harness default.' },
        idempotency_key: { type: 'string', description: 'Stable key for this start request.' },
      },
      required: ['todo_id', 'harness', 'idempotency_key'],
    },
  },
  {
    name: 'operator_integrate_status',
    description: 'Operator: bulk integration batches of this workspace with per-entry state (queued, running, awaiting_confirmation, merged, verified, failed, skipped, cancelled) and the current integration lock. Pass batch_id for one batch. Read only.',
    inputSchema: {
      type: 'object',
      properties: { batch_id: { type: 'string', description: 'Optional batch id from operator_integrate_tree.' } },
    },
  },
  {
    name: 'operator_watcher_status',
    description: 'Operator: compact Workspace Watcher state for this workspace — mode, pause/stop, backoff, failure counts, active cycles and the last decisions. Read only. Pass `workspace` to read any registered workspace.',
    inputSchema: { type: 'object', properties: { workspace: { type: 'string', description: 'Optional registered workspace folder to target instead of this client\'s own. Must be in the workspace registry; mutations need the operator lease on that workspace (call operator_handoff with the same workspace first).' } } },
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
        workspace: { type: 'string', description: 'Optional registered workspace folder to target instead of this client\'s own. Must be in the workspace registry; mutations need the operator lease on that workspace (call operator_handoff with the same workspace first).' },
        paused: { type: 'boolean', description: 'true pauses, false resumes.' },
        confirm: { type: 'boolean', description: 'Must be true.' },
        reason: { type: 'string', description: 'Why (logged by the /mcp audit with the call).' },
      },
      required: ['paused', 'confirm'],
    },
  },
  {
    name: 'operator_watcher_clear_stop',
    description: 'Operator: clear the Workspace Watcher stopReason, like "Clear stop" in Settings → Workspace Watcher. A loop-guard stop (loop_no_eligible_work, loop_same_findings) also resets failures, backoff and the todos the loop guard parked; any other stop (e.g. integration_materialization_mismatch) only loses stopReason, so fix its cause first or the Watcher stops again. Requires the operator lease and confirm: true.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Optional registered workspace folder to target instead of this client\'s own. Must be in the workspace registry; mutations need the operator lease on that workspace (call operator_handoff with the same workspace first).' },
        confirm: { type: 'boolean', description: 'Must be true.' },
        reason: { type: 'string', description: 'Why the stop can be cleared (logged by the /mcp audit with the call).' },
      },
      required: ['confirm'],
    },
  },
  {
    name: 'operator_watcher_limits',
    description: 'Operator: read or change Workspace Watcher throughput limits: maxParallel (1-12), maxParallelCeiling (5-12; default 5), maxParallelWorktree/maxParallelProject (0-12, 0 = inherit maxParallel), maxCyclesPerDay, maxConsecutiveFailures, maxSameFindings, cooldownMs, backoffBaseMs and backoffCapMs. Values above five require increasing maxParallelCeiling and are gated by host resources. Without limits it only returns current values. Sensitive settings remain available in Settings only. Changes require the operator lease and confirm: true; running cycles are not interrupted.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Optional registered workspace folder to target instead of this client\'s own. Must be in the workspace registry; mutations need the operator lease on that workspace (call operator_handoff with the same workspace first).' },
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
    name: 'operator_watcher_policy',
    description: 'Operator: read or patch the Workspace Watcher policy beyond the numeric limits. Whitelisted fields: executionMode, requirePlanApproval, planApprovalScope, requireReviewForDone, requireIndependentReview, reviewGateMaxAttempts, phases, autoIntegrate, autoRestart, allowedHarnesses, pickRoles, proactivePlanning, feedbackTriage, worktree.dirtyPolicy, worktree.prepareCommand. Sensitive fields (worktree.prepareCommand, worktree.dirtyPolicy, requirePlanApproval, planApprovalScope, requireReviewForDone, requireIndependentReview, autoIntegrate, autoRestart) additionally require a non-empty reason. Values are validated by the same Settings validators; the result shows before/after. Needs the operator lease and confirm: true. Mode, stop reason and secrets are not available here.',
    inputSchema: { type: 'object', properties: { patch: { type: 'object' }, confirm: { type: 'boolean' }, reason: { type: 'string' } } },
  },
  {
    name: 'operator_server_status',
    description: 'Operator: read-only server readiness probe. Returns pid, uptime and start time of the serving process plus rolling 1/5/15 min metrics (event-loop delay p50/p99/max, ELU, GC, alloc rate, heapUsed), so a client can tell a fresh restart (small uptime) from a long-running server. Restart itself is not exposed (supervised restart stays a Settings/script action).',
    inputSchema: { type: 'object', properties: {} },
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
/** First result of each operator_integrate_tree, keyed by client id + idempotency key (process lifetime). */
const integrateTreeStarts = new Map();

/**
 * Compact batch view for operator tools (no prompts, no secrets).
 *
 * @param {Record<string, any> | null} batch
 */
function describeBatch(batch) {
  if (!batch) return null;
  return {
    batch_id: text(batch.id),
    status: text(batch.status),
    paused_reason: text(batch.pausedReason),
    chat_id: text(batch.chatId),
    created_at: text(batch.createdAt),
    entries: (Array.isArray(batch.entries) ? batch.entries : []).map((/** @type {any} */ entry) => ({
      todo_id: text(entry.todoId),
      target_id: text(entry.targetId),
      title: text(entry.title),
      mode: text(entry.mode),
      state: text(entry.state),
      reason: text(entry.reason),
    })),
    skipped: Array.isArray(batch.skipped) ? batch.skipped : [],
  };
}

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
 * @returns {Promise<OperatorChat>}
 */
async function resolveChat(client, ref) {
  const value = text(ref);
  if (!value) throw new OperatorToolError('VALIDATION_ERROR', 'chat is required');
  /** @type {OperatorChat[]} */
  const chats = (await loadChatsAsync()).filter((chat) => isChatInWorkspace(chat, client.workspaceFolder));
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
/**
 * Leaves whose latest reviewer-pair journal event is `reviewer_pair_unsatisfiable`
 * (a later `reviewer_pair_satisfiable` clears the alert).
 *
 * @param {string} workspaceFolder
 * @returns {{ leaf_id: string, missing: string, since: string }[]}
 */
function readReviewerPairAlerts(workspaceFolder) {
  try {
    const latest = readLatestOperatorEventsByLeaf(workspaceFolder, ['reviewer_pair_unsatisfiable', 'reviewer_pair_satisfiable'], { dataDir: dataDir() });
    return [...latest.values()]
      .filter((event) => event.kind === 'reviewer_pair_unsatisfiable')
      .map((event) => ({
        leaf_id: event.leafId,
        missing: /, missing (.*)$/.exec(event.summary)?.[1] || '',
        since: event.createdAt,
      }));
  } catch {
    return [];
  }
}

const HANDOFF_DEFAULT_SESSIONS_LIMIT = 10;
const HANDOFF_TEXT_CAP = 400;

/** @param {unknown} value @param {number} fallback @param {number} max */
function handoffLimit(value, fallback, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : fallback;
}

/** @param {unknown} value */
function clipHandoffText(value) {
  const s = String(value ?? '');
  return s.length > HANDOFF_TEXT_CAP ? `${s.slice(0, HANDOFF_TEXT_CAP)}…` : s;
}

/**
 * Shrink the journal handoff to an MCP-sized answer. Unresolved notes older
 * than 48 h are only counted, raw events are capped (newest kept) and every
 * event is still summarised in `event_groups`. `include_all: true` returns the
 * legacy full payload.
 *
 * @param {Record<string, any>} result operatorHandoff() result
 * @param {Record<string, any>} args tool arguments
 * @param {number} nowMs
 */
export function compactOperatorHandoff(result, args = {}, nowMs = Date.now()) {
  const notes = Array.isArray(result.notes) ? result.notes : [];
  const events = Array.isArray(result.events) ? result.events : [];
  const sessions = Array.isArray(result.sessions) ? result.sessions : [];
  const groups = new Map();
  for (const event of events) {
    const kind = String(event?.kind || '');
    const group = groups.get(kind) || { kind, count: 0, first_at: event?.createdAt || '', last_at: '', last_summary: '' };
    group.count += 1;
    group.last_at = event?.createdAt || group.last_at;
    group.last_summary = clipHandoffText(event?.summary);
    groups.set(kind, group);
  }
  const event_groups = [...groups.values()].sort((a, b) => b.count - a.count).map((g) => ({ ...g, label: `${g.count}× ${g.kind}` }));
  if (args.include_all === true) return { ...result, compact: false, event_groups };
  const cutoff = nowMs - HANDOFF_NOTE_WINDOW_HOURS * 3_600_000;
  const recent = notes.filter((note) => { const at = Date.parse(String(note?.createdAt || '')); return !Number.isFinite(at) || at >= cutoff; });
  const notesLimit = handoffLimit(args.notes_limit, HANDOFF_DEFAULT_NOTES_LIMIT, 500);
  const eventsLimit = handoffLimit(args.events_limit, HANDOFF_DEFAULT_EVENTS_LIMIT, 1000);
  const shownNotes = recent.slice(0, notesLimit).map((note) => ({ ...note, text: clipHandoffText(note.text) }));
  const shownEvents = (eventsLimit === 0 ? [] : events.slice(-eventsLimit)).map((event) => ({ ...event, summary: clipHandoffText(event.summary) }));
  return {
    ...result,
    compact: true,
    notes: shownNotes,
    notes_total: notes.length,
    notes_older_count: notes.length - recent.length,
    notes_omitted: recent.length - shownNotes.length,
    events: shownEvents,
    events_total: events.length,
    events_omitted: events.length - shownEvents.length,
    event_groups,
    sessions: sessions.slice(0, HANDOFF_DEFAULT_SESSIONS_LIMIT),
    sessions_total: sessions.length,
  };
}

/**
 * Read-only operator diagnostics, including leaves absent from recovery classification.
 * @param {Record<string, any>} view
 * @param {Record<string, any>[]} items
 * @param {number} [now]
 * @param {unknown} [staleDoingHours]
 */
export function describeWatcherTodoAttention(view, items, now = Date.now(), staleDoingHours = 24) {
  const states = Array.isArray(view?.snapshot?.doingStates) ? view.snapshot.doingStates : [];
  const stale = findWorkspaceWatcherStaleDoing({ items, now, staleDoingHours,
    doingStates: states, cycles: view?.watcher?.activeCycles || [] });
  const byId = new Map(states.map((row) => [row.todoId, row]));
  for (const row of stale) byId.set(row.todoId, row);
  const policy = view?.watcher?.policy && typeof view.watcher.policy === 'object' ? view.watcher.policy : null;
  return {
    ready_blocked_by_gate: items.filter((item) => readTodoExecutionState(items, item, policy) === 'waiting_plan').length,
    stale_doing: stale.length,
    doing_attention: [...byId.values()]
      .filter((row) => ['unknown', 'recoverable', 'user_action'].includes(String(row?.state || '')))
      .map((row) => ({ todo_id: row.todoId || '', state: row.state || '', reason: row.reason || '',
        source: row.source || '', chat_id: row.chatId || '', revision: row.revision || '',
        ...(row.suggestedAction ? { suggested_action: row.suggestedAction } : {}),
      })),
  };
}

async function describeWatcher(workspaceFolder) {
  const view = /** @type {any} */ (await getWorkspaceWatcherView({ dataDir: dataDir(), workspaceFolder }));
  const watcher = view?.watcher || {};
  const items = Array.isArray(view?.snapshot?.items)
    ? view.snapshot.items : (await listTodos(dataDir(), workspaceFolder)).items || [];
  const attention = describeWatcherTodoAttention(view, items, Date.now(), process.env.CRETLI_STALE_DOING_HOURS);
  const decisions = Array.isArray(watcher.decisions) ? watcher.decisions
    : Array.isArray(view?.decisions) ? view.decisions : [];
  return {
    host_resources: view?.host_resources ?? null,
    mode: watcher.mode || '',
    paused: watcher.paused === true,
    stop_reason: watcher.stopReason || '',
    backoff_until: watcher.backoffUntil || '',
    failures: watcher.failures && typeof watcher.failures === 'object' ? /** @type {any} */ (watcher.failures) : {},
    // Per-todo backoff after blocked cycles: a ready todo listed here is skipped until `until`.
    blocked_backoff: watcher.blockedBackoff && typeof watcher.blockedBackoff === 'object'
      ? /** @type {Record<string, { count?: number, until?: string }>} */ (watcher.blockedBackoff) : {},
    // Last blocked close or preflight with a same-cause counter; null when none.
    last_blocked: watcher.lastBlocked && typeof watcher.lastBlocked === 'object' && watcher.lastBlocked.todoId
      ? {
        reason_code: watcher.lastBlocked.reasonCode || 'unspecified',
        count: Number(watcher.lastBlocked.count) || 0,
        todo_id: watcher.lastBlocked.todoId,
        at: watcher.lastBlocked.at || '',
      }
      : null,
    active_cycles: (Array.isArray(watcher.activeCycles) ? watcher.activeCycles : []).map((cycle) => ({
      cycle_id: cycle?.cycleId || '',
      chat_id: cycle?.chatId || '',
      todo_ids: Array.isArray(cycle?.todoIds) ? cycle.todoIds : [],
      started_at: cycle?.startedAt || '',
    })),
    ready_todo_count: Number(view?.snapshot?.readyTodoCount) || 0,
    reviewer_pair_alerts: readReviewerPairAlerts(workspaceFolder),
    limits: Object.fromEntries(Object.keys(OPERATOR_WATCHER_LIMITS).map((key) => [key, watcher.policy?.[key] ?? null])),
    ...attention,
    last_decisions: decisions.slice(-8).map((row) => ({
      at: row?.at || '',
      kind: row?.kind || row?.decision || '',
      reason: String(row?.reason || '').slice(0, 160),
      todo_id: row?.todoId || '',
      next_todo_id: row?.nextTodoId || '',
      // Candidates the Watcher passed over because they wait for a human.
      skipped_todo_ids: (Array.isArray(row?.rejections) ? row.rejections : [])
        .filter((entry) => entry?.filter === 'awaiting_plan_approval')
        .map((entry) => String(entry.id || '')),
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
  const { item: found, matches } = await getTodoRepository(dataDir()).resolveItem(workspaceFolder, value);
  if (found) return /** @type {OperatorTodo} */ ({ ...found });
  if (matches.length === 0) throw new OperatorToolError('NOT_FOUND', `Todo not found in this workspace: ${value}`);
  throw new OperatorToolError('AMBIGUOUS', `Todo id prefix is ambiguous: ${value}`);
}

const DELEGATION_ID_MIN_PREFIX = 8;

/**
 * Read-only delegation view for an operator client (no calling chat needed).
 * Lookups go through this workspace's delegation index, so a delegation of
 * another workspace is reported as not found.
 *
 * @param {{ workspaceFolder: string }} client
 * @param {Record<string, any>} args
 */
async function showOperatorDelegation(client, args) {
  const delegationRef = text(args.delegation_id);
  const todoRef = text(args.todo_id);
  if (!delegationRef && !todoRef) throw new OperatorToolError('VALIDATION_ERROR', 'delegation_id or todo_id is required');
  const scopeKey = workspaceIndexKey(client.workspaceFolder);
  const inWorkspace = (/** @type {any} */ row) => Boolean(row) && workspaceIndexKey(row.workspaceFolder) === scopeKey;
  /** @type {any} */
  let row = null;
  /** @type {any} */
  let todo = null;
  /** @type {any[]} */
  let others = [];
  if (delegationRef) {
    const exact = getDelegationById(delegationRef);
    if (exact) {
      row = inWorkspace(exact) ? exact : null;
    } else if (delegationRef.length >= DELEGATION_ID_MIN_PREFIX && /^[0-9a-f-]+$/i.test(delegationRef)) {
      const lower = delegationRef.toLowerCase();
      const matches = listDelegationsForWorkspace(client.workspaceFolder).filter((candidate) => String(candidate.id).toLowerCase().startsWith(lower));
      if (matches.length > 1) throw new OperatorToolError('AMBIGUOUS', `Delegation id prefix is ambiguous: ${delegationRef}`);
      row = matches[0] || null;
    }
    if (!row) throw new OperatorToolError('NOT_FOUND', `Delegation not found in this workspace: ${delegationRef}`);
    const leafId = text(row.leafId);
    if (leafId) todo = (await getTodoRepository(dataDir()).resolveItem(client.workspaceFolder, leafId)).item;
    if (todo) todo = { ...todo };
  } else {
    todo = await resolveTodo(client.workspaceFolder, todoRef);
    const forTodo = listDelegationsForWorkspace(client.workspaceFolder)
      .filter((candidate) => text(candidate.leafId) === todo.id)
      .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
    row = forTodo.find((candidate) => candidate.assignment === 'review') || forTodo[0] || null;
    if (!row) throw new OperatorToolError('NOT_FOUND', `No delegation recorded for todo ${todo.id}`);
    others = forTodo.filter((candidate) => candidate.id !== row.id).map((candidate) => ({
      id: candidate.id,
      assignment: text(candidate.assignment),
      status: text(candidate.status),
      raw_verdict: resolveDelegationRecordVerdict(candidate),
      created_at: text(candidate.createdAt),
    }));
  }
  const source = String(row.report || '');
  const revision = `${row.id}:report:${createHash('sha256').update(source, 'utf8').digest('hex').slice(0, 16)}`;
  /** @type {any} */
  let page;
  try {
    page = paginateDetail(source, { cursor: args.cursor, revision, field: 'report' });
  } catch (err) {
    const code = /** @type {any} */ (err)?.code;
    throw new OperatorToolError(code === 'CONFLICT' ? 'CONFLICT' : 'VALIDATION_ERROR', err instanceof Error ? err.message : String(err));
  }
  const parsed = parseReviewFindings(source);
  const executor = row.executor && typeof row.executor === 'object' ? row.executor : {};
  const reviewer = todo ? findTodoReviewerForDelegation(todo, row.id) : null;
  return {
    delegation_id: row.id,
    todo_id: todo?.id || text(row.leafId),
    status: text(row.status),
    assignment: text(row.assignment),
    work_role: text(row.workRole),
    review_subject: text(row.reviewSubject),
    harness: text(executor.transport),
    model: text(executor.model),
    attempt_id: text(row.attemptId),
    created_at: text(row.createdAt),
    finished_at: text(row.finishedAt),
    raw_verdict: resolveDelegationRecordVerdict(row),
    server_verdict: reviewer
      ? { ...reviewer, todo_review_state: reviewer.subject_state }
      : null,
    findings: { ...summarizeParsedReviewFindings(parsed), items: parsed.findings },
    report: page.text,
    truncated: page.truncated,
    next_cursor: page.next_cursor,
    ...(others.length ? { other_delegations: others } : {}),
  };
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
    case 'operator_settings_get': {
      if (args.section === undefined) return { sections: OPERATOR_SETTINGS_SECTIONS };
      if (typeof args.section !== 'string') throw new OperatorToolError('VALIDATION_ERROR', 'section must be a string');
      const settings = readOperatorSettingsSection(args.section, { workspaceFolder: client.workspaceFolder, dataDir: dataDir() });
      if (settings === null) throw new OperatorToolError('VALIDATION_ERROR', 'Unknown or forbidden settings section');
      return { section: args.section, settings };
    }
    case 'operator_settings_set': {
      if (typeof args.section !== 'string') throw new OperatorToolError('VALIDATION_ERROR', 'section must be a string');
      const allowed = operatorSettingsWriteFields(args.section);
      if (!allowed) throw new OperatorToolError('VALIDATION_ERROR', 'Unknown or read-only settings section');
      if (!args.patch || typeof args.patch !== 'object' || Array.isArray(args.patch) || !Object.keys(args.patch).length) throw new OperatorToolError('VALIDATION_ERROR', 'patch must be a non-empty object');
      const patch = /** @type {Record<string, any>} */ (args.patch);
      if (args.section === 'autoTitle' && patch.autoTitle && typeof patch.autoTitle === 'object') {
        for (const key of Object.keys(patch.autoTitle)) if (/(?:secret|token|api.?key|credential|account|auth|role|approval|human.?gate|allowSelfOrigin|browser|network)/i.test(key) || !['mode', 'source', 'provider', 'model'].includes(key)) throw new OperatorToolError('VALIDATION_ERROR', `Field autoTitle.${key} is not operator-tunable`);
      }
      if (args.section === 'chatAutoArchive' && patch.chatAutoArchive && typeof patch.chatAutoArchive === 'object') {
        for (const key of Object.keys(patch.chatAutoArchive)) if (/(?:secret|token|api.?key|credential|account|auth|role|approval|human.?gate|allowSelfOrigin|browser|network)/i.test(key) || !['enabled', 'skipFavorites', 'idleUnit', 'idleValue'].includes(key)) throw new OperatorToolError('VALIDATION_ERROR', `Field chatAutoArchive.${key} is not operator-tunable`);
      }
      for (const key of Object.keys(args.patch)) {
        if (/(?:secret|token|api.?key|credential|account|auth|role|approval|human.?gate|allowSelfOrigin|browser|network)/i.test(key) || !allowed.includes(key)) throw new OperatorToolError('VALIDATION_ERROR', `Field ${key} is not operator-tunable in ${args.section}`);
      }
      assertOperatorLease({ workspaceFolder: client.workspaceFolder, sessionId: client.sessionId || client.id, clientId: client.id, clientName: client.name }, journalOptions);
      if (args.confirm !== true) throw new OperatorToolError('VALIDATION_ERROR', 'confirm must be true');
      if (!text(args.reason)) throw new OperatorToolError('VALIDATION_ERROR', 'reason is required');
      const before = readOperatorSettingsSection(args.section, { workspaceFolder: client.workspaceFolder, dataDir: dataDir() });
      const settings = loadSettings();
      const patchResult = await applySettingsPatch({ body: args.patch }, settings);
      if (patchResult.error) throw new OperatorToolError('VALIDATION_ERROR', patchResult.error.message);
      if (!patchResult.changed) throw new OperatorToolError('VALIDATION_ERROR', 'patch contains no valid settings changes');
      saveSettings(settings);
      const after = readOperatorSettingsSection(args.section, { workspaceFolder: client.workspaceFolder, dataDir: dataDir() });
      recordOperatorEvent(client.workspaceFolder, 'settings_patch', `Settings ${args.section} changed: ${JSON.stringify({ before, after })}; reason: ${text(args.reason)}`, journalOptions);
      broadcastChatListChanged({ reason: 'settings' });
      return { section: args.section, before, after };
    }
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
      const result = operatorHandoff({ workspaceFolder: targetWorkspace(client, args), clientId: client.id, clientName: client.name, sessionId: client.sessionId || client.id }, { takeover: args.takeover === true }, journalOptions);
      if (!result.ok) throw new OperatorToolError('OPERATOR_LEASE_HELD', `Workspace is operated by ${result.lease.client_name} until ${result.lease.expires_at}; pass takeover=true to take over explicitly`);
      return compactOperatorHandoff(result, args, now());
    }

    case 'operator_note': {
      const scope = { workspaceFolder: client.workspaceFolder, clientId: client.id, clientName: client.name, sessionId: client.sessionId || client.id };
      if (args.operation === 'add') return addOperatorNote(scope, { kind: args.kind, text: args.text, todoId: args.todo_id, expiresAt: args.expires_at }, journalOptions);
      if (args.operation === 'resolve') return resolveOperatorNote(client.workspaceFolder, text(args.id), journalOptions);
      throw new OperatorToolError('VALIDATION_ERROR', 'operation must be add or resolve');
    }
    case 'operator_todo_reserve':
    case 'operator_todo_release': {
      assertOperatorLease({ workspaceFolder: client.workspaceFolder, sessionId: client.sessionId || client.id, clientId: client.id, clientName: client.name }, journalOptions);
      const item = await resolveTodo(client.workspaceFolder, text(args.todo_id));
      const release = name === 'operator_todo_release';
      const hours = args.hours === undefined ? 4 : Number(args.hours);
      if (!release && (!Number.isFinite(hours) || hours <= 0 || hours > 24)) throw new OperatorToolError('VALIDATION_ERROR', 'hours must be greater than 0 and at most 24');
      if (release && item.reservedBy?.kind === 'operator' && item.reservedBy.clientId !== client.id) throw new OperatorToolError('CONFLICT', 'Todo is reserved by another operator client');
      const reservedBy = release ? null : { kind: 'operator', clientId: client.id, until: new Date(now() + hours * 3_600_000).toISOString() };
      await updateTodo(dataDir(), client.workspaceFolder, item.id, {
        expectedUpdatedAt: item.updatedAt,
        reservedBy,
        appendChangelog: { kind: 'mcp-operator', text: release ? `Operator reservation released${text(args.reason) ? `: ${text(args.reason)}` : ''}.` : `Reserved for operator until ${reservedBy.until}${text(args.reason) ? `: ${text(args.reason)}` : ''}.` },
      });
      recordOperatorEvent(client.workspaceFolder, release ? 'todo_release' : 'todo_reserve', release ? `Released operator reservation for ${item.id}` : `Reserved ${item.id} for operator until ${reservedBy.until}`, journalOptions);
      return { todo_id: item.id, reserved_by: reservedBy };
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
        return { state: snapshot.state, error: snapshot.error, etag: snapshot.etag, roles: snapshot.roles, rotation: snapshot.rotation, weights: snapshot.weights };
      }
      if (operation !== 'patch') throw new OperatorToolError('VALIDATION_ERROR', 'operation must be get or patch');
      const ifMatch = requireIfMatch(args.if_match);
      const delta = {};
      if (args.rotation !== undefined) delta.rotation = args.rotation;
      if (args.weights !== undefined) delta.weights = args.weights;
      if (args.rolesDelta !== undefined) {
        assertOperatorLease({ workspaceFolder: client.workspaceFolder, sessionId: client.sessionId || client.id, clientId: client.id, clientName: client.name }, journalOptions);
        if (args.confirm !== true || !text(args.reason)) throw new OperatorToolError('VALIDATION_ERROR', 'rolesDelta changes require confirm:true and a reason');
        delta.roles = args.rolesDelta;
      }
      if (!Object.keys(delta).length) throw new OperatorToolError('VALIDATION_ERROR', 'rotation or weights is required');
      try {
        const result = checkedWrite(writeModelRoleConfig({ delta, ifMatch }));
        if (args.rolesDelta !== undefined) recordOperatorEvent(client.workspaceFolder, 'model_roles_delta', `Model role policy changed: ${text(args.reason)}`, journalOptions);
        return result;
      }
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
    case 'operator_delegation_show':
      return showOperatorDelegation(/** @type {any} */ (client), args);

    case 'operator_chat_status':
      return describeRun(await resolveChat(client, args.chat));

    case 'operator_chat_wait': {
      const chat = await resolveChat(client, args.chat);
      const requested = Number(args.timeout_ms);
      const timeoutMs = Number.isFinite(requested) && requested > 0 ? requested : WAIT_DEFAULT_MS;
      const run = await waitForIdle(chat, timeoutMs, { signal, now });
      return { ...run, timed_out: run.busy };
    }

    case 'operator_chat_send': {
      const chat = await resolveChat(client, args.chat);
      const message = text(args.text);
      const key = text(args.idempotency_key);
      if (!message) throw new OperatorToolError('VALIDATION_ERROR', 'text is required');
      if (!key) throw new OperatorToolError('VALIDATION_ERROR', 'idempotency_key is required');
      const waitMs = Number(args.wait_idle_ms);
      if (Number.isFinite(waitMs) && waitMs > 0) await waitForIdle(chat, waitMs, { signal, now });
      const deliver = text(args.deliver) || 'auto';
      if (!['auto', 'queue', 'start'].includes(deliver)) throw new OperatorToolError('VALIDATION_ERROR', 'deliver must be auto, queue or start');
      const requestId = `external:${client.id}:${key}`;
      const queueMessage = async () => {
        const res = await enqueueMailboxMessage({
          fromChatId: `operator:${client.id}`,
          toChatId: chat.id,
          kind: 'operator',
          body: message,
          extraInstructions: client.name,
          idempotencyKey: requestId,
        });
        if (!res.ok) throw new OperatorToolError('CONFLICT', res.error || 'operator message was not queued');
        const row = res.message || {};
        return {
          chat_id: chat.id,
          message_id: row.id,
          status: row.status,
          queued: row.status === 'queued',
          accepted: row.status === 'delivered',
          run_id: row.recipientRunId || row.runId || undefined,
        };
      };
      // A key that already went through the mailbox must replay there, even when
      // the chat is idle by now; starting it directly would send it twice.
      if (deliver === 'queue' || (deliver === 'auto' && findMailboxByIdempotencyKey(requestId))) return queueMessage();
      try {
        const started = await startChatRun({
          chatId: chat.id,
          prompt: message,
          mode: normalizeSdkMode(chat.sdkMode),
          requestId,
          displayText: message,
          origin: { kind: 'operator', clientId: client.id, clientName: client.name },
          selectedSkillIds: Array.isArray(args.selected_skill_ids) ? args.selected_skill_ids : [],
        });
        return { chat_id: chat.id, run_id: started.runId, accepted: started.accepted };
      } catch (err) {
        if (deliver === 'auto' && /** @type {any} */ (err)?.code === 'recipient_busy') return queueMessage();
        throw err;
      }
    }

    case 'operator_chat_stop': {
      const chat = await resolveChat(client, args.chat);
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
      return { ...await describeWatcher(targetWorkspace(client, args)), supervisor: readSupervisorStatus({ statePath: path.join(dataDir(), 'supervisor-state.json') }) };

    case 'operator_watcher_reset': {
      if (args.confirm !== true) throw new OperatorToolError('VALIDATION_ERROR', 'confirm must be true');
      const before = await describeWatcher(client.workspaceFolder);
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
        after: await describeWatcher(client.workspaceFolder),
      };
    }

    case 'operator_watcher_pause': {
      const target = targetWorkspace(client, args);
      assertOperatorLease({ workspaceFolder: target, sessionId: client.sessionId || client.id, clientId: client.id, clientName: client.name }, journalOptions);
      if (args.confirm !== true) throw new OperatorToolError('VALIDATION_ERROR', 'confirm must be true');
      if (typeof args.paused !== 'boolean') throw new OperatorToolError('VALIDATION_ERROR', 'paused must be a boolean');
      applyWorkspaceWatcherPatch({
        dataDir: dataDir(),
        workspaceFolder: target,
        patch: { paused: args.paused },
      });
      recordOperatorEvent(target, 'watcher_pause', args.paused ? 'Workspace Watcher paused' : 'Workspace Watcher resumed', journalOptions);
      return await describeWatcher(target);
    }

    case 'operator_watcher_clear_stop': {
      const target = targetWorkspace(client, args);
      assertOperatorLease({ workspaceFolder: target, sessionId: client.sessionId || client.id, clientId: client.id, clientName: client.name }, journalOptions);
      if (args.confirm !== true) throw new OperatorToolError('VALIDATION_ERROR', 'confirm must be true');
      const result = await clearWorkspaceWatcherStop({ dataDir: dataDir(), workspaceFolder: target });
      if (result.stopReason) {
        recordOperatorEvent(target, 'watcher_clear_stop', `Workspace Watcher stop cleared: ${result.stopReason}`, journalOptions);
      }
      return {
        cleared_stop_reason: result.stopReason,
        ...(result.unblockedTodoIds ? { unblocked_todo_ids: result.unblockedTodoIds } : {}),
        after: await describeWatcher(target),
      };
    }

    case 'operator_watcher_limits': {
      const target = targetWorkspace(client, args);
      if (args.limits === undefined) return (await describeWatcher(target)).limits;
      assertOperatorLease({ workspaceFolder: target, sessionId: client.sessionId || client.id, clientId: client.id, clientName: client.name }, journalOptions);
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
      const before = (await describeWatcher(target)).limits;
      const effectiveCeiling = patch.maxParallelCeiling ?? before.maxParallelCeiling ?? 5;
      if ((patch.maxParallel ?? before.maxParallel ?? 1) > effectiveCeiling) {
        throw new OperatorToolError('VALIDATION_ERROR', 'maxParallel cannot exceed maxParallelCeiling; set both limits together');
      }
      applyWorkspaceWatcherPatch({ dataDir: dataDir(), workspaceFolder: target, patch: { policy: patch } });
      const after = (await describeWatcher(target)).limits;
      recordOperatorEvent(target, 'watcher_limits', `Watcher limits changed: ${Object.keys(patch).map((key) => `${key} ${before[key]}->${after[key]}`).join(', ')}`, journalOptions);
      return { before, after };
    }

    case 'operator_watcher_policy': {
      if (args.patch === undefined) return await readOperatorPolicy(client.workspaceFolder);
      assertOperatorLease({ workspaceFolder: client.workspaceFolder, sessionId: client.sessionId || client.id, clientId: client.id, clientName: client.name }, journalOptions);
      if (args.confirm !== true) throw new OperatorToolError('VALIDATION_ERROR', 'confirm must be true');
      const raw = args.patch;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length === 0) throw new OperatorToolError('VALIDATION_ERROR', 'patch must be a non-empty object');
      const { worktree, ...rest } = /** @type {Record<string, any>} */ (raw);
      let sensitive = false;
      for (const key of Object.keys(rest)) {
        const spec = /** @type {Record<string, { sensitive: boolean }>} */ (OPERATOR_WATCHER_POLICY_FIELDS)[key];
        if (!spec) throw new OperatorToolError('VALIDATION_ERROR', `policy field "${key}" is not operator-tunable (allowed: ${Object.keys(OPERATOR_WATCHER_POLICY_FIELDS).join(', ')}, worktree.dirtyPolicy, worktree.prepareCommand)`);
        if (spec.sensitive) sensitive = true;
      }
      if (worktree !== undefined) {
        if (!worktree || typeof worktree !== 'object' || Array.isArray(worktree)) throw new OperatorToolError('VALIDATION_ERROR', 'worktree must be an object');
        for (const key of Object.keys(worktree)) {
          if (!/** @type {Record<string, boolean>} */ (OPERATOR_WATCHER_WORKTREE_FIELDS)[key]) throw new OperatorToolError('VALIDATION_ERROR', `worktree.${key} is not operator-tunable (allowed: dirtyPolicy, prepareCommand)`);
        }
        sensitive = true;
        if (worktree.dirtyPolicy !== undefined && !['block', 'head', 'snapshot'].includes(worktree.dirtyPolicy)) throw new OperatorToolError('VALIDATION_ERROR', 'worktree.dirtyPolicy must be block, head or snapshot');
        if (worktree.prepareCommand !== undefined && !(Array.isArray(worktree.prepareCommand) && worktree.prepareCommand.every((part) => typeof part === 'string'))) throw new OperatorToolError('VALIDATION_ERROR', 'worktree.prepareCommand must be an argv string array');
      }
      if (rest.executionMode !== undefined && !['project', 'worktree'].includes(rest.executionMode)) throw new OperatorToolError('VALIDATION_ERROR', 'executionMode must be project or worktree');
      if (rest.planApprovalScope !== undefined && !['leaf', 'root'].includes(rest.planApprovalScope)) throw new OperatorToolError('VALIDATION_ERROR', 'planApprovalScope must be leaf or root');
      if (rest.feedbackTriage !== undefined && !['off', 'propose', 'auto'].includes(rest.feedbackTriage)) throw new OperatorToolError('VALIDATION_ERROR', 'feedbackTriage must be off, propose or auto');
      for (const key of ['requirePlanApproval', 'requireIndependentReview', 'autoIntegrate', 'autoRestart']) {
        if (rest[key] !== undefined && typeof rest[key] !== 'boolean') throw new OperatorToolError('VALIDATION_ERROR', `${key} must be a boolean`);
      }
      if (sensitive && !text(args.reason)) throw new OperatorToolError('VALIDATION_ERROR', 'a reason is required when changing sensitive policy fields');
      const before = await readOperatorPolicy(client.workspaceFolder);
      try {
        applyWorkspaceWatcherPatch({ dataDir: dataDir(), workspaceFolder: client.workspaceFolder, patch: { policy: { ...rest, ...(worktree !== undefined ? { worktree } : {}) } } });
      } catch (err) {
        if (/** @type {any} */ (err)?.code === 'VALIDATION') throw new OperatorToolError('VALIDATION_ERROR', /** @type {Error} */ (err).message);
        throw err;
      }
      const after = await readOperatorPolicy(client.workspaceFolder);
      const changed = Object.keys(after).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
      recordOperatorEvent(client.workspaceFolder, 'watcher_policy', `Watcher policy changed (${changed.join(', ') || 'no change'})${text(args.reason) ? `: ${text(args.reason)}` : ''}`, journalOptions);
      broadcastWorkspaceWatcherChanged();
      return { changed, before, after };
    }

    case 'operator_server_status': {
      const uptimeSeconds = Math.round(process.uptime());
      return { ready: true, pid: process.pid, uptime_seconds: uptimeSeconds, started_at: new Date(now() - uptimeSeconds * 1000).toISOString(), node: process.version, metrics: readServerMetrics(), backup: getAutoBackupStatus() };
    }

    case 'operator_scout_enable': {
      assertOperatorLease({ workspaceFolder: client.workspaceFolder, sessionId: client.sessionId || client.id, clientId: client.id, clientName: client.name }, journalOptions);
      if (args.confirm !== true) throw new OperatorToolError('VALIDATION_ERROR', 'confirm must be true');
      if (typeof args.enabled !== 'boolean') throw new OperatorToolError('VALIDATION_ERROR', 'enabled must be a boolean');
      applyWorkspaceWatcherPatch({ dataDir: dataDir(), workspaceFolder: client.workspaceFolder, patch: { policy: { scoutEnabled: args.enabled } } });
      recordOperatorEvent(client.workspaceFolder, 'scout_enable', args.enabled ? 'Scouts enabled' : 'Scouts disabled', journalOptions);
      return await describeWatcher(client.workspaceFolder);
    }

    case 'operator_watcher_release_unknown': {
      if (args.confirm !== true) throw new OperatorToolError('VALIDATION_ERROR', 'confirm must be true');
      const item = await resolveTodo(client.workspaceFolder, text(args.todo_id));
      const expectedUpdatedAt = text(args.expected_updated_at);
      if (!expectedUpdatedAt) throw new OperatorToolError('VALIDATION_ERROR', 'expected_updated_at is required');
      const result = /** @type {any} */ (await releaseDoingWorkspaceWatcherTodoForOperator({
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
      // Preflight: refuse before any coordinator chat exists when fewer than two
      // independent reviewers qualify, and make the block visible on the todo.
      const preflight = getBuiltinMcpRuntimeDeps().planReviewPreflight || runPlanReviewerPreflight;
      /** @type {any} */
      let availability;
      try {
        availability = await preflight({ workspaceFolder: client.workspaceFolder, coordinatorModel: text(args.model) });
      } catch {
        // An unreadable catalog must not block a review the coordinator may still run.
        availability = null;
      }
      // Fail open: only a conclusive (successful) selection may refuse or block.
      const preflightWarning = !availability || availability.satisfiable === null || availability.unknown
        ? 'reviewer_preflight_unavailable'
        : '';
      if (!preflightWarning && availability.satisfiable === false) {
        await blockTodoForInsufficientReviewers({
          dataDir: dataDir(),
          workspaceFolder: client.workspaceFolder,
          todoId: item.id,
          available: availability.available,
          required: availability.required,
        });
        return {
          todo_id: item.id,
          accepted: false,
          code: TODO_BLOCKED_REASON_INSUFFICIENT_REVIEWERS,
          available: availability.available,
          required: availability.required,
          reviewers: availability.reviewers || [],
          blocked_reason: TODO_BLOCKED_REASON_INSUFFICIENT_REVIEWERS,
        };
      }
      // The block this tool itself wrote makes the start refuse with
      // todo.blockedByTree (isTodoNodeBlocked reads blockedReason). Reviewers
      // qualify now, so lift it before the start instead of after.
      await clearInsufficientReviewersBlock({ dataDir: dataDir(), workspaceFolder: client.workspaceFolder, todoId: item.id });
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
        origin: { kind: 'operator', clientId: client.id, clientName: client.name },
      });
      await clearInsufficientReviewersBlock({ dataDir: dataDir(), workspaceFolder: client.workspaceFolder, todoId: item.id });
      const result = {
        todo_id: item.id,
        chat_id: chat.id,
        run_id: run.runId,
        accepted: run.accepted,
        model: text(chat.model),
        plan_reviewer_session_id: text(started.planReviewerSession?.id),
        ...(preflightWarning ? { warning: preflightWarning } : {}),
      };
      planReviewStarts.set(memoKey, result);
      return result;
    }

    case 'operator_todo_integrated': {
      assertOperatorLease({ workspaceFolder: client.workspaceFolder, sessionId: client.sessionId || client.id, clientId: client.id, clientName: client.name }, journalOptions);
      if (!text(args.commit)) throw new OperatorToolError('VALIDATION_ERROR', 'commit is required');
      const item = await resolveTodo(client.workspaceFolder, text(args.todo_id));
      const result = await confirmWorkspaceTodoIntegration({
        workspaceFolder: client.workspaceFolder, dataDir: dataDir(), todoId: item.id,
        expectedUpdatedAt: item.updatedAt, proof: { commit: text(args.commit) },
      });
      if (!result.ok) throw new OperatorToolError('CONFLICT', `Integration refused: ${result.reason}${result.detail ? ` (${result.detail})` : ''}`);
      recordOperatorEvent(client.workspaceFolder, 'integration', `Confirmed ${item.id} in ${result.item.integration.evidence.targetCommit}`, journalOptions);
      return { todo_id: item.id, status: result.item.status, evidence: result.item.integration.evidence };
    }

    case 'operator_integrate_tree': {
      const item = await resolveTodo(client.workspaceFolder, text(args.todo_id));
      const harness = text(args.harness);
      const key = text(args.idempotency_key);
      if (!harness) throw new OperatorToolError('VALIDATION_ERROR', 'harness is required');
      if (!key) throw new OperatorToolError('VALIDATION_ERROR', 'idempotency_key is required');
      const memoKey = `${client.id}:${key}`;
      const replay = integrateTreeStarts.get(memoKey);
      if (replay) return { ...replay, replayed: true };
      const starter = getBuiltinMcpRuntimeDeps().startIntegrateBatch;
      if (typeof starter !== 'function') throw new OperatorToolError('UNAVAILABLE', 'Bulk integration is unavailable on this server');
      const started = await starter({
        workspaceFolder: client.workspaceFolder,
        body: { rootId: item.id, agentTransport: harness, model: text(args.model) },
      });
      const body = started?.body || {};
      if (!body.ok) {
        const reason = text(body.error) || 'failed';
        const detail = text(body.message);
        const skipped = Array.isArray(body.skipped)
          ? body.skipped.map((row) => ({ todo_id: text(row?.todoId), reason: text(row?.reason) })).filter((row) => row.todo_id || row.reason)
          : [];
        throw new OperatorToolError(
          started?.status === 409 ? 'CONFLICT' : started?.status === 404 ? 'NOT_FOUND' : 'VALIDATION_ERROR',
          `Integration refused: ${reason}${detail && detail !== reason ? ` (${detail})` : ''}${skipped.length ? `; skipped: ${JSON.stringify(skipped)}` : ''}`,
        );
      }
      const chat = body.chat;
      const prompt = text(body.initialPrompt);
      if (!chat?.id || !prompt) throw new OperatorToolError('CONFLICT', 'The integration chat was not created');
      const run = await startChatRun({
        chatId: chat.id,
        prompt,
        mode: normalizeSdkMode(chat.sdkMode),
        requestId: `external:${client.id}:${key}`,
        displayText: prompt,
        origin: { kind: 'operator', clientId: client.id, clientName: client.name },
      });
      const result = {
        todo_id: item.id,
        chat_id: chat.id,
        run_id: run.runId,
        accepted: run.accepted,
        model: text(chat.model),
        batch: describeBatch(body.batch),
      };
      integrateTreeStarts.set(memoKey, result);
      return result;
    }

    case 'operator_integrate_status': {
      const deps = getBuiltinMcpRuntimeDeps().integrateBatchDeps;
      const lock = getIntegrationLock({ dataDir: dataDir(), workspaceFolder: client.workspaceFolder });
      const batchId = text(args.batch_id);
      if (batchId) {
        const batch = readIntegrateBatch({ dataDir: dataDir(), batchId, deps });
        if (!batch || canonicalPath(batch.workspaceFolder) !== canonicalPath(client.workspaceFolder)) {
          throw new OperatorToolError('NOT_FOUND', 'Batch not found in this workspace');
        }
        return { batch: describeBatch(batch), lock };
      }
      const batches = listIntegrateBatches({ dataDir: dataDir(), workspaceFolder: client.workspaceFolder, deps });
      return { batches: batches.slice(0, 5).map(describeBatch), lock };
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

    case 'operator_scope_accept': {
      const item = await resolveTodo(client.workspaceFolder, text(args.todo_id));
      if (!parseScopeRequest(/** @type {{ body?: string }} */ (item).body)) throw new OperatorToolError('NOT_FOUND', 'Todo has no open scope request');
      const result = await acceptWorkspaceWatcherScopeRequest({
        dataDir: dataDir(),
        workspaceFolder: client.workspaceFolder,
        todoId: item.id,
        files: args.files,
        expectedUpdatedAt: text(args.expected_updated_at) || undefined,
        actor: `external MCP client "${client.name}" (${client.id.slice(0, 8)})`,
      });
      if ('code' in result) throw new OperatorToolError(result.code, result.message);
      broadcastWorkspaceWatcherChanged();
      const { scheduleWorkspaceWatcherAutopilot } = await import('../workspace-watcher-event-schedule.js');
      scheduleWorkspaceWatcherAutopilot({ workspaceFolder: client.workspaceFolder, dataDir: dataDir() });
      return { todo_id: item.id, accepted: result.accepted, remaining: result.remaining, status: result.status, updated_at: result.updatedAt };
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
