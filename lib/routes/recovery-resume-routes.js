/**
 * REST route for the manual "Resume" action (leaf R12).
 *
 * `POST /api/chats/:id/runs/:logicalRunId/resume` with body
 * `{ expectedState, expectedRevision, idempotencyKey, confirmUnknown? }`.
 * Authentication is the app-wide middleware used by every other `/api/*` chat
 * action. All semantics live in `lib/recovery/recovery-resume.ts`.
 */

import {
  getChatRunAdapterCapabilities,
  probeChatRunLiveness,
  startChatRun,
  cancelChatRun,
} from '../chat-run-service.js';
import { loadSettings } from '../persist/settings.js';
import { resolveChatRestartRecoveryMode } from '../recovery/recovery-policy.ts';
import { getChatByIdAsync } from '../persist/chats-persist.js';
import { getChatByIdCompat } from '../persist/chats-sync-compat.js';
import { assertChatCanReceiveMessages } from '../chat-message-guard.js';
import { assertCanAcceptNewRun } from '../update-gate.js';
import { isRecoveryAdapterEnabled } from '../recovery/adapter-validation.ts';
import { createRecoveryResumeService, toSafeErrorCode } from '../recovery/recovery-resume.ts';
import { keepRunStopped, listChatRecoveryViews } from '../recovery/recovery-ui.ts';
import { isHarnessEnabled } from '../harness-enabled.js';
import { getHarnessUsageLimit } from '../harness-usage-limits.js';
import { withTimeout } from '../with-timeout.js';

/** Env-tunable positive integer with a default. */
function envMs(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** The HTTP response deadline: past it the route answers 202 `pending` and the resume keeps running detached. */
export const RESUME_HTTP_WAIT_MS = 5000;

/** A resume step slower than this (wall time, awaits included) is logged so the slow stage can be named. */
export const RESUME_SLOW_STEP_MS = 500;

/**
 * Run one resume step and warn when it exceeds the budget. Timing is observational:
 * it never changes the step's result.
 *
 * @template T
 * @param {string} label
 * @param {() => Promise<T> | T} work
 * @param {{ slowMs?: number, warn?: (message: string) => void }} [opts]
 * @returns {Promise<T>}
 */
async function timedStep(label, work, opts = {}) {
  const started = Date.now();
  try {
    return await work();
  } finally {
    const took = Date.now() - started;
    if (took > (opts.slowMs ?? RESUME_SLOW_STEP_MS)) {
      (opts.warn || console.warn)(`[recovery-resume] slow step ${label}: ${took}ms`);
    }
  }
}

const HTTP_STATUS_BY_RESULT = Object.freeze({
  resumed: 200,
  in_progress: 409,
  superseded: 409,
  reattach_deferred: 409,
  invalid: 400,
  not_found: 404,
  conflict: 409,
  already_recovering: 409,
  not_resumable: 409,
  cancelled: 409,
  waiting: 409,
  stopping: 409,
  executor_alive: 409,
  liveness_unknown: 409,
  limit_blocked: 429,
  family_blocked: 403,
  unsupported: 422,
  launch_failed: 502,
});

/**
 * Production collaborators for the resume service. Exported so tests and the
 * scheduler (R15) can build the same wiring.
 *
 * @param {Record<string, any>} [options]
 * @returns {Record<string, any>}
 */
export function createRuntimeRecoveryResumeService(options = {}) {
  const readSettings = options.loadSettings || loadSettings;
  const probeLiveness = options.probeLiveness || probeChatRunLiveness;
  const getCapabilities = options.getCapabilities || getChatRunAdapterCapabilities;
  const readHarnessUsageLimit = options.getHarnessUsageLimit || getHarnessUsageLimit;
  const assertRunAdmission = options.assertCanAcceptNewRun || assertCanAcceptNewRun;
  // The recovery service calls these two collaborators synchronously (mixed phase: sync compat read, legacy runtime).
  // The chat row is fetched through the async runtime BEFORE the service runs and parked here, so the synchronous
  // collaborators below never trigger a cold full-file chats parse in the middle of a resume.
  // Refcounted per chatId: concurrent resumes of one chat share the row until the last one finishes.
  /** @type {Map<string, { row: Record<string, any> | null, refs: number }>} */
  const prefetchedChats = new Map();
  const readChat = (/** @type {string} */ id) => {
    if (options.loadChats) return options.loadChats().find((/** @type {Record<string, any>} */ row) => row.id === id);
    return prefetchedChats.has(id) ? prefetchedChats.get(id)?.row : getChatByIdCompat(id);
  };
  const fetchChat = options.getChatByIdAsync || getChatByIdAsync;
  const assertChatPermission = options.assertChatCanReceiveMessages || assertChatCanReceiveMessages;
  const startContinuation = options.startChatRun || startChatRun;
  const cancelLaunchedTurn = options.cancelChatRun || cancelChatRun;
  const service = createRecoveryResumeService({
    store: options.store,
    // Automatic resumes are re-checked against the per-adapter enable gate here,
    // so no caller can bypass the scheduler's policy evaluation.
    isAdapterValidated: options.isAdapterValidated || isRecoveryAdapterEnabled,
    probeLiveness: (/** @type {{ run: Record<string, any> }} */ { run }) => {
      // Only the exact adapter run id proves "this run"; a chat-level probe
      // would count an unrelated newer turn as alive.
      const adapterRunId = String(run.acceptance?.adapterRunId || '').trim();
      if (!adapterRunId) return 'unknown';
      // Pass the prefetched row so the probe does not fall back to a sync chat read.
      const live = probeLiveness({ chatId: run.chatId, runId: adapterRunId, chat: readChat(run.chatId) });
      if (live.known && live.busy) return 'alive';
      // A missing room after a restart is the normal "dead" signal; any other
      // failure to probe stays `unknown` and needs explicit confirmation.
      if (live.reason === 'idle' || live.reason === 'state_missing') return 'dead';
      return 'unknown';
    },
    getCapabilities,
    // Pre-claim gates: update/shutdown gate and chat permission (archived).
    checkLimits: (/** @type {{ run: Record<string, any>, actor?: unknown }} */ { run, actor }) => {
      try {
        const settings = readSettings();
        // R14 policy: `off` refuses every resume, `automatic` actors need `automatic`.
        const mode = resolveChatRestartRecoveryMode(settings, run.workspaceFolder);
        if (mode === 'off') return { allowed: false, reason: 'recovery_mode_off' };
        if (actor === 'automatic' && mode !== 'automatic') {
          return { allowed: false, reason: 'recovery_mode_not_automatic' };
        }
        if (!isHarnessEnabled(run.harness, settings.enabledHarnesses)) {
          return { allowed: false, reason: 'harness_disabled' };
        }
        if (readHarnessUsageLimit({ harness: run.harness, model: run.model })) {
          return { allowed: false, reason: 'harness_usage_limited' };
        }
        assertRunAdmission();
        const chat = readChat(run.chatId);
        if (!chat) return { allowed: false, reason: 'chat_not_found' };
        assertChatPermission(chat);
        return { allowed: true };
      } catch (err) {
        return { allowed: false, reason: toSafeErrorCode(err, 'run_not_accepted') };
      }
    },
    getCurrentSessionId: (/** @type {{ run: Record<string, any> }} */ { run }) =>
      String(readChat(run.chatId)?.cursorSessionId || '').trim(),
    // No `reattach` collaborator: real adapter reattach is R19, so a live
    // executor yields `reattach_deferred` (liveness confirmed only).
    // Claim lost after the turn started (Stop landed during the launch): stop it.
    cancelLaunched: async (/** @type {{ run: Record<string, any>, adapterRunId?: string }} */ { run, adapterRunId }) => {
      // Without the exact adapter run id an empty runId would mean "cancel the
      // chat's current turn", which may be a newer user turn: never do that here.
      if (!String(adapterRunId || '').trim()) {
        console.warn('[recovery-resume] claim lost after launch without adapter run id; not cancelling', run.logicalRunId);
        return;
      }
      await cancelLaunchedTurn({ chatId: run.chatId, runId: adapterRunId, reason: 'internal_cancel' });
    },
    startContinuation: async (/** @type {{ run: Record<string, any>, prompt?: string, requestId?: string }} */ { run, prompt, requestId }) => {
      // `requestId` already belongs to the resume attempt (unique per attempt).
      // The continuation turn writes its own run record, so it needs its own key.
      // Only the resume path bounds the start lock and the in-lock section; other starters stay unbounded.
      const started = await startContinuation({
        chatId: run.chatId,
        prompt,
        requestId: `resume-continuation:${requestId}`,
        timeouts: {
          lockMs: options.resumeLockTimeoutMs ?? envMs('RESUME_LOCK_TIMEOUT_MS', 15000),
          startMs: options.resumeStartTimeoutMs ?? envMs('RESUME_START_TIMEOUT_MS', 15000),
        },
      });
      return { accepted: started?.accepted === true, adapterRunId: started?.runId || '' };
    },
  });
  return {
    ...service,
    /** Number of chats currently parked by in-flight resumes (diagnostics and tests). */
    prefetchedChatCount: () => prefetchedChats.size,
    /** @param {Parameters<typeof service.resumeRun>[0]} input */
    async resumeRun(input) {
      const chatId = String(input?.chatId || '');
      const timing = { slowMs: options.slowStepMs, warn: options.warn };
      let held = false;
      if (chatId && !options.loadChats) {
        try {
          // Async read + a macrotask yield: health probes and other requests run between the read and the sync steps.
          const row = await timedStep('prefetch_chat', () => fetchChat(chatId), timing);
          const entry = prefetchedChats.get(chatId);
          if (entry) { entry.row = row; entry.refs += 1; } else prefetchedChats.set(chatId, { row, refs: 1 });
          held = true;
          await new Promise((resolve) => setImmediate(resolve));
        } catch {
          // Fall back to the synchronous read inside the service.
        }
      }
      try {
        // Wall time of the whole service call (awaits included); it does not isolate event-loop blocking.
        return await timedStep('resume_run', () => service.resumeRun(input), timing);
      } finally {
        if (held) {
          const entry = prefetchedChats.get(chatId);
          if (entry && (entry.refs -= 1) <= 0) prefetchedChats.delete(chatId);
        }
      }
    },
  };
}

/**
 * @param {import('express').Express} app
 * @param {{ service?: Record<string, any>, httpWaitMs?: number }} [ctx]
 */
export function registerRecoveryResumeRoutes(app, ctx = {}) {
  let service = ctx.service || null;
  app.post('/api/chats/:id/runs/:logicalRunId/resume', async (req, res) => {
    try {
      service = service || createRuntimeRecoveryResumeService();
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const waitMs = ctx.httpWaitMs ?? envMs('RESUME_HTTP_WAIT_MS', RESUME_HTTP_WAIT_MS);
      const logicalRunId = req.params.logicalRunId;
      const work = Promise.resolve(service.resumeRun({
        chatId: req.params.id,
        logicalRunId,
        expectedState: body.expectedState,
        expectedRevision: body.expectedRevision,
        idempotencyKey: body.idempotencyKey,
        confirmUnknown: body.confirmUnknown === true,
        actor: 'manual',
      }));
      let outcome;
      try {
        outcome = await withTimeout(work, waitMs, 'resume_http_deadline');
      } catch (err) {
        if (err?.code !== 'resume_http_deadline') throw err;
        // The claim may not have happened yet, so the body carries no revision and no promise about state.
        // The detached resume keeps running; fetch the outcome by replaying the same idempotencyKey or from
        // GET /api/chats/:id/recovery-runs.
        work.catch((detachedErr) => console.warn('[recovery-resume] detached resume failed:', logicalRunId, detachedErr?.message || detachedErr));
        res.status(202).json({ status: 'pending', reason: 'resume_pending', logicalRunId });
        return;
      }
      res.status(HTTP_STATUS_BY_RESULT[outcome.status] || 500).json(outcome);
    } catch (err) {
      res.status(500).json({ status: 'error', reason: toSafeErrorCode(err, 'internal_error') });
    }
  });
}

const KEEP_STOPPED_HTTP = Object.freeze({
  kept_stopped: 200,
  not_found: 404,
  conflict: 409,
  not_resumable: 409,
});

/**
 * Read + "Keep stopped" routes (leaf R13). Separate from the resume route so
 * each can be wired and tested on its own.
 *
 * @param {import('express').Express} app
 * @param {Record<string, any>} [ctx]
 */
export function registerRecoveryUiRoutes(app, ctx = {}) {
  app.get('/api/chats/:id/recovery-runs', (req, res) => {
    try {
      res.json({ ok: true, runs: listChatRecoveryViews(req.params.id, ctx.store) });
    } catch (err) {
      res.status(500).json({ ok: false, reason: toSafeErrorCode(err, 'internal_error') });
    }
  });
  app.post('/api/chats/:id/runs/:logicalRunId/keep-stopped', (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const outcome = keepRunStopped(
        {
          chatId: req.params.id,
          logicalRunId: req.params.logicalRunId,
          expectedRevision: body.expectedRevision,
        },
        ctx.store
      );
      res.status(KEEP_STOPPED_HTTP[outcome.status] || 500).json(outcome);
    } catch (err) {
      res.status(500).json({ status: 'error', reason: toSafeErrorCode(err, 'internal_error') });
    }
  });
}
