/**
 * HTTP API for plan-execution delegations.
 */

import { canChatControlDelegation, delegationController, resolveDelegationScopeChat } from '../delegation-control.js';
import { loadChats } from '../persist/chats-persist.js';
import { readChatPlanDocument } from '../chat-plan-persist.js';
import { createDelegationService, flushDelegationOutbox, readDelegationAcceptContext } from '../delegation-service.js';
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
import { resolveDelegationAckActorFromRequest } from '../delegation-ack-actor.js';
import { hashDelegationUiActionTask, mintDelegationUiAction } from '../delegation-start-context.js';
import { resolveTodoReviewReportLinkState } from '../todo-review-read.js';
import { readDelegationMaterialRevisionForRecord } from '../delegation-material-revision.js';
import { buildDelegationOutcomes } from '../model-pick-history.js';
import { buildPricedModelStats } from '../model-pick-priced-stats.js';
import { buildCostProxyQualityReportFromRecords } from '../model-pick-cost-proxy.js';
import { loadModelPickRecords } from '../persist/model-pick-decisions-persist.js';
import { readBenchmarkSnapshots } from '../persist/benchmark-snapshots-persist.js';
import { readUsageEvents } from '../persist/usage-persist.js';
import { createRollingWindowCache } from '../usage-window-cache.js';
import { getOpenRouterEndpointPricing } from '../openrouter/openrouter-pricing-cache.js';
import { summarizeModelPickExecutionCounters } from '../model-pick-decisions.js';
import {
  buildDelegationQualityCycles,
  summarizeDelegationCycleCostMetrics,
} from '../delegation-cycle-outcomes.js';
import { buildDelegationLoopReport } from '../delegation-loop-report.js';
import { loadDelegationWorkflows } from '../persist/delegation-workflows-persist.js';
import { listHarnessCatalog } from '../harness-catalog.js';
import { getHarnessUsageLimit } from '../harness-usage-limits.js';
import {
  applyParentWorkflowUpdate,
  getDelegationWorkflow,
  resolveDelegationWorkflowRow,
} from '../delegation-workflow.js';
import { resolveWorkflowMaterialRevisionForLeaf } from '../todo-leaf-material.js';
import { resolveDataPath } from '../runtime-paths.js';
import { buildReviewLoopStats } from '../review-loop-stats.js';
import { msg } from '../messages.js';
import { buildDelegationTreeSnapshot } from '../delegation-tree-view.js';
import { buildStatsCacheKey, createStatsTtlCache } from '../stats-ttl-cache.js';
import { canChatCancelDelegationTree } from '../delegation-tree-cancel.js';

/** An enabled harness with no delegation job in this window is "unused". */
export const DELEGATION_UNUSED_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * First non-nullish body value as a trimmed string, or `undefined` when the
 * client omitted every candidate (an explicit empty string is preserved).
 *
 * @param {...unknown} candidates
 * @returns {string | undefined}
 */
function readOptionalBodyString(...candidates) {
  for (const value of candidates) {
    if (value !== undefined && value !== null) return String(value).trim();
  }
  return undefined;
}

/**
 * The service returns `update_in_progress` with an English fallback for MCP
 * callers; HTTP clients get the localized message.
 *
 * @param {import('http').IncomingMessage} req
 * @param {object} result
 * @returns {object}
 */
function withLocalizedGateError(req, result) {
  if (result?.code !== 'update_in_progress') return result;
  return { ...result, error: msg(req, 'update.notAcceptingRuns') };
}

/** Rolling window (days) of ledger events behind the priced statistics. */
const PRICED_STATS_WINDOW_DAYS = 30;
const PRICED_STATS_WINDOW_MS = PRICED_STATS_WINDOW_DAYS * 24 * 60 * 60 * 1000;

// Usage events are read from disk; a short TTL keeps repeated stats polls cheap.
const usageEventsWindowCache = createRollingWindowCache({
  read: (range) => readUsageEvents(range),
  windowMs: PRICED_STATS_WINDOW_MS,
});

/**
 * Local-only inputs of the priced statistics (pick records, ledger events,
 * benchmark snapshots, OpenRouter pricing cache). A failed read degrades that
 * input to empty instead of failing the stats feed.
 *
 * @param {object[]} rows scoped delegation rows
 * @param {object[] | null} [picks] already-loaded pick records (one read per feed)
 * @returns {ReturnType<typeof buildPricedModelStats> | null}
 */
function buildPricedStatsSafe(rows, picks = null) {
  const safe = (read, fallback) => {
    try {
      return read();
    } catch {
      return fallback;
    }
  };
  const snapshots = safe(() => readBenchmarkSnapshots({}), { snapshots: [], sourcePreferences: {} });
  try {
    return buildPricedModelStats({
      rows,
      picks: Array.isArray(picks) ? picks : safe(() => loadModelPickRecords(), []),
      usageEvents: safe(() => usageEventsWindowCache.get(), []),
      snapshots: snapshots?.snapshots || [],
      sourcePreferences: snapshots?.sourcePreferences,
      openrouterPricingFor: (modelId) => safe(() => getOpenRouterEndpointPricing(modelId)?.pricing || null, null),
      windowMs: PRICED_STATS_WINDOW_MS,
    });
  } catch {
    return null;
  }
}

/**
 * Cost-proxy quality report over the persisted `model_pick` records. Local-only
 * and side-effect free; an unreadable store degrades the block to `null` rather
 * than failing the statistics feed.
 *
 * @param {object[] | null} [picks] already-loaded pick records (one read per feed)
 * @returns {ReturnType<typeof buildCostProxyQualityReportFromRecords> | null}
 */
function buildCostProxyQualitySafe(picks = null) {
  try {
    return buildCostProxyQualityReportFromRecords(
      Array.isArray(picks) ? picks : loadModelPickRecords(),
    );
  } catch {
    return null;
  }
}

/**
 * One resilient read of the pick store shared by the priced-stats feed and the
 * cost-proxy quality block; `null` when the store is unreadable.
 *
 * @returns {object[] | null}
 */
function loadModelPickRecordsSafe() {
  try {
    return loadModelPickRecords();
  } catch {
    return null;
  }
}

/**
 * Adds `cost_per_pass`, `price_per_1m` and `benchmark` to outcome rows (one per
 * harness x base model x role); the per-level breakdown is `priced_stats`.
 *
 * @param {object[]} outcomeRows
 * @param {ReturnType<typeof buildPricedModelStats> | null} priced
 */
function attachPricedRollup(outcomeRows, priced) {
  if (!priced || !Array.isArray(outcomeRows)) return;
  for (const row of outcomeRows) {
    const hit = priced.by_model_role[`${row.harness}/${String(row.model || '').toLowerCase()}|${row.role}`];
    row.cost_per_pass = hit?.cost_per_pass ?? null;
    row.price_per_1m = hit?.price_per_1m ?? null;
    row.benchmark = hit?.benchmark ?? null;
    row.billing_class = hit?.billing_class ?? null;
  }
}

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

  /** Scope gate chat of a delegation: controller first, historical parent as fallback. */
  function findDelegationScopeChat(req, row) {
    return resolveDelegationScopeChat(row, (id) => findParent(req, id));
  }

  const statsCache = createStatsTtlCache({ ttlMs: Number(process.env.CRETLI_DELEGATION_STATS_TTL_MS ?? 1500) });

  /** Whole-table aggregates shared by a burst of panel requests (same scope). */
  function readStatsCached(name, req, compute) {
    return statsCache.read(buildStatsCacheKey(name, req), compute);
  }

  // Express 4 does not catch rejected promises from async handlers.
  function sendStatsError(res, err) {
    return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
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
    const parent = findDelegationScopeChat(req, row);
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

  app.get('/api/delegations/runtime', async (req, res) => {
    try {
    const snapshot = await readStatsCached('runtime', req, () => {
      const scoped = collectScopedDelegationHealthRows((row) => isDelegationInScope(req, row));
      return buildDelegationRuntimeHealthSnapshot({
        worker: getDelegationRuntimeWorkerStats(),
        delegations: scoped.delegations,
        mailbox: scoped.mailbox,
        storeError: scoped.storeError,
      });
    });
    res.json({ ok: true, runtime: snapshot });
    } catch (err) {
      sendStatsError(res, err);
    }
  });

  // Read-only review-loop baseline (rounds to PASS, first-pass rate, findings)
  // per workspace; scoped like `/api/delegations`. Fields: docs/review-lessons.md.
  app.get('/api/review-loop-stats', async (req, res) => {
    try {
    const stats = await readStatsCached('review-loop', req, () => {
      const delegations = loadDelegations().filter((row) => isDelegationInScope(req, row));
      return buildReviewLoopStats({
        delegations,
        workflows: loadDelegationWorkflows(),
        workspaceFolder: String(req.query?.workspaceFolder || '').trim(),
      });
    });
    return res.json({ ok: true, ...stats });
    } catch (err) {
      return sendStatsError(res, err);
    }
  });

  // Model x role outcomes over the observed window (task 6 UI feed; no UI here)
  // plus the enabled harnesses with no job in the last 14 days. Aggregates are
  // scoped exactly like `GET /api/delegations`: only jobs of chats the caller can
  // see (workspace + widget installation) contribute.
  app.get('/api/delegations/stats', async (req, res) => {
    try {
    const payload = await readStatsCached('stats', req, async () => {
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
    const cycles = buildDelegationQualityCycles({
      rows,
      includeOpen: true,
      leafId: String(req.query?.leafId || req.query?.leaf_id || '').trim(),
    });
    const cycleMetrics = summarizeDelegationCycleCostMetrics(cycles);
    const pickCounters = summarizeModelPickExecutionCounters(rows, {
      cycles: cycleMetrics.closedCycleCount,
    });
    const leafId = String(req.query?.leafId || req.query?.leaf_id || '').trim();
    const loopLeaves = buildDelegationLoopReport({
      rows,
      cycles,
      workflows: loadDelegationWorkflows(),
      leafId,
    });
    const picks = loadModelPickRecordsSafe();
    const priced = buildPricedStatsSafe(rows, picks);
    const costProxyQuality = buildCostProxyQualitySafe(picks);
    attachPricedRollup(outcomes.list, priced);
    attachPricedRollup(Object.values(outcomes.roles || {}).flatMap((role) => Object.values(role)), priced);
    return {
      ok: true,
      ...outcomes,
      priced_stats: priced,
      cost_proxy_quality: costProxyQuality,
      pick_execution: pickCounters,
      cycle_cost: cycleMetrics,
      loop: {
        leaves: loopLeaves,
        generated_at: new Date().toISOString(),
      },
      unused_14d: unused14d,
      unused_14d_error: unused14dError,
    };
    });
    return res.json(payload);
    } catch (err) {
      return sendStatsError(res, err);
    }
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
    // One lockout lookup per executor/workspace within this list call.
    const exclusionCache = new Map();
    res.json({
      ok: true,
      delegations: page.items.map((row) => summarizeDelegation(row, {
        mailbox: mailboxById.get(row.id) || [],
        exclusionCache,
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

  // Read-only tree seen from the chat in the path. The view is derived from
  // that chat (root: all descendants; child: own subtree + ancestors), so a
  // child chat id can never expose a sibling branch or another tree. Callers
  // are already gated by auth + workspace/widget scope like the other reads.
  app.get('/api/chats/:id/delegation-tree', (req, res) => {
    const chat = findParent(req, req.params.id);
    if (!chat) return res.status(404).json({ ok: false, error: 'Chat not found.' });
    const denied = rejectIfOutOfWorkspace(req, chat);
    if (denied) return res.status(denied.status).json(denied.json);
    const tree = buildDelegationTreeSnapshot({
      chatId: chat.id,
      chat,
      rootDelegationId: String(req.query?.rootDelegationId || req.query?.root_delegation_id || '').trim(),
      status: String(req.query?.status || '').trim(),
      cursor: req.query?.cursor,
      limit: req.query?.limit,
    });
    return res.json({ ok: true, tree });
  });

  // Human-only: mints the single-use proof for a direct executor choice made in
  // the UI inside an automatic orchestrator chat. Agent/MCP/widget channels are
  // refused, so a model cannot manufacture a manual selection.
  app.post('/api/chats/:id/delegation-ui-actions', (req, res) => {
    const chat = findParent(req, req.params.id);
    if (!chat) return res.status(404).json({ ok: false, error: 'Chat not found.' });
    const denied = rejectIfOutOfWorkspace(req, chat);
    if (denied) return res.status(denied.status).json(denied.json);
    if (resolveDelegationAckActorFromRequest(req) !== 'human') {
      return res.status(403).json({
        ok: false,
        code: 'ui_action_forbidden',
        error: 'UI actions can only be created from the human UI channel.',
      });
    }
    const executor = req.body?.executor || {};
    const sourceKind = String(req.body?.sourceKind || 'plan');
    let taskText = String(req.body?.taskText || '').trim();
    if (sourceKind === 'message') {
      const found = resolveHistoryMessageSource(chat.id, {
        historySeq: req.body?.historySeq, contentHash: req.body?.contentHash,
      });
      if (!found.ok) return res.status(409).json(found);
      taskText = found.text;
    } else if (sourceKind !== 'text') {
      const cwd = resolveSdkCwdForChat(chat, ctx.workspaceDirForAgent);
      taskText = readChatPlanDocument({ cwd, chatId: chat.id }).body;
    }
    if (!taskText) return res.status(409).json({ ok: false, code: 'source_unavailable', error: 'A task source is required.' });
    const minted = mintDelegationUiAction({
      parentChatId: chat.id,
      workspaceFolder: String(chat.workspaceFolder || '').trim(),
      role: req.body?.role || req.body?.requestedRole || '',
      harness: executor.transport || req.body?.harness,
      model: executor.model || req.body?.model,
      taskHash: hashDelegationUiActionTask(taskText),
    });
    if (!minted.ok) return res.status(400).json(minted);
    return res.status(201).json({ ok: true, uiActionId: minted.id, expiresAt: minted.expiresAt });
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
      idempotencyKey: req.body?.idempotencyKey || req.body?.idempotency_key || '',
      extraInstructions: req.body?.extraInstructions || '',
      pickReason: req.body?.pickReason || req.body?.pick_reason || '',
      pickId: req.body?.pickId || req.body?.pick_id || '',
      manualSource: req.body?.manualSource || req.body?.manual_source || '',
      pickFallbackFrom: req.body?.pickFallbackFrom || req.body?.pick_fallback_from || '',
      continuationOf: req.body?.continuationOf || req.body?.continuation_of || '',
      // Trusted envelope: the actor is derived from the authenticated
      // transport. The proof id is a capability bound to chat/workspace/role/
      // executor/task and is useless without the human channel.
      trustedStart: {
        actor: resolveDelegationAckActorFromRequest(req),
        uiActionId: req.body?.uiActionId || '',
      },
      title: req.body?.title || '',
      sourceKind: req.body?.sourceKind || '',
      historySeq: req.body?.historySeq,
      contentHash: req.body?.contentHash || '',
      taskText: req.body?.taskText || '',
      executionMode: req.body?.executionMode || '',
      assignment: req.body?.assignment || '',
      reviewSubject: req.body?.reviewSubject ?? req.body?.review_subject,
      requestedRole: req.body?.requestedRole || req.body?.requested_role || '',
      leafId: req.body?.leafId ?? req.body?.leaf_id ?? req.body?.todoId ?? req.body?.todo_id,
      resumeRounds: req.body?.resumeRounds ?? req.body?.resume_rounds,
      maxRounds: req.body?.maxRounds ?? req.body?.max_rounds,
      allowFlashReview: req.body?.allowFlashReview === true || req.body?.allow_flash_review === true,
      allowHighInfra: req.body?.allowHighInfra === true || req.body?.allow_high_infra === true,
      allowPremium: req.body?.allowPremium === true || req.body?.allow_premium === true,
      allowChildDelegations: req.body?.allowChildDelegations === true || req.body?.allow_child_delegations === true,
      returnWhenStarting: req.body?.returnWhenStarting === true,
      deadlineAt: req.body?.deadlineAt ?? req.body?.deadline_at,
      allowVerifyFailedReview: req.body?.allowVerifyFailedReview === true
        || req.body?.allow_verify_failed_review === true,
      allowRecheck: req.body?.allowRecheck === true || req.body?.allow_recheck === true,
      planReviewerSessionId: req.body?.planReviewerSessionId ?? req.body?.plan_reviewer_session_id,
      resumeSessionOf: req.body?.resumeSessionOf ?? req.body?.resume_session_of,
      planReviewerPhase: req.body?.planReviewerPhase ?? req.body?.plan_reviewer_phase,
      planReviewerSlot: req.body?.planReviewerSlot ?? req.body?.plan_reviewer_slot,
      exchangeOfDelegationId: req.body?.exchangeOfDelegationId
        ?? req.body?.exchange_of_delegation_id
        ?? req.body?.originDelegationId
        ?? req.body?.origin_delegation_id,
    });
    if (!result.ok) {
      return res.status(result.status || 400).json(withLocalizedGateError(req, result));
    }
    return res.status(result.status || 201).json(result);
  });

  app.get('/api/delegations/:id', (req, res) => {
    const row = service.getById(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'Delegation not found.' });
    const parent = findDelegationScopeChat(req, row);
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
    // Accept context for the delegation card: the values the accept action must
    // echo back (`docs/todo-review-contract.md` §7.3). The material revision is
    // read from the delegation's frozen execution folder, not the workflow row.
    // `todoRevision` is the current revision of the logical todo the job is
    // attributed to; an empty one means there is nothing to pin (unattributed
    // job, or the todo is gone), never "up to date".
    if (field === 'accept') {
      const acceptContext = readDelegationAcceptContext(row, { dataDir: ctx.dataDir });
      return res.json({
        ok: true,
        delegationId: row.id,
        attemptId: String(row.attemptId || ''),
        materialRevision: readDelegationMaterialRevisionForRecord(row),
        todoId: acceptContext.todoId,
        todoRevision: acceptContext.todoRevision,
        todoResolution: acceptContext.resolution,
      });
    }
    // Honest state of the "open the delegation report" link, resolved on demand
    // so a reviewer row in `todo.review` never needs a report body or a chat id
    // (`docs/todo-review-contract.md` §11.3). The list read stays cheap: this is
    // only called when a details panel actually uses the link.
    if (field === 'report-link') {
      const chatId = String(row.childChatId || '').trim();
      const chatExists = !chatId || loadChats().some((chat) => {
        return chat && chat.id === chatId && chat.deleted !== true;
      });
      return res.json({
        ok: true,
        delegationId: row.id,
        chatId,
        reportLinkState: resolveTodoReviewReportLinkState({
          delegation: row,
          delegationExists: true,
          chatExists,
        }),
      });
    }
    res.json({ ok: true, delegation: row });
  });

  app.post('/api/delegations/:id/cancel', async (req, res) => {
    const row = service.getById(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'Delegation not found.' });
    const parent = findDelegationScopeChat(req, row);
    if (!parent) return res.status(404).json({ ok: false, error: 'Delegation not found.' });
    const denied = rejectIfOutOfWorkspace(req, parent);
    if (denied) return res.status(denied.status).json(denied.json);
    if (req.body?.tree === true || req.body?.tree === 'true') {
      // A caller that names itself (MCP bridge) must be the job's parent or the
      // tree root chat; the operator/UI path sends no chat id and keeps the
      // workspace authorization above.
      const actingChatId = String(req.body?.chatId || req.body?.chat_id || '').trim();
      if (actingChatId && !canChatCancelDelegationTree(row, actingChatId)) {
        return res.status(403).json({
          ok: false,
          error: 'Tree cancel is limited to jobs started by the calling chat (or its tree root chat).',
          code: 'out_of_scope',
        });
      }
      const summary = await service.cancelTree(req.params.id);
      return res.status(summary.status || 200).json(summary);
    }
    // Single-job cancel: a caller that names itself (MCP bridge) must own the
    // job; the operator/UI path sends no chat id.
    const singleActingChatId = String(req.body?.chatId || req.body?.chat_id || '').trim();
    if (singleActingChatId && !canChatCancelDelegationTree(row, singleActingChatId)) {
      return res.status(403).json({
        ok: false,
        error: 'Cancel is limited to jobs started by the calling chat (or its tree root chat).',
        code: 'out_of_scope',
      });
    }
    const result = await service.cancel(req.params.id);
    return res.status(result.status || 200).json(result);
  });

  app.post('/api/delegations/:id/confirm-stop', (req, res) => {
    const row = service.getById(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'Delegation not found.' });
    const parent = findDelegationScopeChat(req, row);
    if (!parent) return res.status(404).json({ ok: false, error: 'Delegation not found.' });
    const denied = rejectIfOutOfWorkspace(req, parent);
    if (denied) return res.status(denied.status).json(denied.json);
    const result = service.confirmManualSlotRelease(req.params.id, {
      confirmation: req.body?.confirmation ?? req.body?.confirmed,
      note: req.body?.note || req.body?.text,
      actor: resolveDelegationAckActorFromRequest(req),
    });
    return res.status(result.status || 200).json(result);
  });

  app.post('/api/delegations/:id/ack', (req, res) => {
    const row = service.getById(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'Delegation not found.' });
    const parent = findDelegationScopeChat(req, row);
    if (!parent) return res.status(404).json({ ok: false, error: 'Delegation not found.' });
    const denied = rejectIfOutOfWorkspace(req, parent);
    if (denied) return res.status(denied.status).json(denied.json);
    const reason = String(req.body?.reason || 'reviewed').trim().toLowerCase() || 'reviewed';
    const expectedAttemptId = String(req.body?.attemptId || req.body?.attempt_id || '').trim();
    const expectedMaterialRevision = String(
      req.body?.materialRevision || req.body?.material_revision || '',
    ).trim();
    // Human acceptance is a distinct action: it carries the attempt and material
    // the card displayed and goes through `/accept`. A generic ack must never
    // create a `manual` acceptance from a stale screen, so an `accepted` reason
    // without those expectations is refused here (`docs/todo-review-contract.md`
    // §7.3). A plain `reviewed` ack only dismisses a card and is unaffected.
    // An empty material revision means "detection unavailable" (no git), so only
    // the attempt is mandatory; a known revision is still compared server-side.
    if (reason === 'accepted' && !expectedAttemptId) {
      return res.status(400).json({
        ok: false,
        error: 'Use POST /api/delegations/:id/accept with attemptId (and materialRevision when known) to accept a delegation.',
        code: 'accept_expectation_required',
      });
    }
    const result = service.acknowledge(req.params.id, {
      reason,
      // Derived from the authenticated channel, never from the body: a widget or
      // MCP token is `agent`, a plain session is `human` (§7.2).
      actor: resolveDelegationAckActorFromRequest(req),
      expectedAttemptId,
      expectedMaterialRevision,
    });
    return res.status(result.status || 200).json(result);
  });

  // Explicit human acceptance from the delegation card. Distinct from a plain
  // `reviewed` ack: it records `reason: 'accepted'` with a `human` actor and
  // carries the attempt/material the card displayed so a stale screen is
  // rejected (409) instead of accepted (`docs/todo-review-contract.md` §7).
  app.post('/api/delegations/:id/accept', (req, res) => {
    const row = service.getById(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'Delegation not found.' });
    const parent = findDelegationScopeChat(req, row);
    if (!parent) return res.status(404).json({ ok: false, error: 'Delegation not found.' });
    const denied = rejectIfOutOfWorkspace(req, parent);
    if (denied) return res.status(denied.status).json(denied.json);
    const expectedAttemptId = String(req.body?.attemptId || req.body?.attempt_id || '').trim();
    // `undefined` = omitted by the client; `''` = the card captured an empty
    // value ("detection unavailable"). The service treats them differently.
    const expectedMaterialRevision = readOptionalBodyString(
      req.body?.materialRevision,
      req.body?.material_revision,
    );
    if (!expectedAttemptId) {
      return res.status(400).json({
        ok: false,
        error: 'attemptId is required to accept a delegation (materialRevision is compared when known).',
        code: 'accept_expectation_required',
      });
    }
    const result = service.acknowledge(req.params.id, {
      reason: 'accepted',
      actor: resolveDelegationAckActorFromRequest(req),
      expectedAttemptId,
      expectedMaterialRevision,
      expectedTodoRevision: readOptionalBodyString(req.body?.todoRevision, req.body?.todo_revision),
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
    const parent = findDelegationScopeChat(req, row);
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
    if (!canChatControlDelegation(row, chat.id)) {
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

  // Parent acknowledgement over the remote MCP transport (`delegation_ack`).
  // Same chat-scope rules as `delegation-rate`: the calling session must be the
  // job parent, so a child chat and a cross-parent id are rejected before the
  // service runs. The existing `POST /api/delegations/:id/ack` card route is
  // untouched.
  app.post('/api/chats/:id/delegation-ack', (req, res) => {
    const chat = findParent(req, req.params.id);
    if (!chat) return res.status(404).json({ ok: false, error: 'Chat not found.' });
    const denied = rejectIfOutOfWorkspace(req, chat);
    if (denied) return res.status(denied.status).json(denied.json);
    if (String(chat.delegationParentChatId || '').trim()) {
      return res.status(409).json({
        ok: false,
        error: 'Only the parent chat of this session can acknowledge a job.',
        code: 'ack_parent_required',
      });
    }
    const delegationId = String(req.body?.delegationId || '').trim();
    if (!delegationId) {
      return res.status(400).json({ ok: false, error: 'delegationId is required.', code: 'validation' });
    }
    const row = service.getById(delegationId);
    if (!row) return res.status(404).json({ ok: false, error: 'Delegation not found.' });
    if (!canChatControlDelegation(row, chat.id)) {
      return res.status(403).json({
        ok: false,
        error: 'This delegation belongs to another parent chat.',
        code: 'OUT_OF_SCOPE',
      });
    }
    const result = service.acknowledge(delegationId, {
      reason: String(req.body?.reason || 'reviewed'),
      // The remote-MCP transport is an agent channel, never the human card.
      actor: resolveDelegationAckActorFromRequest(req, { remoteMcp: true }),
    });
    return res.status(result.status || 200).json(result);
  });

  // Orchestration takeover (`todo_takeover`): the calling chat becomes
  // the controller of a todo subtree. Validation, transfer and recovery live in
  // `delegationService.orchestrationTakeover`.
  async function orchestrationTakeoverHandler(req, res, todoRoute = false) {
    const chat = findParent(req, todoRoute ? req.body?.chatId : req.params.id);
    if (!chat) return res.status(404).json({ ok: false, error: 'Chat not found.' });
    const denied = rejectIfOutOfWorkspace(req, chat);
    if (denied) return res.status(denied.status).json(denied.json);
    const result = await service.orchestrationTakeover({
      chatId: chat.id,
      workspaceFolder: chat.workspaceFolder,
      todoId: todoRoute ? req.params.id : req.body?.todoId,
      idempotencyKey: req.body?.idempotencyKey,
      reason: req.body?.reason,
      forceUnavailable: req.body?.forceUnavailable === true,
      scope: req.body?.scope,
    });
    return res.status(result.status || 200).json(result);
  }
  app.post('/api/chats/:id/orchestration-takeover', (req, res) => orchestrationTakeoverHandler(req, res));
  app.post('/api/todos/:id/orchestration-takeover', (req, res) => orchestrationTakeoverHandler(req, res, true));

  app.post('/api/delegations/:id/retry', async (req, res) => {
    const row = service.getById(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'Delegation not found.' });
    const parent = findDelegationScopeChat(req, row);
    if (!parent) return res.status(404).json({ ok: false, error: 'Delegation not found.' });
    const denied = rejectIfOutOfWorkspace(req, parent);
    if (denied) return res.status(denied.status).json(denied.json);
    const result = await service.retry(req.params.id);
    return res.status(result.status || 200).json(withLocalizedGateError(req, result));
  });

  app.post('/api/delegations/:id/retry-delivery', async (req, res) => {
    const row = service.getById(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'Delegation not found.' });
    const parent = findDelegationScopeChat(req, row);
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
    const parentChatId = delegationController(delegation) || String(chat.delegationParentChatId || '').trim();
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
    const leafId = String(req.query?.leafId || req.query?.leaf_id || req.query?.todoId || req.query?.todo_id || '').trim();
    const workflow = resolveDelegationWorkflowRow({ parentChatId: chat.id, leafId })
      || getDelegationWorkflow(chat.id, leafId);
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
      const workspaceFolder = workspaceFolderFrom(req) || chat.workspaceFolder;
      const leafId = String(req.body?.leafId ?? req.body?.leaf_id ?? req.body?.todoId ?? req.body?.todo_id ?? '').trim();
      const materialRevision = resolveWorkflowMaterialRevisionForLeaf({
        dataDir: resolveDataPath(),
        workspaceFolder,
        leafId,
        clientRevision: String(req.body?.materialRevision ?? req.body?.material_revision ?? '').trim(),
      });
      const workflow = applyParentWorkflowUpdate({
        parentChatId: chat.id,
        leafId,
        workspaceFolder,
        role: req.body?.role,
        resumeRounds: req.body?.resumeRounds === true || req.body?.resume_rounds === true,
        round: req.body?.round,
        maxRounds: req.body?.maxRounds ?? req.body?.max_rounds,
        lastImplementer: req.body?.lastImplementer ?? req.body?.last_implementer,
        lastModel: req.body?.lastModel ?? req.body?.last_model,
        lastReviewer: req.body?.lastReviewer ?? req.body?.last_reviewer,
        findingsText: req.body?.findingsText ?? req.body?.findings_text,
        findingsHash: req.body?.findingsHash ?? req.body?.findings_hash,
        lastVerdict: req.body?.lastVerdict ?? req.body?.last_verdict,
        reportText: req.body?.reportText ?? req.body?.report_text,
        fanoutVerdicts: req.body?.fanoutVerdicts ?? req.body?.fanout_verdicts,
        stopReason: req.body?.stopReason ?? req.body?.stop_reason,
        clearStop: req.body?.clearStop === true || req.body?.clear_stop === true,
        deadlineAt: req.body?.deadlineAt ?? req.body?.deadline_at,
        budgetTokens: req.body?.budgetTokens ?? req.body?.budget_tokens,
        budgetCostUsd: req.body?.budgetCostUsd ?? req.body?.budget_cost_usd,
        treeBudgetTokens: req.body?.treeBudgetTokens ?? req.body?.tree_budget_tokens,
        treeBudgetCostUsd: req.body?.treeBudgetCostUsd ?? req.body?.tree_budget_usd,
        rejectedFindings: req.body?.rejectedFindings ?? req.body?.rejected_findings,
        // A blank resolution keeps the stored revision instead of clearing it.
        materialRevision: materialRevision || undefined,
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
