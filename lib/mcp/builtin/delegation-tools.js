/**
 * Builtin Cretli MCP plan and delegation tools.
 */

import { createHash } from 'node:crypto';
import { resolveCretliToolContext } from './tool-context.js';
import { requireClientChat, requireClientMethod } from './client-scope.js';
import { paginateList, paginateDetail } from './paging.js';
import { mcpToolResult, truncateText } from './result.js';
import { CretliMcpToolError, MCP_BUILTIN_ERROR_CODES } from './errors.js';

function summarizeDelegation(row) {
  const report = truncateText(row.report || '', 240);
  return {
    id: row.id,
    status: row.status,
    parent_chat_id: row.parentChatId,
    child_chat_id: row.childChatId || '',
    harness: row.executor?.transport || '',
    model: row.executor?.model || '',
    plan_revision: row.planRevision,
    unverified: row.unverified !== false,
    error: row.error || '',
    report_preview: report.text,
    truncated: report.truncated,
  };
}

function hashDetail(text) {
  return createHash('sha256').update(String(text || ''), 'utf8').digest('hex').slice(0, 16);
}

function delegationFieldRevision(row, field) {
  const source = field === 'plan' ? (row.planMarkdown || '') : (row.report || '');
  return `${row.id}:${field}:${hashDetail(source)}`;
}

function throwIfFailed(result, fallback) {
  if (result?.ok === false) {
    const err = new Error(result.error || fallback);
    err.code = result.code;
    throw err;
  }
}

export const DELEGATION_MCP_TOOLS = Object.freeze([
  {
    name: 'chat_plan_show',
    readOnly: true,
    description: 'Show the saved plan for a chat in this workspace. Use cursor to read further pages of the same revision.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Defaults to the calling chat.' },
        cursor: { type: 'string' },
      },
    },
    async handler(args, { client, session }) {
      requireClientMethod(client, 'getChatPlan');
      const ctx = resolveCretliToolContext(session);
      const chatId = String(args?.chat_id || ctx.chatId || '').trim();
      const chat = await requireClientChat(client, {
        chatId,
        workspaceFolder: ctx.workspaceFolder,
        workspaceFile: ctx.workspaceFile,
      });
      const plan = await client.getChatPlan({
        chatId: chat.id,
        workspaceFolder: ctx.workspaceFolder,
      });
      const body = String(plan?.body || plan?.markdown || '');
      if (!body.trim()) {
        return mcpToolResult('No saved plan for this chat.', { chat_id: chat.id, plan: null });
      }
      const revision = String(plan.revision ?? '');
      const page = paginateDetail(body, { cursor: args?.cursor, revision, field: 'body' });
      return mcpToolResult(
        `Plan revision ${plan.revision} for ${chat.title || chat.id}\n${page.text}`,
        {
          chat_id: chat.id,
          revision: plan.revision,
          updated_at: plan.updatedAt || '',
          content_hash: plan.contentHash || '',
          title: plan.title || '',
          body: page.text,
          truncated: page.truncated,
          next_cursor: page.next_cursor,
        },
      );
    },
  },
  {
    name: 'delegation_list',
    readOnly: true,
    description: 'List plan-execution delegations for a chat in this workspace (defaults to the calling chat).',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        status: { type: 'string' },
        limit: { type: 'number' },
        cursor: { type: 'string' },
      },
    },
    async handler(args, { client, session }) {
      requireClientMethod(client, 'listDelegations');
      const ctx = resolveCretliToolContext(session);
      const chatId = String(args?.chat_id || ctx.chatId || '').trim();
      await requireClientChat(client, {
        chatId,
        workspaceFolder: ctx.workspaceFolder,
        workspaceFile: ctx.workspaceFile,
      });
      const status = String(args?.status || '').trim();
      const rows = await client.listDelegations({ chatId, workspaceFolder: ctx.workspaceFolder });
      const filtered = rows.filter((row) => {
        if (status && String(row.status) !== status) return false;
        return true;
      });
      const page = paginateList(filtered, args);
      const items = page.items.map(summarizeDelegation);
      const text = items.length === 0 ? '(no delegations)' : items.map((row) => `${row.status}  ${row.id.slice(0, 8)}  ${row.harness}/${row.model}`).join('\n');
      return mcpToolResult(text, { items, next_cursor: page.next_cursor });
    },
  },
  {
    name: 'delegation_show',
    readOnly: true,
    description: 'Show delegation status and a paginated report or plan. Finished does not mean reviewed.',
    inputSchema: {
      type: 'object',
      properties: {
        delegation_id: { type: 'string' },
        field: { type: 'string', description: 'report (default) or plan' },
        cursor: { type: 'string' },
      },
      required: ['delegation_id'],
    },
    async handler(args, { client, session }) {
      requireClientMethod(client, 'getDelegation');
      const ctx = resolveCretliToolContext(session);
      const delegationId = String(args?.delegation_id || '').trim();
      if (!delegationId) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'delegation_id is required');
      }
      const row = await client.getDelegation({
        delegationId,
        workspaceFolder: ctx.workspaceFolder,
      });
      if (!row) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.NOT_FOUND, `Delegation not found: ${delegationId}`);
      }
      const field = String(args?.field || 'report').trim() || 'report';
      if (field !== 'report' && field !== 'plan') {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'field must be report or plan');
      }
      const revision = delegationFieldRevision(row, field);
      const source = field === 'plan' ? (row.planMarkdown || '') : (row.report || '');
      const page = paginateDetail(source, { cursor: args?.cursor, revision, field });
      const text = [
        `Delegation ${row.id} status=${row.status}`,
        `executor: ${row.executor?.transport || '-'} / ${row.executor?.model || '-'}`,
        `child_chat: ${row.childChatId || '-'}`,
        row.error ? `error: ${row.error}` : '',
        `${field}:\n${page.text}`,
      ].filter(Boolean).join('\n');
      return mcpToolResult(text, {
        ...summarizeDelegation(row),
        field,
        [field]: page.text,
        truncated: page.truncated,
        next_cursor: page.next_cursor,
        revision,
      });
    },
  },
  {
    name: 'delegation_start',
    readOnly: false,
    description: 'Start a delegation from a saved plan, a chat message, or explicit task text. Does not switch Plan to Agent. Does not ack the report.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        plan_revision: { type: 'number' },
        history_seq: { type: 'number', description: 'Stable history seq of the source message' },
        content_hash: { type: 'string', description: 'SHA-256 of the source message text' },
        task_text: { type: 'string', description: 'Explicit task text (no history record)' },
        harness: { type: 'string' },
        model: { type: 'string' },
        execution_mode: { type: 'string', description: 'plan or agent. Defaults to the parent chat mode.' },
        extra_instructions: { type: 'string' },
        idempotency_key: { type: 'string' },
      },
      required: ['harness', 'model', 'idempotency_key'],
    },
    async handler(args, { client, session }) {
      requireClientMethod(client, 'startDelegation');
      const ctx = resolveCretliToolContext(session);
      const chatId = String(args?.chat_id || ctx.chatId || '').trim();
      await requireClientChat(client, {
        chatId,
        workspaceFolder: ctx.workspaceFolder,
        workspaceFile: ctx.workspaceFile,
      });
      const revision = Number(args?.plan_revision);
      const historySeq = Number(args?.history_seq);
      const contentHash = String(args?.content_hash || '').trim();
      const taskText = String(args?.task_text || '').trim();
      const hasPlan = Number.isInteger(revision) && revision > 0;
      const hasMessage = Number.isInteger(historySeq) && historySeq > 0 && !!contentHash;
      const hasText = !!taskText;
      const sourceCount = [hasPlan, hasMessage, hasText].filter(Boolean).length;
      if (sourceCount !== 1) {
        throw new CretliMcpToolError(
          MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR,
          'Provide exactly one of plan_revision, history_seq+content_hash, or task_text',
        );
      }
      const sourceKind = hasText ? 'text' : hasMessage ? 'message' : 'plan';
      const harness = String(args?.harness || '').trim();
      const model = String(args?.model || '').trim();
      const idempotencyKey = String(args?.idempotency_key || '').trim();
      if (!harness || !model || !idempotencyKey) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'harness, model, and idempotency_key are required');
      }
      const result = await client.startDelegation({
        chatId,
        workspaceFolder: ctx.workspaceFolder,
        planRevision: revision,
        harness,
        model,
        extraInstructions: args?.extra_instructions,
        idempotencyKey,
        sourceKind,
        historySeq: hasMessage ? historySeq : undefined,
        contentHash: hasMessage || hasText ? contentHash : undefined,
        taskText: hasText ? taskText : undefined,
        executionMode: args?.execution_mode,
      });
      throwIfFailed(result, 'Delegation failed');
      const row = result.delegation;
      return mcpToolResult(
        `${result.replayed ? 'Replayed' : 'Started'} delegation ${row.id} status=${row.status} child=${row.childChatId || '-'}`,
        { ...summarizeDelegation(row), replayed: result.replayed === true },
      );
    },
  },
  {
    name: 'delegation_cancel',
    readOnly: false,
    description: 'Request cancellation. Status cancelling means stop was requested, not that the run has ended.',
    inputSchema: {
      type: 'object',
      properties: { delegation_id: { type: 'string' } },
      required: ['delegation_id'],
    },
    async handler(args, { client, session }) {
      requireClientMethod(client, 'cancelDelegation');
      const ctx = resolveCretliToolContext(session);
      const delegationId = String(args?.delegation_id || '').trim();
      if (!delegationId) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'delegation_id is required');
      }
      const result = await client.cancelDelegation({
        delegationId,
        workspaceFolder: ctx.workspaceFolder,
      });
      throwIfFailed(result, 'Cancel failed');
      const row = result.delegation;
      const pending = result.pending === true;
      return mcpToolResult(
        pending
          ? `Cancel requested for ${row.id}; run may still be stopping.`
          : `Delegation ${row.id} status=${row.status}`,
        { ...summarizeDelegation(row), pending },
      );
    },
  },
  {
    name: 'delegation_reply',
    readOnly: false,
    description: 'Send a message from the executor chat to the communication parent. Sidebar grouping is ignored. Does not mark the job reviewed.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        delegation_id: { type: 'string' },
        history_seq: { type: 'number' },
        content_hash: { type: 'string' },
        message_text: { type: 'string' },
        idempotency_key: { type: 'string' },
      },
      required: ['idempotency_key'],
    },
    async handler(args, { client, session }) {
      requireClientMethod(client, 'replyDelegation');
      const ctx = resolveCretliToolContext(session);
      const chatId = String(args?.chat_id || ctx.chatId || '').trim();
      await requireClientChat(client, {
        chatId,
        workspaceFolder: ctx.workspaceFolder,
        workspaceFile: ctx.workspaceFile,
      });
      const idempotencyKey = String(args?.idempotency_key || '').trim();
      if (!idempotencyKey) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'idempotency_key is required');
      }
      const historySeq = Number(args?.history_seq);
      const messageText = String(args?.message_text || '').trim();
      const contentHash = String(args?.content_hash || '').trim();
      const hasSeq = Number.isInteger(historySeq) && historySeq > 0;
      if (hasSeq === !!messageText) {
        throw new CretliMcpToolError(
          MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR,
          'Provide exactly one of history_seq+content_hash or message_text',
        );
      }
      if (hasSeq && !contentHash) {
        throw new CretliMcpToolError(
          MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR,
          'content_hash is required with history_seq',
        );
      }
      const result = await client.replyDelegation({
        chatId,
        workspaceFolder: ctx.workspaceFolder,
        body: hasSeq ? undefined : messageText,
        historySeq: hasSeq ? historySeq : undefined,
        contentHash: hasSeq ? contentHash : undefined,
        idempotencyKey,
        delegationId: args?.delegation_id,
      });
      throwIfFailed(result, 'Reply failed');
      const row = result.message;
      return mcpToolResult(
        `${result.replayed ? 'Replayed' : 'Queued'} reply ${row.id} status=${row.status} to=${row.toChatId}`,
        {
          id: row.id,
          status: row.status,
          from_chat_id: row.fromChatId,
          to_chat_id: row.toChatId,
          delegation_id: row.delegationId || '',
          delivery: row.delivery || '',
          replayed: result.replayed === true,
        },
      );
    },
  },
  {
    name: 'delegation_inbox',
    readOnly: true,
    description: 'List mailbox messages for a chat (queued and delivered). Sidebar grouping does not change the recipient. Pass id for a single message.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        id: { type: 'string', description: 'Optional mailbox message id' },
        status: { type: 'string' },
        limit: { type: 'number' },
        cursor: { type: 'string' },
      },
    },
    async handler(args, { client, session }) {
      requireClientMethod(client, 'listMailbox');
      const ctx = resolveCretliToolContext(session);
      const chatId = String(args?.chat_id || ctx.chatId || '').trim();
      await requireClientChat(client, {
        chatId,
        workspaceFolder: ctx.workspaceFolder,
        workspaceFile: ctx.workspaceFile,
      });
      const wantedId = String(args?.id || '').trim();
      const status = String(args?.status || '').trim();
      const rows = await client.listMailbox({ chatId, workspaceFolder: ctx.workspaceFolder });
      const filtered = rows.filter((row) => {
        if (wantedId && String(row.id) !== wantedId) return false;
        if (status && String(row.status) !== status) return false;
        return true;
      });
      const page = paginateList(filtered, args);
      const items = page.items.map((row) => ({
        id: row.id,
        kind: row.kind,
        status: row.status,
        from_chat_id: row.fromChatId,
        to_chat_id: row.toChatId,
        delegation_id: row.delegationId || '',
        delivery: row.delivery || '',
        body_preview: truncateText(row.body || '', 240).text,
      }));
      const text = items.length === 0
        ? '(empty mailbox)'
        : items.map((row) => `${row.status}  ${row.kind}  ${row.id.slice(0, 8)}`).join('\n');
      return mcpToolResult(text, { items, next_cursor: page.next_cursor });
    },
  },
]);
