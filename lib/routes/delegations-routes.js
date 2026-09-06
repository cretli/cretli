/**
 * HTTP API for plan-execution delegations.
 */

import { loadChats } from '../persist/chats-persist.js';
import { readChatPlanDocument } from '../chat-plan-persist.js';
import { createDelegationService } from '../delegation-service.js';
import { isDelegationModelAvailable } from '../delegation-executor.js';
import { hasChatRunAdapter, listChatRunAdapterTransports } from '../chat-run-service.js';
import { resolveSdkCwdForChat } from '../workspace.js';
import { isChatInWorkspace } from '../mcp/builtin/tool-context.js';
import { resolveHistoryMessageSource } from '../delegation-source.js';
import { listChatMailbox, retryMailboxMessage, sendDelegationReply } from '../delegation-mailbox.js';
import { getMailboxMessageById } from '../persist/delegation-mailbox-persist.js';
import { listDelegationsForChat, getDelegationById } from '../persist/delegations-persist.js';

/**
 * @param {import('express').Express} app
 * @param {{
 *   workspaceDirForAgent: (p: string | null) => string,
 *   dataDir?: string,
 * }} ctx
 */
export function registerDelegationsRoutes(app, ctx) {
  const service = createDelegationService({
    workspaceDirForAgent: ctx.workspaceDirForAgent,
    dataDir: ctx.dataDir,
    isModelAvailable: isDelegationModelAvailable,
  });

  function findParent(req, id) {
    const chat = loadChats().find((row) => row.id === id);
    if (!chat) return null;
    if (req.widgetAccess && chat.widgetInstallationId !== req.widgetAccess.installationId) return null;
    return chat;
  }

  function workspaceFolderFrom(req) {
    return String(req.query?.workspaceFolder || req.body?.workspaceFolder || '').trim();
  }

  function rejectIfOutOfWorkspace(req, chat) {
    const folder = workspaceFolderFrom(req);
    if (!folder) return null;
    const file = String(req.query?.workspaceFile || req.body?.workspaceFile || '').trim();
    if (isChatInWorkspace(chat, folder, file)) return null;
    return resOutOfScope();
  }

  function resOutOfScope() {
    return { status: 403, json: { ok: false, error: 'This chat is outside the requested workspace.', code: 'OUT_OF_SCOPE' } };
  }

  app.get('/api/chats/:id/plan', (req, res) => {
    const chat = findParent(req, req.params.id);
    if (!chat) return res.status(404).json({ ok: false, error: 'Chat not found.' });
    const denied = rejectIfOutOfWorkspace(req, chat);
    if (denied) return res.status(denied.status).json(denied.json);
    const cwd = resolveSdkCwdForChat(chat, ctx.workspaceDirForAgent);
    const plan = readChatPlanDocument({ cwd, chatId: chat.id });
    return res.json({
      ok: true,
      plan,
      workspaceFolder: cwd || chat.workspaceFolder || '',
    });
  });

  app.get('/api/delegations/executors', (_req, res) => {
    res.json({
      ok: true,
      transports: listChatRunAdapterTransports().filter((id) => id !== 'mock' && hasChatRunAdapter(id)),
    });
  });

  app.get('/api/chats/:id/delegations', (req, res) => {
    const chat = findParent(req, req.params.id);
    if (!chat) return res.status(404).json({ ok: false, error: 'Chat not found.' });
    const denied = rejectIfOutOfWorkspace(req, chat);
    if (denied) return res.status(denied.status).json(denied.json);
    res.json({ ok: true, delegations: listDelegationsForChat(chat.id) });
  });

  app.post('/api/chats/:id/delegations', async (req, res) => {
    const chat = findParent(req, req.params.id);
    if (!chat) return res.status(404).json({ ok: false, error: 'Chat not found.' });
    const denied = rejectIfOutOfWorkspace(req, chat);
    if (denied) return res.status(denied.status).json(denied.json);
    const result = await service.createAndStart({
      parentChatId: chat.id,
      executor: req.body?.executor || {},
      planRevision: req.body?.planRevision,
      idempotencyKey: req.body?.idempotencyKey || '',
      extraInstructions: req.body?.extraInstructions || '',
      title: req.body?.title || '',
      sourceKind: req.body?.sourceKind || '',
      historySeq: req.body?.historySeq,
      contentHash: req.body?.contentHash || '',
      taskText: req.body?.taskText || '',
      executionMode: req.body?.executionMode || '',
    });
    if (!result.ok) {
      return res.status(result.status || 400).json(result);
    }
    return res.status(result.status || 201).json(result);
  });

  app.get('/api/delegations/:id', (req, res) => {
    const row = service.getById(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'Delegation not found.' });
    const parent = findParent(req, row.parentChatId);
    if (!parent) return res.status(404).json({ ok: false, error: 'Delegation not found.' });
    const denied = rejectIfOutOfWorkspace(req, parent);
    if (denied) return res.status(denied.status).json(denied.json);
    res.json({ ok: true, delegation: row });
  });

  app.post('/api/delegations/:id/cancel', async (req, res) => {
    const row = service.getById(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'Delegation not found.' });
    const parent = findParent(req, row.parentChatId);
    if (!parent) return res.status(404).json({ ok: false, error: 'Delegation not found.' });
    const denied = rejectIfOutOfWorkspace(req, parent);
    if (denied) return res.status(denied.status).json(denied.json);
    const result = await service.cancel(req.params.id);
    return res.status(result.status || 200).json(result);
  });

  app.post('/api/delegations/:id/ack', (req, res) => {
    const row = service.getById(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'Delegation not found.' });
    if (!findParent(req, row.parentChatId)) {
      return res.status(404).json({ ok: false, error: 'Delegation not found.' });
    }
    const result = service.acknowledge(req.params.id, {
      reason: String(req.body?.reason || 'reviewed'),
    });
    return res.status(result.status || 200).json(result);
  });

  app.post('/api/delegations/:id/retry', async (req, res) => {
    const row = service.getById(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'Delegation not found.' });
    if (!findParent(req, row.parentChatId)) {
      return res.status(404).json({ ok: false, error: 'Delegation not found.' });
    }
    const result = await service.retry(req.params.id);
    return res.status(result.status || 200).json(result);
  });

  app.get('/api/chats/:id/mailbox', (req, res) => {
    const chat = findParent(req, req.params.id);
    if (!chat) return res.status(404).json({ ok: false, error: 'Chat not found.' });
    const denied = rejectIfOutOfWorkspace(req, chat);
    if (denied) return res.status(denied.status).json(denied.json);
    res.json({ ok: true, messages: listChatMailbox(chat.id) });
  });

  app.get('/api/mailbox/:id', (req, res) => {
    const row = getMailboxMessageById(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'Mailbox message not found.' });
    const fromChat = findParent(req, row.fromChatId);
    const toChat = findParent(req, row.toChatId);
    if (!fromChat && !toChat) return res.status(404).json({ ok: false, error: 'Mailbox message not found.' });
    const scoped = fromChat || toChat;
    const denied = rejectIfOutOfWorkspace(req, scoped);
    if (denied) return res.status(denied.status).json(denied.json);
    res.json({ ok: true, message: row });
  });

  app.post('/api/chats/:id/mailbox/:messageId/retry', async (req, res) => {
    const chat = findParent(req, req.params.id);
    if (!chat) return res.status(404).json({ ok: false, error: 'Chat not found.' });
    const denied = rejectIfOutOfWorkspace(req, chat);
    if (denied) return res.status(denied.status).json(denied.json);
    const row = getMailboxMessageById(req.params.messageId);
    if (!row || (row.fromChatId !== chat.id && row.toChatId !== chat.id)) {
      return res.status(404).json({ ok: false, error: 'Mailbox message not found.' });
    }
    const result = await retryMailboxMessage(row.id);
    return res.status(result.status || 200).json(result);
  });

  app.post('/api/chats/:id/mailbox/reply', async (req, res) => {
    const chat = findParent(req, req.params.id);
    if (!chat) return res.status(404).json({ ok: false, error: 'Chat not found.' });
    const denied = rejectIfOutOfWorkspace(req, chat);
    if (denied) return res.status(denied.status).json(denied.json);
    const delegationId = String(req.body?.delegationId || chat.delegationId || '').trim();
    const delegation = delegationId ? getDelegationById(delegationId) : null;
    const parentChatId = String(delegation?.parentChatId || chat.delegationParentChatId || '').trim();
    if (parentChatId) {
      const parent = findParent(req, parentChatId);
      if (!parent) {
        return res.status(404).json({ ok: false, error: 'Parent chat not found.', code: 'parent_deleted' });
      }
      const parentDenied = rejectIfOutOfWorkspace(req, parent);
      if (parentDenied) return res.status(parentDenied.status).json(parentDenied.json);
    }
    const historySeq = Number(req.body?.historySeq);
    let body = String(req.body?.textSnapshot || req.body?.body || '').trim();
    let contentHash = String(req.body?.contentHash || '').trim();
    if (Number.isSafeInteger(historySeq) && historySeq > 0) {
      const found = resolveHistoryMessageSource(chat.id, { historySeq, contentHash });
      if (!found.ok) {
        return res.status(409).json({ ok: false, error: found.error, code: found.code });
      }
      body = found.text;
      contentHash = found.contentHash;
    }
    const result = await sendDelegationReply({
      fromChatId: chat.id,
      body,
      historySeq,
      contentHash,
      idempotencyKey: req.body?.idempotencyKey || '',
      delegationId,
    });
    if (!result.ok) return res.status(result.status || 400).json(result);
    return res.status(result.status || 201).json(result);
  });
}
