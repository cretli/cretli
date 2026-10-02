/**
 * Controlled delegation boot and shutdown for one Cretli process.
 */

import { acquireDelegationOwnerLock, releaseDelegationOwnerLock } from './delegation-owner-lock.js';
import {
  markDelegationRuntimeProcessStart,
  setDelegationLifecycleState,
  isDelegationRuntimeShuttingDown,
} from './delegation-lifecycle.js';
import { enqueueDelegationStoreWork, isDelegationStoreWorkBusy } from './delegation-store-lock.js';
import {
  startDelegationRuntimeWorker,
  stopDelegationRuntimeWorker,
} from './delegation-runtime-worker.js';
import { reconcileDelegationsOnBoot } from './delegation-service.js';
import { reconcileWorkspaceWatchersOnBoot } from './workspace-watcher.js';
import { applyDelegationRetention } from './delegation-retention.js';
import { logDelegationEvent } from './delegation-log.js';
import { closeDelegationSqlite } from './persist/delegation-sqlite.js';
import { loadMailboxMessages, updateMailboxMessage } from './persist/delegation-mailbox-persist.js';
import { loadDelegations, updateDelegationRecord } from './persist/delegations-persist.js';

const DEFAULT_SHUTDOWN_MS = 8000;

/**
 * @param {{ intervalMs?: number }} [options]
 */
export async function bootDelegationRuntime(options = {}) {
  markDelegationRuntimeProcessStart();
  setDelegationLifecycleState('initializing');
  try {
    acquireDelegationOwnerLock();
    await reconcileDelegationsOnBoot();
    try {
      reconcileWorkspaceWatchersOnBoot();
    } catch (err) {
      // The watcher store is optional: a corrupt workspace-watchers.json must
      // not degrade the whole delegation runtime, and it must stay untouched.
      logDelegationEvent('workspace-watcher-reconcile-failed', {}, {
        code: String(err && typeof err === 'object' && 'code' in err ? err.code : '') || 'WORKSPACE_WATCHERS_RECONCILE',
        message: err instanceof Error ? err.message : String(err || 'reconcile_failed'),
      });
    }
    applyDelegationRetention();
    startDelegationRuntimeWorker({ intervalMs: options.intervalMs });
    setDelegationLifecycleState('ready');
    logDelegationEvent('runtime-ready', {});
  } catch (err) {
    const code = String(err && typeof err === 'object' && 'code' in err ? err.code : '') || 'DELEGATION_BOOT';
    const message = err instanceof Error ? err.message : String(err || 'boot_failed');
    setDelegationLifecycleState('degraded', { code, message });
    logDelegationEvent('runtime-boot-failed', {}, { code, message });
    try {
      startDelegationRuntimeWorker({ intervalMs: options.intervalMs });
    } catch {
      // Worker start is best-effort while degraded so health can recover.
    }
  }
}

/**
 * Stop accepting work, flush short writes, persist uncertain intents.
 * A shutdown timeout is not success.
 *
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, timedOut: boolean, state: string }>}
 */
export async function shutdownDelegationRuntime(options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_SHUTDOWN_MS;
  const deadline = Date.now() + timeoutMs;
  setDelegationLifecycleState('shutting_down');
  stopDelegationRuntimeWorker();
  let flushSettled = false;
  const flush = enqueueDelegationStoreWork(() => persistUncertainWorkOnShutdown())
    .finally(() => {
      flushSettled = true;
    });
  try {
    await Promise.race([
      flush,
      sleepUntil(deadline).then(() => {
        if (flushSettled) return undefined;
        const err = new Error('Delegation shutdown deadline reached while flushing the store queue.');
        err.code = 'SHUTDOWN_TIMEOUT';
        throw err;
      }),
    ]);
  } catch (err) {
    logDelegationEvent('runtime-shutdown-flush-error', {}, {
      message: err instanceof Error ? err.message : String(err || 'flush_error'),
      code: err && typeof err === 'object' && 'code' in err ? String(err.code) : '',
    });
  }
  while (isDelegationStoreWorkBusy() && Date.now() < deadline) {
    await sleepMs(Math.min(25, Math.max(0, deadline - Date.now())));
  }
  const stillBusy = isDelegationStoreWorkBusy();
  const timedOut = Date.now() >= deadline && stillBusy;
  if (stillBusy) {
    logDelegationEvent('runtime-shutdown-timeout', {});
    return { ok: false, timedOut: true, state: 'shutting_down' };
  }
  releaseDelegationOwnerLock();
  closeDelegationSqlite();
  return { ok: true, timedOut: false, state: 'shutting_down' };
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * @param {number} deadline
 * @returns {Promise<void>}
 */
function sleepUntil(deadline) {
  return sleepMs(deadline - Date.now());
}

function persistUncertainWorkOnShutdown() {
  if (!isDelegationRuntimeShuttingDown()) return;
  for (const row of loadMailboxMessages()) {
    if (String(row.status || '') !== 'dispatching') continue;
    if (String(row.recipientRunId || row.runId || '').trim()) continue;
    updateMailboxMessage(row.id, {
      status: 'uncertain',
      delivery: 'uncertain',
      error: row.error || 'Server is shutting down; prompt acceptance is unconfirmed.',
    });
  }
  for (const row of loadDelegations()) {
    if (String(row.status || '') !== 'starting') continue;
    if (String(row.runId || '').trim()) continue;
    updateDelegationRecord(row.id, {
      acceptState: 'uncertain',
      errorAppend: [{
        at: new Date().toISOString(),
        code: 'shutdown_unconfirmed',
        message: 'Shutdown before the run was confirmed. This is not success.',
        attemptId: row.attemptId,
      }],
    });
  }
}

/**
 * Register mock adapters over real ones. Isolated E2E only.
 */
export function installDelegationTestAdapters() {
  if (String(process.env.CRETLI_TEST_CHAT_RUN_ADAPTER || '') !== '1') return;
  return import('./chat-run-service.js').then(async (service) => {
    const mock = await import('./chat-run/mock-adapter.js');
    const transports = service.listChatRunAdapterTransports();
    for (const transport of transports) {
      mock.registerMockChatRunAdapter(transport);
    }
    mock.registerMockChatRunAdapter('opencode');
    mock.registerMockChatRunAdapter('mock');
  });
}
