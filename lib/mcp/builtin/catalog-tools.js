/**
 * Builtin Cretli MCP catalogs: tasks, agents, harnesses, models.
 * agent_list returns .cursor/agents definitions, not chats.
 * All reads go through the API client (in-process or HTTP), never local files.
 */

import { parseKnownAgentTransport } from '../../agent-transport.js';
import { assertReviewAdapterAllowed } from '../../delegation-adapter-capabilities.js';
import { MODEL_PICK_ROLES, loadRotationConfig } from '../../model-role-profiles.js';
import { pickModelForPurpose } from '../../model-pick-service.js';
import { buildModelPickHistory } from '../../model-pick-history.js';
import { resolveCretliToolContext } from './tool-context.js';
import { requireClientMethod } from './client-scope.js';
import { paginateList } from './paging.js';
import { mcpToolResult } from './result.js';
import { CretliMcpToolError, MCP_BUILTIN_ERROR_CODES } from './errors.js';

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
 */
async function collectEligibleHarnessModels(client, harnesses) {
  /** @type {Record<string, object>} */
  const modelsByHarness = {};
  for (const harness of harnesses) {
    if (!harness?.enabled || !harness?.ready || !harness?.can_delegate) continue;
    const id = String(harness.id || '').trim();
    if (!id) continue;
    modelsByHarness[id] = await client.listHarnessModels({
      harness: id,
      enabledOnly: true,
    });
  }
  return modelsByHarness;
}

/**
 * Plan/review picks must be startable. Codex without the uncertified flag is unset.
 *
 * @param {string} role
 * @param {Record<string, object>} modelsByHarness
 * @returns {Record<string, object>}
 */
function omitUncertifiedReviewHarnesses(role, modelsByHarness) {
  if (role !== 'review' && role !== 'plan') return modelsByHarness;
  const next = { ...modelsByHarness };
  for (const id of Object.keys(next)) {
    if (assertReviewAdapterAllowed(id).ok) continue;
    delete next[id];
  }
  return next;
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
        return `${row.id}  ${row.label}  ${flags}`;
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
    async handler(args, { client }) {
      requireClientMethod(client, 'listHarnessModels');
      const rawHarness = typeof args?.harness === 'string' ? args.harness.trim() : '';
      const harness = parseKnownAgentTransport(rawHarness) || rawHarness.toLowerCase();
      if (!harness) {
        throw new CretliMcpToolError(
          MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR,
          'harness is required',
        );
      }
      const remote = await client.listHarnessModels({
        harness,
        query: args?.query,
        enabledOnly: args?.enabled_only === true,
      });
      const page = paginateList(remote.items || [], args);
      const warning = remote.warning || '';
      const text = page.items.length === 0
        ? `(no models) ${warning}`.trim()
        : `${page.items.map((row) => `${row.id}  ${row.label || row.id}`).join('\n')}${warning ? `\n[${remote.source || 'remote'}] ${warning}` : ''}`;
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
    description: 'Pick one Settings favorite for a delegation role (plan, implement, review, fix). Joins harness_list: enabled, ready, and can_delegate. Empty favorites for a harness are unset (no pick from that harness). Review never picks *flash* ids. Plan/review skip harnesses that would fail review_uncertified (e.g. Codex). Optional exclude_model skips that id and the same base model (reviewer is not the last implementer, or a failed usage-limit model); optional exclude_harness skips a whole harness (quota or adapter down) — both stay hard. Ranking is score DESC (role weights), then tier tie-break; inside the tie band (rotation.band) a deterministic rotation keys on: keep the proven winner (the newest implement->review cycle of that model in this chat PASSed), then fewest uses in this chat for the role, then least-used harness in role 7d, then least-used model 7d, then least-recently-used, then id. Review auto-excludes the last implementer and last reviewer (real reviews only) as a soft preference: if that leaves no candidate the pick retries without the history excludes and reason says "history exclude relaxed". Models under an active lockout are dropped; a fresh limit-hit penalises only the same model/base, or the whole harness when the row has no model. Cold-start harnesses get a bonus every 5th pick of global role traffic for implement/fix/review only (explore=false disables; plan never explores). Optional rotation=off|balanced|explore overrides the setting. candidates follows the actual selection (rotation band first, then score) and candidates[1] prefers a different harness when one is in band. Each candidate carries a reason and an observed block (last 30d for the harness + base model: n, pass_rate, infra_fail_rate, median_min, median_tokens_per_sec, and for implement median_tool_calls / median_files_changed) or null. Each candidate is shrunk toward its role prior (w=n/(n+10)): observed quality blends into the heuristic tier and infra_fail_rate blends toward the role\'s job-weighted mean, so a pair with no history inherits that prior instead of a free pass; the shrunk infra rate penalises the score by up to 50%, and a keep_winner stays in band within two bands of the best. Review observed quality is the productive-verdict share and useful_rate is reported but not scored. adaptive=false (or adaptive.enabled=false in data/model-role-profiles.json) restores pure heuristics. `count`/`diverse` return `picks` (pick = picks[0]); `exclude_models`/`exclude_harnesses` extend the single excludes. Review candidates carry `traits` (review_can_run_tests, review_can_run_tests_source, known_failure_modes); the effective trait is the static prior unless 30d observation of the harness\'s review reports has at least 2 agreeing signals, then source is "observed". On a tie in the band review prefers a harness that can run the review-verify catalog itself, and the reason names it. Does not start a chat.',
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
        count: { type: 'number', minimum: 1, maximum: 5, description: 'Number of picks for a fanout (integer 1..5; default 1; pick is always picks[0])' },
        diverse: { type: 'boolean', description: 'With count>1, prefer extra picks on different harnesses and providers' },
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
      const harnesses = await client.listHarnessCatalog();
      const modelsByHarness = omitUncertifiedReviewHarnesses(
        role,
        await collectEligibleHarnessModels(client, harnesses),
      );
      const excludeModels = assertStringArrayArg(args?.exclude_models, 'exclude_models');
      const excludeHarnesses = assertStringArrayArg(args?.exclude_harnesses, 'exclude_harnesses');
      const count = assertCountArg(args?.count);
      const chatId = String(args?.chat_id || session?.chatId || '').trim();
      const history = buildModelPickHistory({
        role,
        chatId,
        harnesses: harnesses.map((row) => row?.id),
      });
      const picked = pickModelForPurpose({
        role,
        excludeModel: args?.exclude_model,
        excludeModels,
        excludeHarness: args?.exclude_harness,
        excludeHarnesses,
        harnesses,
        modelsByHarness,
        rotation: args?.rotation !== undefined ? args.rotation : loadRotationConfig(),
        history,
        explore: args?.explore,
        adaptive: args?.adaptive,
        count,
        diverse: args?.diverse,
      });
      if (!picked.ok) {
        throw new CretliMcpToolError(
          picked.code === 'MODEL_UNAVAILABLE'
            ? MCP_BUILTIN_ERROR_CODES.MODEL_UNAVAILABLE
            : MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR,
          picked.error,
        );
      }
      const pick = picked.pick;
      const picks = picked.picks;
      const line = (candidate) => {
        const tests = role === 'review'
          ? `  tests=${candidate.traits.review_can_run_tests ? 'yes' : 'no'}`
          : '';
        return `${candidate.harness}  ${candidate.model}  role=${role}`
          + `  cost=${candidate.cost_tier}  quality=${candidate.quality_tier}  speed=${candidate.speed_tier}`
          + `${tests}  reason=${String(candidate.reason || '').trim()}`;
      };
      return mcpToolResult(
        picks.map(line).join('\n'),
        { pick, picks, candidates: picked.candidates, rotation: picked.rotation },
      );
    },
  },
]);
