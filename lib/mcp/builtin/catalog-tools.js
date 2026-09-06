/**
 * Builtin Cretli MCP catalogs: tasks, agents, harnesses, models.
 * agent_list returns .cursor/agents definitions, not chats.
 * All reads go through the API client (in-process or HTTP), never local files.
 */

import { parseKnownAgentTransport } from '../../agent-transport.js';
import { resolveCretliToolContext } from './tool-context.js';
import { requireClientMethod } from './client-scope.js';
import { paginateList } from './paging.js';
import { mcpToolResult } from './result.js';
import { CretliMcpToolError, MCP_BUILTIN_ERROR_CODES } from './errors.js';

function taskChoiceId(task) {
  const folder = String(task.folderPath || task.cwd || '').trim();
  return `${folder}::${task.label}`;
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
    description: 'List harnesses with enabled, ready, and whether a server-side delegation adapter exists.',
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
    description: 'List models for one harness from cached/fallback catalogs. Does not start harness processes.',
    inputSchema: {
      type: 'object',
      properties: {
        harness: { type: 'string' },
        query: { type: 'string' },
        enabled_only: { type: 'boolean' },
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
      });
    },
  },
]);
