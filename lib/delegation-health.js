/**
 * Diagnostic snapshot for the delegation runtime. No prompt or report bodies.
 */

import { getDelegationRuntimeOwnerToken, getDelegationLifecycleSnapshot } from './delegation-lifecycle.js';
import { getDelegationOwnerLockInfo } from './delegation-owner-lock.js';
import {
  DELEGATION_RUNTIME_TICK_MS,
  DELEGATION_TICK_HUNG_MS,
  isTerminalDelegationStatus,
} from './delegation-status.js';
import { loadDelegationsReadonly } from './persist/delegations-persist.js';
import { listMailboxByStatus } from './persist/delegation-mailbox-persist.js';
import { DELEGATIONS_JSON_SCHEMA_VERSION } from './persist/delegation-schema.js';
import { getDelegationStoreBackend } from './persist/delegation-store-backend.js';

/** @typedef {import('./shared-types/index.js').DelegationRecord} DelegationRecord */

const HEALTH_MAILBOX_STATUSES = ['queued', 'dispatching', 'uncertain', 'failed'];

/**
 * @param {Record<string, any>} row
 * @returns {string}
 */
function oldestTimestamp(row) {
  return String(row?.createdAt || row?.dispatchingAt || row?.lastTransitionAt || '');
}

/**
 * @param {{
 *   worker: {
 *     running: boolean,
 *     tickInFlight: boolean,
 *     dispatchInFlight: number,
 *     startedAt: string,
 *     lastTickStartedAt: number,
 *     lastTickFinishedAt: number,
 *     degraded: boolean,
 *     ok: boolean,
 *     code: string,
 *     message: string,
 *     at: string,
 *     consecutiveErrors: number,
 *     nextRetryAt: number,
 *   },
 *   delegations?: object[],
 *   mailbox?: object[],
 *   storeError?: { code?: string, message?: string } | Error | null,
 *   now?: number,
 * }} input
 */
export function buildDelegationRuntimeHealthSnapshot(input) {
  const lifecycle = getDelegationLifecycleSnapshot();
  const lock = getDelegationOwnerLockInfo();
  const worker = input.worker;
  const delegations = Array.isArray(input.delegations) ? input.delegations : [];
  const mailbox = Array.isArray(input.mailbox) ? input.mailbox : [];
  const storeError = input.storeError || null;
  const storeCode = storeError
    ? String(storeError.code || 'DELEGATIONS_CORRUPT')
    : '';
  const storeMessage = storeError
    ? String(storeError.message || 'Delegation store is unreadable.')
    : '';
  // Single pass, no intermediate arrays: this runs on the main thread over every
  // delegation, outbox item and mailbox row on each health probe.
  let pendingOutbox = 0;
  let pendingMailbox = 0;
  let uncertainDelegations = 0;
  let failedDelegations = 0;
  let uncertainMailbox = 0;
  let failedMailbox = 0;
  let terminal = 0;
  let oldestIntentAt = '';
  /** @param {Record<string, any>} row */
  const trackOldest = (row) => {
    const stamp = oldestTimestamp(row);
    if (stamp && (!oldestIntentAt || stamp < oldestIntentAt)) oldestIntentAt = stamp;
  };
  for (const row of /** @type {Record<string, any>[]} */ (delegations)) {
    const status = String(row.status || '');
    if (status === 'failed') failedDelegations += 1;
    if (status === 'interrupted' || String(row.acceptState || '') === 'uncertain') {
      uncertainDelegations += 1;
    }
    if (isTerminalDelegationStatus(row.status)) terminal += 1;
    const items = Array.isArray(row.outbox) ? row.outbox : [];
    for (const item of items) {
      if (!String(item.deliveredAt || '').trim()) {
        pendingOutbox += 1;
        trackOldest(item);
      }
    }
  }
  for (const row of /** @type {Record<string, any>[]} */ (mailbox)) {
    const status = String(row.status || '');
    if (status === 'queued' || status === 'dispatching' || status === 'uncertain') {
      pendingMailbox += 1;
      trackOldest(row);
    }
    if (status === 'uncertain') uncertainMailbox += 1;
    else if (status === 'failed') failedMailbox += 1;
  }
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const lastTickAgeMs = worker.lastTickFinishedAt > 0
    ? now - worker.lastTickFinishedAt
    : Number.POSITIVE_INFINITY;
  const staleTick = worker.running
    && !worker.tickInFlight
    && Number.isFinite(lastTickAgeMs)
    && lastTickAgeMs > DELEGATION_RUNTIME_TICK_MS * 3;
  const hungTick = worker.running
    && worker.tickInFlight === true
    && Number(worker.lastTickStartedAt) > 0
    && (now - Number(worker.lastTickStartedAt)) > DELEGATION_TICK_HUNG_MS;
  const liveness = true;
  const readiness = worker.ok
    && worker.running === true
    && lifecycle.state === 'ready'
    && !storeError
    && staleTick !== true
    && hungTick !== true;
  return {
    ok: readiness,
    liveness,
    readiness,
    processAlive: true,
    workerRunning: worker.running,
    worker: {
      running: worker.running,
      tickInFlight: worker.tickInFlight,
      dispatchInFlight: worker.dispatchInFlight,
      startedAt: worker.startedAt || lifecycle.startedAt,
      lastTickStartedAt: worker.lastTickStartedAt,
      lastTickFinishedAt: worker.lastTickFinishedAt,
      staleTick,
      hungTick,
    },
    lifecycle: {
      state: lifecycle.state,
      acceptingWork: lifecycle.acceptingWork,
      startedAt: lifecycle.startedAt,
      error: lifecycle.error,
    },
    degraded: worker.degraded || lifecycle.state === 'degraded' || Boolean(storeError),
    code: worker.code || lifecycle.error?.code || storeCode,
    message: worker.message || lifecycle.error?.message || storeMessage,
    at: worker.at || lifecycle.error?.at || '',
    consecutiveErrors: worker.consecutiveErrors,
    nextRetryAt: worker.nextRetryAt,
    version: lifecycle.version,
    serverStartedAt: lifecycle.serverStartedAt,
    owner: {
      ...lock,
      runtimeToken: getDelegationRuntimeOwnerToken(),
    },
    store: {
      backend: getDelegationStoreBackend(),
      schemaVersion: DELEGATIONS_JSON_SCHEMA_VERSION,
      readable: !storeError,
      error: storeError
        ? {
          code: String(storeError.code || 'DELEGATIONS_CORRUPT'),
          message: String(storeError.message || 'Delegation store is unreadable.'),
        }
        : null,
    },
    counts: {
      uncertainDelegations,
      failedDelegations,
      uncertainMailbox,
      failedMailbox,
      pendingMailbox,
      pendingOutbox,
      oldestIntentAt,
      terminal,
    },
  };
}

/**
 * @param {(row: DelegationRecord) => boolean} [isInScope]
 */
export function collectScopedDelegationHealthRows(isInScope) {
  const allow = typeof isInScope === 'function' ? isInScope : () => true;
  let delegations = [];
  let mailbox = [];
  /** @type {Error | null} */
  let storeError = null;
  try {
    delegations = loadDelegationsReadonly().filter((row) => allow(row));
  } catch (err) {
    storeError = err instanceof Error ? err : new Error(String(err || 'delegations_unreadable'));
  }
  try {
    // Only the statuses the snapshot counts; skips cloning the delivered history.
    mailbox = listMailboxByStatus(HEALTH_MAILBOX_STATUSES).filter((row) => isMailboxRowInScope(row, allow));
  } catch (err) {
    if (!storeError) {
      storeError = err instanceof Error ? err : new Error(String(err || 'mailbox_unreadable'));
    }
  }
  return { delegations, mailbox, storeError };
}

/**
 * @param {Record<string, any>} row
 * @param {(row: DelegationRecord) => boolean} allow
 * @returns {boolean}
 */
function isMailboxRowInScope(row, allow) {
  const toChatId = String(row?.toChatId || '').trim();
  const fromChatId = String(row?.fromChatId || '').trim();
  const toOk = toChatId
    ? allow({ parentChatId: toChatId, childChatId: fromChatId })
    : false;
  const fromOk = fromChatId
    ? allow({ parentChatId: fromChatId, childChatId: toChatId })
    : false;
  return toOk || fromOk;
}
