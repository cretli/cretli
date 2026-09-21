/**
 * Builtin Cretli MCP catalogs: tasks, agents, harnesses, models.
 * agent_list returns .cursor/agents definitions, not chats.
 * All reads go through the API client (in-process or HTTP), never local files.
 */

import { parseKnownAgentTransport } from '../../agent-transport.js';
import { assertReviewAdapterAllowed } from '../../delegation-adapter-capabilities.js';
import { MODEL_PICK_ROLES, selectModelPick } from '../../model-role-profiles.js';
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
      const harness = parseKnownAgentTransport(args?.harness);
      if (!harness) {
        throw new CretliMcpToolError(
          MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR,
          String(args?.harness || '').trim() ? `Unknown harness "${args.harness}"` : 'harness is required',
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
    description: 'Pick one Settings favorite for a delegation role (plan, implement, review, fix). Joins harness_list: enabled, ready, and can_delegate. Empty favorites for a harness are unset (no pick from that harness). Review never picks *flash* ids. Plan/review skip harnesses that would fail review_uncertified (e.g. Codex). Optional exclude_model skips that id and the same base model (reviewer ≠ last implementer, or a failed usage-limit model). Optional exclude_harness skips a whole harness (quota or adapter down). Ranking is cost/quality/speed axes, not matcher priority. Does not start a chat.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'plan, implement, review, or fix' },
        exclude_model: { type: 'string', description: 'Skip this catalog id and the same base model id' },
        exclude_harness: { type: 'string', description: 'Skip this harness id (e.g. codex after a usage-limit fail)' },
      },
      required: ['role'],
    },
    async handler(args, { client }) {
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
      const picked = selectModelPick({
        role,
        excludeModel: args?.exclude_model,
        excludeHarness: args?.exclude_harness,
        harnesses,
        modelsByHarness,
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
      const next = picked.candidates[1];
      const nextHint = next ? `  next=${next.harness}/${next.model}` : '';
      return mcpToolResult(
        `${pick.harness}  ${pick.model}  role=${role}  cost=${pick.cost_tier}  quality=${pick.quality_tier}  speed=${pick.speed_tier}${nextHint}`,
        { pick, candidates: picked.candidates },
      );
    },
  },
]);
