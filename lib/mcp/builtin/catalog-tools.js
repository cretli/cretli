/**
 * Builtin Cretli MCP catalogs: tasks, agents, harnesses, models.
 * agent_list returns .cursor/agents definitions, not chats.
 * All reads go through the API client (in-process or HTTP), never local files.
 */

import { parseKnownAgentTransport } from '../../agent-transport.js';
import { MODEL_PICK_ROLES, loadRotationConfig } from '../../model-role-profiles.js';
import { pickAndPersistModelForPurpose } from '../../model-pick-service.js';
import { buildModelPickHistory } from '../../model-pick-history.js';
import { getDelegationWorkflow } from '../../persist/delegation-workflows-persist.js';
import { readCodeReviewPhaseCounters } from '../../delegation-code-review-phase.js';
import { resolveCretliToolContext } from './tool-context.js';
import { requireClientMethod } from './client-scope.js';
import { paginateList } from './paging.js';
import { mcpToolResult } from './result.js';
import { CretliMcpToolError, MCP_BUILTIN_ERROR_CODES } from './errors.js';
import {
  appendLeafSizeToPickReason,
  blockTodoForNoNonFlashCandidate,
  mergeExcludeModelIds,
  resolveLeafImplementPickAdjustments,
} from '../../model-pick-leaf-implement.js';
import { LEAF_SIZE_LARGE } from '../../model-pick-leaf-size.js';
import { getBuiltinMcpRuntimeDeps } from './runtime-deps.js';
import { resolveRequestLeafContext } from '../../orchestrator-leaf-resolution.js';
import { resolveDataPath } from '../../runtime-paths.js';
import { resolveReviewerPolicy } from '../../reviewer-policy.js';
import { loadDelegations } from '../../persist/delegations-persist.js';
import fs from 'node:fs';
import path from 'node:path';

function taskChoiceId(task) {
  const folder = String(task.folderPath || task.cwd || '').trim();
  return `${folder}::${task.label}`;
}

/**
 * `exclude_models` / `exclude_harnesses` are strict string arrays. A wrong type
 * must fail loudly instead of being dropped by `Array.isArray` in the picker
 * (a silently ignored reviewer exclude can re-select the last implementer).
 *
 * @param {unknown} value
 * @param {string} name
 * @returns {string[] | undefined}
 */
function assertStringArrayArg(value, name) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new CretliMcpToolError(
      MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR,
      `${name} must be an array of strings`,
    );
  }
  return value;
}

/**
 * `count` is a small fanout size: integer 1..5. Anything else is a
 * VALIDATION_ERROR rather than a silent clamp.
 *
 * @param {unknown} value
 * @returns {number | undefined}
 */
function assertCountArg(value) {
  if (value === undefined || value === null) return undefined;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 5) {
    throw new CretliMcpToolError(
      MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR,
      'count must be an integer between 1 and 5',
    );
  }
  return count;
}

/**
 * @param {object} client
 * @param {object[]} harnesses
 * @param {string} [workspaceFolder] Per-workspace delegation env for the model list.
 */
async function collectEligibleHarnessModels(client, harnesses, workspaceFolder) {
  /** @type {Record<string, object>} */
  const modelsByHarness = {};
  for (const harness of harnesses) {
    if (!harness?.enabled || !harness?.ready || !harness?.can_delegate) continue;
    const id = String(harness.id || '').trim();
    if (!id) continue;
    modelsByHarness[id] = await client.listHarnessModels({
      harness: id,
      enabledOnly: true,
      workspaceFolder,
    });
  }
  return modelsByHarness;
}

/**
 * Compact, closed-field view of the cost policy verdict for tool results.
 *
 * @param {any} policy
 * @returns {{ mode: string, configured: string, canary_bucket: boolean, decision: string }}
 */
export function summarizeCostPolicy(policy) {
  const applied = policy?.applied === true;
  return {
    mode: String(policy?.mode || ''),
    configured: String(policy?.configured || ''),
    canary_bucket: policy?.bucket === 'canary',
    decision: policy?.wouldChange === true ? (applied ? 'changed' : 'would_change') : 'unchanged',
  };
}

export const CATALOG_MCP_TOOLS = Object.freeze([
  {
    name: 'task_list',
    readOnly: true,
    description: 'List .vscode/tasks.json tasks for this chat workspace. Identical labels in different folders are distinguished.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
        cursor: { type: 'string' },
      },
    },
    async handler(args, { client, session }) {
      requireClientMethod(client, 'listWorkspaceTasks');
      const ctx = resolveCretliToolContext(session);
      const loaded = await client.listWorkspaceTasks({
        workspaceFolder: ctx.workspaceFolder,
        workspaceFile: ctx.workspaceFile,
      });
      const needle = String(args?.query || '').trim().toLowerCase();
      const tasks = (loaded.tasks || []).filter((task) => {
        if (!needle) return true;
        return `${task.label || ''} ${task.folderName || ''}`.toLowerCase().includes(needle);
      });
      const page = paginateList(tasks, args);
      const items = page.items.map((task) => ({
        id: taskChoiceId(task),
        label: task.label,
        type: task.type || 'shell',
        folder: task.folderPath || task.cwd || '',
        folder_name: task.folderName || '',
      }));
      const text = items.length === 0
        ? '(no tasks)'
        : items.map((row) => `${row.label}  (${row.folder_name || row.folder})`).join('\n');
      return mcpToolResult(text, { items, next_cursor: page.next_cursor });
    },
  },
  {
    name: 'task_run_list',
    readOnly: true,
    description: 'List active task runs in this chat workspace (not finished history).',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number' }, cursor: { type: 'string' } },
    },
    async handler(args, { client, session }) {
      requireClientMethod(client, 'listTaskRuns');
      const ctx = resolveCretliToolContext(session);
      const rows = await client.listTaskRuns({ workspaceFolder: ctx.workspaceFolder });
      const page = paginateList(rows, args);
      const items = page.items.map((run) => ({
        run_id: run.runId,
        label: run.taskLabel || '',
        cwd: run.cwd || '',
      }));
      const text = items.length === 0 ? '(no active task runs)' : items.map((row) => `${row.label}  ${row.run_id.slice(0, 8)}`).join('\n');
      return mcpToolResult(text, { items, next_cursor: page.next_cursor });
    },
  },
  {
    name: 'agent_list',
    readOnly: true,
    description: 'List agent definitions from .cursor/agents (project and configured shared roots). This is not chat_list.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
        cursor: { type: 'string' },
      },
    },
    async handler(args, { client, session }) {
      requireClientMethod(client, 'listWorkspaceAgents');
      const ctx = resolveCretliToolContext(session);
      const loaded = await client.listWorkspaceAgents({ workspaceFolder: ctx.workspaceFolder });
      const needle = String(args?.query || '').trim().toLowerCase();
      const agents = (loaded.agents || []).filter((agent) => {
        if (!needle) return true;
        return `${agent.name || ''} ${agent.description || ''}`.toLowerCase().includes(needle);
      });
      const page = paginateList(agents, args);
      const items = page.items.map((agent) => ({
        name: agent.name,
        description: agent.description || '',
        model: agent.model || '',
        path: agent.path || '',
        source: agent.source || 'project',
      }));
      const text = items.length === 0
        ? '(no agent definitions)'
        : items.map((row) => `${row.name}  [${row.source}]  ${row.path}`).join('\n');
      return mcpToolResult(text, { items, next_cursor: page.next_cursor });
    },
  },
  {
    name: 'agent_run_list',
    readOnly: true,
    description: 'List active agent-definition runs in this chat workspace (not chats).',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number' }, cursor: { type: 'string' } },
    },
    async handler(args, { client, session }) {
      requireClientMethod(client, 'listAgentRuns');
      const ctx = resolveCretliToolContext(session);
      const rows = await client.listAgentRuns({ workspaceFolder: ctx.workspaceFolder });
      const page = paginateList(rows, args);
      const items = page.items.map((run) => ({
        run_id: run.runId,
        name: run.agentName || '',
        cwd: run.cwd || '',
      }));
      const text = items.length === 0 ? '(no active agent runs)' : items.map((row) => `${row.name}  ${row.run_id.slice(0, 8)}`).join('\n');
      return mcpToolResult(text, { items, next_cursor: page.next_cursor });
    },
  },
  {
    name: 'harness_list',
    readOnly: true,
    description: 'List harnesses with enabled, ready, and whether a server-side delegation adapter exists. This is the catalog for sub-chats via delegation_start — not the Cursor Task model list.',
    inputSchema: { type: 'object', properties: {} },
    async handler(_args, { client }) {
      requireClientMethod(client, 'listHarnessCatalog');
      const items = await client.listHarnessCatalog();
      const text = items.map((row) => {
        const flags = [
          row.enabled ? 'enabled' : 'disabled',
          row.ready ? 'ready' : 'not-ready',
          row.can_delegate ? 'delegate' : 'no-adapter',
        ].join(',');
        const review = row.review_certified === true
          ? `review=certified:${row.review_certification_reason || 'unknown'}`
          : 'review=uncertified';
        const tests = `tests=${row.review_can_run_tests === true ? 'yes' : 'no'}`;
        return `${row.id}  ${row.label}  ${flags}  ${review}  ${tests}`;
      }).join('\n');
      return mcpToolResult(text, { items });
    },
  },
  {
    name: 'model_list',
    readOnly: true,
    description: 'List models for one harness from cached/fallback catalogs. enabled_only=true returns Settings favorites only (required before delegation_start). Empty favorites → empty list; rows without that flag are catalog, not start-eligible. Cursor Task only lists a few Cursor-local ids. Does not start harness processes.',
    inputSchema: {
      type: 'object',
      properties: {
        harness: { type: 'string' },
        query: { type: 'string' },
        enabled_only: { type: 'boolean', description: 'true = Settings favorites only (empty when none are configured)' },
        limit: { type: 'number' },
        cursor: { type: 'string' },
      },
      required: ['harness'],
    },
    async handler(args, { client, session }) {
      requireClientMethod(client, 'listHarnessModels');
      const rawHarness = typeof args?.harness === 'string' ? args.harness.trim() : '';
      const harness = parseKnownAgentTransport(rawHarness) || rawHarness.toLowerCase();
      if (!harness) {
        throw new CretliMcpToolError(
          MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR,
          'harness is required',
        );
      }
      // The per-workspace delegation env drives `empty_favorites`. A standalone
      // stdio call may have no workspace, so guard instead of hard-failing.
      let ctx = null;
      try {
        ctx = resolveCretliToolContext(session);
      } catch (ctxErr) {
        if (ctxErr?.code !== MCP_BUILTIN_ERROR_CODES.WORKSPACE_REQUIRED) throw ctxErr;
      }
      const remote = await client.listHarnessModels({
        harness,
        query: args?.query,
        enabledOnly: args?.enabled_only === true,
        workspaceFolder: ctx?.workspaceFolder,
      });
      const page = paginateList(remote.items || [], args);
      const warning = remote.warning || '';
      const text = page.items.length === 0
        ? `(no models) ${warning}`.trim()
        : `${page.items.map((row) => `${row.id}  ${row.label || row.id}${row.favorite ? '  [favorite]' : ''}`).join('\n')}${warning ? `\n[${remote.source || 'remote'}] ${warning}` : ''}`;
      return mcpToolResult(text, {
        items: page.items,
        next_cursor: page.next_cursor,
        source: remote.source || 'remote',
        warning,
        favorites_configured: remote.favorites_configured === true,
      });
    },
  },
  {
    name: 'model_pick',
    readOnly: true,
    description: 'Pick one Settings favorite for a delegation role (plan, implement, review, fix). Joins harness_list: enabled, ready, and can_delegate. Empty favorites for a harness are unset (no pick from that harness). Review never picks *flash* ids. Plan/review skip harnesses that would fail review_uncertified (no pre-exec deny or read-only sandbox; see harness_list review=). Optional exclude_model skips that id and the same base model (reviewer is not the last implementer, or a failed usage-limit model); optional exclude_harness skips a whole harness (quota or adapter down) — both stay hard. Ranking is score DESC (role weights), then tier tie-break; inside the tie band (rotation.band) a deterministic rotation keys on: keep the proven winner (the newest implement->review cycle of that model in this chat PASSed), then fewest uses in this chat for the role, then least-used harness in role 7d, then least-used model 7d, then least-recently-used, then id. Review auto-excludes the last implementer and last reviewer (real reviews only) as a soft preference: if that leaves no candidate the pick retries without the history excludes and reason says "history exclude relaxed". Models under an active lockout are dropped (including startup_failure after a recent adapter_timeout or transport-not-started start; diagnosis rows include lockout_code and lockout_reset_at); a fresh limit-hit penalises only the same model/base, or the whole harness when the row has no model. A pair measured above 50% infrastructure failures (n>=3) is demoted below every measured-safe candidate and kept out of the top-2 unless allow_high_infra=true. Implement/fix with adaptive on: terminal completion rate and observed median duration adjust the score when n>=completionMinN (default 10); measured completion below adaptive.completionMinRate (default 80%) demotes a pair below every candidate above the threshold and out of the top-2 unless allow_low_completion=true. todo_id/leaf_id sticky-picks the last completed implement/fix model on that leaf when the prior job finished completed (chat_uses=-2), unless exclude_model, lockout, or strategy excludes it. Cold-start harnesses get a bonus every 5th pick of global role traffic for implement/fix/review only (explore=false disables; plan never explores). Optional rotation=off|balanced|explore overrides the setting. candidates follows the actual selection (rotation band first, then score) and candidates[1] prefers a different harness when one is in band. Each candidate carries a reason and an observed block (last 30d for the harness + base model: n, pass_rate, infra_fail_rate, median_min, median_tokens_per_sec, and for implement median_tool_calls / median_files_changed) or null. Each candidate is shrunk toward its role prior (w=n/(n+10)): observed quality blends into the heuristic tier and infra_fail_rate blends toward the role\'s job-weighted mean, so a pair with no history inherits that prior instead of a free pass; the shrunk infra rate penalises the score by up to 50%, and a keep_winner stays in band within two bands of the best. Review observed quality is the productive-verdict share and useful_rate is reported but not scored. adaptive=false (or adaptive.enabled=false in data/model-role-profiles.json) restores pure heuristics. `count`/`diverse` return `picks` (pick = picks[0]); `exclude_models`/`exclude_harnesses` extend the single excludes. Review candidates carry `traits` (review_can_run_tests, review_can_run_tests_source, known_failure_modes); the effective trait is the static prior unless 30d observation of the harness\'s review reports has at least 2 agreeing signals, then source is "observed". On a tie in the band review prefers a harness that can run the review-verify catalog itself, and the reason names it. Does not start a chat.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'plan, implement, review, or fix' },
        exclude_model: { type: 'string', description: 'Skip this catalog id and the same base model id' },
        exclude_harness: { type: 'string', description: 'Skip this harness id (e.g. codex after a usage-limit fail)' },
        exclude_models: {
          type: 'array',
          items: { type: 'string' },
          description: 'Hard-exclude several catalog ids (merged with exclude_model)',
        },
        exclude_harnesses: {
          type: 'array',
          items: { type: 'string' },
          description: 'Hard-exclude several harness ids (merged with exclude_harness)',
        },
        chat_id: { type: 'string', description: 'Parent chat id for workflow diversity (default: the calling chat)' },
        rotation: { type: 'string', description: 'off, balanced (default), or explore; overrides data/model-role-profiles.json' },
        explore: { type: 'boolean', description: 'false disables the cold-start explore bonus' },
        adaptive: { type: 'boolean', description: 'false disables the observed-outcome blend/penalty (default: data/model-role-profiles.json adaptive.enabled, else on)' },
        shadow: { type: 'boolean', description: 'Shadow observer for the explainable cost/time ranking. On by default (observer only: it never changes the selection). false disables it for the call.' },
        allow_high_infra: {
          type: 'boolean',
          description: 'Explicit exception: allow a model measured above 50% infrastructure failures (n>=3) to win the pick and appear in the top-2. Off by default; the picker otherwise demotes such a model below every measured-safe candidate.',
        },
        allow_low_completion: {
          type: 'boolean',
          description: 'Explicit exception: allow implement/fix models with terminal completion below adaptive.completionMinRate (default 80%, n>=10) to win. Off by default.',
        },
        prefer_models: {
          type: 'array',
          maxItems: 2,
          items: {
            type: 'object',
            properties: { harness: { type: 'string' }, model: { type: 'string' } },
            required: ['harness', 'model'],
          },
          description: 'Opt-in reviewer pool (reviewer_pair_members from delegation settings, resolved by the parent; the picker never reads settings). Pool members that survive the hard excludes (implementer, caller excludes, closure limits, lockouts) win the pick; a lost member is replaced by the normal pick and rotation.pool.degraded=true; with no survivor the normal pick and relaxation path apply. Omit for unchanged behaviour.',
        },
        review_subject: { type: 'string', enum: ['plan', 'code'], description: 'role=review only: which reviewer policy applies (plan or code). Required to inject that subject\'s fixed reviewer pair as prefer_models; when omitted no pair is injected (a plan review must pass plan).' },
        count: { type: 'number', minimum: 1, maximum: 5, description: 'Number of picks for a fanout (integer 1..5; default 1; pick is always picks[0])' },
        diverse: { type: 'boolean', description: 'With count>1, prefer extra picks on different harnesses and providers' },
        todo_id: { type: 'string', description: 'Todo leaf id: implement leaf-size policy (*flash* on large stages) and sticky implement/fix executor after a completed job on that leaf. When omitted, the server may infer the sole doing leaf under a todo root whose orchestrator_chat_id is this chat (leaf_source=inferred).' },
        leaf_id: { type: 'string', description: 'Alias of todo_id for leaf-scoped pick policy and orchestrator inference.' },
        heavy: { type: 'boolean', description: 'Mark the task as demanding. With complexityPolicy.mode=enforce a tier 5 model is only eligible for demanding + heavy/premium picks.' },
        premium: { type: 'boolean', description: 'Explicitly allow a tier 5 (premium) model for a demanding pick under the cost policy.' },
        complexity: { type: 'string', enum: ['trivial', 'standard', 'demanding'], description: 'Explicit complexity level; overrides the heuristic signal.' },
        source_kind: { type: 'string', description: 'Origin of the task, e.g. plan; read by the complexity signal (shadow only).' },
      },
      required: ['role'],
    },
    async handler(args, { client, session }) {
      requireClientMethod(client, 'listHarnessCatalog');
      requireClientMethod(client, 'listHarnessModels');
      const role = String(args?.role || '').trim().toLowerCase();
      if (!MODEL_PICK_ROLES.includes(/** @type {import('../../model-role-profiles.js').ModelPickRole} */ (role))) {
        throw new CretliMcpToolError(
          MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR,
          'role must be plan, implement, review, or fix',
        );
      }
      // The leaf-size policy needs the workspace to resolve a todo, but a plain
      // model_pick must keep working without one (it did before the leaf-policy
      // wiring). Only the leaf-policy branch below uses the context; the pick
      // itself reads `session.workspaceFolder`, so guard rather than hard-fail.
      let ctx = null;
      try {
        ctx = resolveCretliToolContext(session);
      } catch (ctxErr) {
        if (ctxErr?.code !== MCP_BUILTIN_ERROR_CODES.WORKSPACE_REQUIRED) throw ctxErr;
      }
      const harnesses = await client.listHarnessCatalog();
      const modelsByHarness = await collectEligibleHarnessModels(client, harnesses, ctx?.workspaceFolder);
      const excludeModels = assertStringArrayArg(args?.exclude_models, 'exclude_models');
      const excludeHarnesses = assertStringArrayArg(args?.exclude_harnesses, 'exclude_harnesses');
      let count = assertCountArg(args?.count);
      const chatId = String(args?.chat_id || session?.chatId || '').trim();
      const ctxFolder = ctx?.workspaceFolder ? path.resolve(ctx.workspaceFolder) : '';
      const ctxFile = ctx?.workspaceFile || '';
      // Fixed reviewer pair: the configured or learned pair of the review
      // subject is injected for every review pick, so no mode can start
      // reviewers outside it. While a learned pair is still forming, a known
      // member stays preferred and the second slot is filled by the normal pick.
      // `review_subject` is required for this injection: without it the pick
      // must not guess a subject, or a plan review would silently get the code
      // pair. Callers are instructed to pass `review_subject=plan|code`.
      let preferModels = args?.prefer_models;
      const reviewSubject = String(args?.review_subject || '').trim().toLowerCase();
      if (role === 'review' && !preferModels && ctxFolder && (reviewSubject === 'plan' || reviewSubject === 'code')) {
        const policy = resolveReviewerPolicy(ctxFolder, {
          subject: reviewSubject,
          parentChatId: chatId,
          delegations: loadDelegations(),
        });
        if (policy.selection === 'fixed_pair' && policy.known.length > 0) {
          preferModels = policy.known;
          if (args?.count === undefined) count = 2;
        }
      }
      const leafContext = resolveRequestLeafContext({
        input: args,
        parentChatId: chatId,
        workspaceFolder: ctx?.workspaceFolder,
        dataDir: String(getBuiltinMcpRuntimeDeps().dataDir || '').trim() || resolveDataPath(),
        role,
        purpose: 'model_pick',
      });
      if (!leafContext.ok) {
        throw new CretliMcpToolError(
          leafContext.status === 404 ? MCP_BUILTIN_ERROR_CODES.NOT_FOUND : MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR,
          leafContext.error,
          { code: leafContext.code },
        );
      }
      const leafTodoId = String(leafContext.leafId || '').trim();
      let leafBody = '';
      if (leafTodoId && typeof client.getTodo === 'function') {
        const todo = await client.getTodo({
          workspaceFolder: ctxFolder,
          workspaceFile: ctxFile,
          todoId: leafTodoId,
        });
        leafBody = String(todo?.body || '');
      }
      // Workspace-aware existence check: only paths that exist on disk count,
      // so a leaf body naming only non-existent files is treated as large.
      const leafExists = ctxFolder
        ? (relativePath) => {
          try {
            return fs.existsSync(path.resolve(ctxFolder, String(relativePath || '').trim()));
          } catch {
            return false;
          }
        }
        : undefined;
      const leafAdjustments = role === 'implement' && leafTodoId
        ? resolveLeafImplementPickAdjustments(leafBody, { modelsByHarness, exists: leafExists })
        : null;
      const mergedExcludeModels = leafAdjustments?.excludeFlashModels?.length
        ? mergeExcludeModelIds(excludeModels || [], leafAdjustments.excludeFlashModels)
        : (excludeModels || []);
      const workflowRow = chatId && leafTodoId ? getDelegationWorkflow(chatId, leafTodoId) : null;
      const codeReviewPhase = readCodeReviewPhaseCounters(workflowRow);
      const history = buildModelPickHistory({
        role,
        chatId,
        leafId: leafTodoId,
        workspaceFolder: ctxFolder,
        harnesses: harnesses.map((row) => row?.id),
        codeReviewAuditDone: codeReviewPhase.auditDone,
        codeReviewAuditReviewer: codeReviewPhase.auditReviewer,
      });
      const picked = pickAndPersistModelForPurpose({
        role,
        chatId,
        workspaceFolder: session?.workspaceFolder,
        purpose: 'model_pick',
        leafSource: leafContext.leafSource,
        excludeModel: args?.exclude_model,
        excludeModels: mergedExcludeModels,
        excludeHarness: args?.exclude_harness,
        excludeHarnesses,
        harnesses,
        modelsByHarness,
        diagnosisInput: {
          checkReviewAdapter: true,
        },
        rotation: args?.rotation !== undefined ? args.rotation : loadRotationConfig(),
        history,
        explore: args?.explore,
        adaptive: args?.adaptive,
        shadow: args?.shadow,
        allowHighInfra: args?.allow_high_infra === true,
        allowLowCompletion: args?.allow_low_completion === true,
        preferModels,
        leafId: leafTodoId,
        count,
        diverse: args?.diverse,
        // Shadow-only complexity inputs; the leaf body is not persisted.
        leafBody,
        leafSize: leafAdjustments?.leafSize,
        leafExists,
        heavy: args?.heavy === true,
        premium: args?.premium === true,
        complexity: args?.complexity,
        sourceKind: args?.source_kind,
      });
      if (!picked.ok) {
        // A large-leaf implement pick that could not find any usable non-flash
        // candidate (whether because every candidate was flash-excluded, the
        // pool was empty, or all harnesses were unready) is blocked with the
        // explicit reason. The acceptance criterion is "no candidate", not
        // "at least one flash existed", so we no longer require a flash to have
        // been present (that previously hid the block on an empty pool).
        if (
          role === 'implement'
          && leafTodoId
          && leafAdjustments?.leafSize === LEAF_SIZE_LARGE
          && picked.code === 'MODEL_UNAVAILABLE'
        ) {
          const blockResult = blockTodoForNoNonFlashCandidate({
            dataDir: String(getBuiltinMcpRuntimeDeps().dataDir || '').trim(),
            workspaceFolder: ctxFolder,
            todoId: leafTodoId,
          });
          if (!blockResult?.ok) {
            console.warn(
              `model_pick: failed to record no_non_flash_candidate block for todo ${leafTodoId}: ${blockResult?.reason || 'unknown'}`,
            );
          }
        }
        const code = picked.code === 'MODEL_UNAVAILABLE'
          ? MCP_BUILTIN_ERROR_CODES.MODEL_UNAVAILABLE
          : MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR;
        return mcpToolResult(
          `${code}: ${picked.error}`,
          {
            ok: false,
            code,
            error: picked.error,
            policyVersion: picked.policyVersion,
            eligibilityCohort: picked.eligibilityCohort,
            diagnosis: picked.diagnosis,
            leaf_size: leafAdjustments?.leafSize || null,
            complexity: picked.complexity,
            ...(picked.reason ? { reason: String(picked.reason) } : {}),
            ...(picked.cost_policy
              ? {
                cost_policy: {
                  ...summarizeCostPolicy(picked.cost_policy),
                  rejected: Array.isArray(picked.cost_policy.rejected) ? picked.cost_policy.rejected : [],
                },
              }
              : {}),
          },
          true,
        );
      }
      const pick = leafAdjustments
        ? {
          ...picked.pick,
          reason: appendLeafSizeToPickReason(picked.pick?.reason, {
            leafSize: leafAdjustments.leafSize,
            flashExcluded: leafAdjustments.excludeFlashModels.length,
          }),
        }
        : picked.pick;
      const picks = Array.isArray(picked.picks)
        ? picked.picks.map((row, index) => (index === 0 && leafAdjustments
          ? {
            ...row,
            reason: appendLeafSizeToPickReason(row?.reason, {
              leafSize: leafAdjustments.leafSize,
              flashExcluded: leafAdjustments.excludeFlashModels.length,
            }),
          }
          : row))
        : picked.picks;
      // Review contract: when the chosen harness cannot run the host runner
      // itself the parent must call `delegation_verify` before a PASS closes the
      // leaf. Surface it on every pick so the loop does not have to re-derive it.
      const withVerifyContract = (candidate) => (role === 'review'
        ? { ...candidate, review_requires_verify: candidate.traits.review_can_run_tests !== true }
        : candidate);
      const line = (candidate) => {
        const tests = role === 'review'
          ? `  tests=${candidate.traits.review_can_run_tests ? 'yes' : 'no'}`
            + `  verify=${candidate.traits.review_can_run_tests ? 'self' : 'required'}`
          : '';
        return `${candidate.harness}  ${candidate.model}  role=${role}`
          + `  cost=${candidate.cost_tier}  quality=${candidate.quality_tier}  speed=${candidate.speed_tier}`
          + `${tests}  reason=${String(candidate.reason || '').trim()}`;
      };
      return mcpToolResult(
        picks.map(line).join('\n'),
        {
          pick: withVerifyContract(pick),
          picks: picks.map(withVerifyContract),
          candidates: picked.candidates,
          rotation: picked.rotation,
          pickId: picked.pickId,
          pickExpiresAt: picked.pickExpiresAt,
          policyVersion: picked.policyVersion,
          eligibilityCohort: picked.eligibilityCohort,
          diagnosis: picked.diagnosis,
          // Explainable shadow observer (stage 4). Additive: the line rendering
          // above and the selected pick are unchanged.
          shadow_top: picked.shadow_top,
          shadow_explanation: picked.shadow_explanation,
          shadow_agreement: picked.shadow_agreement,
          leaf_size: leafAdjustments?.leafSize || null,
          complexity: picked.complexity,
          // RCU index (basis/tokenSource), shadow only; never a USD figure.
          cost_proxy: picked.costProxy ?? null,
          // Shadow benchmark signal with source/date and attribution; never a selection input.
          benchmark: picked.benchmark ?? null,
          ...(picked.cost_policy ? { cost_policy: summarizeCostPolicy(picked.cost_policy) } : {}),
          ...(leafTodoId ? { leafId: leafTodoId, leaf_source: leafContext.leafSource || undefined } : {}),
          ...(leafContext.warning ? { warning: leafContext.warning } : {}),
        },
      );
    },
  },
]);
