/**
 * Builtin Cretli MCP TODO tools (workspace of the calling chat).
 */

import { TODO_STATUSES } from '../../persist/todos-persist.js';
import { listReadyTodoLeaves } from '../../todo-tree.js';
import { assessParallelRunModeForSiblings } from '../../todo-parallel-scope.js';
import { TODO_EXECUTION_WORKFLOW } from '../../todo-execution-prompt.js';
import {
  buildTodoReviewReadModel,
  parseTodoReviewFilter,
  summarizeTodoReviewForList,
  todoReviewMatchesFilter,
} from '../../todo-review-read.js';
import { attachTodoIntegrationReadModels } from '../../todo-integration-read.js';
import { formatTodoLeafMaterialDiagnostics } from '../../todo-leaf-material.js';
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

/**
 * Compact list-row projection. `options.isContainer` flips the review summary to
 * its empty container form (`docs/todo-review-contract.md` §10.6, §12.2).
 *
 * @param {object} item
 * @param {{ isContainer?: boolean }} [options]
 */
function summarizeTodo(item, options = {}) {
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
    integration_summary: item.integrationSummary || null,
    ...summarizeTodoReviewForList(item, { isContainer: options.isContainer === true }),
    body_preview: body.text,
    truncated: body.truncated,
  };
}

/**
 * Direct-parent id set, so a list row can tell a leaf from a container without
 * another store read.
 *
 * @param {Array<{ id?: string, parentId?: string }>} items
 * @returns {Set<string>}
 */
function collectContainerIds(items) {
  const ids = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const parentId = String(item?.parentId || '').trim();
    if (parentId) ids.add(parentId);
  }
  return ids;
}

/**
 * One readable review line for `todo_show` so an orchestrator can confirm the
 * server-side snapshot without parsing the structured block.
 *
 * @param {object} review
 * @returns {string}
 */
function formatTodoReviewLine(review) {
  const code = String(review?.code?.state || 'none');
  const plan = String(review?.plan?.state || 'none');
  const independence = String(review?.code?.independence?.class || 'unknown');
  const reviewer = review?.code?.reviewers?.[0];
  const reviewerText = reviewer
    ? `${reviewer.harness || '?'}:${reviewer.model || '?'}`
    : '-';
  const aggregate = review?.aggregate
    ? ` aggregate(code passed=${review.aggregate.code?.passed || 0} failed=${review.aggregate.code?.failed || 0})`
    : '';
  return `review: code=${code} plan=${plan} independence=${independence} reviewer=${reviewerText}${aggregate}`;
}

function formatTodoIntegrationLine(summary) {
  const state = String(summary?.state || 'unconfirmed');
  const detail = summary?.detail ? ` detail=${summary.detail}` : '';
  const target = summary?.targetBranch
    ? ` target=${summary.targetBranch}@${summary.targetCommit || '-'}`
    : '';
  return `integration: ${state}${detail}${target}`;
}

function formatTodoLine(item) {
  const parent = item.parent_id ? ` (parent ${String(item.parent_id).slice(0, 8)})` : '';
  const assignee = item.assignee
    ? ` [${item.assignee.harness}${item.assignee.model ? `:${item.assignee.model}` : ''}/${item.assignee.role}]`
    : '';
  const integration = ` [integration ${item.integration_summary?.detail === 'no_code_changes'
    ? 'no code changes'
    : item.integration_summary?.state || (item.integration_state === 'ready' ? 'awaiting' : 'unconfirmed')}]`;
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
    description: 'List TODO items for this chat workspace (not the UI global folder). Each row carries a compact server-computed `review` summary and the optional `review` filter narrows by it; the field is read-only and never set by an agent.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: `Filter: ${TODO_STATUSES.join(', ')}` },
        query: { type: 'string', description: 'Filter by title or body substring.' },
        review: { type: 'string', description: 'Filter by review state: a bare state (code subject) or subject:state (e.g. plan:none). States: none, pending, passed, failed, manual, stale, unknown.' },
        integration: { type: 'string', description: 'Filter by derived integration state: unconfirmed, awaiting, integrated, partial, rejected, conflict or no_code_changes.' },
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
      const reviewFilter = parseTodoReviewFilter(args?.review);
      if (!reviewFilter.ok) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, reviewFilter.message);
      }
      const needle = String(args?.query || '').trim().toLowerCase();
      const integrationFilter = String(args?.integration || '').trim().toLowerCase();
      const validIntegrationFilters = new Set(['unconfirmed', 'awaiting', 'integrated', 'partial', 'rejected', 'conflict', 'no_code_changes']);
      if (integrationFilter && !validIntegrationFilters.has(integrationFilter)) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, `Invalid integration filter "${integrationFilter}"`);
      }
      const items = attachTodoIntegrationReadModels(await client.listTodos({ workspaceFolder: ctx.workspaceFolder }));
      const containerIds = collectContainerIds(items);
      const filtered = items.filter((item) => {
        if (status && item.status !== status) return false;
        if (!todoReviewMatchesFilter(item, containerIds.has(String(item?.id || '')), reviewFilter)) return false;
        if (integrationFilter && item.integrationSummary?.state !== integrationFilter
          && item.integrationSummary?.detail !== integrationFilter) return false;
        if (!needle) return true;
        const hay = `${item.title || ''} ${item.body || ''}`.toLowerCase();
        return hay.includes(needle);
      });
      const page = paginateList(filtered, args);
      const rows = page.items.map((item) => summarizeTodo(item, { isContainer: containerIds.has(String(item?.id || '')) }));
      const text = rows.length === 0 ? '(no todos)' : rows.map((row) => formatTodoLine(row)).join('\n');
      return mcpToolResult(text, { items: rows, next_cursor: page.next_cursor });
    },
  },
  {
    name: 'todo_show',
    readOnly: true,
    description: 'Show one TODO given its full id or a unique id prefix (>= 8 chars): paginated body/plan, ordered children, plan approval, chats, and recent changelog. A `cretli-ref todo=<id>` line means load this task; executing a parent means orchestrating all descendants with implementation and review subchats. When the body/plan page is truncated, follow the `next_cursor` line with cursor=... until truncated is false; use children_cursor for further children. The response includes the server-written `review` block (per-subject state: none, pending, passed, failed, manual, stale, unknown). `passed` means an independent reviewer PASSed with satisfied verify and no implement/fix was queued after it; `manual` appears only after a human accepted a review attempt in the UI. A plan review is not a code review. Check it before closing a leaf.',
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
      const workspaceItems = attachTodoIntegrationReadModels(await client.listTodos({ workspaceFolder: ctx.workspaceFolder, workspaceFile: ctx.workspaceFile }));
      const readItem = workspaceItems.find((row) => String(row?.id || '') === String(item.id)) || item;
      const children = workspaceItems
        .filter((row) => row.parentId === item.id)
        .sort((a, b) => (a.siblingIndex ?? 0) - (b.siblingIndex ?? 0));
      const childrenPage = paginateList(children, { cursor: args?.children_cursor });
      const containerIds = collectContainerIds(workspaceItems);
      const isContainer = children.length > 0;
      const childRows = childrenPage.items.map((child) => summarizeTodo(child, {
        isContainer: containerIds.has(String(child?.id || '')),
      }));
      const review = buildTodoReviewReadModel(item, { children });
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
        formatTodoReviewLine(review),
        formatTodoLeafMaterialDiagnostics(item),
        formatTodoIntegrationLine(readItem.integrationSummary),
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
          ...summarizeTodo(readItem, { isContainer }),
          chats,
          review,
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
    description: 'Start a TODO through the manual workspace start path. Prepares the selected worktree first, freezes it on the TODO orchestrator chat, then starts the orchestrator delegation. Pass execution_mode=worktree to force worktree preparation for this start. Pass execution_mode=project to run in the project folder; if the tree already owns a worktree the start is refused unless release_worktree=true. Pass force_new=true to continue the TODO in a fresh orchestrator chat (the Todo panel "Continue in a new chat" action): the existing worktree is reused and the previous chats stay linked; every call creates another chat, so do not retry it blindly. Use model_list first and provide the selected harness/model.',
    inputSchema: {
      type: 'object',
      properties: {
        todo_id: { type: 'string', description: 'Full TODO id or unique prefix (at least 8 characters).' },
        harness: { type: 'string', description: 'Enabled harness to run the TODO orchestrator.' },
        model: { type: 'string', description: 'Enabled model id for the selected harness.' },
        execution_mode: { type: 'string', enum: ['worktree', 'project'], description: 'Optional explicit execution folder choice. worktree is created and prepared before the agent starts.' },
        force_new: { type: 'boolean', description: 'true = always create a fresh orchestrator chat instead of reusing the linked one (default false).' },
        release_worktree: { type: 'boolean', description: 'With execution_mode=project: release the tree\'s existing worktree (kept on disk, record closed) and run in the project folder. Without it a frozen worktree makes the start fail with a conflict. Refused while a chat of the tree has a live run.' },
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
            releaseWorktree: args?.release_worktree === true,
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
    description: 'Update TODO title, body, status, or tree fields (parent_id, sibling_index, assignee, run_mode, execution_mode). Accepts a full id or a unique id prefix (>= 8 chars). A `cretli-ref todo=<id>` line means call todo_show first and continue the task. Requires expected_updated_at from todo_show. The `review` field is server-written: a patch carrying `review` is rejected and it cannot be set or cleared through this tool.',
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
    name: 'todo_integration',
    readOnly: false,
    description: 'Record TODO integration evidence (target-branch proof). Actions: confirm (proof.simple=true derives branch/HEAD from the workspace, or pass target_branch + target_commit + change_ref + change_attested), invalidate (needs reason), no_code (done TODO without code changes, needs reason), reject (needs reason). Requires expected_updated_at from todo_show. Never commits, merges or pushes. `confirm` is a human attestation: only call it when the user asked you to and the changes were verified in the target branch (`git branch --contains`). `done` or review PASS alone is not proof.',
    inputSchema: {
      type: 'object',
      properties: {
        todo_id: { type: 'string', description: 'Full todo id or a unique id prefix of at least 8 characters.' },
        action: { type: 'string', description: 'confirm, invalidate, no_code or reject.' },
        expected_updated_at: { type: 'string' },
        reason: { type: 'string', description: 'Required for invalidate, no_code and reject.' },
        proof: {
          type: 'object',
          description: 'confirm only.',
          properties: {
            simple: { type: 'boolean', description: 'Derive target branch and HEAD from the current workspace branch.' },
            target_branch: { type: 'string' },
            target_commit: { type: 'string', description: 'Full commit SHA.' },
            source_commit: { type: 'string' },
            material_revision: { type: 'string' },
            change_ref: { type: 'string' },
            change_attested: { type: 'boolean' },
            scope: { type: 'string', description: 'task or tree.' },
          },
        },
      },
      required: ['todo_id', 'action', 'expected_updated_at'],
    },
    async handler(args, { client, session }) {
      requireClientMethod(client, 'recordTodoIntegration');
      const ctx = resolveCretliToolContext(session);
      const todoId = String(args?.todo_id || '').trim();
      const action = String(args?.action || '').trim().toLowerCase().replace('-', '_');
      const expectedUpdatedAt = String(args?.expected_updated_at || '').trim();
      if (!todoId || !expectedUpdatedAt) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'todo_id and expected_updated_at are required');
      }
      if (!['confirm', 'invalidate', 'no_code', 'reject'].includes(action)) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'action must be confirm, invalidate, no_code or reject');
      }
      const resolution = await resolveTodoIdOrPrefix(client, ctx, todoId);
      if (!resolution.ok) throw todoIdResolutionError(todoId, resolution);
      const p = args?.proof && typeof args.proof === 'object' ? args.proof : {};
      const result = await client.recordTodoIntegration({
        workspaceFolder: ctx.workspaceFolder,
        todoId: String(resolution.item.id),
        action,
        expectedUpdatedAt,
        reason: String(args?.reason || '').trim(),
        proof: {
          targetBranch: p.target_branch,
          targetCommit: p.target_commit,
          sourceCommit: p.source_commit,
          materialRevision: p.material_revision,
          changeRef: p.change_ref,
          changeAttested: p.change_attested === true,
          scope: p.scope,
          simple: p.simple === true,
        },
      });
      if (!result?.ok) {
        const reason = String(result?.reason || 'integration failed');
        const code = ['conflict', 'not_ready', 'not_done', 'integration_ready', 'already_integrated', 'target_commit_not_on_branch', 'target_ref_missing', 'material_revision_mismatch', 'already_applied', 'busy'].includes(reason)
          ? MCP_BUILTIN_ERROR_CODES.CONFLICT
          : reason === 'not_found' ? MCP_BUILTIN_ERROR_CODES.NOT_FOUND : MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR;
        throw new CretliMcpToolError(code, `TODO integration ${action} failed: ${reason}`, { reason });
      }
      const [read] = attachTodoIntegrationReadModels(result.item ? [result.item] : []);
      return mcpToolResult(
        `TODO ${resolution.item.title} (${String(resolution.item.id).slice(0, 8)}): integration ${action} ok`,
        { item: summarizeTodo(read || result.item || resolution.item) },
      );
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
      /** @type {Record<string, object>} */
      const parallelHints = {};
      const parentIds = new Set(
        ready.map((row) => String(row?.parentId || '').trim()).filter(Boolean),
      );
      for (const parentId of parentIds) {
        const assessment = assessParallelRunModeForSiblings(items, parentId);
        if (assessment.ok) {
          parallelHints[parentId] = { parallel_safe: true };
        } else {
          parallelHints[parentId] = {
            parallel_safe: false,
            collisions: assessment.collisions,
          };
        }
      }
      return mcpToolResult(text, {
        items: rows,
        next_cursor: page.next_cursor,
        parallel_scope: Object.keys(parallelHints).length ? parallelHints : undefined,
      });
    },
  },
]);
