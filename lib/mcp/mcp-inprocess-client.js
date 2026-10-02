/**
 * In-process chat/MCP facade for the builtin Cretli MCP server.
 */

import path from 'path';
import { loadChats, updateChat, deleteChat } from '../persist/chats-persist.js';
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
import { readChatPlanDocument } from '../chat-plan-persist.js';
import { createDelegationService } from '../delegation-service.js';
import { getDelegationById, listDelegationsForChat } from '../persist/delegations-persist.js';
import { listChatMailbox, sendDelegationReply } from '../delegation-mailbox.js';
import {
  applyDelegationWorkflowPatch,
  getDelegationWorkflow,
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
 * Parent-channel rating: the in-process session chat must be the caller and it
 * must not be a child chat. Mirrors `assertWorkflowParentWrite`.
 *
 * @param {object} context
 * @param {unknown} requestedChatId
 * @param {unknown} workspaceFolder
 * @returns {object}
 */
function assertRatingParentChat(context, requestedChatId, workspaceFolder) {
  const sessionChatId = String(context?.chatId || '').trim();
  if (!sessionChatId) {
    throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'chat_id is required');
  }
  const requested = String(requestedChatId || '').trim();
  if (requested && requested !== sessionChatId) {
    throw new CretliMcpToolError(
      MCP_BUILTIN_ERROR_CODES.CONFLICT,
      'delegation_rate applies only to the calling parent chat.',
    );
  }
  const chat = assertChatInWorkspace(findChatById(sessionChatId), workspaceFolder);
  if (!chat) {
    throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.NOT_FOUND, 'Chat not found');
  }
  if (String(chat.delegationParentChatId || '').trim()) {
    throw new CretliMcpToolError(
      MCP_BUILTIN_ERROR_CODES.CONFLICT,
      'Only the parent chat of a job can rate it.',
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
    async createTodo({ workspaceFolder, title, body, status, idempotencyKey, parentId, siblingIndex, assignee, runMode, orchestratorChatId, createdByChatId, sourceHarness } = {}) {
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
        orchestratorChatId,
        createdByChatId,
        sourceHarness,
      });
    },
    async updateTodo({ workspaceFolder, todoId, expectedUpdatedAt, title, body, status, parentId, siblingIndex, assignee, runMode, orchestratorChatId, linkedChatId, appendChangelog } = {}) {
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
        orchestratorChatId,
        linkedChatId,
        appendChangelog,
      });
      return doc.items.find((row) => row.id === todoId) || null;
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
      idempotencyKey,
      sourceKind,
      historySeq,
      contentHash,
      taskText,
      executionMode,
      assignment,
      returnWhenStarting,
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
        sourceKind,
        historySeq,
        contentHash,
        taskText,
        executionMode,
        assignment,
        returnWhenStarting,
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
    async getDelegationWorkflow({ chatId, workspaceFolder } = {}) {
      const chat = assertChatInWorkspace(findChatById(chatId), workspaceFolder);
      if (!chat) return null;
      return getDelegationWorkflow(chat.id);
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
      materialRevision,
      idempotencyKey,
    } = {}) {
      const chat = assertWorkflowParentWrite(context, chatId, workspaceFolder);
      try {
        const workflow = applyDelegationWorkflowPatch({
          parentChatId: chat.id,
          workspaceFolder: workspaceFolder || chat.workspaceFolder,
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
  };
}
