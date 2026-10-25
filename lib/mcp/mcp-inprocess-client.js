import { assertNoTakeoverInProgress, loadDelegationTakeovers } from '../persist/delegation-takeovers-persist.js';
/**
 * In-process chat/MCP facade for the builtin Cretli MCP server.
 */

import { canChatControlDelegation, resolveDelegationScopeChat } from '../delegation-control.js';
import path from 'path';
import { ensurePlanReviewerSession, stalePlanReviewerSessionsForTodoPlanChange } from '../plan-reviewer-cooperation-service.js';
import { syncTodoReviewTarget } from '../todo-review-sync-hooks.js';
import { loadChats, updateChat, deleteChat } from '../persist/chats-persist.js';
import '../chat-archive-guard.js';
import { applyAgentTitle } from '../chat-title-agent.js';
import { getChatTitleHistory } from '../persist/chat-title-history-persist.js';
import { readChatHistoryFromHttpQuery } from '../persist/chat-history-service.js';
import { loadMcpDocument } from '../persist/mcp-persist.js';
import {
  addTodo,
  getTodoById,
  loadTodosData,
  updateTodo,
} from '../persist/todos-persist.js';
import { buildTodoChatIndex, enrichTodoItemsWithSourceChat } from '../todo-source-chat.js';
import { moveTodoTree } from '../todo-move.js';
import { checkReviewGateForTodoWrite } from '../workspace-watcher-review-gate-guard.js';
import { resetWorkspaceWatcherOrchestratorCooldown } from '../workspace-watcher.js';
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
  releaseDoingWorkspaceWatcherTodoForOperator,
  saveWorkspaceWatcherTodoPlanDraft,
  updateWorkspaceWatcherScoutProfile,
} from '../workspace-watcher-control.js';
import { getActiveScoutScanByChatId, getWorkspaceWatcher } from '../persist/workspace-watchers-persist.js';
import { isScoutReadOnlyChat } from '../workspace-scout-chat.js';
import { readChatPlanDocument } from '../chat-plan-persist.js';
import { createDelegationService } from '../delegation-service.js';
import { getDelegationById, listDelegationsForChat } from '../persist/delegations-persist.js';
import { buildDelegationTreeSnapshot } from '../delegation-tree-view.js';
import { listChatMailbox, sendDelegationReply } from '../delegation-mailbox.js';
import {
  applyParentWorkflowUpdate,
  resolveDelegationWorkflowRow,
} from '../delegation-workflow.js';
import {
  confirmWorkspaceTodoIntegration,
  reportSmartMergeOutcome,
  invalidateTodoIntegrationProof,
  markTodoIntegrationNoCode,
  prepareManualTodoIntegration,
  refuseWhenIntegrationLockedForWriter,
  rejectWorkspaceTodoIntegration,
} from '../workspace-watcher-integration.js';
import { loadAgents } from '../agents.js';
import { resolveDataPath } from '../runtime-paths.js';
import { resolveWorkflowMaterialRevisionForLeaf } from '../todo-leaf-material.js';
import { normalizeMcpServers, resolveMcpServersForContext, toMcpRuntimeName } from './mcp-config.js';
import { listMcpSecretKeys } from './mcp-secrets.js';
import { listMcpStatuses } from './mcp-status.js';
import { getBuiltinMcpRuntimeDeps } from './builtin/runtime-deps.js';
import { isChatInWorkspace } from './builtin/tool-context.js';
import { CretliMcpToolError, MCP_BUILTIN_ERROR_CODES, NO_CALLING_CHAT_HINT } from './builtin/errors.js';
import { checkBatchLegacyReport, handleBatchNext, recordBatchLegacyReport } from '../integrate-batch.js';
import { canChatCancelDelegationTree } from '../delegation-tree-cancel.js';
import { listHarnessCatalog, listHarnessModelsIncludingLocal } from '../harness-catalog.js';
import {
  createLedgerRow,
  listLedgerRows,
  showLedgerRow,
  updateLedgerRow,
} from '../credit-ledger/mcp-ledger-service.ts';
import { proposeLessonCheck } from '../review-lessons-checks.js';
import { runUsageControl } from '../usage/usage-control-service.js';
import { readBalanceForecastReport } from '../credit-ledger/balance-forecast.ts';
import { distillReviewLessons } from '../review-lessons-distill.js';
import { addLesson, deleteLesson, listLessons, updateLesson } from '../review-lessons-service.js';

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

/**
 * Resolve the lesson store folder for a call and enforce the same workspace
 * rule as the REST routes: the calling chat must belong to the folder; with no
 * chat record the folder must be the session workspace.
 */
function lessonScope(context, workspaceFolder, chatId) {
  const folder = String(workspaceFolder || context?.workspaceFolder || '').trim();
  if (!folder) throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'workspace_folder is required');
  const chat = findChatById(chatId || context?.chatId);
  if (chat) {
    assertChatInWorkspace(chat, folder, context?.workspaceFile);
  } else if (!sameFolder(folder, context?.workspaceFolder)) {
    throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.OUT_OF_SCOPE, 'This chat is outside the requested workspace.');
  }
  return folder;
}

function findChatById(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return null;
  return loadChats().find((row) => row.id === id) || null;
}

/**
 * Workflow writes use the in-process session chat, not a model-supplied id.
 *
 * @param {Record<string, any>} context
 * @param {unknown} requestedChatId
 * @param {unknown} workspaceFolder
 * @returns {Record<string, any>}
 */
function assertWorkflowParentWrite(context, requestedChatId, workspaceFolder) {
  const sessionChatId = String(context?.chatId || '').trim();
  if (!sessionChatId) {
    throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, `chat_id is required. ${NO_CALLING_CHAT_HINT}`);
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
 * @param {Record<string, any>} context
 * @param {unknown} requestedChatId
 * @param {unknown} workspaceFolder
 * @param {string} toolName Tool named in the rejection messages.
 * @returns {Record<string, any>}
 */
function assertRatingParentChat(context, requestedChatId, workspaceFolder, toolName = 'delegation_rate') {
  const sessionChatId = String(context?.chatId || '').trim();
  if (!sessionChatId) {
    throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, `chat_id is required. ${NO_CALLING_CHAT_HINT}`);
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
 * @returns {any}
 */
function requireConditionCheckService() {
  const service = getBuiltinMcpRuntimeDeps().conditionCheck;
  if (!service) throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'Scheduled checks are unavailable in this client.');
  return service;
}

export function createInProcessMcpClient(context) {
  return {
    __inProcess: true,
    /**
     * Billing ledger access for the builtin billing tools. Owner scope = the
     * in-process session of an existing chat; a delegation child is refused so
     * finance privileges never widen beyond the parent chat.
     */
    async billingLedger({ op, ...args } = /** @type {any} */ ({})) {
      const chat = findChatById(context?.chatId);
      if (!chat) throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.OUT_OF_SCOPE, 'Billing tools need an existing chat.');
      if (String(/** @type {any} */ (chat).delegationParentChatId || '').trim()) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.OUT_OF_SCOPE, 'Billing tools are not available to delegation children.');
      }
      const base = { dataDir: dataDir() };
      if (op === 'list') return listLedgerRows({ ...base, ...args });
      if (op === 'show') return showLedgerRow({ ...base, ...args });
      if (op === 'create') return createLedgerRow({ ...base, ...args });
      if (op === 'update') return updateLedgerRow({ ...base, ...args });
      if (op === 'forecast') return { ok: true, ...readBalanceForecastReport(base) };
      throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'Unknown billing operation.');
    },
    /**
     * Settings → Usage operations for the builtin usage tools. Same owner scope
     * as billing: an existing chat that is not a delegation child, because the
     * settings writes change instance-wide alerts, budgets and auto-resume.
     */
    async usageControl({ op, ...args } = /** @type {any} */ ({})) {
      const chat = findChatById(context?.chatId);
      if (!chat) throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.OUT_OF_SCOPE, 'Usage tools need an existing chat.');
      if (String(/** @type {any} */ (chat).delegationParentChatId || '').trim()) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.OUT_OF_SCOPE, 'Usage settings tools are not available to delegation children.');
      }
      // Same data dir as the REST routes (undefined = default), so both share
      // one in-memory store per reader.
      return runUsageControl(op, args, { dataDir: getBuiltinMcpRuntimeDeps().dataDir });
    },
    async listReviewLessons({ workspaceFolder, chatId } = /** @type {any} */ ({})) { return listLessons(lessonScope(context, workspaceFolder, chatId), { dataDir: dataDir() }); },
    async addReviewLesson({ workspaceFolder, chatId, lesson } = /** @type {any} */ ({})) { return addLesson(lessonScope(context, workspaceFolder, chatId), lesson, { dataDir: dataDir() }); },
    async distillReviewLessons({ workspaceFolder, chatId, options } = /** @type {any} */ ({})) {
      return { ok: true, ...distillReviewLessons(lessonScope(context, workspaceFolder, chatId), { ...options, dataDir: dataDir() }) };
    },
    async updateReviewLesson({ workspaceFolder, chatId, id, patch, expectedRevision } = /** @type {any} */ ({})) { return updateLesson(lessonScope(context, workspaceFolder, chatId), id, patch, expectedRevision, { dataDir: dataDir() }); },
    async proposeLessonCheck({ workspaceFolder, chatId, id } = /** @type {any} */ ({})) {
      const folder = lessonScope(context, workspaceFolder, chatId);
      return { ok: true, ...proposeLessonCheck(folder, id, { dataDir: dataDir(), createdByChatId: String(chatId || context?.chatId || '') }) };
    },
    async deleteReviewLesson({ workspaceFolder, chatId, id } = /** @type {any} */ ({})) { return deleteLesson(lessonScope(context, workspaceFolder, chatId), id, { dataDir: dataDir() }); },
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
    async listChats({ includeArchived } = /** @type {any} */ ({})) {
      const chats = loadChats();
      if (includeArchived === true) return chats;
      return chats.filter((chat) => !/** @type {any} */ (chat).archivedAt);
    },
    async getChat({ chatId, workspaceFolder, workspaceFile, skipWorkspace } = /** @type {any} */ ({})) {
      const chat = findChatById(chatId);
      if (skipWorkspace === true) return chat;
      return assertChatInWorkspace(chat, workspaceFolder, workspaceFile);
    },
    async getChatHistory(chatId, options = {}) {
      return await readChatHistoryFromHttpQuery(chatId, {
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
      await deleteChat(chatId);
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
    async listTodos({ workspaceFolder, workspaceFile } = /** @type {any} */ ({})) {
      const data = loadTodosData(dataDir(), workspaceFolder);
      return enrichTodoItemsWithSourceChat(
        data.items || [],
        todoChatIndex(workspaceFolder, workspaceFile),
        workspaceFolder,
      );
    },
    async getTodo({ workspaceFolder, workspaceFile, todoId } = /** @type {any} */ ({})) {
      const item = getTodoById(dataDir(), workspaceFolder, todoId);
      if (!item) return null;
      const [enriched] = enrichTodoItemsWithSourceChat(
        [item],
        todoChatIndex(workspaceFolder, workspaceFile),
        workspaceFolder,
      );
      return { .../** @type {any} */ (enriched || item), takeovers: loadDelegationTakeovers().filter((row) => row.todoId === item.id && row.workspaceFolder === workspaceFolder) };
    },
    async createTodo({ workspaceFolder, title, body, status, deferredUntil, deferredReason, idempotencyKey, parentId, siblingIndex, assignee, runMode, nonBlocking, executionMode, reviewerPair, orchestratorChatId, sourceTodoId, createdByChatId, sourceHarness } = /** @type {any} */ ({})) {
      return addTodo(dataDir(), workspaceFolder, {
        title,
        body,
        status,
        deferredUntil,
        deferredReason,
        idempotencyKey,
        strictStatus: true,
        parentId,
        siblingIndex,
        assignee,
        runMode,
        nonBlocking,
        executionMode,
        ...(/** @type {any} */ ({ reviewerPair })),
        orchestratorChatId,
        sourceTodoId,
        createdByChatId,
        sourceHarness,
      });
    },
    /**
     * Records integration evidence. `prepare` only builds the worktree patch
     * (the same lock-guarded path as REST `action: prepare`) and never touches
     * the project folder; apply/merge stay deliberately unexposed.
     */
    async recordTodoIntegration({ workspaceFolder, todoId, action, expectedUpdatedAt, proof, reason, callerChatId } = /** @type {any} */ ({})) {
      const base = { todoId, workspaceFolder, dataDir: dataDir(), expectedUpdatedAt, callerChatId };
      if (action === 'prepare') {
        const refused = refuseWhenIntegrationLockedForWriter(base);
        if (refused) return refused;
        return await prepareManualTodoIntegration({ todoId, workspaceFolder, dataDir: dataDir() });
      }
      if (action === 'confirm') return confirmWorkspaceTodoIntegration({ ...base, ...(/** @type {any} */ ({ proof: proof || {} })) });
      if (action === 'invalidate') return invalidateTodoIntegrationProof({ ...base, reason });
      if (action === 'no_code') return markTodoIntegrationNoCode({ ...base, reason });
      if (action === 'reject') return rejectWorkspaceTodoIntegration({ ...base, reason });
      return { ok: false, reason: 'invalid_action' };
    },
    /**
     * Smart-merge agent report (MCP twin of `POST /api/smart-merge-report-from-agent`).
     * A todo in an open bulk-integrate entry must carry the entry's fencing context.
     */
    async reportSmartMergeOutcome({ workspaceFolder, todoId, outcome, summary, batch } = /** @type {any} */ ({})) {
      const body = { ...(batch || {}) };
      const fence = checkBatchLegacyReport({ dataDir: dataDir(), workspaceFolder, todoId, body });
      if (!fence.ok) return { ok: false, reason: 'batch_context_invalid' };
      const result = reportSmartMergeOutcome({ todoId, workspaceFolder, dataDir: dataDir(), outcome, summary });
      if (result.ok && fence.batchId) {
        recordBatchLegacyReport({ dataDir: dataDir(), batchId: fence.batchId, entryId: fence.entryId, outcome });
      }
      return result;
    },
    /**
     * Bulk-integrate `next` (MCP twin of `POST /api/integrate-batch/next`). The
     * capability token stays the authority; the batch must belong to the caller's workspace.
     */
    async integrateBatchNext({ workspaceFolder, body } = /** @type {any} */ ({})) {
      return handleBatchNext({
        dataDir: dataDir(),
        workspaceFolder,
        body: body || {},
        deps: getBuiltinMcpRuntimeDeps().integrateBatchDeps,
      });
    },
    /** Scheduled condition checks: thin facade over the shared service (no model call). */
    async scheduleCheck(input = {}) {
      return requireConditionCheckService().create(input);
    },
    async listChecks({ state } = /** @type {any} */ ({})) {
      return requireConditionCheckService().list({ state });
    },
    async cancelCheck({ checkId } = /** @type {any} */ ({})) {
      return requireConditionCheckService().cancel(checkId);
    },
    async startTodoAgent({ workspaceFolder, todoId, body } = /** @type {any} */ ({})) {
      const starter = getBuiltinMcpRuntimeDeps().startTodoAgent;
      if (typeof starter !== 'function') {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'TODO agent start is unavailable in this client.');
      }
      return starter({ workspaceFolder, todoId, body });
    },
    async updateTodo({ workspaceFolder, todoId, expectedUpdatedAt, title, body, status, deferredUntil, deferredReason, parentId, siblingIndex, assignee, runMode, nonBlocking, executionMode, reviewerPair, orchestratorChatId, sourceTodoId, moveToLater, restoreToTree, linkedChatId, appendChangelog, plan, callerChatId } = /** @type {any} */ ({})) {
      // Review gate (D2): the in-process client is only reachable from an MCP
      // tool, so the caller is always an agent. `callerChatId` is the signed
      // tool-context chat id (may be empty); it is classification, not trust.
      const reviewGate = checkReviewGateForTodoWrite({
        dataDir: dataDir(),
        workspaceFolder,
        todoId,
        patch: { status },
        caller: { kind: 'mcp', chatId: String(callerChatId || '').trim() },
      });
      let doc = updateTodo(dataDir(), workspaceFolder, todoId, {
        title,
        body,
        status,
        deferredUntil,
        deferredReason,
        expectedUpdatedAt,
        strictStatus: true,
        parentId,
        siblingIndex,
        assignee,
        runMode,
        nonBlocking,
        executionMode,
        ...(/** @type {any} */ ({ reviewerPair })),
        orchestratorChatId,
        sourceTodoId,
        moveToLater,
        restoreToTree,
        linkedChatId,
        appendChangelog,
        plan: plan && typeof plan === 'object'
          ? {
            markdown: plan.markdown,
            sourceChatId: plan.sourceChatId,
          }
          : undefined,
      });
      reviewGate.afterWrite();
      // afterWrite may touch the todo again (label / warning note): return the persisted item.
      if (plan && typeof plan === 'object' && plan.markdown !== undefined) {
        // Parity with the REST route: a plan revision stales plan-reviewer sessions and
        // opens a new plan review round (todo-review contract 4.3). Best effort.
        try {
          stalePlanReviewerSessionsForTodoPlanChange({ dataDir: dataDir(), workspaceFolder, todoId });
        } catch {
          // Todo update must succeed even if cooperation stale marking fails.
        }
        try {
          syncTodoReviewTarget({ todoId, workspaceFolder, dataDir: dataDir() }, { source: 'plan-edit' });
        } catch {
          // Review snapshot repair on restart covers a failed resync.
        }
      }
      doc = loadTodosData(dataDir(), workspaceFolder);
      const item = doc.items.find((row) => row.id === todoId) || null;
      if (item && (body != null || (plan && plan.markdown != null))) {
        const { scheduleWorkspaceWatcherAutopilot } = await import('../workspace-watcher-event-schedule.js');
        scheduleWorkspaceWatcherAutopilot({ workspaceFolder, dataDir: dataDir() });
      }
      return item;
    },
    /** @param {{ workspaceFolder: string, todoId: string, expectedUpdatedAt: string, targetWorkspaceFolder: string, chatId?: string }} input */
    async moveTodoTree({ workspaceFolder, todoId, expectedUpdatedAt, targetWorkspaceFolder, chatId }) {
      return moveTodoTree({
        dataDir: dataDir(),
        sourceFolder: workspaceFolder,
        targetFolder: targetWorkspaceFolder,
        todoId,
        expectedUpdatedAt,
        chatId,
      });
    },
    async getChatPlan({ chatId, workspaceFolder } = /** @type {any} */ ({})) {
      const chat = assertChatInWorkspace(findChatById(chatId), workspaceFolder);
      if (!chat) return null;
      return readChatPlanDocument({ cwd: workspaceFolder, chatId: chat.id });
    },
    async listDelegations({ chatId, workspaceFolder, skipWorkspace } = /** @type {any} */ ({})) {
      const found = findChatById(chatId);
      const chat = skipWorkspace === true ? found : assertChatInWorkspace(found, workspaceFolder);
      if (!chat) return [];
      return listDelegationsForChat(chat.id);
    },
    /**
     * Read-only delegation tree for the session chat. The viewer is always the
     * in-process session chat: a different `chatId` is rejected so one chat can
     * never read another tree.
     */
    async getDelegationTree({ chatId, workspaceFolder, rootDelegationId, status, cursor, limit } = /** @type {any} */ ({})) {
      const sessionChatId = String(context?.chatId || '').trim();
      if (!sessionChatId) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'chat_id is required');
      }
      const requested = String(chatId || '').trim();
      if (requested && requested !== sessionChatId) {
        throw new CretliMcpToolError(
          MCP_BUILTIN_ERROR_CODES.CONFLICT,
          'The delegation tree can only be read for the calling chat.',
        );
      }
      const chat = assertChatInWorkspace(findChatById(sessionChatId), workspaceFolder);
      if (!chat) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.NOT_FOUND, 'Chat not found');
      }
      return buildDelegationTreeSnapshot({
        chatId: chat.id,
        chat,
        rootDelegationId,
        status,
        cursor,
        limit,
      });
    },
    async getDelegation({ delegationId, workspaceFolder } = /** @type {any} */ ({})) {
      const row = getDelegationById(delegationId);
      if (!row) return null;
      const parent = resolveDelegationScopeChat(row, findChatById);
      if (!parent) return null;
      assertChatInWorkspace(parent, workspaceFolder);
      return row;
    },
    /** @param {Record<string, any>} [params] */
    async startDelegation({
      chatId,
      workspaceFolder,
      planRevision,
      harness,
      model,
      extraInstructions,
      selectedSkillIds,
      selected_skill_ids,
      pickReason,
      pickId,
      pick_id,
      manualSource,
      manual_source,
      pickFallbackFrom,
      pick_fallback_from,
      continuationOf,
      continuation_of,
      idempotencyKey,
      sourceKind,
      historySeq,
      contentHash,
      taskText,
      executionMode,
      assignment,
      reviewSubject,
      review_subject,
      requestedRole,
      requested_role,
      leafId,
      resumeRounds,
      maxRounds,
      returnWhenStarting,
      allowFlashReview,
      allowHighInfra,
      allowPremium,
      allowChildDelegations,
      allowVerifyFailedReview,
      allow_verify_failed_review,
      allowRecheck,
      allow_recheck,
      planReviewerSessionId,
      plan_reviewer_session_id,
      planReviewerPhase,
      plan_reviewer_phase,
      planReviewerSlot,
      plan_reviewer_slot,
      exchangeOfDelegationId,
      exchange_of_delegation_id,
      originDelegationId,
      origin_delegation_id,
    } = /** @type {any} */ ({})) {
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
        selectedSkillIds: selectedSkillIds ?? selected_skill_ids,
        pickReason,
        pickId: pickId ?? pick_id,
        manualSource: manualSource ?? manual_source,
        pickFallbackFrom: pickFallbackFrom ?? pick_fallback_from,
        continuationOf: continuationOf ?? continuation_of,
        sourceKind,
        historySeq,
        contentHash,
        taskText,
        executionMode,
        assignment,
        reviewSubject: reviewSubject ?? review_subject,
        requestedRole: requestedRole ?? requested_role,
        leafId,
        resumeRounds,
        maxRounds,
        returnWhenStarting,
        allowFlashReview,
        allowHighInfra,
        allowPremium,
        allowChildDelegations,
        allowVerifyFailedReview: allowVerifyFailedReview === true || allow_verify_failed_review === true,
        allowRecheck: allowRecheck === true || allow_recheck === true,
        planReviewerSessionId: planReviewerSessionId ?? plan_reviewer_session_id,
        planReviewerPhase: planReviewerPhase ?? plan_reviewer_phase,
        planReviewerSlot: planReviewerSlot ?? plan_reviewer_slot,
        exchangeOfDelegationId: exchangeOfDelegationId
          ?? exchange_of_delegation_id
          ?? originDelegationId
          ?? origin_delegation_id,
      });
    },
    /**
     * Same contract as the remote `POST /api/todos/:id/plan-reviewer-session`
     * with `reuseCurrentRevision`. The coordinator is always the in-process
     * session chat, so one chat cannot open a session on behalf of another.
     */
    async ensurePlanReviewerSession({ todoId, workspaceFolder, coordinatorChatId, cooperationMode } = /** @type {any} */ ({})) {
      const sessionChatId = String(context?.chatId || '').trim();
      const requested = String(coordinatorChatId || '').trim();
      if (!sessionChatId || (requested && requested !== sessionChatId)) {
        throw new CretliMcpToolError(
          MCP_BUILTIN_ERROR_CODES.OUT_OF_SCOPE,
          'A plan reviewer session can only be opened by its coordinator chat.',
        );
      }
      const chat = assertChatInWorkspace(findChatById(sessionChatId), workspaceFolder);
      if (!chat) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.NOT_FOUND, 'Chat not found');
      }
      return ensurePlanReviewerSession({
        dataDir: dataDir(),
        workspaceFolder,
        todoId,
        coordinatorChatId: chat.id,
        cooperationMode,
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
      callAttemptId,
      callDelegationId,
      taskOutcome,
    } = /** @type {any} */ ({})) {
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
        ...(/** @type {any} */ ({ replyKind })),
        attemptId,
        runId,
        sessionAttemptId,
        sessionRunId,
        callAttemptId,
        callDelegationId,
        taskOutcome,
      });
    },
    async listMailbox({ chatId, workspaceFolder, skipWorkspace } = /** @type {any} */ ({})) {
      const found = findChatById(chatId);
      const chat = skipWorkspace === true ? found : assertChatInWorkspace(found, workspaceFolder);
      if (!chat) return [];
      return listChatMailbox(chat.id);
    },
    async cancelDelegation({ delegationId, workspaceFolder, tree, chatId } = /** @type {any} */ ({})) {
      const row = getDelegationById(delegationId);
      if (!row) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.NOT_FOUND, 'Delegation not found');
      }
      const parent = resolveDelegationScopeChat(row, findChatById);
      if (!parent) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.NOT_FOUND, 'Delegation not found');
      }
      assertChatInWorkspace(parent, workspaceFolder);
      if (tree === true) {
        // The caller must be the session chat: a spoofed chat id is refused.
        const sessionChatId = String(context?.chatId || '').trim();
        const requested = String(chatId || '').trim();
        if (!sessionChatId || (requested && requested !== sessionChatId)) {
          throw new CretliMcpToolError(
            MCP_BUILTIN_ERROR_CODES.CONFLICT,
            'Tree cancel applies only to the calling chat.',
          );
        }
        if (!canChatCancelDelegationTree(row, sessionChatId)) {
          throw new CretliMcpToolError(
            MCP_BUILTIN_ERROR_CODES.OUT_OF_SCOPE,
            'Tree cancel is limited to jobs started by the calling chat (or its tree root chat).',
          );
        }
        return delegationService().cancelTree(delegationId);
      }
      // Single-job cancel: when the session chat is known it must own the job.
      const sessionChatId = String(context?.chatId || '').trim();
      if (sessionChatId) {
        const requested = String(chatId || '').trim();
        if (requested && requested !== sessionChatId) {
          throw new CretliMcpToolError(
            MCP_BUILTIN_ERROR_CODES.CONFLICT,
            'Cancel applies only to the calling chat.',
          );
        }
        if (!canChatCancelDelegationTree(row, sessionChatId)) {
          throw new CretliMcpToolError(
            MCP_BUILTIN_ERROR_CODES.OUT_OF_SCOPE,
            'Cancel is limited to jobs started by the calling chat (or its tree root chat).',
          );
        }
      }
      return delegationService().cancel(delegationId);
    },
    async confirmDelegationStop({
      delegationId,
      workspaceFolder,
      confirmation,
      note,
    } = /** @type {any} */ ({})) {
      const row = getDelegationById(delegationId);
      if (!row) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.NOT_FOUND, 'Delegation not found');
      }
      const parent = resolveDelegationScopeChat(row, findChatById);
      if (!parent) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.NOT_FOUND, 'Delegation not found');
      }
      assertChatInWorkspace(parent, workspaceFolder);
      const sessionChatId = String(context?.chatId || '').trim();
      if (sessionChatId && !canChatControlDelegation(row, sessionChatId)) {
        throw new CretliMcpToolError(
          MCP_BUILTIN_ERROR_CODES.OUT_OF_SCOPE,
          'Confirm stop is limited to jobs started by the calling chat.',
        );
      }
      return delegationService().confirmManualSlotRelease(delegationId, {
        confirmation,
        note,
        actor: 'orchestrator',
      });
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
    } = /** @type {any} */ ({})) {
      const chat = assertRatingParentChat(context, chatId, workspaceFolder);
      const id = String(delegationId || '').trim();
      if (!id) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'delegation_id is required');
      }
      const row = getDelegationById(id);
      if (!row) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.NOT_FOUND, 'Delegation not found');
      }
      const parent = resolveDelegationScopeChat(row, findChatById);
      if (!parent) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.NOT_FOUND, 'Delegation not found');
      }
      assertChatInWorkspace(parent, workspaceFolder);
      if (!canChatControlDelegation(row, chat.id)) {
        throw new CretliMcpToolError(
          MCP_BUILTIN_ERROR_CODES.OUT_OF_SCOPE,
          'delegation_rate is limited to jobs started by this parent chat.',
        );
      }
      return await delegationService().rate(id, { rater: 'parent', score, tags, note });
    },
    /**
     * Parent-channel acknowledgement. Clears `unverified` on a terminal job and
     * stores `acknowledgedAt`/`acknowledgedReason`; a non-terminal job is
     * returned unchanged with `skipped: true` (same rule as the card's ack).
     *
     * The in-process transport is server-internal, not the authenticated browser
     * card channel, so the derived actor is always `unknown`
     * (`docs/todo-review-contract.md` §7.2). An MCP/widget connection can never
     * produce a `manual` acceptance from here.
     *
     * @param {{ chatId?: string, delegationId?: string, workspaceFolder?: string,
     *   reason?: unknown, expectedAttemptId?: unknown,
     *   expectedMaterialRevision?: unknown, expectedTodoRevision?: unknown }} input
     */
    async acknowledgeDelegation({
      chatId,
      delegationId,
      workspaceFolder,
      reason,
      expectedAttemptId,
      expectedMaterialRevision,
      expectedTodoRevision,
    } = /** @type {any} */ ({})) {
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
      const parent = resolveDelegationScopeChat(row, findChatById);
      if (!parent) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.NOT_FOUND, 'Delegation not found');
      }
      assertChatInWorkspace(parent, workspaceFolder);
      if (!canChatControlDelegation(row, chat.id)) {
        throw new CretliMcpToolError(
          MCP_BUILTIN_ERROR_CODES.OUT_OF_SCOPE,
          'delegation_ack is limited to jobs started by this parent chat.',
        );
      }
      return await delegationService().acknowledge(id, /** @type {any} */ ({
        reason,
        actor: 'unknown',
        expectedAttemptId,
        expectedMaterialRevision,
        expectedTodoRevision,
      }));
    },
    async orchestrationTakeover({ chatId, workspaceFolder, todoId, idempotencyKey, reason, forceUnavailable, scope } = /** @type {any} */ ({})) {
      const chat = assertRatingParentChat(context, chatId, workspaceFolder, 'todo_takeover');
      return delegationService().orchestrationTakeover({
        chatId: chat.id,
        workspaceFolder: workspaceFolder || chat.workspaceFolder,
        todoId,
        idempotencyKey,
        reason,
        forceUnavailable: forceUnavailable === true,
        scope,
      });
    },
    async getDelegationWorkflow({ chatId, workspaceFolder, leafId } = /** @type {any} */ ({})) {
      assertNoTakeoverInProgress({ chatId, leafId });
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
      treeBudgetTokens,
      treeBudgetCostUsd,
      materialRevision,
      idempotencyKey,
      leafId,
      resumeRounds,
      rejectedFindings,
    } = /** @type {any} */ ({})) {
      assertNoTakeoverInProgress({ chatId, leafId });
      const chat = assertWorkflowParentWrite(context, chatId, workspaceFolder);
      const cwd = workspaceFolder || chat.workspaceFolder;
      const resolvedMaterialRevision = resolveWorkflowMaterialRevisionForLeaf({
        dataDir: resolveDataPath(),
        workspaceFolder: cwd,
        leafId,
        clientRevision: String(materialRevision || '').trim(),
      });
      try {
        const workflow = applyParentWorkflowUpdate({
          parentChatId: chat.id,
          leafId,
          workspaceFolder: cwd,
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
          treeBudgetTokens,
          treeBudgetCostUsd,
          // An omitted revision keeps the stored one instead of clearing it.
          materialRevision: materialRevision === undefined && !resolvedMaterialRevision
            ? undefined
            : resolvedMaterialRevision,
          idempotencyKey,
          rejectedFindings,
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
    async listWorkspaceTasks({ workspaceFolder, workspaceFile } = /** @type {any} */ ({})) {
      const loaded = getBuiltinMcpRuntimeDeps().loadTasksForWorkspace({
        workspaceFolder,
        workspaceFile,
      });
      return loaded || { tasks: [] };
    },
    async listTaskRuns({ workspaceFolder } = /** @type {any} */ ({})) {
      return [...getBuiltinMcpRuntimeDeps().taskRuns.entries()]
        .filter(([, run]) => sameFolder(/** @type {any} */ (run)?.cwd, workspaceFolder))
        .map(([runId, run]) => ({ runId, taskLabel: /** @type {any} */ (run).taskLabel, cwd: /** @type {any} */ (run).cwd }));
    },
    async listWorkspaceAgents({ workspaceFolder } = /** @type {any} */ ({})) {
      return loadAgents(workspaceFolder);
    },
    async listAgentRuns({ workspaceFolder } = /** @type {any} */ ({})) {
      return [...getBuiltinMcpRuntimeDeps().agentRuns.entries()]
        .filter(([, run]) => sameFolder(/** @type {any} */ (run)?.cwd, workspaceFolder))
        .map(([runId, run]) => ({ runId, agentName: /** @type {any} */ (run).agentName, cwd: /** @type {any} */ (run).cwd }));
    },
    async listHarnessCatalog() {
      return listHarnessCatalog();
    },
    async listHarnessModels(input = {}) {
      return listHarnessModelsIncludingLocal(input);
    },
    async workspaceWatcherShow({ workspaceFolder } = /** @type {any} */ ({})) {
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
          ...(/** @type {any} */ ({ ttlMs: input.ttlMs })),
        });
        return { ok: true, action, ...result };
      }
      if (action === 'reset_plan_requests') {
        const result = resetWorkspaceWatcherPlanRequests({ dataDir: dir, workspaceFolder, todoId: input.todoId });
        return { ok: true, action, ...result };
      }
      if (action === 'reset_orchestrator_cooldown') {
        const watcher = resetWorkspaceWatcherOrchestratorCooldown({
          dataDir: dir, workspaceFolder, harness: input.harness, model: input.model,
        });
        return { ok: watcher !== null, action, reset: watcher !== null };
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
        const result = await reportWorkspaceWatcherCycle({
          dataDir: dir,
          workspaceFolder,
          sourceChatId: input.sourceChatId,
          outcome: input.outcome,
          todoIds: input.todoIds,
          cycleId: input.cycleId,
          reportId: input.reportId,
          message: input.message,
          reasonCode: input.reasonCode,
          reasonDate: input.reasonDate,
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
      if (action === 'release_unknown_todo') {
        const todoId = String(input.todoId || input.todo_id || '').trim();
        const expectedUpdatedAt = String(
          input.expectedUpdatedAt || input.expected_updated_at || '',
        ).trim();
        const confirmUnknownRelease = input.confirmUnknownRelease === true
          || input.confirm_unknown_release === true
          || input.confirm === true;
        if (!todoId || !expectedUpdatedAt) {
          return {
            ok: false,
            action,
            outcome: 'api-error',
            error: {
              code: 'VALIDATION',
              message: 'release_unknown_todo requires todo_id and expected_updated_at',
            },
          };
        }
        if (!confirmUnknownRelease) {
          return {
            ok: false,
            action,
            outcome: 'api-error',
            error: {
              code: 'VALIDATION',
              message: 'release_unknown_todo requires confirm_unknown_release',
            },
          };
        }
        const result = releaseDoingWorkspaceWatcherTodoForOperator({
          dataDir: dir,
          workspaceFolder,
          todoId,
          expectedUpdatedAt,
          confirmUnknownRelease: true,
          operatorMessage: String(input.operatorMessage || input.message || '').trim() || undefined,
          idempotencyKey: String(input.idempotencyKey || input.idempotency_key || '').trim() || undefined,
        });
        return {
          ok: result.ok === true,
          action,
          ...result,
        };
      }
      if (action === 'release_unknown_todo') {
        const todoId = String(input.todoId || input.todo_id || '').trim();
        const expectedUpdatedAt = String(
          input.expectedUpdatedAt || input.expected_updated_at || '',
        ).trim();
        const confirmUnknownRelease = input.confirmUnknownRelease === true
          || input.confirm_unknown_release === true
          || input.confirm === true;
        if (!todoId || !expectedUpdatedAt) {
          return {
            ok: false,
            action,
            outcome: 'api-error',
            error: {
              code: 'VALIDATION',
              message: 'release_unknown_todo requires todo_id and expected_updated_at',
            },
          };
        }
        if (!confirmUnknownRelease) {
          return {
            ok: false,
            action,
            outcome: 'api-error',
            error: {
              code: 'VALIDATION',
              message: 'release_unknown_todo requires confirm_unknown_release',
            },
          };
        }
        const result = releaseDoingWorkspaceWatcherTodoForOperator({
          dataDir: dir,
          workspaceFolder,
          todoId,
          expectedUpdatedAt,
          confirmUnknownRelease: true,
          operatorMessage: String(input.operatorMessage || input.message || '').trim() || undefined,
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
        if (/** @type {any} */ (active)?.chatId === sourceChatId) {
          if (!scoutSubmitToken) scoutSubmitToken = /** @type {any} */ (active).submitToken;
          if (!scanId) scanId = /** @type {any} */ (active).scanId;
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
     * @param {Record<string, any>} [input]
     * @returns {Promise<Record<string, any>>}
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
          /** @type {any} */ (error).code = 'VALIDATION';
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
      /** @type {any} */ (error).code = 'VALIDATION';
      throw error;
    },
  };
}
