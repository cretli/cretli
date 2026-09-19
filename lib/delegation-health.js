/**
 * Diagnostic snapshot for the delegation runtime. No prompt or report bodies.
 */

import { getDelegationRuntimeOwnerToken, getDelegationLifecycleSnapshot } from './delegation-lifecycle.js';
import { getDelegationOwnerLockInfo } from './delegation-owner-lock.js';
import {
  DELEGATION_RUNTIME_TICK_MS,
  isTerminalDelegationStatus,
} from './delegation-status.js';
import { loadDelegations } from './persist/delegations-persist.js';
import { loadMailboxMessages } from './persist/delegation-mailbox-persist.js';
import { DELEGATIONS_JSON_SCHEMA_VERSION } from './persist/delegation-schema.js';
import { getDelegationStoreBackend } from './persist/delegation-store-backend.js';

/**
 * @param {object} row
 * @returns {string}
 */
function oldestTimestamp(row) {
  return String(row?.createdAt || row?.dispatchingAt || row?.lastTransitionAt || '');
}

/**
 * @param {object[]} rows
 * @returns {string}
 */
function minTimestamp(rows) {
  const stamps = rows.map((row) => oldestTimestamp(row)).filter(Boolean).sort();
  return stamps[0] || '';
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
  const pendingOutbox = [];
  let uncertainDelegations = 0;
  let failedDelegations = 0;
  for (const row of delegations) {
    if (String(row.status || '') === 'failed') failedDelegations += 1;
    if (String(row.status || '') === 'interrupted' || String(row.acceptState || '') === 'uncertain') {
      uncertainDelegations += 1;
    }
    const items = Array.isArray(row.outbox) ? row.outbox : [];
    for (const item of items) {
      if (!String(item.deliveredAt || '').trim()) pendingOutbox.push(item);
    }
  }
  const pendingMailbox = mailbox.filter((row) => {
    const status = String(row.status || '');
    return status === 'queued' || status === 'dispatching' || status === 'uncertain';
  });
  const uncertainMailbox = mailbox.filter((row) => String(row.status || '') === 'uncertain').length;
  const failedMailbox = mailbox.filter((row) => String(row.status || '') === 'failed').length;
  const lastTickAgeMs = worker.lastTickFinishedAt > 0
    ? Date.now() - worker.lastTickFinishedAt
    : Number.POSITIVE_INFINITY;
  const staleTick = worker.running
    && !worker.tickInFlight
    && Number.isFinite(lastTickAgeMs)
    && lastTickAgeMs > DELEGATION_RUNTIME_TICK_MS * 3;
  return {
    ok: worker.ok && lifecycle.state !== 'degraded' && !storeError,
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
      pendingMailbox: pendingMailbox.length,
      pendingOutbox: pendingOutbox.length,
      oldestIntentAt: minTimestamp([...pendingMailbox, ...pendingOutbox]),
      terminal: delegations.filter((row) => isTerminalDelegationStatus(row.status)).length,
    },
  };
}

/**
 * @param {(row: object) => boolean} [isInScope]
 */
export function collectScopedDelegationHealthRows(isInScope) {
  const allow = typeof isInScope === 'function' ? isInScope : () => true;
  let delegations = [];
  let mailbox = [];
  /** @type {Error | null} */
  let storeError = null;
  try {
    delegations = loadDelegations().filter((row) => allow(row));
  } catch (err) {
    storeError = err instanceof Error ? err : new Error(String(err || 'delegations_unreadable'));
  }
  try {
    mailbox = loadMailboxMessages().filter((row) => isMailboxRowInScope(row, allow));
  } catch (err) {
    if (!storeError) {
      storeError = err instanceof Error ? err : new Error(String(err || 'mailbox_unreadable'));
    }
  }
  return { delegations, mailbox, storeError };
}

/**
 * @param {object} row
 * @param {(row: object) => boolean} allow
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
