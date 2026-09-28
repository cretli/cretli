/**
 * Builtin Cretli MCP plan and delegation tools.
 */

import { createHash } from 'node:crypto';
import { resolveCretliToolContext } from './tool-context.js';
import { requireClientChat, requireClientMethod } from './client-scope.js';
import { paginateList, paginateDetail } from './paging.js';
import { mcpToolResult, truncateText } from './result.js';
import { CretliMcpToolError, MCP_BUILTIN_ERROR_CODES } from './errors.js';
import { summarizeDelegation as summarizeDelegationQuery } from '../../delegation-query.js';
import {
  mapDelegationRoleToAssignment,
  parseDelegationVerdict,
} from '../../delegation-verdict.js';
import { normalizeMcpChatScope } from './chat-scope.js';
import {
  clampDelegationWaitTimeoutMs,
  isDelegationWaitSatisfied,
  isDelegationWaitSettled,
  sleepDelegationWait,
  DELEGATION_WAIT_POLL_MS,
} from './delegation-wait.js';

function summarizeDelegation(row) {
  const query = summarizeDelegationQuery(row);
  const report = truncateText(row.report || '', 240);
  return {
    id: row.id,
    status: row.status,
    parent_chat_id: row.parentChatId,
    child_chat_id: row.childChatId || '',
    harness: row.executor?.transport || '',
    model: row.executor?.model || '',
    assignment: row.assignment || '',
    plan_revision: row.planRevision,
    unverified: row.unverified !== false,
    attempt_id: query.attemptId || row.attemptId || '',
    run_id: query.runId || row.runId || '',
    attempt_count: Array.isArray(row.attempts) ? row.attempts.length + 1 : 1,
    error: row.error || '',
    report_preview: report.text,
    truncated: report.truncated,
    task_outcome: query.taskOutcome || 'unspecified',
    run_stopping: query.runStopping === true,
    slot_occupied: query.slotOccupied === true,
    verdict: parseDelegationVerdict(row.report || ''),
  };
}

function formatDelegationListLine(row) {
  return `${row.status}  ${row.id}  ${row.harness}/${row.model}`;
}

function summarizeWaitItem(row) {
  const summary = summarizeDelegation(row);
  return {
    id: summary.id,
    status: summary.status,
    slot_occupied: summary.slot_occupied,
    run_stopping: summary.run_stopping,
    task_outcome: summary.task_outcome,
    verdict: summary.verdict,
    harness: summary.harness,
    model: summary.model,
    assignment: summary.assignment,
    error: summary.error,
  };
}

function formatWaitItemLine(item) {
  return `${item.id} status=${item.status} slot_occupied=${item.slot_occupied} run_stopping=${item.run_stopping} task_outcome=${item.task_outcome} verdict=${item.verdict}`;
}

function parseWaitIds(args) {
  const raw = args?.ids;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'ids is required');
  }
  const ids = [...new Set(raw.map((value) => String(value || '').trim()).filter(Boolean))];
  if (ids.length === 0) {
    throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'ids is required');
  }
  return ids;
}

function parseWaitUntil(args) {
  const raw = String(args?.until || 'all').trim() || 'all';
  if (raw !== 'all' && raw !== 'any') {
    throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'until must be all or any');
  }
  return raw;
}

function throwIfWaitAborted(signal) {
  if (!signal?.aborted) return;
  throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'MCP call cancelled');
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
    err.status = result.status;
    err.delegationId = result.delegationId || result.id || result.delegation?.id || '';
    err.attemptId = result.attemptId || result.delegation?.attemptId || '';
    err.reason = result.reason || '';
    throw err;
  }
}

/**
 * Workflow writes belong to the calling parent chat. Model-supplied chat_id is
 * not a substitute for the session identity.
 *
 * @param {object} client
 * @param {object} session
 * @param {unknown} requestedChatId
 * @param {{ write?: boolean }} [options]
 */
async function requireWorkflowParentChat(client, session, requestedChatId, options = {}) {
  const ctx = resolveCretliToolContext(session);
  const sessionChatId = String(ctx.chatId || '').trim();
  if (!sessionChatId) {
    throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'chat_id is required');
  }
  const requested = String(requestedChatId || '').trim();
  if (requested && requested !== sessionChatId) {
    throw new CretliMcpToolError(
      MCP_BUILTIN_ERROR_CODES.CONFLICT,
      'Workflow state applies only to the calling parent chat.',
    );
  }
  const chat = await requireClientChat(client, {
    chatId: sessionChatId,
    workspaceFolder: ctx.workspaceFolder,
    workspaceFile: ctx.workspaceFile,
  });
  if (options.write === true && String(chat.delegationParentChatId || '').trim()) {
    throw new CretliMcpToolError(
      MCP_BUILTIN_ERROR_CODES.CONFLICT,
      'Only the parent chat of this session can update workflow state.',
    );
  }
  return { ctx, chat };
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
    description: 'List plan-execution delegations for a chat. Defaults to the calling chat in this workspace. Pass scope=all to read another workspace. List text uses the full UUID.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        status: { type: 'string' },
        limit: { type: 'number' },
        cursor: { type: 'string' },
        scope: { type: 'string', description: 'workspace (default) or all.' },
      },
    },
    async handler(args, { client, session }) {
      requireClientMethod(client, 'listDelegations');
      const ctx = resolveCretliToolContext(session);
      const chatId = String(args?.chat_id || ctx.chatId || '').trim();
      const scope = normalizeMcpChatScope(args?.scope);
      const chat = await requireClientChat(client, {
        chatId,
        workspaceFolder: ctx.workspaceFolder,
        workspaceFile: ctx.workspaceFile,
        skipWorkspace: scope === 'all',
      });
      const status = String(args?.status || '').trim();
      const rows = await client.listDelegations({
        chatId: chat.id,
        workspaceFolder: ctx.workspaceFolder,
        skipWorkspace: scope === 'all',
      });
      const filtered = rows.filter((row) => {
        if (status && String(row.status) !== status) return false;
        return true;
      });
      const page = paginateList(filtered, args);
      const items = page.items.map(summarizeDelegation);
      const text = items.length === 0 ? '(no delegations)' : items.map(formatDelegationListLine).join('\n');
      return mcpToolResult(text, { items, next_cursor: page.next_cursor });
    },
  },
  {
    name: 'delegation_show',
    readOnly: true,
    description: 'Show delegation status and a paginated report or plan. Terminal statuses are completed, failed, cancelled, and interrupted — not finished. completed does not mean the slot is free or that the report is reviewed. Follow next_cursor; inbox previews omit the ending VERDICT.',
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
      const summary = summarizeDelegation(row);
      const text = [
        `Delegation ${row.id} status=${row.status} task_outcome=${summary.task_outcome} slot_occupied=${summary.slot_occupied} run_stopping=${summary.run_stopping} verdict=${summary.verdict}`,
        `attempt_id: ${summary.attempt_id || '-'} run_id: ${summary.run_id || '-'}`,
        `executor: ${row.executor?.transport || '-'} / ${row.executor?.model || '-'}`,
        `child_chat: ${row.childChatId || '-'}`,
        row.error ? `error: ${row.error}` : '',
        page.truncated ? `truncated=true next_cursor=${page.next_cursor}` : '',
        `${field}:\n${page.text}`,
      ].filter(Boolean).join('\n');
      return mcpToolResult(text, {
        ...summary,
        field,
        [field]: page.text,
        truncated: page.truncated,
        next_cursor: page.next_cursor,
        revision,
      });
    },
  },
  {
    name: 'delegation_wait',
    readOnly: true,
    description: 'Bounded long-poll for jobs started by this parent chat. Returns done when each id is terminal and slot_occupied is false (until=all) or when any id is (until=any). Default timeout_ms=20000, max 25000. Call again on pending. Does not return the full report — use delegation_show or delegation_inbox.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Delegation UUIDs owned by the calling parent chat.',
        },
        until: { type: 'string', description: 'all (default) or any.' },
        timeout_ms: { type: 'number', description: 'Default 20000, max 25000 (below the 30s bridge HTTP timeout).' },
      },
      required: ['ids'],
    },
    async handler(args, { client, session, signal }) {
      requireClientMethod(client, 'getDelegation');
      const ctx = resolveCretliToolContext(session);
      const caller = await requireClientChat(client, {
        chatId: ctx.chatId,
        workspaceFolder: ctx.workspaceFolder,
        workspaceFile: ctx.workspaceFile,
      });
      const ids = parseWaitIds(args);
      const until = parseWaitUntil(args);
      const timeoutMs = clampDelegationWaitTimeoutMs(args?.timeout_ms);
      const startedAt = Date.now();
      async function loadRows() {
        const rows = [];
        for (const id of ids) {
          const row = await client.getDelegation({
            delegationId: id,
            workspaceFolder: ctx.workspaceFolder,
          });
          if (!row) {
            throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.NOT_FOUND, `Delegation not found: ${id}`);
          }
          if (String(row.parentChatId || '') !== caller.id) {
            throw new CretliMcpToolError(
              MCP_BUILTIN_ERROR_CODES.OUT_OF_SCOPE,
              'Delegation wait is limited to jobs started by this parent chat.',
            );
          }
          rows.push(row);
        }
        return rows;
      }
      while (true) {
        throwIfWaitAborted(signal);
        const rows = await loadRows();
        const items = rows.map(summarizeWaitItem);
        const settled = rows.filter(isDelegationWaitSettled).length;
        const done = isDelegationWaitSatisfied(rows, until);
        const status = done ? 'done' : 'pending';
        const remaining = Math.max(0, timeoutMs - (Date.now() - startedAt));
        if (done || remaining === 0) {
          const text = [
            `delegation_wait status=${status} until=${until} settled=${settled}/${items.length}`,
            ...items.map(formatWaitItemLine),
          ].join('\n');
          return mcpToolResult(text, { status, until, timeout_ms: timeoutMs, items });
        }
        await sleepDelegationWait(signal, Math.min(DELEGATION_WAIT_POLL_MS, remaining));
      }
    },
  },
  {
    name: 'delegation_start',
    readOnly: false,
    description: 'Start a Cretli child chat on another harness/model (DeepSeek, OpenCode, Qwen, Codex, OpenRouter, CodeBuddy, or Cursor). Use this for a sub-chat or review when Cursor Task does not list that model. Source: saved plan, history message, or task_text. Call model_list(harness, enabled_only=true) first. Does not switch Plan to Agent. Does not ack the report.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        plan_revision: { type: 'number' },
        history_seq: { type: 'number', description: 'Stable history seq of the source message' },
        content_hash: { type: 'string', description: 'SHA-256 of the source message text' },
        task_text: { type: 'string', description: 'Explicit task text (no history record)' },
        harness: { type: 'string' },
        model: { type: 'string', description: 'Settings-enabled model id for that harness (from model_list enabled_only=true)' },
        execution_mode: { type: 'string', description: 'Child SDK mode: plan or agent. Reviews are automatically run in agent mode so the child can inspect the workspace.' },
        assignment: { type: 'string', description: 'review or implement. Map plan→review, implement/fix→implement. Review requires a hard pre-exec or sandbox read-only guarantee.' },
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
        assignment: mapDelegationRoleToAssignment(args?.assignment) || args?.assignment,
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
    description: 'Send a message from this executor chat to the communication parent. chat_id if passed must be this chat. Sidebar grouping is ignored. Does not mark the job reviewed.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        delegation_id: { type: 'string' },
        history_seq: { type: 'number' },
        content_hash: { type: 'string' },
        message_text: { type: 'string' },
        idempotency_key: { type: 'string' },
        reply_kind: { type: 'string', description: 'progress, question, or final_report' },
        attempt_id: { type: 'string', description: 'Executing attempt. Compared with the live run; not taken from the job record alone.' },
        run_id: { type: 'string', description: 'Executing run id. Compared with the live run.' },
        task_outcome: { type: 'string', description: 'success, failure, blocked, or unspecified' },
      },
      required: ['idempotency_key'],
    },
    async handler(args, { client, session }) {
      requireClientMethod(client, 'replyDelegation');
      const ctx = resolveCretliToolContext(session);
      const sessionChatId = String(ctx.chatId || '').trim();
      if (!sessionChatId) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'chat_id is required');
      }
      const requestedChatId = String(args?.chat_id || '').trim();
      if (requestedChatId && requestedChatId !== sessionChatId) {
        throw new CretliMcpToolError(
          MCP_BUILTIN_ERROR_CODES.CONFLICT,
          'delegation_reply chat_id must be this chat. You cannot reply as another executor.',
        );
      }
      const chatId = sessionChatId;
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
        replyKind: args?.reply_kind,
        attemptId: args?.attempt_id || session?.attemptId,
        runId: args?.run_id || session?.runId,
        sessionAttemptId: session?.attemptId,
        sessionRunId: session?.runId,
        taskOutcome: args?.task_outcome,
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
          attempt_id: row.delegationAttemptId || '',
          delivery: row.delivery || '',
          replayed: result.replayed === true,
        },
      );
    },
  },
  {
    name: 'delegation_inbox',
    readOnly: true,
    description: 'List mailbox messages for a chat (queued and delivered). Sidebar grouping does not change the recipient. Pass id to page the full body; list previews are 240 characters and may omit VERDICT. Use delegation_show for the report. Pass scope=all to read another workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        id: { type: 'string', description: 'Optional mailbox message id. Pages the full body with cursor.' },
        status: { type: 'string' },
        limit: { type: 'number' },
        cursor: { type: 'string' },
        scope: { type: 'string', description: 'workspace (default) or all.' },
      },
    },
    async handler(args, { client, session }) {
      requireClientMethod(client, 'listMailbox');
      const ctx = resolveCretliToolContext(session);
      const chatId = String(args?.chat_id || ctx.chatId || '').trim();
      const scope = normalizeMcpChatScope(args?.scope);
      const chat = await requireClientChat(client, {
        chatId,
        workspaceFolder: ctx.workspaceFolder,
        workspaceFile: ctx.workspaceFile,
        skipWorkspace: scope === 'all',
      });
      const wantedId = String(args?.id || '').trim();
      const status = String(args?.status || '').trim();
      const rows = await client.listMailbox({
        chatId: chat.id,
        workspaceFolder: ctx.workspaceFolder,
        skipWorkspace: scope === 'all',
      });
      const filtered = rows.filter((row) => {
        if (wantedId && String(row.id) !== wantedId) return false;
        if (status && String(row.status) !== status) return false;
        return true;
      });
      if (wantedId) {
        const row = filtered[0];
        if (!row) {
          return mcpToolResult('(empty mailbox)', { items: [], next_cursor: '' });
        }
        const revision = `${row.id}:body:${hashDetail(row.body || '')}`;
        const page = paginateDetail(row.body || '', { cursor: args?.cursor, revision, field: 'body' });
        const item = {
          id: row.id,
          kind: row.kind,
          status: row.status,
          from_chat_id: row.fromChatId,
          to_chat_id: row.toChatId,
          delegation_id: row.delegationId || '',
          delivery: row.delivery || '',
          body: page.text,
          truncated: page.truncated,
          next_cursor: page.next_cursor,
          verdict: parseDelegationVerdict(row.body || ''),
        };
        return mcpToolResult(
          `${row.status}  ${row.kind}  ${row.id}${page.truncated ? `\ntruncated=true next_cursor=${page.next_cursor}` : ''}\n${page.text}`,
          { items: [item], next_cursor: page.next_cursor },
        );
      }
      const page = paginateList(filtered, args);
      const items = page.items.map((row) => {
        const preview = truncateText(row.body || '', 240);
        return {
          id: row.id,
          kind: row.kind,
          status: row.status,
          from_chat_id: row.fromChatId,
          to_chat_id: row.toChatId,
          delegation_id: row.delegationId || '',
          delivery: row.delivery || '',
          body_preview: preview.text,
          truncated: preview.truncated,
          verdict: parseDelegationVerdict(row.body || ''),
        };
      });
      const text = items.length === 0
        ? '(empty mailbox)'
        : items.map((row) => `${row.status}  ${row.kind}  ${row.id}`).join('\n');
      return mcpToolResult(text, { items, next_cursor: page.next_cursor });
    },
  },
  {
    name: 'delegation_workflow_show',
    readOnly: true,
    description: 'Show durable parent-loop state (role, round, implementer, verdict, stop reason, deadline). The parent still starts each child; this is not a server sequencer.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Defaults to the calling chat.' },
      },
    },
    async handler(args, { client, session }) {
      requireClientMethod(client, 'getDelegationWorkflow');
      const { ctx, chat } = await requireWorkflowParentChat(client, session, args?.chat_id);
      const row = await client.getDelegationWorkflow({
        chatId: chat.id,
        workspaceFolder: ctx.workspaceFolder,
      });
      if (!row) {
        return mcpToolResult('No workflow state for this chat.', { chat_id: chat.id, workflow: null });
      }
      const text = [
        `workflow parent=${row.parentChatId} role=${row.role || '-'} round=${row.round}/${row.maxRounds}`,
        `verdict=${row.lastVerdict} stop=${row.stopReason || '-'} implementer=${row.lastImplementer || '-'} reviewer=${row.lastReviewer || '-'}`,
        `deadline=${row.deadlineAt || '-'} material=${row.materialRevision || '-'} same_fail=${row.consecutiveSameFail}`,
      ].join('\n');
      return mcpToolResult(text, { chat_id: chat.id, workflow: row });
    },
  },
  {
    name: 'delegation_workflow_update',
    readOnly: false,
    description: 'Write parent-loop state so a restart does not reset rounds. Optional deadline/max_rounds/material_revision. Pass idempotency_key per review event; replaying any previously applied key with the same params is a no-op, the same key with different params is CONFLICT. A second distinct identical FAIL with material unchanged since the last FAIL review sets stop_reason=same_findings. Does not start a child.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        role: { type: 'string' },
        round: { type: 'number' },
        max_rounds: { type: 'number' },
        last_implementer: { type: 'string' },
        last_reviewer: { type: 'string' },
        findings_text: { type: 'string' },
        findings_hash: { type: 'string' },
        last_verdict: { type: 'string' },
        report_text: { type: 'string' },
        fanout_verdicts: { type: 'array', items: { type: 'string' } },
        stop_reason: { type: 'string' },
        clear_stop: { type: 'boolean' },
        deadline_at: { type: 'string' },
        material_revision: { type: 'string', description: 'Code/artifact revision. A second distinct FAIL with the same findings_hash and the same material as the last FAIL review sets same_findings.' },
        idempotency_key: { type: 'string', description: 'Stable per review/event. Replay of any previously applied key with the same params is a no-op.' },
      },
    },
    async handler(args, { client, session }) {
      requireClientMethod(client, 'updateDelegationWorkflow');
      const { ctx, chat } = await requireWorkflowParentChat(client, session, args?.chat_id, { write: true });
      const result = await client.updateDelegationWorkflow({
        chatId: chat.id,
        workspaceFolder: ctx.workspaceFolder,
        role: args?.role,
        round: args?.round,
        maxRounds: args?.max_rounds,
        lastImplementer: args?.last_implementer,
        lastReviewer: args?.last_reviewer,
        findingsText: args?.findings_text,
        findingsHash: args?.findings_hash,
        lastVerdict: args?.last_verdict,
        reportText: args?.report_text,
        fanoutVerdicts: args?.fanout_verdicts,
        stopReason: args?.stop_reason,
        clearStop: args?.clear_stop === true,
        deadlineAt: args?.deadline_at,
        materialRevision: args?.material_revision,
        idempotencyKey: args?.idempotency_key,
      });
      throwIfFailed(result, 'Workflow update failed');
      const row = result.workflow || result;
      const replayed = result.replayed === true || row.replayed === true;
      return mcpToolResult(
        `workflow parent=${row.parentChatId} role=${row.role || '-'} round=${row.round}/${row.maxRounds} verdict=${row.lastVerdict} stop=${row.stopReason || '-'}`,
        { chat_id: chat.id, workflow: row, replayed },
      );
    },
  },
]);
