/**
 * Builtin Cretli MCP Workspace Watcher tools (workspace of the calling chat).
 *
 * The stable, task-facing surface is the four `watcher_*` tools:
 *   - `watcher_status`      read-only: snapshot + durable state + recent decisions
 *   - `watcher_set`         operator config: mode / policy / pause / stop_reason
 *   - `watcher_report`      the cycle orchestrator reports its outcome (idempotent)
 *   - `watcher_claim_next`  atomic claim of the next ready todo (task-3 policy)
 *
 * `workspace_watcher_show` / `workspace_watcher_update` remain registered as the
 * combined control surface the orchestrator prompt (task 4), the changelog and
 * the docs use. Both name sets share these handlers, so there is exactly one
 * implementation and one authorization rule.
 *
 * Authorization is the same "parent only" rule the delegation tools use: a chat
 * that is not a live cycle's orchestrator can never write watcher state while
 * cycles exist. The authorizing set is `activeCycles[].chatId`; the row's
 * `orchestratorChatId` is the "last known" owner and only authorizes an idle row
 * without live cycles. The human operator path for `off`/`observe`/`autopilot`
 * and policy stays the REST/UI settings surface. `watcher_report` keeps its soft
 * `not_orchestrator` answer so a foreign chat cannot close someone else's cycle,
 * and `watcher_claim_next` stays open to any chat in the workspace (a manual
 * agent taking the next todo).
 */

import { resolveCretliToolContext } from './tool-context.js';
import { requireClientMethod } from './client-scope.js';
import { mcpToolResult } from './result.js';
import { CretliMcpToolError, MCP_BUILTIN_ERROR_CODES } from './errors.js';
import {
  getWorkspaceWatcherActiveCycles,
  workspaceWatcherOrchestratorChatIds,
} from '../../persist/workspace-watchers-persist.js';

const MODES = ['off', 'observe', 'autopilot'];
const ACTIONS = ['configure', 'tick', 'run_cycle', 'claim_next', 'reset_plan_requests', 'record_findings', 'save_plan', 'report'];
const ORCHESTRATOR_ONLY_ACTIONS = new Set([
  'configure',
  'tick',
  'run_cycle',
  'reset_plan_requests',
  'record_findings',
  'save_plan',
]);

const STOP_REASON_DESCRIPTION = 'Set a non-empty value to stop the watcher; empty clears it.';
const POLICY_DESCRIPTION = 'Partial policy patch; nested quietHours/orchestrator are merged.';

/**
 * @param {object} view
 * @returns {string}
 */
function formatWatcher(view) {
  const watcher = view?.watcher || {};
  const policy = watcher.policy || {};
  const cycles = getWorkspaceWatcherActiveCycles(watcher);
  const failures = watcher.failures && Object.keys(watcher.failures).length
    ? Object.entries(watcher.failures).map(([id, n]) => `${String(id).slice(0, 8)}=${n}`).join(' ')
    : '-';
  return [
    `# Workspace Watcher (${view?.workspaceFolder || ''})`,
    `mode: ${watcher.mode || 'off'}  enabled: ${watcher.enabled === true}  paused: ${watcher.paused === true}`,
    `stop_reason: ${watcher.stopReason || '-'}`,
    `cycles: ${watcher.cycleCount || 0} (today ${view?.guardrails?.usedToday ?? 0}/${view?.guardrails?.maxCyclesPerDay ?? 0})`,
    `last_tick: ${watcher.lastTickAt || '-'}  last_cycle: ${watcher.lastCycleAt || '-'}`,
    `backoff_until: ${watcher.backoffUntil || '-'}`,
    `active_cycles: ${cycles.length ? cycles.map((cycle) => `${String(cycle.cycleId || '').slice(0, 8)} chat=${String(cycle.chatId || '').slice(0, 8)} todo=${(cycle.todoIds || []).map((id) => String(id).slice(0, 8)).join(',')}`).join('; ') : '-'}`,
    `failures: ${failures}`,
    `reports: ${(watcher.reports || []).slice(-3).map((r) => `${String(r.cycleId || '').slice(0, 8)}=${r.outcome}${r.deferred ? '(deferred)' : ''}`).join(' ') || '-'}`,
    `previous_cycles: ${(watcher.cycleChats || []).slice(-3).map((c) => `${String(c.id || '').slice(0, 8)}:${c.outcome || '-'}`).join(' ') || '-'}`,
    `findings: tracked=${Object.keys(watcher.findings?.byTodo || {}).length}`,
    `scout: enabled=${watcher.policy?.scoutEnabled === true} last=${watcher.lastScoutAt || '-'} today=${watcher.scoutScans?.day && watcher.scoutScans.day === new Date().toISOString().slice(0, 10) ? (watcher.scoutScans?.count || 0) : 0}/${watcher.policy?.scoutMaxPerDay ?? 0} pending=${(watcher.pendingScoutFindings || []).filter((finding) => finding.status === 'pending').length}`,
    `plan_requests: ${Object.keys(watcher.planRequests || {}).length}`,
    `policy: maxParallel=${policy.maxParallel} scoutMaxParallel=${policy.scoutMaxParallel ?? 1} maxCyclesPerDay=${policy.maxCyclesPerDay} maxConsecutiveFailures=${policy.maxConsecutiveFailures} maxSameFindings=${policy.maxSameFindings}`,
    `requirePlanApproval=${policy.requirePlanApproval} allowedHarnesses=${(policy.allowedHarnesses || []).join(',') || '(any)'}`,
    `quietHours=${policy.quietHours?.start || '-'}..${policy.quietHours?.end || '-'}  orchestrator=${policy.orchestrator?.harness || '(pick)'}${policy.orchestrator?.model ? `:${policy.orchestrator.model}` : ''}`,
    `snapshot: ready=${view?.snapshot?.readyTodoCount ?? 0} active=${view?.snapshot?.activeAgentCount ?? 0} scout=${view?.snapshot?.scoutAgentCount ?? 0} unknown=${view?.snapshot?.unknownAgentCount ?? 0}`,
    `guardrail: ${view?.guardrails?.kind || '-'} (${view?.guardrails?.reason || '-'})`,
    `recent_decisions: ${(watcher.decisions || []).slice(-5).map((d) => `${d.kind}/${d.reason}`).join(' | ') || '-'}`,
  ].join('\n');
}

/**
 * Read the snapshot without performing an action.
 *
 * @param {object} _args
 * @param {{ client: object, session: object }} env
 */
async function watcherStatusHandler(_args, { client, session }) {
  requireClientMethod(client, 'workspaceWatcherShow');
  const ctx = resolveCretliToolContext(session);
  const view = await client.workspaceWatcherShow({ workspaceFolder: ctx.workspaceFolder });
  return mcpToolResult(formatWatcher(view), view);
}

/**
 * The orchestrator chat owns watcher state writes for its workspace. The
 * operator (human) path is REST/UI, which does not pass through this check.
 *
 * @param {object} client
 * @param {{ chatId: string, workspaceFolder: string }} ctx
 */
async function requireWorkspaceOrchestrator(client, ctx) {
  const view = await client.workspaceWatcherShow({ workspaceFolder: ctx.workspaceFolder });
  const watcher = view?.watcher || {};
  // Live cycles own the row: `orchestratorChatId` is only the idle "last known"
  // owner and is deliberately ignored while any slot is live, so a closed or
  // replaced orchestrator cannot drive a sibling cycle.
  const owners = new Set(workspaceWatcherOrchestratorChatIds(watcher));
  const caller = String(ctx.chatId || '').trim();
  if (!caller || !owners.has(caller)) {
    throw new CretliMcpToolError(
      MCP_BUILTIN_ERROR_CODES.OUT_OF_SCOPE,
      'Only the workspace orchestrator chat may change the Workspace Watcher state. Use Settings \u2192 Workspace Watcher for operator changes.',
    );
  }
  return view;
}

/**
 * Shared runner for every mutating watcher tool. Validation always runs before
 * the authorization check so an invalid mode/policy is a validation error no
 * matter who calls it.
 *
 * @param {object} args
 * @param {{ client: object, session: object }} env
 * @param {string} label
 */
async function runWatcherUpdate(args, { client, session }, label = 'workspace_watcher_update') {
  requireClientMethod(client, 'workspaceWatcherUpdate');
  const ctx = resolveCretliToolContext(session);
  const action = String(args?.action || 'configure').trim().toLowerCase();
  if (!ACTIONS.includes(action)) {
    throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, `action must be one of: ${ACTIONS.join(', ')}`);
  }
  if (args?.mode != null && !MODES.includes(String(args.mode))) {
    throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, `mode must be one of: ${MODES.join(', ')}`);
  }
  if (args?.outcome != null && action === 'report') {
    const outcome = String(args.outcome).trim().toLowerCase();
    if (!['success', 'blocked', 'failure'].includes(outcome)) {
      throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'outcome must be one of: success, blocked, failure');
    }
  }
  if (ORCHESTRATOR_ONLY_ACTIONS.has(action)) {
    await requireWorkspaceOrchestrator(client, ctx);
  }
  const callerChatId = String(ctx.chatId || '').trim();
  let claimedByChatId = callerChatId;
  if (action === 'claim_next') {
    const requestedClaimChatId = String(args?.claimed_by_chat_id || '').trim();
    claimedByChatId = requestedClaimChatId || callerChatId;
    if (requestedClaimChatId && requestedClaimChatId !== callerChatId) {
      await requireWorkspaceOrchestrator(client, ctx);
    }
  }
  const result = await client.workspaceWatcherUpdate({
    workspaceFolder: ctx.workspaceFolder,
    action,
    mode: args?.mode,
    enabled: args?.enabled,
    paused: args?.paused,
    stopReason: args?.stop_reason,
    policy: args?.policy,
    claimedByChatId,
    ttlMs: args?.ttl_ms,
    todoId: args?.todo_id,
    findingsHash: args?.findings_hash,
    findingsText: args?.findings_text,
    expectedUpdatedAt: args?.expected_updated_at,
    planMarkdown: args?.plan_markdown,
    outcome: args?.outcome,
    todoIds: args?.todo_ids,
    cycleId: args?.cycle_id,
    reportId: args?.report_id || args?.idempotency_key,
    message: args?.message ?? args?.summary,
    sourceChatId: ctx.chatId || undefined,
  });
  const view = result?.view ? formatWatcher(result.view) : '';
  const headline = result?.message || `${label}: ${action} ok`;
  return mcpToolResult([headline, view].filter(Boolean).join('\n\n'), result);
}

const SCOUT_ACTIONS = ['list', 'accept', 'reject', 'submit'];

/**
 * @param {object} result
 * @returns {string}
 */
function formatScoutFindings(result) {
  const findings = Array.isArray(result?.findings) ? result.findings : [];
  const pending = findings.filter((finding) => finding.status === 'pending').length;
  const accepted = findings.filter((finding) => finding.status === 'accepted').length;
  const rejected = findings.filter((finding) => finding.status === 'rejected').length;
  const lines = [
    `# Scout findings (${result?.workspaceFolder || ''}) action=${result?.action || 'list'}`,
    `pending=${pending} accepted=${accepted} rejected=${rejected} total=${findings.length}`,
  ];
  if (Number.isFinite(result?.added)) lines.push(`added=${result.added}`);
  if (Array.isArray(result?.createdTodos) && result.createdTodos.length) {
    lines.push(`created_todos=${result.createdTodos.map((todo) => String(todo.id || '').slice(0, 8)).join(',')}`);
  }
  for (const finding of findings) {
    const id = String(finding.id || '').slice(0, 8);
    const files = Array.isArray(finding.files) && finding.files.length ? ` files=${finding.files.join(',')}` : '';
    const todo = finding.todoId ? ` todo=${String(finding.todoId).slice(0, 8)}` : '';
    lines.push(`- ${id} [${finding.category}] (${finding.status}) ${finding.title}${files}${todo}`);
  }
  if (findings.length === 0) lines.push('- (none)');
  return lines.join('\n');
}

/**
 * List, accept, reject or submit Scout proposals. Accept/reject is the user
 * decision; `submit` is what a Scout scan itself calls. Scout never creates a
 * todo unless `policy.scoutAutoCreate` is true and the finding is accepted.
 * That todo is an `idea` with an unapproved plan draft.
 *
 * @param {object} args
 * @param {{ client: object, session: object }} env
 */
async function watcherScoutFindingsHandler(args, { client, session }) {
  requireClientMethod(client, 'workspaceWatcherScout');
  const ctx = resolveCretliToolContext(session);
  const action = String(args?.action || 'list').trim().toLowerCase() || 'list';
  if (!SCOUT_ACTIONS.includes(action)) {
    throw new CretliMcpToolError(
      MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR,
      `action must be one of: ${SCOUT_ACTIONS.join(', ')}`,
    );
  }
  const result = await client.workspaceWatcherScout({
    workspaceFolder: ctx.workspaceFolder,
    action,
    ids: args?.ids,
    id: args?.id,
    findings: args?.findings,
    text: args?.text,
    status: args?.status,
    category: args?.category,
    max: args?.max,
    sourceChatId: ctx.chatId,
    scanId: args?.scan_id || args?.scanId,
    scoutSubmitToken: args?.submit_token || args?.submitToken,
  });
  return mcpToolResult(formatScoutFindings(result), result);
}

const UPDATE_TOOL_PROPERTIES = {
  action: { type: 'string', description: `One of: ${ACTIONS.join(', ')}` },
  mode: { type: 'string', description: `One of: ${MODES.join(', ')}` },
  enabled: { type: 'boolean' },
  paused: { type: 'boolean', description: 'configure only: global pause. A paused watcher halts decisions and cycle starts without clearing failures/backoff/findings or the active cycle, so resuming continues where it stopped. Independent of stop_reason.' },
  stop_reason: { type: 'string', description: STOP_REASON_DESCRIPTION },
  policy: { type: 'object', description: POLICY_DESCRIPTION },
  claimed_by_chat_id: { type: 'string', description: 'claim_next only: the chat that owns the claim.' },
  ttl_ms: { type: 'integer', minimum: 1, maximum: 86400000, description: 'claim_next only: claim lease duration in milliseconds (default 30000). Live or unknown work is never stolen just because its TTL passed.' },
  todo_id: { type: 'string', description: 'reset_plan_requests: clear one todo; save_plan: todo to update.' },
  findings_hash: { type: 'string', description: 'record_findings only: current review findings hash.' },
  findings_text: { type: 'string', description: 'record_findings only: the review finding summary text (≤2000 chars). Persisted with the hash so the Workspace Scout dedupes against real prior-review findings instead of an opaque hash. Empty clears the stored finding for the todo.' },
  expected_updated_at: { type: 'string', description: 'save_plan only: CAS token from todo_show.' },
  plan_markdown: { type: 'string', description: 'save_plan only: draft plan markdown (never sets approvedAt).' },
  outcome: { type: 'string', description: 'report only: success, blocked, or failure.' },
  todo_ids: { type: 'array', items: { type: 'string' }, description: 'report only: todos this cycle covered (defaults to the active cycle todoIds).' },
  cycle_id: { type: 'string', description: 'report only: active cycle id (identity check; from watcher_status).' },
  report_id: { type: 'string', description: 'report only: stable idempotency key for this report (defaults to the cycle id).' },
  idempotency_key: { type: 'string', description: 'report only: alias of report_id.' },
  summary: { type: 'string', description: 'report only: one line: what was done / blocked / next.' },
  message: { type: 'string', description: 'report only: alias of summary.' },
};

export const WATCHER_MCP_TOOLS = Object.freeze([
  {
    name: 'watcher_status',
    readOnly: true,
    description: 'Read the Workspace Watcher for this chat workspace: durable state (mode, policy, pause, stop reason, failures, findings, plan requests), the live snapshot (ready todos, active/unknown agents) and the last decisions. Safe to call from any harness/chat; it never creates a watcher row.',
    inputSchema: { type: 'object', properties: {} },
    handler: watcherStatusHandler,
  },
  {
    name: 'watcher_set',
    readOnly: false,
    description: 'Set Workspace Watcher operator state: mode (off|observe|autopilot), enabled, paused, stop_reason (empty clears it) and a partial policy patch. Values are validated and nested quietHours/orchestrator are merged. Only the workspace orchestrator chat may change this through MCP; the human operator path is Settings \u2192 Workspace Watcher (REST/UI).',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', description: `One of: ${MODES.join(', ')}` },
        enabled: { type: 'boolean' },
        paused: { type: 'boolean', description: 'Global pause; it preserves failures, backoff, findings and the active cycle so resuming continues where it stopped.' },
        stop_reason: { type: 'string', description: STOP_REASON_DESCRIPTION },
        policy: { type: 'object', description: POLICY_DESCRIPTION },
      },
    },
    handler: (args, env) => runWatcherUpdate({ ...args, action: 'configure' }, env, 'watcher_set'),
  },
  {
    name: 'watcher_report',
    readOnly: false,
    description: 'Report the durable outcome (success|blocked|failure) of the active watcher cycle. Accepted only from that cycle\'s orchestrator chat; a foreign chat gets ok=false/not_orchestrator and cannot close the cycle. Idempotent through idempotency_key/report_id: replaying the same key is a no-op.',
    inputSchema: {
      type: 'object',
      properties: {
        outcome: { type: 'string', description: 'success, blocked, or failure.' },
        todo_ids: { type: 'array', items: { type: 'string' }, description: 'Todos this cycle covered (defaults to the active cycle todoIds).' },
        cycle_id: { type: 'string', description: 'Active cycle id (identity check; from watcher_status).' },
        idempotency_key: { type: 'string', description: 'Stable key for this report (defaults to the cycle id).' },
        report_id: { type: 'string', description: 'Alias of idempotency_key.' },
        summary: { type: 'string', description: 'One line: what was done / blocked / next.' },
        message: { type: 'string', description: 'Alias of summary.' },
      },
      required: ['outcome'],
    },
    handler: (args, env) => runWatcherUpdate({ ...args, action: 'report' }, env, 'watcher_report'),
  },
  {
    name: 'watcher_claim_next',
    readOnly: false,
    description: 'Atomically claim the next ready todo for the calling workspace using the watcher selection policy (assignment/sibling order, failure ceiling). The claim is CAS-guarded (status doing + claim lease) so two agents cannot take the same todo. Available to any chat in the workspace that wants to take the next item.',
    inputSchema: {
      type: 'object',
      properties: {
        claimed_by_chat_id: { type: 'string', description: 'The chat that owns the claim (defaults to the calling chat).' },
        ttl_ms: { type: 'integer', minimum: 1, maximum: 86400000, description: 'Claim lease duration in milliseconds (default 30000).' },
      },
    },
    handler: (args, env) => runWatcherUpdate({ ...args, action: 'claim_next' }, env, 'watcher_claim_next'),
  },
  {
    name: 'watcher_scout_findings',
    readOnly: false,
    description: 'List, accept, reject or submit Workspace Scout proposals (proactive findings: bug, improvement, security, opportunity, documentation). Scout never creates a todo by itself; accepting one creates an `idea` todo with an unapproved plan draft only when policy `scoutAutoCreate` is true. Accept/reject is the user decision; `submit` is used by the Scout scan itself. Actions: list (default), accept, reject, submit.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'One of: list, accept, reject, submit.' },
        ids: { type: 'array', items: { type: 'string' }, description: 'accept/reject: finding ids to resolve.' },
        id: { type: 'string', description: 'accept/reject: a single finding id (alias of ids).' },
        findings: {
          type: 'array',
          items: { type: 'object' },
          description: 'submit only: proposed findings { title, category, rationale, files[] }.',
        },
        text: { type: 'string', description: 'submit only: raw JSON (fenced block or array) to parse into findings.' },
        scan_id: { type: 'string', description: 'submit only: active scan id from the Scout prompt.' },
        submit_token: { type: 'string', description: 'submit only: submit token from the Scout prompt.' },
        status: { type: 'string', description: 'list only: filter by pending|accepted|rejected.' },
        category: { type: 'string', description: 'list only: filter by category.' },
        max: { type: 'integer', minimum: 1, maximum: 200, description: 'list only: maximum rows to return.' },
      },
    },
    handler: watcherScoutFindingsHandler,
  },
  // Combined control surface used by the orchestrator prompt (task 4) and docs.
  {
    name: 'workspace_watcher_show',
    readOnly: true,
    description: 'Show the Workspace Watcher state for this chat workspace: mode, policy, active cycles, guardrail verdict, snapshot counts and recent decisions.',
    inputSchema: { type: 'object', properties: {} },
    handler: watcherStatusHandler,
  },
  {
    name: 'workspace_watcher_update',
    readOnly: false,
    description: 'Update the Workspace Watcher for this chat workspace, or run a manual action. Actions: configure (default), tick, run_cycle, claim_next, reset_plan_requests, record_findings, save_plan, report. Only a human approves a plan; this tool never sets plan.approvedAt. The `report` action records the durable outcome (success|blocked|failure) of the active cycle and is accepted only from that cycle\'s orchestrator chat.',
    inputSchema: {
      type: 'object',
      properties: UPDATE_TOOL_PROPERTIES,
    },
    handler: (args, env) => runWatcherUpdate(args, env),
  },
]);
