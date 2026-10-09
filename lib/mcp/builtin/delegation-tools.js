/**
 * Builtin Cretli MCP plan and delegation tools.
 */

import { createHash } from 'node:crypto';
import { resolveCretliToolContext } from './tool-context.js';
import { requireClientChat, requireClientMethod } from './client-scope.js';
import { paginateList, paginateDetail } from './paging.js';
import { mcpToolResult, truncateText } from './result.js';
import { CretliMcpToolError, MCP_BUILTIN_ERROR_CODES } from './errors.js';
import { mcpBuiltinToolDescriptionCanonicalPrefix } from '../mcp-tool-names.js';
import { summarizeDelegation as summarizeDelegationQuery } from '../../delegation-query.js';
import {
  mapDelegationRoleToAssignment,
  parseDelegationVerdict,
  resolveDelegationRecordVerdict,
} from '../../delegation-verdict.js';
import { normalizeMcpChatScope } from './chat-scope.js';
import {
  MAX_DELEGATION_PICK_REASON_LENGTH,
  normalizeDelegationPickReason,
} from '../../delegation-request.js';
import {
  DELEGATION_RATING_MAX_SCORE,
  DELEGATION_RATING_MIN_SCORE,
  DELEGATION_RATING_TAGS,
  MAX_DELEGATION_RATING_NOTE_LENGTH,
} from '../../delegation-ratings.js';
import { isTerminalDelegationStatus } from '../../delegation-status.js';
import {
  buildDelegationLoopReport,
  formatDelegationLoopSummaryLine,
} from '../../delegation-loop-report.js';
import { loadDelegationWorkflows } from '../../persist/delegation-workflows-persist.js';
import { markDelegationReportReadByParent } from '../../delegation-report-context.js';
import { runReviewVerify } from '../../sdk/sdk-review-verify.js';
import { recordDelegationVerifyResult } from '../../delegation-service.js';
import {
  clampDelegationWaitTimeoutMs,
  isDelegationWaitSatisfied,
  isDelegationWaitSettled,
  DELEGATION_WAIT_FALLBACK_MS,
} from './delegation-wait.js';
import { waitForDelegationChange } from '../../delegation-change-signal.js';

/** Ack reasons the parent channel may set; mirrors the card's ack vocabulary. */
const DELEGATION_ACK_REASONS = Object.freeze(['reviewed', 'accepted']);

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
    pick_reason: query.pickReason || normalizeDelegationPickReason(row.pickReason),
    plan_revision: row.planRevision,
    unverified: row.unverified !== false,
    attempt_id: query.attemptId || row.attemptId || '',
    run_id: query.runId || row.runId || '',
    attempt_count: Array.isArray(row.attempts) ? row.attempts.length + 1 : 1,
    error: row.error || '',
    report_preview: report.text,
    truncated: report.truncated,
    task_outcome: query.taskOutcome || 'unspecified',
    interrupt_code: query.interruptCode || '',
    run_stopping: query.runStopping === true,
    slot_occupied: query.slotOccupied === true,
    verdict: resolveDelegationRecordVerdict(row),
    report_degraded: row.reportDegraded === true,
    report_summary: String(row.reportSummary || ''),
    verify_result: query.verifyResult,
    verify_required: row.verifyRequired === true,
    review_can_run_tests: row.reviewCanRunTests === true,
    review_can_run_tests_source: String(row.reviewCanRunTestsSource || ''),
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
    interrupt_code: summary.interrupt_code,
    verdict: summary.verdict,
    harness: summary.harness,
    model: summary.model,
    assignment: summary.assignment,
    error: summary.error,
  };
}

function formatWaitItemLine(item) {
  return `${item.id} status=${item.status} slot_occupied=${item.slot_occupied} run_stopping=${item.run_stopping} task_outcome=${item.task_outcome} interrupt_code=${item.interrupt_code || '-'} verdict=${item.verdict}`;
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
    description: 'Show delegation status and a paginated report or plan. Accepts a full UUID or a unique UUID prefix of at least 8 characters from the calling chat. Terminal statuses are completed, failed, cancelled, and interrupted — not finished. completed does not mean the slot is free or that the report is reviewed. Follow next_cursor; inbox previews omit the ending VERDICT.',
    inputSchema: {
      type: 'object',
      properties: {
        delegation_id: { type: 'string', description: 'Full UUID or unique prefix (at least 8 characters) in the calling chat.' },
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
      let row = await client.getDelegation({
        delegationId,
        workspaceFolder: ctx.workspaceFolder,
      });
      const canResolvePrefix = delegationId.length >= 8
        && /[0-9a-f]/i.test(delegationId)
        && /^[0-9a-f-]+$/i.test(delegationId)
        && ctx.chatId
        && typeof client.listDelegations === 'function';
      if (!row && canResolvePrefix) {
        const rows = await client.listDelegations({
          chatId: ctx.chatId,
          workspaceFolder: ctx.workspaceFolder,
        });
        const matches = rows.filter((item) => String(item.id || '').toLowerCase().startsWith(delegationId.toLowerCase()));
        if (matches.length > 1) {
          throw new CretliMcpToolError(
            MCP_BUILTIN_ERROR_CODES.CONFLICT,
            `Delegation prefix is ambiguous: ${delegationId}`,
          );
        }
        if (matches.length === 1) {
          row = await client.getDelegation({
            delegationId: matches[0].id,
            workspaceFolder: ctx.workspaceFolder,
          });
        }
      }
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
      // The first page puts the terminal report into the parent's context.
      // Record that as delivery so the queued mailbox final_report does not wake
      // the same parent with the same body again (a "re-delivery" run). It
      // changes only delivery bookkeeping, never the job state.
      if (
        field === 'report'
        && !String(args?.cursor || '').trim()
        && String(row.parentChatId || '') === String(ctx.chatId || '')
        && String(row.report || '').trim()
        && isTerminalDelegationStatus(row.status)
      ) {
        markDelegationReportReadByParent(row.id);
      }
      const summary = summarizeDelegation(row);
      const text = [
        `Delegation ${row.id} status=${row.status} task_outcome=${summary.task_outcome} slot_occupied=${summary.slot_occupied} run_stopping=${summary.run_stopping} interrupt_code=${summary.interrupt_code || '-'} verdict=${summary.verdict}${summary.report_degraded ? ' report_degraded=true' : ''}`,
        `attempt_id: ${summary.attempt_id || '-'} run_id: ${summary.run_id || '-'}`,
        summary.report_degraded && summary.report_summary ? `report_summary: ${summary.report_summary}` : '',
        `review_verify: ${summary.verify_result ? `${summary.verify_result.status} exit=${summary.verify_result.exitCode} verdict=${summary.verify_result.verdict || '-'} data_dir=${summary.verify_result.dataDir || '-'}` : 'not recorded'}${summary.verify_required ? ' (required: executor cannot run the runner)' : ''}`,
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
    name: 'delegation_verify',
    readOnly: false,
    description: 'Run the host-owned review-verify catalog for one of your delegation jobs and persist its hard result beside VERDICT. Use when the child reviewer cannot run tests (`review_can_run_tests=false` / `verify_required=true`); a PASS review without this evidence does not close the leaf. IDs are restricted to the audited catalog and new audited tests are picked up without a restart.',
    inputSchema: {
      type: 'object',
      properties: {
        delegation_id: { type: 'string' },
        ids: { type: 'array', items: { type: 'string' } },
      },
      required: ['delegation_id'],
    },
    async handler(args, { client, session }) {
      requireClientMethod(client, 'getDelegation');
      const ctx = resolveCretliToolContext(session);
      const id = String(args?.delegation_id || '').trim();
      const row = await client.getDelegation({ delegationId: id, workspaceFolder: ctx.workspaceFolder });
      if (!row) throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.NOT_FOUND, `Delegation not found: ${id}`);
      if (String(row.parentChatId || '') !== String(ctx.chatId || '')) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.OUT_OF_SCOPE, 'Only the parent chat may verify this delegation.');
      }
      // Tests run in the delegation's frozen execution folder, not in the
      // logical workspace that keys TODO/scope.
      const verifyRoot = String(row.executionFolder || '').trim() || ctx.workspaceFolder;
      const result = await runReviewVerify({ ids: Array.isArray(args?.ids) ? args.ids : [], projectRoot: verifyRoot });
      const verdict = resolveDelegationRecordVerdict(row);
      recordDelegationVerifyResult({
        delegationId: row.id,
        attemptId: row.attemptId,
        result,
        verdict,
        source: 'delegation_verify',
      });
      const verifyResult = {
        status: result.ok ? 'passed' : 'failed',
        exitCode: result.ok ? 0 : 1,
        verdict,
        source: 'delegation_verify',
        dataDir: result.dataDir || '',
      };
      return mcpToolResult(`review_verify=${verifyResult.status} exit=${verifyResult.exitCode} verdict=${verifyResult.verdict || '-'}\n${result.output || result.error || ''}`, { delegation_id: row.id, verify_result: verifyResult });
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
        // Block on the persist change signal instead of a 50 ms hot poll. The
        // wait wakes on any id's write, on the fallback re-check, or when the
        // remaining budget elapses; only then does it read the rows again.
        await waitForDelegationChange(ids, {
          signal,
          timeoutMs: remaining,
          fallbackMs: DELEGATION_WAIT_FALLBACK_MS,
        });
      }
    },
  },
  {
    name: 'delegation_start',
    readOnly: false,
    description: 'Start a Cretli child chat on another harness/model (DeepSeek, OpenCode, Qwen, Claude, Codex, OpenRouter, Mistral, CodeBuddy, or Cursor). Use this for a sub-chat or review when Cursor Task does not list that model. Source: saved plan, history message, or task_text. Call model_list(harness, enabled_only=true) first. The same gates as model_pick apply to a named model: a *flash* review and a premium review (tier 4+) without a pick_reason are refused unless confirm_flash_review / confirm_premium_review is set, and an uncertified review harness is refused. Does not switch Plan to Agent. Does not ack the report — use `delegation_ack` after reading it.',
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
        pick_reason: {
          type: 'string',
          maxLength: MAX_DELEGATION_PICK_REASON_LENGTH,
          description: 'Optional short justification of the model_pick that chose this executor (stored on the job and shown on the delegation card). Not part of the idempotency hash.',
        },
        pickReason: {
          type: 'string',
          maxLength: MAX_DELEGATION_PICK_REASON_LENGTH,
          description: 'Alias of pick_reason (camelCase accepted for API parity).',
        },
        pick_id: {
          type: 'string',
          description: 'Optional model_pick proposal id from model_pick (pickId). It must come from this chat/workspace and the executor must be one of its picks; each pick slot starts at most once. Needs idempotency_key. Invalid, expired, foreign or reused links are stored as unknown/rejected and never bypass start gates.',
        },
        pickId: { type: 'string', description: 'Alias of pick_id.' },
        manual_source: {
          type: 'string',
          description: 'Marks the executor as an explicit manual choice (origin=manual). Allowed values: manual, user, operator, ui, settings-ui, todo-assignee; any other value is rejected as unknown.',
        },
        pick_fallback_from: {
          type: 'string',
          description: 'Optional id of an earlier delegation of this chat (same leaf) that ran on a different executor; marks this start as its fallback with its own pick slot. Unverifiable values are rejected as unknown.',
        },
        idempotency_key: { type: 'string' },
        leaf_id: { type: 'string', description: 'Todo leaf id for per-leaf workflow caps (optional).' },
        todo_id: { type: 'string', description: 'Alias of leaf_id.' },
        resume_rounds: { type: 'boolean', description: 'Resume after soft round cap for this leaf.' },
        max_rounds: { type: 'number', description: 'Optional bump when resume_rounds is true.' },
        confirm_flash_review: {
          type: 'boolean',
          description: 'Explicitly accept a *flash* model for assignment=review. Flash ids are excluded from reviews by default because they time out; only set this when the user asked for that exact model.',
        },
        confirm_premium_review: {
          type: 'boolean',
          description: 'Explicitly start a premium cost-tier review (tier 4+) without a pick_reason. Prefer providing pick_reason instead.',
        },
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
      const pickReason = normalizeDelegationPickReason(args?.pick_reason ?? args?.pickReason);
      if (pickReason.length > MAX_DELEGATION_PICK_REASON_LENGTH) {
        throw new CretliMcpToolError(
          MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR,
          `pick_reason must be at most ${MAX_DELEGATION_PICK_REASON_LENGTH} characters`,
        );
      }
      const result = await client.startDelegation({
        chatId,
        workspaceFolder: ctx.workspaceFolder,
        planRevision: revision,
        harness,
        model,
        extraInstructions: args?.extra_instructions,
        pickReason,
        pickId: args?.pick_id ?? args?.pickId,
        manualSource: args?.manual_source,
        pickFallbackFrom: args?.pick_fallback_from,
        idempotencyKey,
        sourceKind,
        historySeq: hasMessage ? historySeq : undefined,
        contentHash: hasMessage || hasText ? contentHash : undefined,
        taskText: hasText ? taskText : undefined,
        executionMode: args?.execution_mode,
        assignment: mapDelegationRoleToAssignment(args?.assignment) || args?.assignment,
        requestedRole: args?.assignment,
        leafId: args?.leaf_id ?? args?.todo_id,
        resumeRounds: args?.resume_rounds,
        maxRounds: args?.max_rounds,
        allowFlashReview: args?.confirm_flash_review === true,
        allowPremium: args?.confirm_premium_review === true,
        returnWhenStarting: true,
      });
      throwIfFailed(result, 'Delegation failed');
      const row = result.delegation;
      const reviewUncertified = result.reviewUncertified === true;
      const warning = reviewUncertified
        ? '\nWARNING review_uncertified=true: this review started without a hard pre-exec or sandbox read-only guarantee (CRETLI_DELEGATION_REVIEW_ALLOW_UNCERTIFIED=1). Event abort is not a write block.'
        : '';
      const queued = result.queued === true;
      const queueNote = queued && result.queueConflict
        ? ` (queued: parent slot held by ${String(result.queueConflict.code || '')})`
        : '';
      return mcpToolResult(
        `${result.replayed ? 'Replayed' : 'Started'} delegation ${row.id} status=${row.status} child=${row.childChatId || '-'}${queueNote}${warning}`,
        {
          ...summarizeDelegation(row),
          replayed: result.replayed === true,
          review_uncertified: reviewUncertified,
          queued,
          queue_conflict: result.queueConflict || null,
        },
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
    name: 'delegation_rate',
    readOnly: false,
    description: 'Rate a finished delegation job as its parent chat (stars 1-5). Terminal jobs only; the calling session must be the job parent (a child chat is rejected) and a parent cannot rate a job on its own base model. Ratings are immutable per (job, rater): an identical replay succeeds, a changed payload is CONFLICT. Optional tags are telemetry only. Tag rubric: a critical tag (missed_bug, false_positive, scope_creep, too_slow) is only accepted at score 1-3, and `great` only at 4-5 — a review whose FAIL was real is score 5 with `caught_bug`, never `missed_bug`; a contradictory mix is rejected with `contradictory_rating`. Your own rating never enters model ranking: only `user` ratings raise observed model quality. The user rates from the delegation card (HTTP), not through this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        delegation_id: { type: 'string' },
        score: {
          type: 'number',
          description: `Integer ${DELEGATION_RATING_MIN_SCORE}..${DELEGATION_RATING_MAX_SCORE} (${DELEGATION_RATING_MAX_SCORE} = best).`,
        },
        tags: {
          type: 'array',
          items: { type: 'string', enum: [...DELEGATION_RATING_TAGS] },
          description: 'Optional allow-listed telemetry tags (max 5, de-duplicated). missed_bug/false_positive/scope_creep/too_slow require score 1-3; great requires score 4-5; a review that correctly caught a real bug is caught_bug.',
        },
        note: {
          type: 'string',
          maxLength: MAX_DELEGATION_RATING_NOTE_LENGTH,
          description: `Optional short note (max ${MAX_DELEGATION_RATING_NOTE_LENGTH} characters).`,
        },
      },
      required: ['delegation_id', 'score'],
    },
    async handler(args, { client, session }) {
      requireClientMethod(client, 'rateDelegation');
      const ctx = resolveCretliToolContext(session);
      const sessionChatId = String(ctx.chatId || '').trim();
      if (!sessionChatId) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'chat_id is required');
      }
      const chat = await requireClientChat(client, {
        chatId: sessionChatId,
        workspaceFolder: ctx.workspaceFolder,
        workspaceFile: ctx.workspaceFile,
      });
      if (String(chat.delegationParentChatId || '').trim()) {
        throw new CretliMcpToolError(
          MCP_BUILTIN_ERROR_CODES.CONFLICT,
          'Only the parent chat of a job can rate it.',
        );
      }
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
      if (String(row.parentChatId || '') !== chat.id) {
        throw new CretliMcpToolError(
          MCP_BUILTIN_ERROR_CODES.OUT_OF_SCOPE,
          'delegation_rate is limited to jobs started by this parent chat.',
        );
      }
      if (!isTerminalDelegationStatus(row.status)) {
        throw new CretliMcpToolError(
          MCP_BUILTIN_ERROR_CODES.CONFLICT,
          'Only a finished job can be rated.',
        );
      }
      const tags = Array.isArray(args?.tags) ? args.tags.map((tag) => String(tag ?? '')) : undefined;
      // The rater is fixed by this transport: never read it from the arguments.
      const result = await client.rateDelegation({
        delegationId,
        chatId: chat.id,
        workspaceFolder: ctx.workspaceFolder,
        score: args?.score,
        tags,
        note: args?.note,
      });
      throwIfFailed(result, 'Rating failed');
      const rating = result.rating || {};
      const replayed = result.replayed === true;
      const tagList = Array.isArray(rating.tags) && rating.tags.length > 0
        ? ` tags=${rating.tags.join(',')}`
        : '';
      return mcpToolResult(
        `${replayed ? 'Replayed' : 'Rated'} delegation ${delegationId} rater=parent score=${rating.score ?? ''}${tagList}`,
        {
          delegation_id: delegationId,
          rater: 'parent',
          score: rating.score ?? null,
          tags: Array.isArray(rating.tags) ? rating.tags : [],
          note: String(rating.note || ''),
          replayed,
        },
      );
    },
  },
  {
    name: 'delegation_ack',
    readOnly: false,
    description: 'Acknowledge a report you have read as its parent chat, clearing the `unverified` flag the terminal report carries. Terminal jobs only (`completed`, `failed`, `interrupted`); a running job is returned unchanged with `skipped: true`. The calling session must be the job parent (a child chat is rejected). `reason=reviewed` (default) only dismisses the card; `reason=accepted` is an explicit human acceptance of the cycle, recorded as `manualAccepted` on the quality cycle. Does not rate the job and does not start a child.',
    inputSchema: {
      type: 'object',
      properties: {
        delegation_id: { type: 'string' },
        reason: {
          type: 'string',
          enum: [...DELEGATION_ACK_REASONS],
          description: 'reviewed (default) = the parent read the report; accepted = the parent accepts the cycle.',
        },
      },
      required: ['delegation_id'],
    },
    async handler(args, { client, session }) {
      requireClientMethod(client, 'acknowledgeDelegation');
      const ctx = resolveCretliToolContext(session);
      const sessionChatId = String(ctx.chatId || '').trim();
      if (!sessionChatId) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'chat_id is required');
      }
      const chat = await requireClientChat(client, {
        chatId: sessionChatId,
        workspaceFolder: ctx.workspaceFolder,
        workspaceFile: ctx.workspaceFile,
      });
      if (String(chat.delegationParentChatId || '').trim()) {
        throw new CretliMcpToolError(
          MCP_BUILTIN_ERROR_CODES.CONFLICT,
          'Only the parent chat of a job can acknowledge it.',
        );
      }
      const delegationId = String(args?.delegation_id || '').trim();
      if (!delegationId) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'delegation_id is required');
      }
      const reason = String(args?.reason || 'reviewed').trim() || 'reviewed';
      if (!DELEGATION_ACK_REASONS.includes(reason)) {
        throw new CretliMcpToolError(
          MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR,
          `reason must be one of: ${DELEGATION_ACK_REASONS.join(', ')}.`,
        );
      }
      const row = await client.getDelegation({
        delegationId,
        workspaceFolder: ctx.workspaceFolder,
      });
      if (!row) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.NOT_FOUND, `Delegation not found: ${delegationId}`);
      }
      if (String(row.parentChatId || '') !== chat.id) {
        throw new CretliMcpToolError(
          MCP_BUILTIN_ERROR_CODES.OUT_OF_SCOPE,
          'delegation_ack is limited to jobs started by this parent chat.',
        );
      }
      // The rater rule of `delegation_rate` applies here too: this transport is
      // the parent channel, so `reason` never comes from a stored record.
      const result = await client.acknowledgeDelegation({
        delegationId,
        chatId: chat.id,
        workspaceFolder: ctx.workspaceFolder,
        reason,
      });
      throwIfFailed(result, 'Acknowledge failed');
      const next = result.delegation || row;
      const skipped = result.skipped === true;
      return mcpToolResult(
        `${skipped ? 'Ack skipped' : 'Acknowledged'} delegation ${delegationId} status=${next.status} reason=${next.acknowledgedReason || ''} unverified=${next.unverified !== false}`,
        {
          ...summarizeDelegation(next),
          acknowledged_reason: String(next.acknowledgedReason || ''),
          acknowledged_at: String(next.acknowledgedAt || ''),
          skipped,
        },
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
        // Paging the full body of a final_report is also a parent read: record
        // delivery so the queued push does not repeat the same report.
        if (
          !String(args?.cursor || '').trim()
          && String(row.kind || '') === 'reply'
          && String(row.replyKind || '') === 'final_report'
          && String(row.toChatId || '') === String(ctx.chatId || '')
          && String(chat.id || '') === String(ctx.chatId || '')
        ) {
          markDelegationReportReadByParent(row.delegationId);
        }
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
    name: 'workflow_show',
    readOnly: true,
    description: `${mcpBuiltinToolDescriptionCanonicalPrefix('workflow_show', 'delegation_workflow_show')}Show durable parent-loop state (role, round, implementer, verdict, stop reason, deadline). The parent still starts each child; this is not a server sequencer.`,
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Defaults to the calling chat.' },
        leaf_id: { type: 'string', description: 'Todo leaf id for per-leaf loop state (optional; chat-wide when omitted).' },
        todo_id: { type: 'string', description: 'Alias of leaf_id.' },
      },
    },
    async handler(args, { client, session }) {
      requireClientMethod(client, 'getDelegationWorkflow');
      const { ctx, chat } = await requireWorkflowParentChat(client, session, args?.chat_id);
      const leafId = args?.leaf_id ?? args?.todo_id;
      const row = await client.getDelegationWorkflow({
        chatId: chat.id,
        workspaceFolder: ctx.workspaceFolder,
        leafId,
      });
      if (!row) {
        return mcpToolResult('No workflow state for this chat.', { chat_id: chat.id, workflow: null, loop: [] });
      }
      /** @type {ReturnType<typeof buildDelegationLoopReport>} */
      let loopLeaves = [];
      let loopLine = '';
      if (typeof client.listDelegations === 'function') {
        try {
          const delegationRows = await client.listDelegations({
            chatId: chat.id,
            workspaceFolder: ctx.workspaceFolder,
          });
          loopLeaves = buildDelegationLoopReport({
            rows: Array.isArray(delegationRows) ? delegationRows : [],
            workflows: loadDelegationWorkflows(),
            parentChatId: chat.id,
            leafId: String(leafId || '').trim(),
          });
          loopLine = formatDelegationLoopSummaryLine(
            loopLeaves[0] || loopLeaves.find((entry) => String(entry.leafId || '') === String(row.leafId || '').trim()),
          );
        } catch {
          loopLeaves = [];
          loopLine = '';
        }
      }
      const text = [
        `workflow parent=${row.parentChatId} role=${row.role || '-'} round=${row.round}/${row.maxRounds}`,
        `verdict=${row.lastVerdict} stop=${row.stopReason || '-'} role_model=${row.lastModel || '-'} implementer=${row.lastImplementer || '-'} reviewer=${row.lastReviewer || '-'}`,
        `deadline=${row.deadlineAt || '-'} material=${row.materialRevision || '-'} same_fail=${row.consecutiveSameFail}`,
        `budget_tokens=${row.budgetTokens || '-'} budget_cost_usd=${row.budgetCostUsd || '-'}`,
        loopLine,
      ].filter(Boolean).join('\n');
      return mcpToolResult(text, { chat_id: chat.id, workflow: row, loop: loopLeaves });
    },
  },
  {
    name: 'workflow_update',
    readOnly: false,
    description: `${mcpBuiltinToolDescriptionCanonicalPrefix('workflow_update', 'delegation_workflow_update')}Write per-leaf parent-loop state so a restart does not reset rounds. Optional deadline/max_rounds/budget_tokens/budget_cost_usd/material_revision. resume_rounds lifts the soft round gate (bump max_rounds or grant one cycle automatically). Cost/token budgets are enforced only when the usage ledger measured spend at/above the cap. Pass idempotency_key per review event; replaying any previously applied key with the same params is a no-op, the same key with different params is CONFLICT. A second distinct identical FAIL with material unchanged since the last FAIL review sets stop_reason=same_findings. Does not start a child.`,
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        leaf_id: { type: 'string', description: 'Todo leaf id for per-leaf loop state (optional; chat-wide when omitted).' },
        todo_id: { type: 'string', description: 'Alias of leaf_id.' },
        role: { type: 'string' },
        resume_rounds: { type: 'boolean', description: 'Clear soft round cap and continue after workflow_rounds_exhausted.' },
        round: { type: 'number' },
        max_rounds: { type: 'number' },
        last_implementer: { type: 'string' },
        last_model: { type: 'string', description: 'Model used for the current or most recently recorded workflow role.' },
        last_reviewer: { type: 'string' },
        findings_text: { type: 'string', description: 'Review findings to feed the fix-loop [REGRESSION GATE] for the next review. When omitted on a FAIL, findings are derived from report_text so the gate and same_findings still work.' },
        findings_hash: { type: 'string' },
        last_verdict: { type: 'string' },
        report_text: { type: 'string', description: 'Full child report. On a FAIL it is the fallback source of findings for the [REGRESSION GATE] and same_findings when findings_text is not passed.' },
        fanout_verdicts: { type: 'array', items: { type: 'string' } },
        stop_reason: { type: 'string' },
        clear_stop: { type: 'boolean' },
        deadline_at: { type: 'string', description: 'Per-leaf time budget (ISO-8601). Past deadline blocks starts and requests cancel for that leaf only.' },
        budget_tokens: { type: 'number', description: 'Per-leaf token budget. Enforced only when the usage ledger measured spend at/above the cap.' },
        budget_cost_usd: { type: 'number', description: 'Per-leaf USD budget. Enforced only when the usage ledger measured spend at/above the cap.' },
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
        leafId: args?.leaf_id ?? args?.todo_id,
        role: args?.role,
        resumeRounds: args?.resume_rounds,
        round: args?.round,
        maxRounds: args?.max_rounds,
        lastImplementer: args?.last_implementer,
        lastModel: args?.last_model,
        lastReviewer: args?.last_reviewer,
        findingsText: args?.findings_text,
        findingsHash: args?.findings_hash,
        lastVerdict: args?.last_verdict,
        reportText: args?.report_text,
        fanoutVerdicts: args?.fanout_verdicts,
        stopReason: args?.stop_reason,
        clearStop: args?.clear_stop === true,
        deadlineAt: args?.deadline_at,
        budgetTokens: args?.budget_tokens,
        budgetCostUsd: args?.budget_cost_usd,
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
