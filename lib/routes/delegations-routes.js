/**
 * HTTP API for plan-execution delegations.
 */

import { loadChats } from '../persist/chats-persist.js';
import { readChatPlanDocument } from '../chat-plan-persist.js';
import { createDelegationService, flushDelegationOutbox } from '../delegation-service.js';
import { isDelegationModelAvailable } from '../delegation-executor.js';
import { hasChatRunAdapter, listChatRunAdapterTransports } from '../chat-run-service.js';
import { resolveSdkCwdForChat } from '../workspace.js';
import { isChatInWorkspace } from '../mcp/builtin/tool-context.js';
import { resolveHistoryMessageSource } from '../delegation-source.js';
import { listChatMailbox, retryMailboxMessage, sendDelegationReply } from '../delegation-mailbox.js';
import { getMailboxMessageById, loadMailboxMessages } from '../persist/delegation-mailbox-persist.js';
import { listDelegationsForChat, getDelegationById, loadDelegations } from '../persist/delegations-persist.js';
import { getDelegationRuntimeWorkerStats } from '../delegation-runtime-worker.js';
import { buildDelegationRuntimeHealthSnapshot, collectScopedDelegationHealthRows } from '../delegation-health.js';
import {
  classifyDelegationAttention,
  groupMailboxByDelegation,
  pageDelegationAttempts,
  pageDelegationOutbox,
  pageDelegationRows,
  pageDelegationText,
  summarizeDelegation,
} from '../delegation-query.js';
import { listDelegationAdapterCapabilities } from '../delegation-adapter-capabilities.js';
import { buildDelegationOutcomes } from '../model-pick-history.js';
import { listHarnessCatalog } from '../harness-catalog.js';
import { getHarnessUsageLimit } from '../harness-usage-limits.js';
import {
  applyDelegationWorkflowPatch,
  getDelegationWorkflow,
} from '../delegation-workflow.js';

/** An enabled harness with no delegation job in this window is "unused". */
export const DELEGATION_UNUSED_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * @param {import('express').Express} app
 * @param {{
 *   workspaceDirForAgent: (p: string | null) => string,
 *   dataDir?: string,
 *   listHarnessCatalog?: () => Promise<object[]>,
 * }} ctx
 */
export function registerDelegationsRoutes(app, ctx) {
  const service = createDelegationService({
    workspaceDirForAgent: ctx.workspaceDirForAgent,
    dataDir: ctx.dataDir,
    isModelAvailable: isDelegationModelAvailable,
  });
  const listCatalog = typeof ctx.listHarnessCatalog === 'function'
    ? ctx.listHarnessCatalog
    : listHarnessCatalog;

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

  function isDelegationInScope(req, row) {
    const parent = findParent(req, row.parentChatId);
    if (!parent) return false;
    return !rejectIfOutOfWorkspace(req, parent);
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
      usageLimits: listChatRunAdapterTransports()
        .filter((id) => id !== 'mock' && hasChatRunAdapter(id))
        .map((id) => ({ harness: id, usageLimit: getHarnessUsageLimit({ harness: id }) }))
        .filter((row) => row.usageLimit),
      capabilities: listDelegationAdapterCapabilities(),
    });
  });

  app.get('/api/delegations/runtime', (req, res) => {
    const scoped = collectScopedDelegationHealthRows((row) => isDelegationInScope(req, row));
    const snapshot = buildDelegationRuntimeHealthSnapshot({
      worker: getDelegationRuntimeWorkerStats(),
      delegations: scoped.delegations,
      mailbox: scoped.mailbox,
      storeError: scoped.storeError,
    });
    res.json({ ok: true, runtime: snapshot });
  });

  // Model x role outcomes over the observed window (task 6 UI feed; no UI here)
  // plus the enabled harnesses with no job in the last 14 days. Aggregates are
  // scoped exactly like `GET /api/delegations`: only jobs of chats the caller can
  // see (workspace + widget installation) contribute.
  app.get('/api/delegations/stats', async (req, res) => {
    const rows = loadDelegations().filter((row) => isDelegationInScope(req, row));
    const outcomes = buildDelegationOutcomes({ rows });
    /** @type {string[]} */
    let unused14d = [];
    // Distinguishes "catalog read failed" from "catalog reports nothing unused".
    // Without it, an empty `unused_14d` from a failed catalog would render the
    // misleading "every enabled harness has traffic" message.
    let unused14dError = false;
    try {
      const cutoff = Date.now() - DELEGATION_UNUSED_WINDOW_MS;
      const used = new Set(
        rows
          .filter((row) => {
            const at = Date.parse(String(row?.createdAt || row?.startedAt || ''));
            return at > 0 && at >= cutoff;
          })
          .map((row) => String(row?.executor?.transport || '').trim().toLowerCase())
          .filter(Boolean),
      );
      const catalog = await listCatalog();
      unused14d = catalog
        .filter((row) => row?.enabled === true)
        .map((row) => String(row.id || '').trim().toLowerCase())
        .filter((id) => id && !used.has(id));
    } catch {
      unused14d = [];
      unused14dError = true;
    }
    return res.json({
      ok: true,
      ...outcomes,
      unused_14d: unused14d,
      unused_14d_error: unused14dError,
    });
  });

  app.get('/api/delegations', (req, res) => {
    const attention = String(req.query?.attention || '').trim();
    const status = String(req.query?.status || '').trim();
    const mailboxById = groupMailboxByDelegation(loadMailboxMessages());
    const rows = loadDelegations().filter((row) => {
      const extras = { mailbox: mailboxById.get(row.id) || [] };
      if (!isDelegationInScope(req, row)) return false;
      if (status && String(row.status || '') !== status) return false;
      if (attention && classifyDelegationAttention(row, extras) !== attention) return false;
      return true;
    });
    const page = pageDelegationRows(rows, {
      cursor: req.query?.cursor,
      limit: req.query?.limit,
    });
    res.json({
      ok: true,
      delegations: page.items.map((row) => summarizeDelegation(row, {
        mailbox: mailboxById.get(row.id) || [],
      })),
      nextCursor: page.nextCursor,
    });
  });

  app.get('/api/chats/:id/delegations', (req, res) => {
    const chat = findParent(req, req.params.id);
    if (!chat) return res.status(404).json({ ok: false, error: 'Chat not found.' });
    const denied = rejectIfOutOfWorkspace(req, chat);
    if (denied) return res.status(denied.status).json(denied.json);
    const full = String(req.query?.full || '') === '1';
    const rows = listDelegationsForChat(chat.id);
    res.json({
      ok: true,
      delegations: full ? rows : rows.map(summarizeDelegation),
    });
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
      pickReason: req.body?.pickReason || req.body?.pick_reason || '',
      title: req.body?.title || '',
      sourceKind: req.body?.sourceKind || '',
      historySeq: req.body?.historySeq,
      contentHash: req.body?.contentHash || '',
      taskText: req.body?.taskText || '',
      executionMode: req.body?.executionMode || '',
      assignment: req.body?.assignment || '',
      returnWhenStarting: req.body?.returnWhenStarting === true,
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
    const field = String(req.query?.field || '').trim();
    if (field === 'summary') {
      const mailbox = loadMailboxMessages().filter((item) => String(item.delegationId || '') === row.id);
      return res.json({ ok: true, delegation: summarizeDelegation(row, { mailbox }) });
    }
    if (field === 'report' || field === 'plan') {
      return res.json({ ok: true, ...pageDelegationText(row, {
        field,
        cursor: req.query?.cursor,
        limit: req.query?.limit,
      }) });
    }
    if (field === 'attempts') {
      return res.json({ ok: true, ...pageDelegationAttempts(row, {
        cursor: req.query?.cursor,
        limit: req.query?.limit,
      }) });
    }
    if (field === 'outbox') {
      return res.json({ ok: true, ...pageDelegationOutbox(row, {
        cursor: req.query?.cursor,
        limit: req.query?.limit,
      }) });
    }
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
    const parent = findParent(req, row.parentChatId);
    if (!parent) return res.status(404).json({ ok: false, error: 'Delegation not found.' });
    const denied = rejectIfOutOfWorkspace(req, parent);
    if (denied) return res.status(denied.status).json(denied.json);
    const result = service.acknowledge(req.params.id, {
      reason: String(req.body?.reason || 'reviewed'),
    });
    return res.status(result.status || 200).json(result);
  });

  // User rating from the delegation card. The rater is fixed by the channel —
  // a body-supplied `rater` is ignored, so no request can impersonate the
  // parent. Scope is exactly the ack/cancel set: widget installation +
  // workspace, terminal jobs only (enforced in the service).
  app.post('/api/delegations/:id/rate', (req, res) => {
    const row = service.getById(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'Delegation not found.' });
    const parent = findParent(req, row.parentChatId);
    if (!parent) return res.status(404).json({ ok: false, error: 'Delegation not found.' });
    const denied = rejectIfOutOfWorkspace(req, parent);
    if (denied) return res.status(denied.status).json(denied.json);
    const result = service.rate(req.params.id, {
      rater: 'user',
      score: req.body?.score,
      tags: req.body?.tags,
      note: req.body?.note,
    });
    return res.status(result.status || 200).json(result);
  });

  // Parent rating over the remote MCP transport (stdio client). Chat-scoped
  // like `delegation-workflow`, so the calling session must be the job parent:
  // child chats and cross-parent ids are rejected before the service runs.
  app.post('/api/chats/:id/delegation-rate', (req, res) => {
    const chat = findParent(req, req.params.id);
    if (!chat) return res.status(404).json({ ok: false, error: 'Chat not found.' });
    const denied = rejectIfOutOfWorkspace(req, chat);
    if (denied) return res.status(denied.status).json(denied.json);
    if (String(chat.delegationParentChatId || '').trim()) {
      return res.status(409).json({
        ok: false,
        error: 'Only the parent chat of this session can rate a job.',
        code: 'rating_parent_required',
      });
    }
    const delegationId = String(req.body?.delegationId || '').trim();
    if (!delegationId) {
      return res.status(400).json({ ok: false, error: 'delegationId is required.', code: 'validation' });
    }
    const row = service.getById(delegationId);
    if (!row) return res.status(404).json({ ok: false, error: 'Delegation not found.' });
    if (String(row.parentChatId || '') !== chat.id) {
      return res.status(403).json({
        ok: false,
        error: 'This delegation belongs to another parent chat.',
        code: 'OUT_OF_SCOPE',
      });
    }
    const result = service.rate(delegationId, {
      rater: 'parent',
      score: req.body?.score,
      tags: req.body?.tags,
      note: req.body?.note,
    });
    return res.status(result.status || 200).json(result);
  });

  app.post('/api/delegations/:id/retry', async (req, res) => {
    const row = service.getById(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'Delegation not found.' });
    const parent = findParent(req, row.parentChatId);
    if (!parent) return res.status(404).json({ ok: false, error: 'Delegation not found.' });
    const denied = rejectIfOutOfWorkspace(req, parent);
    if (denied) return res.status(denied.status).json(denied.json);
    const result = await service.retry(req.params.id);
    return res.status(result.status || 200).json(result);
  });

  app.post('/api/delegations/:id/retry-delivery', async (req, res) => {
    const row = service.getById(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'Delegation not found.' });
    const parent = findParent(req, row.parentChatId);
    if (!parent) return res.status(404).json({ ok: false, error: 'Delegation not found.' });
    const denied = rejectIfOutOfWorkspace(req, parent);
    if (denied) return res.status(denied.status).json(denied.json);
    const mailboxId = String(req.body?.mailboxId || req.body?.messageId || '').trim();
    const attemptId = String(req.body?.attemptId || '').trim();
    await flushDelegationOutbox(row);
    const messages = loadMailboxMessages().filter((item) => {
      if (String(item.delegationId || '') !== row.id) return false;
      const status = String(item.status || '');
      if (status !== 'failed' && status !== 'uncertain') return false;
      if (attemptId && String(item.delegationAttemptId || '') !== attemptId) return false;
      return true;
    });
    if (!mailboxId) {
      return res.status(400).json({
        ok: false,
        error: 'mailboxId is required.',
        code: 'mailbox_id_required',
        retryableMailboxCount: messages.length,
      });
    }
    const wanted = messages.find((item) => item.id === mailboxId) || getMailboxMessageById(mailboxId);
    if (!wanted || String(wanted.delegationId || '') !== row.id) {
      return res.status(404).json({ ok: false, error: 'Mailbox message not found.', code: 'not_found' });
    }
    const retried = [await retryMailboxMessage(wanted.id)];
    const latest = getDelegationById(row.id) || row;
    const mailbox = loadMailboxMessages().filter((item) => String(item.delegationId || '') === latest.id);
    res.json({
      ok: true,
      status: 200,
      retried: retried.length,
      results: retried,
      delegation: summarizeDelegation(latest, { mailbox }),
    });
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
      replyKind: req.body?.replyKind || '',
      attemptId: req.body?.attemptId || '',
      runId: req.body?.runId || '',
      taskOutcome: req.body?.taskOutcome || '',
    });
    if (!result.ok) return res.status(result.status || 400).json(result);
    return res.status(result.status || 201).json(result);
  });

  app.get('/api/chats/:id/delegation-workflow', (req, res) => {
    const chat = findParent(req, req.params.id);
    if (!chat) return res.status(404).json({ ok: false, error: 'Chat not found.' });
    const denied = rejectIfOutOfWorkspace(req, chat);
    if (denied) return res.status(denied.status).json(denied.json);
    const workflow = getDelegationWorkflow(chat.id);
    return res.json({ ok: true, workflow });
  });

  app.post('/api/chats/:id/delegation-workflow', (req, res) => {
    const chat = findParent(req, req.params.id);
    if (!chat) return res.status(404).json({ ok: false, error: 'Chat not found.' });
    const denied = rejectIfOutOfWorkspace(req, chat);
    if (denied) return res.status(denied.status).json(denied.json);
    if (String(chat.delegationParentChatId || '').trim()) {
      return res.status(409).json({
        ok: false,
        error: 'Only the parent chat of this session can update workflow state.',
        code: 'workflow_parent_required',
      });
    }
    try {
      const workflow = applyDelegationWorkflowPatch({
        parentChatId: chat.id,
        workspaceFolder: workspaceFolderFrom(req) || chat.workspaceFolder,
        role: req.body?.role,
        round: req.body?.round,
        maxRounds: req.body?.maxRounds ?? req.body?.max_rounds,
        lastImplementer: req.body?.lastImplementer ?? req.body?.last_implementer,
        lastReviewer: req.body?.lastReviewer ?? req.body?.last_reviewer,
        findingsText: req.body?.findingsText ?? req.body?.findings_text,
        findingsHash: req.body?.findingsHash ?? req.body?.findings_hash,
        lastVerdict: req.body?.lastVerdict ?? req.body?.last_verdict,
        reportText: req.body?.reportText ?? req.body?.report_text,
        fanoutVerdicts: req.body?.fanoutVerdicts ?? req.body?.fanout_verdicts,
        stopReason: req.body?.stopReason ?? req.body?.stop_reason,
        clearStop: req.body?.clearStop === true || req.body?.clear_stop === true,
        deadlineAt: req.body?.deadlineAt ?? req.body?.deadline_at,
        materialRevision: req.body?.materialRevision ?? req.body?.material_revision,
        idempotencyKey: req.body?.idempotencyKey ?? req.body?.idempotency_key,
      });
      return res.json({
        ok: true,
        workflow,
        replayed: workflow.replayed === true,
      });
    } catch (err) {
      const status = Number(err?.status) || 409;
      return res.status(status).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        code: err?.code || 'idempotency_conflict',
      });
    }
  });
}
