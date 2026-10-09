/**
 * In-process chat/MCP facade for the builtin Cretli MCP server.
 */

import path from 'path';
import { loadChats, updateChat, deleteChat } from '../persist/chats-persist.js';
import '../chat-archive-guard.js';
import { applyAgentTitle } from '../chat-title-agent.js';
import { getChatTitleHistory } from '../persist/chat-title-history-persist.js';
import { readChatHistoryFromHttpQuery } from '../persist/chat-history-persist.js';
import { loadMcpDocument } from '../persist/mcp-persist.js';
import {
  addTodo,
  getTodoById,
  loadTodosData,
  updateTodo,
} from '../persist/todos-persist.js';
import { buildTodoChatIndex, enrichTodoItemsWithSourceChat } from '../todo-source-chat.js';
import {
  applyWorkspaceWatcherPatch,
  archiveWorkspaceWatcherScoutProfile,
  claimNextWorkspaceWatcherTodo,
  createWorkspaceWatcherScoutProfile,
  createWorkspaceWatcherScoutProfileFromTemplate,
  duplicateWorkspaceWatcherScoutProfile,
  getWorkspaceWatcherScoutHistory,
  getWorkspaceWatcherScoutProfile,
  getWorkspaceWatcherView,
  listWorkspaceWatcherScoutProfiles,
  listWorkspaceWatcherScoutTemplates,
  previewWorkspaceWatcherScoutProfile,
  previewWorkspaceWatcherScoutProfileDraft,
  previewWorkspaceWatcherScoutRestoreDiff,
  recordWorkspaceWatcherFindings,
  reportWorkspaceWatcherCycle,
  resetWorkspaceWatcherPlanRequests,
  restoreWorkspaceWatcherScoutProfileFromTemplate,
  runWorkspaceWatcherCycleNow,
  runWorkspaceWatcherScoutFindings,
  runWorkspaceWatcherScoutNow,
  runWorkspaceWatcherTick,
  recoverWorkspaceWatcherTodoForOperator,
  saveWorkspaceWatcherTodoPlanDraft,
  updateWorkspaceWatcherScoutProfile,
} from '../workspace-watcher-control.js';
import { getActiveScoutScanByChatId, getWorkspaceWatcher } from '../persist/workspace-watchers-persist.js';
import { isScoutReadOnlyChat } from '../workspace-scout-chat.js';
import { readChatPlanDocument } from '../chat-plan-persist.js';
import { createDelegationService } from '../delegation-service.js';
import { getDelegationById, listDelegationsForChat } from '../persist/delegations-persist.js';
import { listChatMailbox, sendDelegationReply } from '../delegation-mailbox.js';
import {
  applyDelegationWorkflowPatch,
  getDelegationWorkflow,
  resolveDelegationWorkflowRow,
} from '../delegation-workflow.js';
import { loadAgents } from '../agents.js';
import { resolveDataPath } from '../runtime-paths.js';
import { normalizeMcpServers, resolveMcpServersForContext, toMcpRuntimeName } from './mcp-config.js';
import { listMcpSecretKeys } from './mcp-secrets.js';
import { listMcpStatuses } from './mcp-status.js';
import { getBuiltinMcpRuntimeDeps } from './builtin/runtime-deps.js';
import { isChatInWorkspace } from './builtin/tool-context.js';
import { CretliMcpToolError, MCP_BUILTIN_ERROR_CODES } from './builtin/errors.js';
import { listHarnessCatalog, listHarnessModelsIncludingLocal } from '../harness-catalog.js';

function dataDir() {
  return getBuiltinMcpRuntimeDeps().dataDir || resolveDataPath();
}

function todoChatIndex(workspaceFolder, workspaceFile) {
  return buildTodoChatIndex(loadChats(), { workspaceFolder, workspaceFile });
}

function sameFolder(left, right) {
  const a = String(left || '').trim();
  const b = String(right || '').trim();
  if (!a || !b) return false;
  return path.resolve(a) === path.resolve(b);
}

function assertChatInWorkspace(chat, workspaceFolder, workspaceFile) {
  const folder = String(workspaceFolder || '').trim();
  if (!folder) return chat;
  if (!chat) return null;
  if (!isChatInWorkspace(chat, folder, workspaceFile)) {
    throw new CretliMcpToolError(
      MCP_BUILTIN_ERROR_CODES.OUT_OF_SCOPE,
      'This chat is outside the current workspace.',
    );
  }
  return chat;
}

function findChatById(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return null;
  return loadChats().find((row) => row.id === id) || null;
}

/**
 * Workflow writes use the in-process session chat, not a model-supplied id.
 *
 * @param {object} context
 * @param {unknown} requestedChatId
 * @param {unknown} workspaceFolder
 * @returns {object}
 */
function assertWorkflowParentWrite(context, requestedChatId, workspaceFolder) {
  const sessionChatId = String(context?.chatId || '').trim();
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
  const chat = assertChatInWorkspace(findChatById(sessionChatId), workspaceFolder);
  if (!chat) {
    throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.NOT_FOUND, 'Chat not found');
  }
  if (String(chat.delegationParentChatId || '').trim()) {
    throw new CretliMcpToolError(
      MCP_BUILTIN_ERROR_CODES.CONFLICT,
      'Only the parent chat of this session can update workflow state.',
    );
  }
  return chat;
}

function delegationService() {
  const deps = getBuiltinMcpRuntimeDeps();
  return createDelegationService({
    dataDir: dataDir(),
    workspaceDirForAgent: (workspacePath) => {
      if (!workspacePath || typeof deps.workspaceDirForAgent !== 'function') return '';
      return deps.workspaceDirForAgent(workspacePath) || '';
    },
  });
}

/**
 * Parent-channel writes on a finished job (rating, acknowledgement): the
 * in-process session chat must be the caller and it must not be a child chat.
 * Mirrors `assertWorkflowParentWrite`.
 *
 * @param {object} context
 * @param {unknown} requestedChatId
 * @param {unknown} workspaceFolder
 * @param {string} toolName Tool named in the rejection messages.
 * @returns {object}
 */
function assertRatingParentChat(context, requestedChatId, workspaceFolder, toolName = 'delegation_rate') {
  const sessionChatId = String(context?.chatId || '').trim();
  if (!sessionChatId) {
    throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'chat_id is required');
  }
  const requested = String(requestedChatId || '').trim();
  if (requested && requested !== sessionChatId) {
    throw new CretliMcpToolError(
      MCP_BUILTIN_ERROR_CODES.CONFLICT,
      `${toolName} applies only to the calling parent chat.`,
    );
  }
  const chat = assertChatInWorkspace(findChatById(sessionChatId), workspaceFolder);
  if (!chat) {
    throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.NOT_FOUND, 'Chat not found');
  }
  if (String(chat.delegationParentChatId || '').trim()) {
    throw new CretliMcpToolError(
      MCP_BUILTIN_ERROR_CODES.CONFLICT,
      `Only the parent chat of a job can use ${toolName}.`,
    );
  }
  return chat;
}

/**
 * @param {object} context
 */
export function createInProcessMcpClient(context) {
  return {
    __inProcess: true,
    /**
     * Host-owned identity of a read-only Scout chat. The builtin tool catalog
     * uses this (never a model argument) to apply the Scout read-only policy
     * before a handler runs, even though Scout transports in agent mode.
     *
     * @returns {boolean}
     */
    isWorkspaceScoutChat() {
      return isScoutReadOnlyChat(findChatById(context?.chatId));
    },
    async listChats({ includeArchived } = {}) {
      const chats = loadChats();
      if (includeArchived === true) return chats;
      return chats.filter((chat) => !chat.archivedAt);
    },
    async getChat({ chatId, workspaceFolder, workspaceFile, skipWorkspace } = {}) {
      const chat = findChatById(chatId);
      if (skipWorkspace === true) return chat;
      return assertChatInWorkspace(chat, workspaceFolder, workspaceFile);
    },
    async getChatHistory(chatId, options = {}) {
      return readChatHistoryFromHttpQuery(chatId, {
        tail: options.tail,
        before: options.before || options.beforeSeq,
        since: options.since,
        limit: options.limit,
        seq: options.seq,
      });
    },
    async archiveChat(chatId, archived) {
      return updateChat(chatId, { archived: archived === true });
    },
    async getChatTitleHistory(chatId) {
      return getChatTitleHistory(chatId);
    },
    async renameChat(chatId, title) {
      return updateChat(chatId, { title: String(title || '').trim() });
    },
    async setAgentTitle(chatId, title) {
      return applyAgentTitle(chatId, title);
    },
    async deleteChat(chatId) {
      deleteChat(chatId);
      return { ok: true };
    },
    async listMcpIntegrations() {
      const document = loadMcpDocument();
      const servers = normalizeMcpServers(document.servers);
      const resolved = new Set(resolveMcpServersForContext(context, servers).map((row) => row.id));
      return servers.map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind,
        enabled: row.enabled,
        scope: row.scope,
        harnesses: row.harnesses,
        runtimeName: toMcpRuntimeName(row.id),
        secretKeys: listMcpSecretKeys(row.id),
        activeInContext: resolved.has(row.id),
      }));
    },
    async getMcpStatus() {
      return listMcpStatuses({
        harness: context?.harness,
        sessionId: context?.sessionId,
        workspaceKey: context?.workspaceId || context?.workspaceFolder || context?.workspaceFile,
      });
    },
    async listTodos({ workspaceFolder, workspaceFile } = {}) {
      const data = loadTodosData(dataDir(), workspaceFolder);
      return enrichTodoItemsWithSourceChat(
        data.items || [],
        todoChatIndex(workspaceFolder, workspaceFile),
        workspaceFolder,
      );
    },
    async getTodo({ workspaceFolder, workspaceFile, todoId } = {}) {
      const item = getTodoById(dataDir(), workspaceFolder, todoId);
      if (!item) return null;
      const [enriched] = enrichTodoItemsWithSourceChat(
        [item],
        todoChatIndex(workspaceFolder, workspaceFile),
        workspaceFolder,
      );
      return enriched || item;
    },
    async createTodo({ workspaceFolder, title, body, status, idempotencyKey, parentId, siblingIndex, assignee, runMode, executionMode, orchestratorChatId, createdByChatId, sourceHarness } = {}) {
      return addTodo(dataDir(), workspaceFolder, {
        title,
        body,
        status,
        idempotencyKey,
        strictStatus: true,
        parentId,
        siblingIndex,
        assignee,
        runMode,
        executionMode,
        orchestratorChatId,
        createdByChatId,
        sourceHarness,
      });
    },
    async updateTodo({ workspaceFolder, todoId, expectedUpdatedAt, title, body, status, parentId, siblingIndex, assignee, runMode, executionMode, orchestratorChatId, linkedChatId, appendChangelog, plan } = {}) {
      const doc = updateTodo(dataDir(), workspaceFolder, todoId, {
        title,
        body,
        status,
        expectedUpdatedAt,
        strictStatus: true,
        parentId,
        siblingIndex,
        assignee,
        runMode,
        executionMode,
        orchestratorChatId,
        linkedChatId,
        appendChangelog,
        plan: plan && typeof plan === 'object'
          ? {
            markdown: plan.markdown,
            sourceChatId: plan.sourceChatId,
          }
          : undefined,
      });
      const item = doc.items.find((row) => row.id === todoId) || null;
      if (item && (body != null || (plan && plan.markdown != null))) {
        const { scheduleWorkspaceWatcherAutopilot } = await import('../workspace-watcher-event-schedule.js');
        scheduleWorkspaceWatcherAutopilot({ workspaceFolder, dataDir: dataDir() });
      }
      return item;
    },
    async getChatPlan({ chatId, workspaceFolder } = {}) {
      const chat = assertChatInWorkspace(findChatById(chatId), workspaceFolder);
      if (!chat) return null;
      return readChatPlanDocument({ cwd: workspaceFolder, chatId: chat.id });
    },
    async listDelegations({ chatId, workspaceFolder, skipWorkspace } = {}) {
      const found = findChatById(chatId);
      const chat = skipWorkspace === true ? found : assertChatInWorkspace(found, workspaceFolder);
      if (!chat) return [];
      return listDelegationsForChat(chat.id);
    },
    async getDelegation({ delegationId, workspaceFolder } = {}) {
      const row = getDelegationById(delegationId);
      if (!row) return null;
      const parent = findChatById(row.parentChatId);
      if (!parent) return null;
      assertChatInWorkspace(parent, workspaceFolder);
      return row;
    },
    async startDelegation({
      chatId,
      workspaceFolder,
      planRevision,
      harness,
      model,
      extraInstructions,
      pickReason,
      pickId,
      pick_id,
      manualSource,
      manual_source,
      pickFallbackFrom,
      pick_fallback_from,
      idempotencyKey,
      sourceKind,
      historySeq,
      contentHash,
      taskText,
      executionMode,
      assignment,
      requestedRole,
      requested_role,
      leafId,
      resumeRounds,
      maxRounds,
      returnWhenStarting,
      allowFlashReview,
      allowHighInfra,
      allowPremium,
    } = {}) {
      const chat = assertChatInWorkspace(findChatById(chatId), workspaceFolder);
      if (!chat) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.NOT_FOUND, 'Chat not found');
      }
      return delegationService().createAndStart({
        parentChatId: chat.id,
        executor: { transport: harness, model },
        planRevision,
        idempotencyKey,
        extraInstructions,
        pickReason,
        pickId: pickId ?? pick_id,
        manualSource: manualSource ?? manual_source,
        pickFallbackFrom: pickFallbackFrom ?? pick_fallback_from,
        sourceKind,
        historySeq,
        contentHash,
        taskText,
        executionMode,
        assignment,
        requestedRole: requestedRole ?? requested_role,
        leafId,
        resumeRounds,
        maxRounds,
        returnWhenStarting,
        allowFlashReview,
        allowHighInfra,
        allowPremium,
      });
    },
    async replyDelegation({
      chatId,
      workspaceFolder,
      body,
      historySeq,
      contentHash,
      idempotencyKey,
      delegationId,
      replyKind,
      attemptId,
      runId,
      sessionAttemptId,
      sessionRunId,
      taskOutcome,
    } = {}) {
      const chat = assertChatInWorkspace(findChatById(chatId), workspaceFolder);
      if (!chat) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.NOT_FOUND, 'Chat not found');
      }
      return sendDelegationReply({
        fromChatId: chat.id,
        body,
        historySeq,
        contentHash,
        idempotencyKey,
        delegationId,
        replyKind,
        attemptId,
        runId,
        sessionAttemptId,
        sessionRunId,
        taskOutcome,
      });
    },
    async listMailbox({ chatId, workspaceFolder, skipWorkspace } = {}) {
      const found = findChatById(chatId);
      const chat = skipWorkspace === true ? found : assertChatInWorkspace(found, workspaceFolder);
      if (!chat) return [];
      return listChatMailbox(chat.id);
    },
    async cancelDelegation({ delegationId, workspaceFolder } = {}) {
      const row = getDelegationById(delegationId);
      if (!row) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.NOT_FOUND, 'Delegation not found');
      }
      const parent = findChatById(row.parentChatId);
      if (!parent) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.NOT_FOUND, 'Delegation not found');
      }
      assertChatInWorkspace(parent, workspaceFolder);
      return delegationService().cancel(delegationId);
    },
    /**
     * Parent-channel rating. The `parent` rater is hard-coded here — this
     * method is only reachable from the MCP tool, and no caller-supplied field
     * can select another rater (the user channel is the HTTP card route).
     *
     * @param {{ chatId?: string, delegationId?: string, workspaceFolder?: string,
     *   score?: unknown, tags?: unknown, note?: unknown }} input
     */
    async rateDelegation({
      chatId,
      delegationId,
      workspaceFolder,
      score,
      tags,
      note,
    } = {}) {
      const chat = assertRatingParentChat(context, chatId, workspaceFolder);
      const id = String(delegationId || '').trim();
      if (!id) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'delegation_id is required');
      }
      const row = getDelegationById(id);
      if (!row) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.NOT_FOUND, 'Delegation not found');
      }
      const parent = findChatById(row.parentChatId);
      if (!parent) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.NOT_FOUND, 'Delegation not found');
      }
      assertChatInWorkspace(parent, workspaceFolder);
      if (String(row.parentChatId || '') !== chat.id) {
        throw new CretliMcpToolError(
          MCP_BUILTIN_ERROR_CODES.OUT_OF_SCOPE,
          'delegation_rate is limited to jobs started by this parent chat.',
        );
      }
      return delegationService().rate(id, { rater: 'parent', score, tags, note });
    },
    /**
     * Parent-channel acknowledgement. Clears `unverified` on a terminal job and
     * stores `acknowledgedAt`/`acknowledgedReason`; a non-terminal job is
     * returned unchanged with `skipped: true` (same rule as the card's ack).
     *
     * @param {{ chatId?: string, delegationId?: string, workspaceFolder?: string,
     *   reason?: unknown }} input
     */
    async acknowledgeDelegation({
      chatId,
      delegationId,
      workspaceFolder,
      reason,
    } = {}) {
      const chat = assertRatingParentChat(
        context,
        chatId,
        workspaceFolder,
        'delegation_ack',
      );
      const id = String(delegationId || '').trim();
      if (!id) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'delegation_id is required');
      }
      const row = getDelegationById(id);
      if (!row) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.NOT_FOUND, 'Delegation not found');
      }
      const parent = findChatById(row.parentChatId);
      if (!parent) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.NOT_FOUND, 'Delegation not found');
      }
      assertChatInWorkspace(parent, workspaceFolder);
      if (String(row.parentChatId || '') !== chat.id) {
        throw new CretliMcpToolError(
          MCP_BUILTIN_ERROR_CODES.OUT_OF_SCOPE,
          'delegation_ack is limited to jobs started by this parent chat.',
        );
      }
      return delegationService().acknowledge(id, { reason });
    },
    async getDelegationWorkflow({ chatId, workspaceFolder, leafId } = {}) {
      const chat = assertChatInWorkspace(findChatById(chatId), workspaceFolder);
      if (!chat) return null;
      return resolveDelegationWorkflowRow({ parentChatId: chat.id, leafId });
    },
    async updateDelegationWorkflow({
      chatId,
      workspaceFolder,
      role,
      round,
      maxRounds,
      lastImplementer,
      lastModel,
      lastReviewer,
      findingsText,
      findingsHash,
      lastVerdict,
      reportText,
      fanoutVerdicts,
      stopReason,
      clearStop,
      deadlineAt,
      budgetTokens,
      budgetCostUsd,
      materialRevision,
      idempotencyKey,
      leafId,
      resumeRounds,
    } = {}) {
      const chat = assertWorkflowParentWrite(context, chatId, workspaceFolder);
      try {
        const workflow = applyDelegationWorkflowPatch({
          parentChatId: chat.id,
          leafId,
          workspaceFolder: workspaceFolder || chat.workspaceFolder,
          role,
          resumeRounds,
          round,
          maxRounds,
          lastImplementer,
          lastModel,
          lastReviewer,
          findingsText,
          findingsHash,
          lastVerdict,
          reportText,
          fanoutVerdicts,
          stopReason,
          clearStop,
          deadlineAt,
          budgetTokens,
          budgetCostUsd,
          materialRevision,
          idempotencyKey,
        });
        return { ok: true, workflow, replayed: workflow.replayed === true };
      } catch (err) {
        return {
          ok: false,
          status: Number(err?.status) || 409,
          error: err instanceof Error ? err.message : String(err),
          code: err?.code || 'idempotency_conflict',
        };
      }
    },
    async listWorkspaceTasks({ workspaceFolder, workspaceFile } = {}) {
      const loaded = getBuiltinMcpRuntimeDeps().loadTasksForWorkspace({
        workspaceFolder,
        workspaceFile,
      });
      return loaded || { tasks: [] };
    },
    async listTaskRuns({ workspaceFolder } = {}) {
      return [...getBuiltinMcpRuntimeDeps().taskRuns.entries()]
        .filter(([, run]) => sameFolder(run?.cwd, workspaceFolder))
        .map(([runId, run]) => ({ runId, taskLabel: run.taskLabel, cwd: run.cwd }));
    },
    async listWorkspaceAgents({ workspaceFolder } = {}) {
      return loadAgents(workspaceFolder);
    },
    async listAgentRuns({ workspaceFolder } = {}) {
      return [...getBuiltinMcpRuntimeDeps().agentRuns.entries()]
        .filter(([, run]) => sameFolder(run?.cwd, workspaceFolder))
        .map(([runId, run]) => ({ runId, agentName: run.agentName, cwd: run.cwd }));
    },
    async listHarnessCatalog() {
      return listHarnessCatalog();
    },
    async listHarnessModels(input = {}) {
      return listHarnessModelsIncludingLocal(input);
    },
    async workspaceWatcherShow({ workspaceFolder } = {}) {
      return getWorkspaceWatcherView({ dataDir: dataDir(), workspaceFolder });
    },
    async workspaceWatcherUpdate(input = {}) {
      const dir = dataDir();
      const workspaceFolder = String(input.workspaceFolder || '').trim();
      const action = String(input.action || 'configure').trim().toLowerCase();
      if (action === 'tick') {
        const result = await runWorkspaceWatcherTick({ dataDir: dir, workspaceFolder });
        return { ok: true, action, ...result, view: getWorkspaceWatcherView({ dataDir: dir, workspaceFolder }) };
      }
      if (action === 'run_cycle') {
        const result = await runWorkspaceWatcherCycleNow({ dataDir: dir, workspaceFolder });
        return { ok: true, action, ...result, view: getWorkspaceWatcherView({ dataDir: dir, workspaceFolder }) };
      }
      if (action === 'claim_next') {
        const result = claimNextWorkspaceWatcherTodo({
          dataDir: dir,
          workspaceFolder,
          claimedByChatId: input.claimedByChatId,
          ttlMs: input.ttlMs,
        });
        return { ok: true, action, ...result };
      }
      if (action === 'reset_plan_requests') {
        const result = resetWorkspaceWatcherPlanRequests({ dataDir: dir, workspaceFolder, todoId: input.todoId });
        return { ok: true, action, ...result };
      }
      if (action === 'record_findings') {
        const result = recordWorkspaceWatcherFindings({
          dataDir: dir,
          workspaceFolder,
          hash: input.findingsHash,
          todoId: input.todoId,
          findingsText: input.findingsText,
        });
        return { ok: true, action, ...result };
      }
      if (action === 'report') {
        const result = reportWorkspaceWatcherCycle({
          dataDir: dir,
          workspaceFolder,
          sourceChatId: input.sourceChatId,
          outcome: input.outcome,
          todoIds: input.todoIds,
          cycleId: input.cycleId,
          reportId: input.reportId,
          message: input.message,
        });
        return {
          ok: result.ok !== false,
          action,
          ...result,
          view: getWorkspaceWatcherView({ dataDir: dir, workspaceFolder }),
        };
      }
      if (action === 'save_plan') {
        const result = saveWorkspaceWatcherTodoPlanDraft({
          dataDir: dir,
          workspaceFolder,
          todoId: input.todoId,
          expectedUpdatedAt: input.expectedUpdatedAt,
          planMarkdown: input.planMarkdown,
          sourceChatId: input.sourceChatId,
        });
        return {
          ok: true,
          action,
          item: result.item,
          view: getWorkspaceWatcherView({ dataDir: dir, workspaceFolder }),
        };
      }
      if (action === 'recover_todo') {
        const todoId = String(input.todoId || input.todo_id || '').trim();
        const expectedUpdatedAt = String(
          input.expectedUpdatedAt || input.expected_updated_at || '',
        ).trim();
        if (!todoId || !expectedUpdatedAt) {
          return {
            ok: false,
            action,
            outcome: 'api-error',
            error: {
              code: 'VALIDATION',
              message: 'recover_todo requires todo_id and expected_updated_at',
            },
          };
        }
        const result = recoverWorkspaceWatcherTodoForOperator({
          dataDir: dir,
          workspaceFolder,
          todoId,
          expectedUpdatedAt,
          idempotencyKey: String(input.idempotencyKey || input.idempotency_key || '').trim() || undefined,
        });
        return {
          ok: result.ok === true,
          action,
          ...result,
        };
      }
      const watcher = applyWorkspaceWatcherPatch({
        dataDir: dir,
        workspaceFolder,
        patch: {
          mode: input.mode,
          enabled: input.enabled,
          paused: input.paused,
          stopReason: input.stopReason,
          policy: input.policy,
        },
      });
      return {
        ok: true,
        action: 'configure',
        watcher,
        view: getWorkspaceWatcherView({ dataDir: dir, workspaceFolder }),
      };
    },
    async workspaceWatcherScout(input = {}) {
      const dir = dataDir();
      const workspaceFolder = String(input.workspaceFolder || '').trim();
      const action = String(input.action || 'list').trim().toLowerCase() || 'list';
      if (action === 'run') {
        const result = await runWorkspaceWatcherScoutNow({
          dataDir: dir,
          workspaceFolder,
          scoutId: String(input.scoutId || input.scout_id || '').trim() || undefined,
        });
        return { ok: result.ok !== false, action, ...result };
      }
      let scoutSubmitToken = String(input.scoutSubmitToken || input.submitToken || '').trim();
      let scanId = String(input.scanId || input.scan_id || '').trim();
      const sourceChatId = String(input.sourceChatId || '').trim();
      if (action === 'submit' && sourceChatId && (!scoutSubmitToken || !scanId)) {
        const row = getWorkspaceWatcher(workspaceFolder, { dataDir: dir });
        const active = getActiveScoutScanByChatId(row, sourceChatId);
        // The calling chat's identity is the real authenticator; fill any
        // credential the model omitted from the recommended submit shape so a
        // normal tool call succeeds. A foreign chat never matches, so nothing
        // leaks: only the active Scout chat gets its own credentials.
        if (active?.chatId === sourceChatId) {
          if (!scoutSubmitToken) scoutSubmitToken = active.submitToken;
          if (!scanId) scanId = active.scanId;
        }
      }
      return runWorkspaceWatcherScoutFindings({
        dataDir: dir,
        workspaceFolder,
        action,
        ids: Array.isArray(input.ids) ? input.ids : input.id ? [input.id] : [],
        id: input.id,
        findings: Array.isArray(input.findings) ? input.findings : undefined,
        text: input.text,
        status: input.status,
        category: input.category,
        scoutId: input.scoutId || input.scout_id,
        max: input.max,
        sourceChatId,
        scanId,
        scoutSubmitToken,
      });
    },
    /**
     * Scout profile configuration surface (stage 4a). Thin dispatch over the
     * shared control wrappers; errors carry the same VALIDATION/CONFLICT/
     * NOT_FOUND codes as REST.
     *
     * @param {object} [input]
     * @returns {Promise<object>}
     */
    async workspaceWatcherScoutProfiles(input = {}) {
      const dir = dataDir();
      const workspaceFolder = String(input.workspaceFolder || '').trim();
      const action = String(input.action || 'list').trim().toLowerCase() || 'list';
      const scoutId = String(input.scoutId || input.scout_id || '').trim();
      if (action === 'list') {
        return { ok: true, action, ...listWorkspaceWatcherScoutProfiles({ dataDir: dir, workspaceFolder }) };
      }
      if (action === 'get') {
        return { ok: true, action, ...getWorkspaceWatcherScoutProfile({ dataDir: dir, workspaceFolder, scoutId }) };
      }
      if (action === 'create') {
        return {
          ok: true,
          action,
          ...createWorkspaceWatcherScoutProfile({ dataDir: dir, workspaceFolder, profile: input.profile }),
        };
      }
      if (action === 'update') {
        return {
          ok: true,
          action,
          ...updateWorkspaceWatcherScoutProfile({
            dataDir: dir,
            workspaceFolder,
            scoutId,
            profile: input.profile,
            expectedRevision: input.expectedRevision ?? input.expected_revision,
          }),
        };
      }
      if (action === 'duplicate') {
        return {
          ok: true,
          action,
          ...duplicateWorkspaceWatcherScoutProfile({ dataDir: dir, workspaceFolder, scoutId }),
        };
      }
      if (action === 'archive') {
        return {
          ok: true,
          action,
          ...archiveWorkspaceWatcherScoutProfile({ dataDir: dir, workspaceFolder, scoutId }),
        };
      }
      if (action === 'preview') {
        return {
          ok: true,
          action,
          ...previewWorkspaceWatcherScoutProfile({ dataDir: dir, workspaceFolder, scoutId }),
        };
      }
      if (action === 'history') {
        return {
          ok: true,
          action,
          ...getWorkspaceWatcherScoutHistory({
            dataDir: dir,
            workspaceFolder,
            scoutId: scoutId || undefined,
            max: input.max,
          }),
        };
      }
      if (action === 'run') {
        if (!scoutId) {
          const error = new Error('scoutId is required for run');
          error.code = 'VALIDATION';
          throw error;
        }
        const result = await runWorkspaceWatcherScoutNow({ dataDir: dir, workspaceFolder, scoutId });
        return { ok: result.ok !== false, action, ...result };
      }
      if (action === 'templates') {
        return {
          ok: true,
          action,
          ...listWorkspaceWatcherScoutTemplates({ workspaceFolder }),
        };
      }
      if (action === 'from_template') {
        return {
          ok: true,
          action,
          ...createWorkspaceWatcherScoutProfileFromTemplate({
            dataDir: dir,
            workspaceFolder,
            templateId: input.templateId || input.template_id,
            overrides: input.overrides,
          }),
        };
      }
      if (action === 'restore_preview') {
        return {
          ok: true,
          action,
          ...previewWorkspaceWatcherScoutRestoreDiff({
            dataDir: dir,
            workspaceFolder,
            scoutId,
            templateId: input.templateId || input.template_id,
          }),
        };
      }
      if (action === 'restore') {
        return {
          ok: true,
          action,
          ...restoreWorkspaceWatcherScoutProfileFromTemplate({
            dataDir: dir,
            workspaceFolder,
            scoutId,
            expectedRevision: input.expectedRevision ?? input.expected_revision,
            confirm: input.confirm === true,
            templateId: input.templateId || input.template_id,
          }),
        };
      }
      if (action === 'preview_draft') {
        return {
          ok: true,
          action,
          ...previewWorkspaceWatcherScoutProfileDraft({
            dataDir: dir,
            workspaceFolder,
            profile: input.profile,
          }),
        };
      }
      const error = new Error(`action must be one of: list, get, create, update, duplicate, archive, preview, history, run, templates, from_template, restore_preview, restore, preview_draft`);
      error.code = 'VALIDATION';
      throw error;
    },
  };
}
