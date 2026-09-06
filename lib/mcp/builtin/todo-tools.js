/**
 * Builtin Cretli MCP TODO tools (workspace of the calling chat).
 */

import { TODO_STATUSES } from '../../persist/todos-persist.js';
import { resolveCretliToolContext } from './tool-context.js';
import { requireClientMethod } from './client-scope.js';
import { paginateList, paginateDetail } from './paging.js';
import { mcpToolResult, truncateText } from './result.js';
import { CretliMcpToolError, MCP_BUILTIN_ERROR_CODES } from './errors.js';

const TODO_PATCH_KEYS = new Set(['title', 'body', 'status']);

function summarizeTodo(item) {
  const body = truncateText(item.body || '', 160);
  return {
    id: item.id,
    title: item.title || '',
    status: item.status || 'idea',
    updated_at: item.updatedAt || '',
    chat_id: item.chatId || '',
    linked_chat_ids: Array.isArray(item.linkedChatIds) ? item.linkedChatIds : [],
    body_preview: body.text,
    truncated: body.truncated,
  };
}

function formatTodoLine(item) {
  return `${item.status || 'idea'}  ${item.title || '(untitled)'}  ${String(item.id).slice(0, 8)}`;
}

export const TODO_MCP_TOOLS = Object.freeze([
  {
    name: 'todo_list',
    readOnly: true,
    description: 'List TODO items for this chat workspace (not the UI global folder).',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: `Filter: ${TODO_STATUSES.join(', ')}` },
        query: { type: 'string', description: 'Filter by title or body substring.' },
        limit: { type: 'number' },
        cursor: { type: 'string' },
      },
    },
    async handler(args, { client, session }) {
      requireClientMethod(client, 'listTodos');
      const ctx = resolveCretliToolContext(session);
      const status = args?.status == null || args?.status === '' ? '' : String(args.status).trim().toLowerCase();
      if (status && !TODO_STATUSES.includes(status)) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, `Invalid todo status "${args.status}"`);
      }
      const needle = String(args?.query || '').trim().toLowerCase();
      const items = await client.listTodos({ workspaceFolder: ctx.workspaceFolder });
      const filtered = items.filter((item) => {
        if (status && item.status !== status) return false;
        if (!needle) return true;
        const hay = `${item.title || ''} ${item.body || ''}`.toLowerCase();
        return hay.includes(needle);
      });
      const page = paginateList(filtered, args);
      const rows = page.items.map(summarizeTodo);
      const text = rows.length === 0 ? '(no todos)' : rows.map((row) => formatTodoLine(row)).join('\n');
      return mcpToolResult(text, { items: rows, next_cursor: page.next_cursor });
    },
  },
  {
    name: 'todo_show',
    readOnly: true,
    description: 'Show one TODO, including paginated body/plan. Use cursor from a previous call to read the rest.',
    inputSchema: {
      type: 'object',
      properties: {
        todo_id: { type: 'string' },
        field: { type: 'string', description: 'body (default) or plan' },
        cursor: { type: 'string' },
      },
      required: ['todo_id'],
    },
    async handler(args, { client, session }) {
      requireClientMethod(client, 'getTodo');
      const ctx = resolveCretliToolContext(session);
      const todoId = String(args?.todo_id || '').trim();
      if (!todoId) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'todo_id is required');
      }
      const item = await client.getTodo({ workspaceFolder: ctx.workspaceFolder, todoId });
      if (!item) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.NOT_FOUND, `Todo not found: ${todoId}`);
      }
      const field = String(args?.field || 'body').trim() || 'body';
      if (field !== 'body' && field !== 'plan') {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'field must be body or plan');
      }
      const revision = String(item.updatedAt || '');
      const source = field === 'plan' ? (item.plan?.markdown || '') : (item.body || '');
      const page = paginateDetail(source, { cursor: args?.cursor, revision, field });
      const text = [
        `# ${item.title} (${item.id})`,
        `status: ${item.status}  updated: ${item.updatedAt}`,
        `chat: ${item.chatId || '-'}`,
        `field: ${field}`,
        page.text,
      ].join('\n');
      return mcpToolResult(text, {
        item: {
          ...summarizeTodo(item),
          field,
          [field]: page.text,
          changelog: Array.isArray(item.changelog) ? item.changelog.slice(-10) : [],
        },
        truncated: page.truncated,
        next_cursor: page.next_cursor,
        revision,
      });
    },
  },
  {
    name: 'todo_create',
    readOnly: false,
    description: 'Create a TODO in this workspace. Does not start an agent. Replay with the same idempotency_key.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        status: { type: 'string', description: `One of ${TODO_STATUSES.join(', ')}` },
        idempotency_key: { type: 'string' },
      },
      required: ['title', 'idempotency_key'],
    },
    async handler(args, { client, session }) {
      requireClientMethod(client, 'createTodo');
      const ctx = resolveCretliToolContext(session);
      const title = String(args?.title || '').trim();
      const idempotencyKey = String(args?.idempotency_key || '').trim();
      if (!title) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'title is required');
      }
      if (!idempotencyKey) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'idempotency_key is required');
      }
      const result = await client.createTodo({
        workspaceFolder: ctx.workspaceFolder,
        title,
        body: args?.body,
        status: args?.status,
        idempotencyKey,
      });
      const item = result.item || result;
      return mcpToolResult(
        `${result.replayed ? 'Replayed' : 'Created'} TODO ${item.title} (${item.id})`,
        { item: summarizeTodo(item), replayed: result.replayed === true },
      );
    },
  },
  {
    name: 'todo_update',
    readOnly: false,
    description: 'Update TODO title, body, or status. Requires expected_updated_at from todo_show.',
    inputSchema: {
      type: 'object',
      properties: {
        todo_id: { type: 'string' },
        expected_updated_at: { type: 'string' },
        patch: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            body: { type: 'string' },
            status: { type: 'string' },
          },
        },
      },
      required: ['todo_id', 'patch', 'expected_updated_at'],
    },
    async handler(args, { client, session }) {
      requireClientMethod(client, 'updateTodo');
      const ctx = resolveCretliToolContext(session);
      const todoId = String(args?.todo_id || '').trim();
      const expectedUpdatedAt = String(args?.expected_updated_at || '').trim();
      const patch = args?.patch && typeof args.patch === 'object' ? args.patch : null;
      if (!todoId) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'todo_id is required');
      }
      if (!expectedUpdatedAt) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'expected_updated_at is required');
      }
      if (!patch) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'patch is required');
      }
      const extra = Object.keys(patch).filter((key) => !TODO_PATCH_KEYS.has(key));
      if (extra.length > 0) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, `Unsupported patch fields: ${extra.join(', ')}`);
      }
      const item = await client.updateTodo({
        workspaceFolder: ctx.workspaceFolder,
        todoId,
        expectedUpdatedAt,
        title: patch.title,
        body: patch.body,
        status: patch.status,
      });
      return mcpToolResult(`Updated TODO ${item.title} (${item.id})`, { item: summarizeTodo(item) });
    },
  },
]);
