/**
 * Builtin Cretli MCP tools for scheduled condition checks. The server
 * evaluates a named predicate every tick and starts ONE fresh chat for a todo
 * when it holds. None of these tools ever calls a model.
 */

import { requireClientMethod } from './client-scope.js';
import { resolveCretliToolContext } from './tool-context.js';
import { mcpToolResult } from './result.js';
import { CretliMcpToolError, MCP_BUILTIN_ERROR_CODES } from './errors.js';
import { resolveTodoIdOrPrefix, todoIdResolutionError } from './todo-tools.js';

function render(result, label) {
  if (result?.ok === false) {
    const code = result.status === 404 ? MCP_BUILTIN_ERROR_CODES.NOT_FOUND
      : result.status === 409 ? MCP_BUILTIN_ERROR_CODES.CONFLICT
        : MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR;
    throw new CretliMcpToolError(code, `${label}: ${result.code || 'failed'} (${result.error || ''})`, { reason: String(result.code || '') });
  }
  return mcpToolResult(JSON.stringify(result, null, 2), result);
}

export const CHECK_MCP_TOOLS = Object.freeze([
  {
    name: 'check_schedule',
    readOnly: false,
    description: 'Schedule a deterministic follow-up check. The server evaluates a named predicate every minute (no model call, no tokens) and, only when it holds, starts ONE fresh chat for the todo with a short brief; the calling chat is never resumed. Predicate `delegations_finished_since` params: { transport, assignment?, sinceMs, minCount (1..1000) }. A check expires after expires_in_ms (default 14 days). This tool never calls a model.',
    inputSchema: {
      type: 'object',
      properties: {
        todo_id: { type: 'string', description: 'Full todo id or unique prefix (at least 8 characters) the fresh chat will work on.' },
        title: { type: 'string', description: 'Short label shown in the scheduler list (max 120 characters).' },
        predicate: {
          type: 'object',
          description: 'Named predicate: { id, params }. Closed registry; unknown ids are refused.',
          properties: { id: { type: 'string' }, params: { type: 'object' } },
          required: ['id'],
        },
        brief: { type: 'string', description: 'Short self-contained instruction for the fresh chat (max 1500 characters).' },
        expires_in_ms: { type: 'number', description: 'Lifetime in ms (60000..90 days; default 14 days).' },
      },
      required: ['todo_id', 'predicate'],
    },
    async handler(args, { client, session }) {
      requireClientMethod(client, 'scheduleCheck');
      const ctx = resolveCretliToolContext(session);
      const resolution = await resolveTodoIdOrPrefix(client, ctx, args?.todo_id);
      if (!resolution.ok) throw todoIdResolutionError(args?.todo_id, /** @type {any} */ (resolution));
      const result = await client.scheduleCheck({
        workspaceFolder: ctx.workspaceFolder,
        todoId: String(resolution.item.id),
        title: args?.title,
        predicate: args?.predicate,
        brief: args?.brief,
        expiresInMs: args?.expires_in_ms,
      });
      return render(result, 'check_schedule');
    },
  },
  {
    name: 'check_list',
    readOnly: true,
    description: 'List scheduled checks with state, expiry, started chat and the last in-memory evaluation progress (empty after a server restart until the next tick). Local read only: it never calls a model.',
    inputSchema: { type: 'object', properties: { state: { type: 'string', description: 'Optional state filter: armed, resuming, resumed, cancelled, expired, blocked.' } } },
    async handler(args, { client }) {
      requireClientMethod(client, 'listChecks');
      const items = await client.listChecks({ state: args?.state });
      return mcpToolResult(JSON.stringify({ items }, null, 2), { items });
    },
  },
  {
    name: 'check_cancel',
    readOnly: false,
    description: 'Cancel one armed scheduled check by id. A cancelled check never starts a chat. This tool never calls a model.',
    inputSchema: { type: 'object', properties: { check_id: { type: 'string', description: 'Scheduled check id from check_list.' } }, required: ['check_id'] },
    async handler(args, { client }) {
      requireClientMethod(client, 'cancelCheck');
      const result = await client.cancelCheck({ checkId: String(args?.check_id || '').trim() });
      return render(result, 'check_cancel');
    },
  },
]);
