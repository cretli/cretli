/**
 * Builtin Cretli MCP TODO tools (workspace of the calling chat).
 */

import { TODO_STATUSES } from '../../persist/todos-persist.js';
import { listReadyTodoLeaves } from '../../todo-tree.js';
import { TODO_EXECUTION_WORKFLOW } from '../../todo-execution-prompt.js';
import { resolveCretliToolContext } from './tool-context.js';
import { requireClientMethod } from './client-scope.js';
import { paginateList, paginateDetail } from './paging.js';
import { mcpToolResult, truncateText } from './result.js';
import { CretliMcpToolError, MCP_BUILTIN_ERROR_CODES } from './errors.js';

const TODO_PATCH_KEYS = new Set(['title', 'body', 'status', 'parent_id', 'sibling_index', 'assignee', 'run_mode', 'execution_mode', 'orchestrator_chat_id', 'plan']);

const ASSIGNEE_SCHEMA = {
  type: 'object',
  description: 'Executor assignment: harness + optional model and role (plan|implement|review).',
  properties: {
    harness: { type: 'string', description: 'Harness transport, e.g. sdk, opencode, deepseek, codex, qwen, claude, codebuddy, openrouter' },
    model: { type: 'string' },
    role: { type: 'string', description: 'One of plan, implement, review' },
  },
  required: ['harness', 'role'],
};

function summarizeTodo(item) {
  const body = truncateText(item.body || '', 160);
  return {
    id: item.id,
    title: item.title || '',
    status: item.status || 'idea',
    updated_at: item.updatedAt || '',
    chat_id: item.chatId || '',
    created_by_chat_id: item.createdByChatId || '',
    linked_chat_ids: Array.isArray(item.linkedChatIds) ? item.linkedChatIds : [],
    parent_id: item.parentId || '',
    sibling_index: Number.isInteger(item.siblingIndex) ? item.siblingIndex : 0,
    assignee: item.assignee || null,
    run_mode: item.runMode || 'sequential',
    execution_mode: item.executionMode || 'inherit',
    claimed_by_chat_id: item.claimedByChatId || '',
    claimed_at: item.claimedAt || '',
    claim_lease_until: item.claimLeaseUntil || '',
    blocked_reason: item.blockedReason || '',
    orchestrator_chat_id: item.orchestratorChatId || '',
    has_plan: Boolean(String(item.plan?.markdown || '').trim()),
    plan_approved_at: item.plan?.approvedAt || '',
    integration_state: item.integration?.state || '',
    integration_result_path: item.integration?.resultPath || '',
    body_preview: body.text,
    truncated: body.truncated,
  };
}

function formatTodoLine(item) {
  const parent = item.parent_id ? ` (parent ${String(item.parent_id).slice(0, 8)})` : '';
  const assignee = item.assignee
    ? ` [${item.assignee.harness}${item.assignee.model ? `:${item.assignee.model}` : ''}/${item.assignee.role}]`
    : '';
  const integration = item.integration_state === 'ready' ? ' [integration ready]' : '';
  return `${item.status || 'idea'}  ${item.title || '(untitled)'}  ${String(item.id).slice(0, 8)}${parent}${assignee}${integration}`;
}

const TODO_ID_PREFIX_MIN_LENGTH = 8;

/**
 * Resolve a full todo id or a unique id prefix (>= 8 chars) inside the calling
 * chat's workspace. A prefix that matches several items is a validation error
 * so the agent can pick a longer one.
 *
 * @param {object} client
 * @param {{ workspaceFolder: string, workspaceFile?: string }} ctx
 * @param {unknown} rawId
 * @returns {Promise<{ ok: true, item: object } | { ok: false, code: string, matches?: object[] }>}
 */
async function resolveTodoIdOrPrefix(client, ctx, rawId) {
  const requested = String(rawId || '').trim();
  if (!requested) return { ok: false, code: 'NOT_FOUND' };
  const items = await client.listTodos({
    workspaceFolder: ctx.workspaceFolder,
    workspaceFile: ctx.workspaceFile,
  });
  const exact = items.find((row) => String(row?.id || '') === requested);
  if (exact) return { ok: true, item: exact };
  const prefix = requested.toLowerCase();
  if (prefix.length < TODO_ID_PREFIX_MIN_LENGTH) return { ok: false, code: 'NOT_FOUND' };
  const matches = items.filter((row) => String(row?.id || '').toLowerCase().startsWith(prefix));
  if (matches.length === 0) return { ok: false, code: 'NOT_FOUND' };
  if (matches.length > 1) return { ok: false, code: 'VALIDATION_ERROR', matches };
  return { ok: true, item: matches[0] };
}

/**
 * @param {unknown} rawId
 * @param {{ ok: false, code: string, matches?: object[] }} resolution
 * @returns {CretliMcpToolError}
 */
function todoIdResolutionError(rawId, resolution) {
  const requested = String(rawId || '').trim();
  if (resolution.code === 'VALIDATION_ERROR') {
    const candidates = (resolution.matches || [])
      .map((row) => `${row.id} (${row.title || '(untitled)'})`)
      .join(', ');
    return new CretliMcpToolError(
      MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR,
      `Todo id prefix "${requested}" matches more than one item: ${candidates}`,
    );
  }
  return new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.NOT_FOUND, `Todo not found: ${requested}`);
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
    description: 'Show one TODO given its full id or a unique id prefix (>= 8 chars): paginated body/plan, ordered children, plan approval, chats, and recent changelog. A `cretli-ref todo=<id>` line means load this task; executing a parent means orchestrating all descendants with implementation and review subchats. When the body/plan page is truncated, follow the `next_cursor` line with cursor=... until truncated is false; use children_cursor for further children.',
    inputSchema: {
      type: 'object',
      properties: {
        todo_id: { type: 'string', description: 'Full todo id or a unique id prefix of at least 8 characters.' },
        field: { type: 'string', description: 'body (default) or plan' },
        cursor: { type: 'string', description: 'Opaque page cursor from `next_cursor` of a truncated body/plan page. It is bound to the todo revision and field; a malformed cursor is a VALIDATION_ERROR and a stale one is a CONFLICT.' },
        children_cursor: { type: 'string', description: 'Offset from next_children_cursor to read more direct children.' },
      },
      required: ['todo_id'],
    },
    async handler(args, { client, session }) {
      requireClientMethod(client, 'listTodos');
      const ctx = resolveCretliToolContext(session);
      const todoId = String(args?.todo_id || '').trim();
      if (!todoId) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'todo_id is required');
      }
      const resolution = await resolveTodoIdOrPrefix(client, ctx, todoId);
      if (!resolution.ok) throw todoIdResolutionError(todoId, resolution);
      const item = resolution.item;
      const workspaceItems = await client.listTodos({ workspaceFolder: ctx.workspaceFolder, workspaceFile: ctx.workspaceFile });
      const children = workspaceItems
        .filter((row) => row.parentId === item.id)
        .sort((a, b) => (a.siblingIndex ?? 0) - (b.siblingIndex ?? 0));
      const childrenPage = paginateList(children, { cursor: args?.children_cursor });
      const childRows = childrenPage.items.map(summarizeTodo);
      const field = String(args?.field || 'body').trim() || 'body';
      if (field !== 'body' && field !== 'plan') {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'field must be body or plan');
      }
      const revision = String(item.updatedAt || '');
      const source = field === 'plan' ? (item.plan?.markdown || '') : (item.body || '');
      const page = paginateDetail(source, { cursor: args?.cursor, revision, field });
      const assignee = item.assignee
        ? `${item.assignee.harness}${item.assignee.model ? `:${item.assignee.model}` : ''} (${item.assignee.role})`
        : '-';
      const chats = Array.isArray(item.chats) ? item.chats : [];
      const chatSummary = chats.length === 0
        ? '-'
        : chats
          .map((row) => `${row.roles.join('/')}:${String(row.id).slice(0, 8)}${row.deleted ? '(deleted)' : ''}`)
          .join(' ');
      const text = [
        `# ${item.title} (${item.id})`,
        `status: ${item.status}  updated: ${item.updatedAt}`,
        `chat: ${item.chatId || '-'}  parent: ${item.parentId || '-'}  run_mode: ${item.runMode || 'sequential'}`,
        `execution_mode: ${item.executionMode || 'inherit'}`,
        `chats: ${chatSummary}`,
        `assignee: ${assignee}`,
        `plan: ${String(item.plan?.markdown || '').trim() ? (item.plan?.approvedAt ? 'approved' : 'awaiting approval') : 'none'}`,
        `children: ${children.length}`,
        ...childRows.map(formatTodoLine),
        ...(childrenPage.next_cursor ? [`More children: call todo_show with children_cursor="${childrenPage.next_cursor}".`] : []),
        `field: ${field}`,
        ...(page.truncated ? [`truncated=true next_cursor=${page.next_cursor}`] : []),
        page.text,
        ...(children.length ? [
          'When the user requests execution of this parent (rather than inspection or planning), follow this workflow:',
          TODO_EXECUTION_WORKFLOW,
        ] : []),
      ].join('\n');
      return mcpToolResult(text, {
        item: {
          ...summarizeTodo(item),
          chats,
          children: childRows,
          children_count: children.length,
          field,
          [field]: page.text,
          changelog: Array.isArray(item.changelog) ? item.changelog.slice(-10) : [],
        },
        truncated: page.truncated,
        next_cursor: page.next_cursor,
        next_children_cursor: childrenPage.next_cursor,
        revision,
      });
    },
  },
  {
    name: 'todo_create',
    readOnly: false,
    description: 'Create a TODO in this workspace and record the calling chat. Does not start an agent. Replay with the same idempotency_key.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        status: { type: 'string', description: `One of ${TODO_STATUSES.join(', ')}` },
        parent_id: { type: 'string', description: 'Optional parent TODO id — makes this a subtask.' },
        sibling_index: { type: 'number', description: 'Position inside the sibling group (>= 0). Default: first for roots, last for children.' },
        assignee: ASSIGNEE_SCHEMA,
        run_mode: { type: 'string', description: 'sequential (default) or explicit parallel — how this node runs its children. Parent status follows its children.' },
        execution_mode: { type: 'string', description: 'Per-leaf execution folder override: inherit (default), worktree or project. Watcher worktree mode only applies when the workspace enables it.' },
        orchestrator_chat_id: { type: 'string', description: 'Chat that orchestrates this subtree (separate from the node chat).' },
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
        parentId: args?.parent_id,
        siblingIndex: args?.sibling_index,
        assignee: args?.assignee,
        runMode: args?.run_mode,
        executionMode: args?.execution_mode,
        orchestratorChatId: args?.orchestrator_chat_id,
        createdByChatId: ctx.chatId || undefined,
        sourceHarness: ctx.harness || undefined,
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
    name: 'todo_start',
    readOnly: false,
    description: 'Start a TODO through the manual workspace start path. Prepares the selected worktree first, freezes it on the TODO orchestrator chat, then starts the orchestrator delegation. Pass execution_mode=worktree to force worktree preparation for this start. Pass force_new=true to continue the TODO in a fresh orchestrator chat (the Todo panel "Continue in a new chat" action): the existing worktree is reused and the previous chats stay linked; every call creates another chat, so do not retry it blindly. Use model_list first and provide the selected harness/model.',
    inputSchema: {
      type: 'object',
      properties: {
        todo_id: { type: 'string', description: 'Full TODO id or unique prefix (at least 8 characters).' },
        harness: { type: 'string', description: 'Enabled harness to run the TODO orchestrator.' },
        model: { type: 'string', description: 'Enabled model id for the selected harness.' },
        execution_mode: { type: 'string', enum: ['worktree', 'project'], description: 'Optional explicit execution folder choice. worktree is created and prepared before the agent starts.' },
        force_new: { type: 'boolean', description: 'true = always create a fresh orchestrator chat instead of reusing the linked one (default false).' },
        idempotency_key: { type: 'string', description: 'Stable key for this start request.' },
      },
      required: ['todo_id', 'harness', 'model', 'idempotency_key'],
    },
    async handler(args, { client, session }) {
      requireClientMethod(client, 'startTodoAgent');
      requireClientMethod(client, 'startDelegation');
      const ctx = resolveCretliToolContext(session);
      const resolution = await resolveTodoIdOrPrefix(client, ctx, args?.todo_id);
      if (!resolution.ok) throw todoIdResolutionError(args?.todo_id, resolution);
      const todo = resolution.item;
      const harness = String(args?.harness || '').trim();
      const model = String(args?.model || '').trim();
      const idempotencyKey = String(args?.idempotency_key || '').trim();
      const executionMode = String(args?.execution_mode || '').trim();
      if (!harness || !model || !idempotencyKey) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'harness, model, and idempotency_key are required');
      }
      if (executionMode && !['worktree', 'project'].includes(executionMode)) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'execution_mode must be worktree or project');
      }
      let started;
      try {
        started = await client.startTodoAgent({
          workspaceFolder: ctx.workspaceFolder,
          todoId: String(todo.id),
          body: {
            model,
            agentTransport: harness,
            executionMode,
            forceNew: args?.force_new === true,
            workspaceFile: ctx.workspaceFile,
            workspaceFolder: ctx.workspaceFolder,
          },
        });
      } catch (error) {
        const message = String(error?.message || error?.code || error?.key || 'TODO start failed');
        throw new CretliMcpToolError(
          error?.status === 409 ? MCP_BUILTIN_ERROR_CODES.CONFLICT : MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR,
          message,
          { reason: String(error?.code || '') },
        );
      }
      const chatId = String(started?.chat?.id || '').trim();
      if (!chatId) throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.CONFLICT, 'TODO workspace was prepared but its orchestrator chat is missing.');
      const delegation = await client.startDelegation({
        chatId,
        workspaceFolder: ctx.workspaceFolder,
        harness,
        model,
        idempotencyKey,
        sourceKind: 'text',
        taskText: String(started.initialPrompt || ''),
        executionMode: 'agent',
        assignment: 'implement',
        requestedRole: 'implement',
        leafId: String(todo.id),
        returnWhenStarting: true,
      });
      if (!delegation?.ok) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.CONFLICT, delegation?.error || 'TODO delegation failed to start.');
      }
      return mcpToolResult(
        `Started TODO ${todo.title} (${todo.id}) in ${started.worktree ? 'worktree' : 'project'} mode; orchestrator chat=${chatId} (${started.reused ? 'reused' : 'new'}), delegation=${delegation.delegation?.id || ''}`,
        { todo: summarizeTodo(started.todo || todo), chat_id: chatId, chat_reused: started.reused === true, execution_folder: started.executionFolder || ctx.workspaceFolder, worktree: started.worktree === true, delegation: delegation.delegation || null },
      );
    },
  },
  {
    name: 'todo_update',
    readOnly: false,
    description: 'Update TODO title, body, status, or tree fields (parent_id, sibling_index, assignee, run_mode, execution_mode). Accepts a full id or a unique id prefix (>= 8 chars). A `cretli-ref todo=<id>` line means call todo_show first and continue the task. Requires expected_updated_at from todo_show.',
    inputSchema: {
      type: 'object',
      properties: {
        todo_id: { type: 'string', description: 'Full todo id or a unique id prefix of at least 8 characters.' },
        expected_updated_at: { type: 'string' },
        patch: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            body: { type: 'string' },
            status: { type: 'string' },
            parent_id: { type: 'string', description: 'Move under this parent; empty string moves back to root.' },
            sibling_index: { type: 'number', description: 'Position inside the sibling group (>= 0).' },
            assignee: { ...ASSIGNEE_SCHEMA, description: `${ASSIGNEE_SCHEMA.description} Send {"harness":"","role":""} to clear.` },
            run_mode: { type: 'string', description: 'sequential (default) or explicit parallel; empty string restores the default.' },
            execution_mode: { type: 'string', description: 'Per-leaf execution folder override: inherit, worktree or project; empty string restores inherit.' },
            orchestrator_chat_id: { type: 'string', description: 'Chat that orchestrates this subtree; empty string clears it.' },
            plan: {
              type: 'object',
              description: 'Draft plan only: { markdown }. Never set approvedAt (human approval is UI-only).',
              properties: {
                markdown: { type: 'string', description: 'Plan body markdown (draft).' },
              },
            },
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
      if (patch.plan != null) {
        if (typeof patch.plan !== 'object' || Array.isArray(patch.plan)) {
          throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'patch.plan must be an object');
        }
        const planKeys = Object.keys(patch.plan);
        const illegalPlanKeys = planKeys.filter((key) => key !== 'markdown');
        if (illegalPlanKeys.length > 0) {
          throw new CretliMcpToolError(
            MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR,
            `patch.plan may only include markdown (not ${illegalPlanKeys.join(', ')})`,
          );
        }
        if (patch.plan.markdown == null) {
          throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'patch.plan.markdown is required when plan is set');
        }
      }
      const resolution = await resolveTodoIdOrPrefix(client, ctx, todoId);
      if (!resolution.ok) throw todoIdResolutionError(todoId, resolution);
      const current = resolution.item;
      const nextStatus = patch.status == null ? '' : String(patch.status).trim().toLowerCase();
      const item = await client.updateTodo({
        workspaceFolder: ctx.workspaceFolder,
        workspaceFile: ctx.workspaceFile,
        todoId: String(current.id),
        expectedUpdatedAt,
        title: patch.title,
        body: patch.body,
        status: patch.status,
        parentId: patch.parent_id,
        siblingIndex: patch.sibling_index,
        assignee: patch.assignee,
        runMode: patch.run_mode,
        executionMode: patch.execution_mode,
        orchestratorChatId: patch.orchestrator_chat_id,
        linkedChatId: ctx.chatId || undefined,
        plan: patch.plan ? {
          markdown: String(patch.plan.markdown || ''),
          sourceChatId: ctx.chatId || undefined,
        } : undefined,
        appendChangelog: nextStatus && nextStatus !== current.status
          ? { kind: 'note', text: `status: ${current.status}→${nextStatus}`, chatId: ctx.chatId || undefined }
          : undefined,
      });
      if (!item) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.NOT_FOUND, `Todo not found: ${todoId}`);
      }
      return mcpToolResult(`Updated TODO ${item.title} (${item.id})`, { item: summarizeTodo(item) });
    },
  },
  {
    name: 'todo_next_ready',
    readOnly: true,
    description: 'List ready TODO leaves: not done/doing and not blocked (parent plan unapproved, or a sequential earlier sibling). Optional root_id limits to a subtree.',
    inputSchema: {
      type: 'object',
      properties: {
        root_id: { type: 'string', description: 'Limit results to this subtree.' },
        limit: { type: 'number' },
        cursor: { type: 'string' },
      },
    },
    async handler(args, { client, session }) {
      requireClientMethod(client, 'listTodos');
      const ctx = resolveCretliToolContext(session);
      const items = await client.listTodos({ workspaceFolder: ctx.workspaceFolder });
      const rootId = String(args?.root_id || '').trim();
      if (rootId && !items.some((row) => row?.id === rootId)) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.NOT_FOUND, `Todo not found: ${rootId}`);
      }
      const ready = listReadyTodoLeaves(items, { rootId: rootId || undefined });
      const page = paginateList(ready, args);
      const rows = page.items.map(summarizeTodo);
      const text = rows.length === 0 ? '(no ready todos)' : rows.map((row) => formatTodoLine(row)).join('\n');
      return mcpToolResult(text, { items: rows, next_cursor: page.next_cursor });
    },
  },
]);
