/**
 * HTTP API for plan-execution delegations.
 */

import { loadChats } from '../persist/chats-persist.js';
import { readChatPlanDocument } from '../chat-plan-persist.js';
import { createDelegationService } from '../delegation-service.js';
import { isDelegationModelAvailable } from '../delegation-executor.js';
import { hasChatRunAdapter, listChatRunAdapterTransports } from '../chat-run-service.js';
import { resolveSdkCwdForChat } from '../workspace.js';

/**
 * @param {import('express').Express} app
 * @param {{
 *   workspaceDirForAgent: (p: string | null) => string,
 * }} ctx
 */
export function registerDelegationsRoutes(app, ctx) {
  const service = createDelegationService({
    workspaceDirForAgent: ctx.workspaceDirForAgent,
    isModelAvailable: isDelegationModelAvailable,
  });

  function findParent(req, id) {
    const chat = loadChats().find((row) => row.id === id);
    if (!chat) return null;
    if (req.widgetAccess && chat.widgetInstallationId !== req.widgetAccess.installationId) return null;
    return chat;
  }

  app.get('/api/chats/:id/plan', (req, res) => {
    const chat = findParent(req, req.params.id);
    if (!chat) return res.status(404).json({ ok: false, error: 'Chat not found.' });
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
    res.json({ ok: true, delegations: service.listForParent(chat.id) });
  });

  app.post('/api/chats/:id/delegations', async (req, res) => {
    const chat = findParent(req, req.params.id);
    if (!chat) return res.status(404).json({ ok: false, error: 'Chat not found.' });
    const result = await service.createAndStart({
      parentChatId: chat.id,
      executor: req.body?.executor || {},
      planRevision: req.body?.planRevision,
      idempotencyKey: req.body?.idempotencyKey || '',
      extraInstructions: req.body?.extraInstructions || '',
      title: req.body?.title || '',
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
    res.json({ ok: true, delegation: row });
  });

  app.post('/api/delegations/:id/cancel', async (req, res) => {
    const row = service.getById(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'Delegation not found.' });
    if (!findParent(req, row.parentChatId)) {
      return res.status(404).json({ ok: false, error: 'Delegation not found.' });
    }
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
}
