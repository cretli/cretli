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
import { loadChats } from '../persist/chats-persist.js';
import { assertChatCanReceiveMessages } from '../chat-message-guard.js';
import { assertCanAcceptNewRun } from '../update-gate.js';
import { isRecoveryAdapterEnabled } from '../recovery/adapter-validation.ts';
import { createRecoveryResumeService, toSafeErrorCode } from '../recovery/recovery-resume.ts';
import { keepRunStopped, listChatRecoveryViews } from '../recovery/recovery-ui.ts';
import { isHarnessEnabled } from '../harness-enabled.js';
import { getHarnessUsageLimit } from '../harness-usage-limits.js';

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
  const readChats = options.loadChats || loadChats;
  const assertChatPermission = options.assertChatCanReceiveMessages || assertChatCanReceiveMessages;
  const startContinuation = options.startChatRun || startChatRun;
  const cancelLaunchedTurn = options.cancelChatRun || cancelChatRun;
  return createRecoveryResumeService({
    store: options.store,
    // Automatic resumes are re-checked against the per-adapter enable gate here,
    // so no caller can bypass the scheduler's policy evaluation.
    isAdapterValidated: options.isAdapterValidated || isRecoveryAdapterEnabled,
    probeLiveness: (/** @type {{ run: Record<string, any> }} */ { run }) => {
      // Only the exact adapter run id proves "this run"; a chat-level probe
      // would count an unrelated newer turn as alive.
      const adapterRunId = String(run.acceptance?.adapterRunId || '').trim();
      if (!adapterRunId) return 'unknown';
      const live = probeLiveness({ chatId: run.chatId, runId: adapterRunId });
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
        const chat = readChats().find((row) => row.id === run.chatId);
        if (!chat) return { allowed: false, reason: 'chat_not_found' };
        assertChatPermission(chat);
        return { allowed: true };
      } catch (err) {
        return { allowed: false, reason: toSafeErrorCode(err, 'run_not_accepted') };
      }
    },
    getCurrentSessionId: (/** @type {{ run: Record<string, any> }} */ { run }) =>
      String(readChats().find((row) => row.id === run.chatId)?.cursorSessionId || '').trim(),
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
      const started = await startContinuation({ chatId: run.chatId, prompt, requestId });
      return { accepted: started?.accepted === true, adapterRunId: started?.runId || '' };
    },
  });
}

/**
 * @param {import('express').Express} app
 * @param {{ service?: Record<string, any> }} [ctx]
 */
export function registerRecoveryResumeRoutes(app, ctx = {}) {
  let service = ctx.service || null;
  app.post('/api/chats/:id/runs/:logicalRunId/resume', async (req, res) => {
    try {
      service = service || createRuntimeRecoveryResumeService();
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const outcome = await service.resumeRun({
        chatId: req.params.id,
        logicalRunId: req.params.logicalRunId,
        expectedState: body.expectedState,
        expectedRevision: body.expectedRevision,
        idempotencyKey: body.idempotencyKey,
        confirmUnknown: body.confirmUnknown === true,
        actor: 'manual',
      });
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
