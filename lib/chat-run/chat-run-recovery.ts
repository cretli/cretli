/**
 * Production wiring between `startChatRun` and the recovery registry (R5).
 *
 * Every server-started chat run gets one durable `chat` family record:
 * 1. intent BEFORE the prompt reaches the adapter (`beginRunLaunch`);
 * 2. acceptance only from the adapter's own start result (`recordExecutorAck`);
 * 3. terminal evidence from the harness `sdkRunFinished` event (`finishRun`).
 *
 * Safety rules kept here:
 * - a store write failure blocks the launch (`launch_blocked`);
 * - the same caller `requestId` never launches twice unless the earlier row is
 *   PROVEN not to have reached the executor (`launch_refused`); an unproven row
 *   is marked `unconfirmed` and the prompt is NOT resent;
 * - an unknown start failure leaves acceptance `unconfirmed`, never `accepted`;
 * - a closed store (recovery not initialised in this process, e.g. unit tests)
 *   skips recording instead of blocking every chat.
 */

import { createHash } from 'node:crypto';
import { newRecoveryId, isRecoveryId } from '../recovery/recovery-ids.ts';
import {
  beginRunLaunch,
  finishRun,
  markAcceptanceUnconfirmed,
  recordExecutorAck,
} from '../recovery/recovery-lifecycle.ts';
import { getRunByRequestId, listRuns } from '../recovery/recovery-store.ts';
import { requestRunCancel } from '../recovery/recovery-queue.ts';
import { getProcessInstance } from '../recovery/recovery-shutdown.ts';

/** Start errors that prove the executor never received the prompt. */
const LAUNCH_REFUSED_CODES = new Set([
  'recipient_busy',
  'adapter_unavailable',
  'update_in_progress',
  'server_shutting_down',
  'chat_archived',
  'chat_not_found',
]);

const LAUNCH_REFUSED_DETAIL = 'launch_refused';
const MAX_REFUSED_ORDINALS = 8;

type Store = Record<string, any>;
type Rec = Record<string, any>;
type RunRecord = { run: Rec, logicalRunId: string };
type CodedError = Error & { code?: string, logicalRunId?: string };

function text(value: unknown): string {
  return String(value ?? '').trim();
}

/**
 * Deterministic recovery request id for a caller `requestId`. A caller that
 * already holds a recovery `req_` id keeps it; any other token is hashed into
 * a UUID so the same caller key always maps to the same durable row.
 * `ordinal` > 0 is used only after earlier rows were proven refused.
 */
export function toRecoveryRequestId(raw: unknown, ordinal = 0): string {
  const key = text(raw);
  if (!key) return newRecoveryId('request');
  if (ordinal === 0 && isRecoveryId(key, 'request')) return key;
  const hex = createHash('sha256').update(`${key}#${ordinal}`).digest('hex').slice(0, 32);
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return newRecoveryId('request', { uuid });
}

/**
 * Newest durable row for a caller `requestId` (walks refused ordinals).
 */
export function getChatRunRecordByCallerRequest(raw: unknown, store?: Store): Rec | null {
  const key = text(raw);
  if (!key) return null;
  let found: Rec | null = null;
  for (let ordinal = 0; ordinal < MAX_REFUSED_ORDINALS; ordinal += 1) {
    const row = getRunByRequestId(toRecoveryRequestId(key, ordinal), store);
    if (!row) break;
    found = row;
    if (!isRefusedRow(row)) break;
  }
  return found;
}

function isRefusedRow(row: Rec | null): boolean {
  return row?.state === 'cancelled'
    && text(row.terminalProof?.detail).startsWith(LAUNCH_REFUSED_DETAIL);
}

function isStoreNotOpen(err: unknown): boolean {
  const e = err as { details?: { cause?: unknown }, code?: unknown, message?: unknown } | null | undefined;
  return text(e?.details?.cause).includes('store_not_open')
    || text(e?.code) === 'store_not_open'
    || /not open/i.test(text(e?.message));
}

function blockedError(cause: unknown, extra: Record<string, unknown> = {}): Error {
  const error: CodedError = new Error('Recovery intent could not be persisted; run not started');
  error.code = 'launch_blocked';
  error.cause = cause;
  Object.assign(error, extra);
  return error;
}

/**
 * Write the durable intent. Returns `null` when recovery is not initialised in
 * this process (closed store).
 *
 * @throws {Error} `launch_blocked` | `acceptance_unconfirmed`
 */
export function beginChatRunRecord(input: { chat: Rec, transport: string, requestId?: string, mode?: string, store?: Store }): RunRecord | null {
  const { chat, transport, store } = input;
  const callerKey = text(input.requestId);
  for (let ordinal = 0; ordinal < MAX_REFUSED_ORDINALS; ordinal += 1) {
    const recoveryRequestId = toRecoveryRequestId(callerKey, ordinal);
    // beginRunLaunch mints fresh run ids, so a repeated key must be detected
    // here instead of relying on its idempotent replay.
    let existing: Rec | null = null;
    try {
      existing = getRunByRequestId(recoveryRequestId, store);
    } catch (err) {
      if (isStoreNotOpen(err)) return null;
      throw blockedError(err);
    }
    if (existing) {
      // Only a row proven refused may be superseded by a new attempt.
      if (isRefusedRow(existing)) continue;
      throw duplicateRequestError(existing, store);
    }
    try {
      const launched = beginRunLaunch({
        family: 'chat',
        owner: 'chat-run-service',
        requestId: recoveryRequestId,
        chatId: text(chat?.id),
        workspaceFolder: text(chat?.workspaceFolder || chat?.folder),
        sessionId: text(chat?.cursorSessionId),
        harness: text(transport),
        model: text(chat?.model),
        mode: text(input.mode),
        // Restart evidence for the Workspace Watcher: a run whose token differs
        // from the current process was accepted by a process that is gone.
        instanceToken: getProcessInstance().instanceId,
      }, store);
      return { run: launched.run, logicalRunId: launched.ids.logicalRunId };
    } catch (err) {
      if (isStoreNotOpen(err)) return null;
      // A concurrent writer took the key between the read and the write.
      if (text((err as { details?: { cause?: unknown } } | null)?.details?.cause) === 'request_conflict') {
        throw duplicateRequestError(getRunByRequestId(recoveryRequestId, store), store);
      }
      throw blockedError(err);
    }
  }
  throw blockedError(new Error('too_many_refused_launches'));
}

function duplicateRequestError(existing: Rec | null, store?: Store): Error {
  const logicalRunId = text(existing?.logicalRunId);
  if (text(existing?.acceptance?.state) === 'accepted') {
    const accepted: CodedError = new Error('requestId was already accepted by the executor; not resending');
    accepted.code = 'request_already_accepted';
    accepted.logicalRunId = logicalRunId;
    return accepted;
  }
  if (existing && text(existing.state) === 'starting') {
    try {
      markAcceptanceUnconfirmed({
        logicalRunId,
        expectedRevision: existing.revision as number,
        reasonToken: 'duplicate_request_without_acceptance',
      }, store);
    } catch { /* evidence is best effort; the prompt is not resent regardless */ }
  }
  const error: CodedError = new Error('Earlier launch for this requestId has no acceptance proof; not resending');
  error.code = 'acceptance_unconfirmed';
  error.logicalRunId = logicalRunId;
  return error;
}

/**
 * Record the adapter's acceptance. Never throws: a failed ack leaves the run
 * `starting`, which boot reconciliation classifies as unproven.
 */
export function recordChatRunAccepted({ record, runId, store }: { record: RunRecord, runId: string, store?: Store }): void {
  try {
    recordExecutorAck({
      logicalRunId: record.logicalRunId,
      expectedRevision: record.run.revision,
      source: 'adapter_ack',
      adapterRunId: text(runId),
    }, store);
  } catch (err) {
    console.warn('[chat-run-recovery] acceptance write failed:', (err as Error | null)?.message || err);
  }
}

/**
 * Record a failed `adapter.start`. A known pre-launch refusal is final
 * (`launch_refused`, retry allowed); anything else is unproven acceptance.
 */
export function recordChatRunStartFailed({ record, error, store }: { record: RunRecord, error: unknown, store?: Store }): void {
  const code = text((error as { code?: unknown } | null | undefined)?.code);
  try {
    if (LAUNCH_REFUSED_CODES.has(code)) {
      finishRun({
        logicalRunId: record.logicalRunId,
        expectedRevision: record.run.revision,
        to: 'cancelled',
        infraOutcome: 'cancelled',
        proof: { source: 'adapter_event', detail: `${LAUNCH_REFUSED_DETAIL}:${code}` },
      }, store);
      return;
    }
    markAcceptanceUnconfirmed({
      logicalRunId: record.logicalRunId,
      expectedRevision: record.run.revision,
      reasonToken: code || 'start_failed',
    }, store);
  } catch (err) {
    console.warn('[chat-run-recovery] start failure write failed:', (err as Error | null)?.message || err);
  }
}

/**
 * Terminal evidence from a harness `sdkRunFinished`. Matches only the open
 * chat-family run whose acked adapter run id equals `runId`; runs the server
 * did not start (user WS prompts) and stale events are ignored. Never throws.
 *
 * @returns true when a terminal state was written
 */
export function noteChatRunFinished({ chatId, runId, status, store }: { chatId: string, runId: string, status: string, store?: Store }): boolean {
  const chat = text(chatId);
  const adapterRunId = text(runId);
  if (!chat || !adapterRunId) return false;
  try {
    // A resumed run still in `starting` is matched by its launched adapter run id
    // (the turn may finish before the resume ack lands). The continuation turn
    // also has its own record with the same adapter run id: finish every match.
    const candidates = [
      ...listRuns({ family: 'chat', state: 'running', chatIds: [chat], order: 'desc' }, store),
      ...listRuns({ family: 'chat', state: 'starting', chatIds: [chat], order: 'desc' }, store)
        .filter((row) => text(row.resumeAdapterRunId) === adapterRunId),
    ];
    const matches = candidates.filter((row) =>
      text(row.acceptance?.adapterRunId) === adapterRunId || text(row.resumeAdapterRunId) === adapterRunId);
    if (matches.length === 0) return false;
    const normalized = text(status).toLowerCase();
    const completed = normalized === 'finished' || normalized === 'completed' || normalized === 'success';
    const cancelled = normalized.includes('cancel');
    const to = completed ? 'completed' : cancelled ? 'cancelled' : 'interrupted';
    let wrote = false;
    for (const run of matches) {
      const result = finishRun({
        logicalRunId: run.logicalRunId,
        expectedRevision: run.revision,
        to,
        infraOutcome: to,
        reason: to === 'interrupted' ? 'unknown' : undefined,
        proof: { source: 'adapter_event', detail: `sdkRunFinished:${normalized || 'unknown'}`, adapterRunId },
      }, store);
      wrote = wrote || result.applied === true;
    }
    return wrote;
  } catch (err) {
    if (!isStoreNotOpen(err)) console.warn('[chat-run-recovery] terminal write failed:', (err as Error | null)?.message || err);
    return false;
  }
}

/**
 * Persist a User Stop for the open chat-family runs of a chat BEFORE the
 * adapter is cancelled, so a crash right after Stop can never auto-resume the
 * run. `runId` (adapter run id) narrows the match; empty stops every open run
 * of the chat. Never throws: a failed write must not keep the executor alive.
 *
 * @returns runs recorded as cancelled
 */
export function noteChatRunStopped({ chatId, runId, reason = 'user_stop', store }: { chatId: string, runId?: string, reason?: string, store?: Store }): number {
  const chat = text(chatId);
  if (!chat) return 0;
  const adapterRunId = text(runId);
  let recorded = 0;
  try {
    for (const state of ['starting', 'running']) {
      const rows = listRuns({ family: 'chat', state, chatIds: [chat], order: 'desc' }, store);
      for (const row of rows) {
        if (adapterRunId && text(row.acceptance?.adapterRunId) !== adapterRunId) continue;
        const outcome = requestRunCancel({
          logicalRunId: row.logicalRunId,
          requestId: newRecoveryId('request'),
          reason: reason === 'user_stop' ? 'user_stop' : 'internal_cancel',
        }, store);
        if (outcome.cancelled) recorded += 1;
      }
    }
  } catch (err) {
    if (!isStoreNotOpen(err)) console.warn('[chat-run-recovery] user stop write failed:', (err as Error | null)?.message || err);
  }
  return recorded;
}
