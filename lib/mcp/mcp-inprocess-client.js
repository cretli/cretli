/**
 * In-process chat/MCP facade for the builtin Cretli MCP server.
 */

import path from 'path';
import { loadChats, updateChat, deleteChat } from '../persist/chats-persist.js';
import { readChatHistoryFromHttpQuery } from '../persist/chat-history-persist.js';
import { loadMcpDocument } from '../persist/mcp-persist.js';
import {
  addTodo,
  getTodoById,
  loadTodosData,
  updateTodo,
} from '../persist/todos-persist.js';
import { readChatPlanDocument } from '../chat-plan-persist.js';
import { createDelegationService } from '../delegation-service.js';
import { getDelegationById, listDelegationsForChat } from '../persist/delegations-persist.js';
import { listChatMailbox, sendDelegationReply } from '../delegation-mailbox.js';
import { loadAgents } from '../agents.js';
import { resolveDataPath } from '../runtime-paths.js';
import { normalizeMcpServers, resolveMcpServersForContext, toMcpRuntimeName } from './mcp-config.js';
import { listMcpSecretKeys } from './mcp-secrets.js';
import { listMcpStatuses } from './mcp-status.js';
import { getBuiltinMcpRuntimeDeps } from './builtin/runtime-deps.js';
import { isChatInWorkspace } from './builtin/tool-context.js';
import { CretliMcpToolError, MCP_BUILTIN_ERROR_CODES } from './builtin/errors.js';
import { listHarnessCatalog, listHarnessModels } from '../harness-catalog.js';

function dataDir() {
  return getBuiltinMcpRuntimeDeps().dataDir || resolveDataPath();
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
    async getChat({ chatId, workspaceFolder, workspaceFile } = {}) {
      return assertChatInWorkspace(findChatById(chatId), workspaceFolder, workspaceFile);
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
    async renameChat(chatId, title) {
      return updateChat(chatId, { title: String(title || '').trim() });
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
    async listTodos({ workspaceFolder } = {}) {
      const data = loadTodosData(dataDir(), workspaceFolder);
      return data.items || [];
    },
    async getTodo({ workspaceFolder, todoId } = {}) {
      return getTodoById(dataDir(), workspaceFolder, todoId);
    },
    async createTodo({ workspaceFolder, title, body, status, idempotencyKey } = {}) {
      return addTodo(dataDir(), workspaceFolder, {
        title,
        body,
        status,
        idempotencyKey,
        strictStatus: true,
      });
    },
    async updateTodo({ workspaceFolder, todoId, expectedUpdatedAt, title, body, status } = {}) {
      const doc = updateTodo(dataDir(), workspaceFolder, todoId, {
        title,
        body,
        status,
        expectedUpdatedAt,
        strictStatus: true,
      });
      return doc.items.find((row) => row.id === todoId) || null;
    },
    async getChatPlan({ chatId, workspaceFolder } = {}) {
      const chat = assertChatInWorkspace(findChatById(chatId), workspaceFolder);
      if (!chat) return null;
      return readChatPlanDocument({ cwd: workspaceFolder, chatId: chat.id });
    },
    async listDelegations({ chatId, workspaceFolder } = {}) {
      const chat = assertChatInWorkspace(findChatById(chatId), workspaceFolder);
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
      idempotencyKey,
      sourceKind,
      historySeq,
      contentHash,
      taskText,
      executionMode,
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
        sourceKind,
        historySeq,
        contentHash,
        taskText,
        executionMode,
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
      });
    },
    async listMailbox({ chatId, workspaceFolder } = {}) {
      const chat = assertChatInWorkspace(findChatById(chatId), workspaceFolder);
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
      return listHarnessModels(input);
    },
  };
}
