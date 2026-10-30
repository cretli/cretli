/**
 * Controlled delegation boot and shutdown for one Cretli process.
 */

import { acquireDelegationOwnerLock, releaseDelegationOwnerLock } from './delegation-owner-lock.js';
import {
  markDelegationRuntimeProcessStart,
  setDelegationLifecycleState,
  isDelegationRuntimeShuttingDown,
  isBootReconciliationComplete,
} from './delegation-lifecycle.js';
import { enqueueDelegationStoreWork, isDelegationStoreWorkBusy } from './delegation-store-lock.js';
import {
  startDelegationRuntimeWorker,
  stopDelegationRuntimeWorker,
} from './delegation-runtime-worker.js';
import { chatAutoArchiveJob } from './chat-auto-archive-worker.js';
import { chatRetentionJob } from './chat-retention-worker.js';
import { createPeriodicJobRunner } from './periodic-job-runner.js';
import { createAppsMonitorJob } from './apps/runtime.js';
import { createPortExposureJob } from './port-exposure/runtime.js';
import {
  startHarnessUpdateCheckWorker,
  stopHarnessUpdateCheckWorker,
} from './harness-updates-worker.js';
import { delegationService, interruptActiveDelegationsForServerRestart, interruptRestartedDelegations, reconcileDelegationsOnBoot, reconcileTakeoversOnBoot } from './delegation-service.js';
import { createWakeupScheduler } from './wakeup-scheduler.js';
import { createUsageLimitResumeKind, loadDefaultResumeDeps } from './usage-limit-resume-executor.js';
import { createResumeAnnouncers } from './usage-limit-resume-notices.js';
import { createConditionCheckKind } from './wakeup-condition-check.js';
import { createConditionCheckAnnouncers } from './wakeup-condition-check-notices.js';
import { readConditionCheckSettings } from './condition-check-settings.js';
import { composeAnnouncers } from './wakeup-announcers.js';
import { publishConditionCheckNotification } from './notifications/condition-check-producer.ts';
import { getBuiltinMcpRuntimeDeps } from './mcp/builtin/runtime-deps.js';
import { getHarnessUsageLimit } from './harness-usage-limits.js';
import { patchWakeup } from './persist/wakeups-persist.js';
import { readUsageLimitResumeSettings } from './usage-limit-resume-settings.js';
import { publishUsageLimitResumeNotification } from './notifications/usage-limit-resume-producer.ts';
import { repairTodoReviewSnapshotsOnBoot } from './todo-review-sync-hooks.js';
import { reconcileWorkspaceWatchersOnBoot, runWorkspaceWatcherHeartbeat } from './workspace-watcher.js';
import { registerWorkspaceWatcherAutopilotRunner, stopWorkspaceWatcherAutopilotSchedule } from './workspace-watcher-event-schedule.js';
import { runWorkspaceWatcherAutopilot } from './workspace-watcher-cycle.js';
import { registerWorkspaceWatcherPresenceNudge } from './agent-presence-hooks.js';
import { scheduleWorkspaceWatcherAutopilotFromChatIds } from './workspace-watcher-nudge.js';
import { resolveDataPath } from './runtime-paths.js';
import { applyDelegationRetention } from './delegation-retention.js';
import { logDelegationEvent } from './delegation-log.js';
import { closeDelegationSqlite } from './persist/delegation-sqlite.js';
import { loadMailboxMessages, updateMailboxMessage } from './persist/delegation-mailbox-persist.js';
import { listDelegationsForChat, loadDelegationsReadonly, updateDelegationRecord } from './persist/delegations-persist.js';
import { classifyAndRecordOpenRuns } from './recovery/recovery-boot.ts';
import { acquireRecoveryOwnerLease, releaseRecoveryOwnerLease } from './recovery/recovery-owner-lease.ts';
import { runFamilyBootRecovery } from './recovery/recovery-family.ts';
import { drainChatMailbox } from './delegation-mailbox.js';
import { closeRecoveryStore, openRecoveryStore } from './recovery/recovery-store.ts';
import { getChatRunAdapterCapabilities, probeChatRunLiveness } from './chat-run-service.js';
import { loadSettings } from './persist/settings.js';
import { createRuntimeRecoveryResumeService } from './routes/recovery-resume-routes.js';
import { createRecoveryScheduler } from './recovery/recovery-scheduler.ts';
import { isRecoveryAdapterEnabled } from './recovery/adapter-validation.ts';
import { isActiveDelegationStatus, isDelegationSlotOccupied } from './delegation-status.js';
import { loadWorkspaceWatchers, workspaceWatcherCycleChatIds } from './persist/workspace-watchers-persist.js';
import {
  checkpointOpenRunsForShutdown,
  consumeRestartIntent,
  readRestartIntent,
  runBoundedShutdownFlush,
  writeRestartIntent,
} from './recovery/recovery-shutdown.ts';
import { bootPhase } from './boot-log.js';
import { peekChats } from './persist/chats-persist.js';
import { flushAllRoomPersistBuffers } from './agent-harness/room-kernel.ts';

const DEFAULT_SHUTDOWN_MS = 8000;

/** Periodic job runner; independent of the wake-up scheduler so it also runs while degraded. */
let periodicJobRunnerInstance = null;
export function getPeriodicJobRunner() { return periodicJobRunnerInstance; }

/** Creates the runner once, registers the built-in jobs and starts it. */
function startPeriodicJobsSafely() {
  if (!periodicJobRunnerInstance) {
    periodicJobRunnerInstance = createPeriodicJobRunner();
    periodicJobRunnerInstance.register(chatAutoArchiveJob);
    periodicJobRunnerInstance.register(chatRetentionJob);
    periodicJobRunnerInstance.register(createAppsMonitorJob());
    periodicJobRunnerInstance.register(createPortExposureJob());
  }
  periodicJobRunnerInstance.start();
}

/** Generic wake-up scheduler; `usage_limit_resume` is its first registered kind. */
let wakeupSchedulerInstance = null;
export function getWakeupScheduler() { return wakeupSchedulerInstance; }

/**
 * Registers the wake-up kinds and starts the scheduler. Best-effort: a failure
 * is logged and never degrades the delegation runtime. `notify` feeds the
 * notification centre and `announceChat` the chat transcript; both are
 * best-effort and run once per settled state (no second poller).
 *
 * @returns {Promise<void>}
 */
async function startWakeupSchedulerSafely() {
  try {
    stopWakeupSchedulerSafely();
    const log = (event, data) => logDelegationEvent(event, {}, data || {});
    const scheduler = createWakeupScheduler({
      log,
      // Every announcer sees every payload and ignores foreign kinds.
      ...composeAnnouncers([
        createResumeAnnouncers({
          readSettings: () => readUsageLimitResumeSettings(),
          publish: (payload) => publishUsageLimitResumeNotification(payload),
          log,
        }),
        createConditionCheckAnnouncers({
          readSettings: () => readConditionCheckSettings(),
          publish: (payload) => publishConditionCheckNotification(payload),
        }),
      ], { log }),
    });
    const resumeDeps = await loadDefaultResumeDeps({
      retryDelegation: (id) => delegationService.retry(id),
    });
    scheduler.registerKind(createUsageLimitResumeKind(resumeDeps));
    scheduler.registerKind(createConditionCheckKind({
      loadDelegations: () => loadDelegationsReadonly(),
      getLimit: (input) => getHarnessUsageLimit({ ...input, latest: true }),
      // Reuse the todo-start primitive and the chat-run start used by usage-limit resume.
      startTodoAgent: (input) => getBuiltinMcpRuntimeDeps().startTodoAgent(input),
      startChatRun: resumeDeps.startChatRun,
      lookupChatRunRequest: resumeDeps.lookupChatRunRequest,
      probeChatRunLiveness: resumeDeps.probeChatRunLiveness,
      patchRow: (id, fields, now) => patchWakeup(id, fields, { now }),
      readSettings: () => readConditionCheckSettings(),
    }));
    scheduler.start();
    wakeupSchedulerInstance = scheduler;
  } catch (err) {
    logDelegationEvent('wakeup-scheduler-start-failed', {}, {
      message: err instanceof Error ? err.message : String(err || 'start_failed'),
    });
  }
}

function stopWakeupSchedulerSafely() {
  if (!wakeupSchedulerInstance) return;
  wakeupSchedulerInstance.stop();
  wakeupSchedulerInstance = null;
}

/** True while the default recovery store handle was opened by this boot. */
let recoveryStoreOpenedByBoot = false;
/** Stop callback for the client-less recovery scheduler owned by this boot. */
let stopRecoveryScheduler = null;

function stopBootRecoveryScheduler() {
  if (typeof stopRecoveryScheduler !== 'function') return;
  const stop = stopRecoveryScheduler;
  stopRecoveryScheduler = null;
  stop();
}

/**
 * Workflow-owned chats are recovered by delegation/watcher reconciliation,
 * never by the generic chat scheduler. Store read failures fail closed.
 *
 * @param {{ run?: Record<string, any> }} input
 * @param {{ listDelegations?: Function, loadWatchers?: Function }} [deps]
 * @returns {boolean}
 */
export function isRecoveryRunWorkflowLocked(input, deps = {}) {
  const chatId = String(input?.run?.chatId || '').trim();
  if (!chatId) return true;
  try {
    const delegationRows = (deps.listDelegations || listDelegationsForChat)(chatId);
    const delegated = delegationRows.some((row) =>
      isDelegationSlotOccupied(row) || isActiveDelegationStatus(row.status));
    if (delegated) return true;
    const watcherRows = (deps.loadWatchers || loadWorkspaceWatchers)();
    return watcherRows.some((row) => workspaceWatcherCycleChatIds(row).includes(chatId));
  } catch (err) {
    logDelegationEvent('recovery-scheduler-lock-read-failed', {}, {
      message: err instanceof Error ? err.message : String(err || 'lock_read_failed'),
    });
    return true;
  }
}

/**
 * Enable gate for automatic resume: only an adapter whose R7 record is
 * `validated` for both the overall status and the enable gate may be resumed
 * automatically. Unknown harnesses and lookup failures stay blocked.
 *
 * @param {string} harness
 * @returns {boolean}
 */
export function isRecoveryAdapterValidated(harness) {
  return isRecoveryAdapterEnabled(harness);
}

export function createRuntimeRecoveryScheduler(options = {}) {
  const probeLiveness = options.probeLiveness || probeChatRunLiveness;
  const getCapabilities = options.getCapabilities || getChatRunAdapterCapabilities;
  const mapLiveness = ({ run }) => {
    const adapterRunId = String(run?.acceptance?.adapterRunId || run?.adapterRunId || '').trim();
    if (!adapterRunId) return 'unknown';
    const live = probeLiveness({ chatId: run.chatId, runId: adapterRunId });
    if (live.known && live.busy) return 'alive';
    if (live.reason === 'idle') return 'dead';
    // Automatic recovery fails closed on state_missing; the manual route may
    // still accept it under its explicit, human-triggered confirmation policy.
    return 'unknown';
  };
  return createRecoveryScheduler({
    store: options.store,
    loadSettings: options.loadSettings || loadSettings,
    resumeService: options.resumeService || createRuntimeRecoveryResumeService(options),
    probeLiveness: mapLiveness,
    getCapabilities,
    isAdapterValidated: options.isAdapterValidated || isRecoveryAdapterValidated,
    isLocked: options.isLocked || isRecoveryRunWorkflowLocked,
    isReady: options.isReady || isBootReconciliationComplete,
    onError: (err) => logDelegationEvent('recovery-scheduler-tick-failed', {}, {
      message: err instanceof Error ? err.message : String(err || 'tick_failed'),
    }),
  });
}

function closeBootRecoveryStore() {
  if (!recoveryStoreOpenedByBoot) return;
  recoveryStoreOpenedByBoot = false;
  try {
    closeRecoveryStore();
  } catch (err) {
    logDelegationEvent('recovery-store-close-failed', {}, {
      message: err instanceof Error ? err.message : String(err || 'close_failed'),
    });
  }
}

/**
 * Read the previous process's shutdown intent for boot classification without
 * consuming it. Evidence only: any read failure is logged and treated as "no
 * intent", so it never degrades the runtime. The intent is deleted by
 * `consumeBootRestartIntent` only after classification succeeded.
 *
 * @param {{ store?: Record<string, any> }} [options]
 * @returns {{ status: string, reason: string, intent: Record<string, any> | null }}
 */
export function readBootRestartIntent(options = {}) {
  try {
    const result = readRestartIntent({ store: options.store });
    logDelegationEvent('restart-intent-read', {}, { status: result.status, reason: result.reason });
    return result;
  } catch (err) {
    logDelegationEvent('restart-intent-read-failed', {}, {
      message: err instanceof Error ? err.message : String(err || 'read_failed'),
    });
    return { status: 'absent', reason: 'read_failed', intent: null };
  }
}

/**
 * Delete the pending intent once classification succeeded. A delete failure is
 * logged and ignored: keeping the evidence for a later boot is safer than
 * losing it.
 *
 * @param {{ store?: Record<string, any> }} [options]
 * @returns {Record<string, any> | null}
 */
export function consumeBootRestartIntent(options = {}) {
  try {
    const result = consumeRestartIntent({ store: options.store });
    logDelegationEvent('restart-intent-consumed', {}, { status: result.status, reason: result.reason });
    return result;
  } catch (err) {
    logDelegationEvent('restart-intent-consume-failed', {}, {
      message: err instanceof Error ? err.message : String(err || 'consume_failed'),
    });
    return null;
  }
}

/**
 * Acquire the R3 recovery owner lease and run the family outbox pass under it.
 * Never throws: the outbox stays queued and the worker drains it later.
 *
 * @returns {Promise<void>}
 */
async function runBootFamilyRecovery() {
  let lease = null;
  try {
    lease = acquireRecoveryOwnerLease({ ownerId: 'delegation-boot' });
    if (!lease.acquired && !lease.renewed) {
      logDelegationEvent('family-recovery-skipped', {}, { reason: lease.reason });
      return;
    }
    const result = await runFamilyBootRecovery({
      delegations: loadDelegationsReadonly(),
      mailbox: loadMailboxMessages(),
      ownerToken: lease.ownerToken,
      generation: lease.generation,
      bootReconciled: true,
      drainRecipient: (chatId, opts) => drainChatMailbox(chatId, opts),
    });
    logDelegationEvent('family-recovery-done', {}, {
      reason: result.reason,
      families: result.families.length,
    });
  } catch (err) {
    logDelegationEvent('family-recovery-failed', {}, {
      message: err instanceof Error ? err.message : String(err || 'family_recovery_failed'),
    });
  } finally {
    if (lease?.ownerToken) {
      try {
        releaseRecoveryOwnerLease({ ownerToken: lease.ownerToken, generation: lease.generation });
      } catch {
        // Lease release is best-effort; the TTL expires it anyway.
      }
    }
  }
}

/** Hands the event loop to queued I/O (HTTP accept, /login) between heavy synchronous boot stages. */
function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * @param {{ intervalMs?: number, recoverySchedulerIntervalMs?: number, recoverySchedulerFactory?: Function, recoverySchedulerOptions?: Record<string, any>, shouldSkipAutomaticWork?: Function }} [options]
 */
export async function bootDelegationRuntime(options = {}) {
  if (typeof options.shouldSkipAutomaticWork === 'function' && options.shouldSkipAutomaticWork()) {
    logDelegationEvent('runtime-boot-paused-after-restore', {}, {});
    return { paused: true };
  }
  markDelegationRuntimeProcessStart();
  setDelegationLifecycleState('initializing');
  registerWorkspaceWatcherAutopilotRunner(async ({ workspaceFolder, dataDir }) => {
    // A delegation whose child died in a restart must not hold the slot and
    // block this tick; a failed sweep never blocks the Watcher.
    try {
      const closed = await interruptRestartedDelegations();
      if (closed.length > 0) logDelegationEvent('watcher-tick-interrupted-restart', {}, { delegations: closed });
    } catch (err) {
      logDelegationEvent('watcher-tick-restart-sweep-failed', {}, {
        message: err instanceof Error ? err.message : String(err || 'sweep_failed'),
      });
    }
    await runWorkspaceWatcherHeartbeat({ dataDir: dataDir || resolveDataPath(), workspaceFolders: [workspaceFolder] });
    await runWorkspaceWatcherAutopilot({
      dataDir: dataDir || resolveDataPath(),
      workspaceFolders: [workspaceFolder],
    });
  });
  registerWorkspaceWatcherPresenceNudge((chatIds) => {
    scheduleWorkspaceWatcherAutopilotFromChatIds(chatIds, resolveDataPath());
  });
  try {
    acquireDelegationOwnerLock();
    await reconcileTakeoversOnBoot();
    bootPhase('delegation-takeovers-reconciled');
    await yieldToEventLoop();
    await reconcileDelegationsOnBoot({ deferOutbox: true });
    bootPhase('delegation-reconciled');
    await yieldToEventLoop();
    // After the delegation records are repaired and before the Watcher reconcile
    // and retention: restore `todo.review` so every snapshot matches the durable
    // delegation records again (`docs/todo-review-contract.md` §10.5). A failure
    // is logged and re-armed inside the repair; it must not degrade the runtime.
    try {
      const repair = await repairTodoReviewSnapshotsOnBoot({ dataDir: resolveDataPath() });
      if (repair.failed > 0) {
        logDelegationEvent('todo-review-repair-partial', {}, {
          workspaces: repair.workspaces,
          todos: repair.todos,
          repaired: repair.repaired,
          failed: repair.failed,
        });
      }
    } catch (err) {
      logDelegationEvent('todo-review-repair-failed', {}, {
        code: String(err && typeof err === 'object' && 'code' in err ? err.code : '') || 'TODO_REVIEW_REPAIR',
        message: err instanceof Error ? err.message : String(err || 'repair_failed'),
      });
    }
    // Leaf R8: classify the open recovery-registry runs and durably record the
    // evidence (incl. a bounded `unknown` re-probe plan). Durable evidence is a
    // readiness condition: when the store cannot be opened or the pass fails,
    // the runtime stays degraded and no worker starts.
    await yieldToEventLoop();
    let classified = null;
    let notReadyReason = '';
    let notReadyErrors = 0;
    try {
      openRecoveryStore();
      recoveryStoreOpenedByBoot = true;
      bootPhase('delegation-recovery-store-opened');
      // R9: read the previous process's shutdown intent before classification
      // and delete it only after the classification pass succeeded, so a failed
      // pass keeps the evidence for the next boot. The read is evidence only: a
      // read failure must not degrade the runtime.
      const intentResult = readBootRestartIntent();
      bootPhase('delegation-recovery-intent-read');
      // One chat snapshot for every probe: a per-run lookup re-parses chats.json
      // whenever the file signature changes mid-boot, which blocked the loop.
      const chatsById = new Map();
      for (const row of peekChats()) {
        if (row && typeof row.id === 'string') chatsById.set(row.id, row);
      }
      bootPhase('delegation-recovery-chats-snapshot');
      classified = classifyAndRecordOpenRuns({
        restartIntent: intentResult.intent,
        probeLiveness: (/** @type {Record<string, any>} */ run) => probeChatRunLiveness({
          chatId: run.chatId,
          chat: chatsById.has(run.chatId) ? { ...chatsById.get(run.chatId) } : undefined,
          runId: run.acceptance?.adapterRunId || run.adapterRunId,
        }),
      });
      bootPhase('delegation-recovery-evidence-recorded');
      if (!classified.ok) {
        notReadyReason = classified.reason || 'classify_failed';
        notReadyErrors = classified.errors.length;
      } else {
        consumeBootRestartIntent();
      }
    } catch (err) {
      notReadyReason = String(err && typeof err === 'object' && 'code' in err ? err.code : '') || 'RECOVERY_BOOT_CLASSIFY';
      notReadyErrors = 1;
      logDelegationEvent('recovery-boot-classify-failed', {}, {
        code: notReadyReason,
        message: err instanceof Error ? err.message : String(err || 'classify_failed'),
      });
    }
    if (notReadyReason) {
      logDelegationEvent('recovery-boot-not-ready', {}, { reason: notReadyReason, errors: notReadyErrors });
      const notReady = new Error(`Recovery boot evidence is not durable (${notReadyReason}).`);
      notReady.code = 'RECOVERY_BOOT_NOT_READY';
      throw notReady;
    }
    logDelegationEvent('recovery-boot-classified', {}, {
      scanned: classified.scanned,
      recorded: classified.recorded,
      states: classified.classifications.map((entry) => entry.classification.state).join(','),
      escalated: classified.classifications.filter((entry) => entry.escalated).length,
    });
    // R10: one family owner redelivers the queued outbox once, only now that
    // boot reconciliation and R8 classification are durable. Best-effort: a
    // failure leaves the rows queued for the worker's normal drain.
    bootPhase('delegation-recovery-classified');
    await yieldToEventLoop();
    await runBootFamilyRecovery();
    bootPhase('delegation-family-recovery');
    await yieldToEventLoop();
    let watcherReconciled = false;
    let finalizeCycleUsage = null;
    try {
      finalizeCycleUsage = (await reconcileWorkspaceWatchersOnBoot({ deferCycleUsage: true })).finalizeCycleUsage || null;
      watcherReconciled = true;
    } catch (err) {
      // The watcher store is optional: a corrupt workspace-watchers.json must
      // not degrade the whole delegation runtime, and it must stay untouched.
      logDelegationEvent('workspace-watcher-reconcile-failed', {}, {
        code: String(err && typeof err === 'object' && 'code' in err ? err.code : '') || 'WORKSPACE_WATCHERS_RECONCILE',
        message: err instanceof Error ? err.message : String(err || 'reconcile_failed'),
      });
    }
    bootPhase('delegation-watchers-reconciled');
    await yieldToEventLoop();
    await applyDelegationRetention();
    bootPhase('delegation-retention');
    await yieldToEventLoop();
    startDelegationRuntimeWorker({ intervalMs: options.intervalMs });
    startPeriodicJobsSafely();
    startHarnessUpdateCheckWorker();
    await startWakeupSchedulerSafely();
    setDelegationLifecycleState('ready');
    if (watcherReconciled) {
      const scheduler = typeof options.recoverySchedulerFactory === 'function'
        ? options.recoverySchedulerFactory()
        : createRuntimeRecoveryScheduler(options.recoverySchedulerOptions);
      stopBootRecoveryScheduler();
      stopRecoveryScheduler = scheduler.start(options.recoverySchedulerIntervalMs);
    } else {
      logDelegationEvent('recovery-scheduler-not-ready', {}, { reason: 'watcher_reconcile_failed' });
    }
    bootPhase('delegation-runtime-ready');
    logDelegationEvent('runtime-ready', {});
    // Cycle usage finalization is idempotent and not needed for readiness, so it
    // runs chunked in the background once the runtime is up.
    if (finalizeCycleUsage) {
      setImmediate(() => {
        finalizeCycleUsage().then(() => bootPhase('workspace-watcher-cycle-usage-finalized'), () => {});
      });
    }
  } catch (err) {
    const code = String(err && typeof err === 'object' && 'code' in err ? err.code : '') || 'DELEGATION_BOOT';
    const message = err instanceof Error ? err.message : String(err || 'boot_failed');
    setDelegationLifecycleState('degraded', { code, message });
    stopBootRecoveryScheduler();
    stopDelegationRuntimeWorker();
    stopWorkspaceWatcherAutopilotSchedule();
    logDelegationEvent('runtime-boot-failed', {}, { code, message });
    // The degraded path must NOT admit reconciliation-dependent work: the
    // delegation runtime worker and the watcher autopilot schedule stay off, so
    // nothing acts on rows the failed reconcile never proved. The independent
    // archive/update workers may still run.
    try {
      startPeriodicJobsSafely();
      startHarnessUpdateCheckWorker();
    } catch {
      // Worker start is best-effort while degraded.
    }
  }
}

/**
 * Marks the delegation runtime degraded when the deferred boot fails before
 * `bootDelegationRuntime` can run its own catch (history seed, test adapters).
 * Without it the lifecycle would stay `initializing` forever with no signal.
 * @param {unknown} err
 * @returns {{ code: string, message: string }}
 */
export function markDeferredBootFailed(err) {
  const code = String(err && typeof err === 'object' && 'code' in err ? err.code : '') || 'DELEGATION_BOOT';
  const message = err instanceof Error ? err.message : String(err || 'boot_failed');
  setDelegationLifecycleState('degraded', { code, message });
  logDelegationEvent('runtime-boot-failed', {}, { code, message, stage: 'deferred-boot' });
  return { code, message };
}

/**
 * First shutdown phase (synchronous, never awaited): stop admitting delegation
 * work. `shutdownDelegationRuntime` repeats these calls idempotently, but doing
 * them here means new jobs are refused from the first moment of the handler,
 * before the slow browser and OpenCode teardown.
 *
 * The lifecycle state also makes `persistUncertainWorkOnShutdown` treat the
 * later store flush as shutdown work: dispatching mailbox rows become
 * `uncertain`, and every active delegation whose executor run the first phase
 * just SIGTERMed is written as `interrupted` / `server_restart` — retryable
 * once — instead of being re-classified as stop-only `running_orphan` by the
 * orphan watchdog after the next boot.
 *
 * @returns {void}
 */
export function beginDelegationShutdown() {
  setDelegationLifecycleState('shutting_down');
  stopBootRecoveryScheduler();
  stopWorkspaceWatcherAutopilotSchedule();
  registerWorkspaceWatcherPresenceNudge(null);
}

/**
 * Durably record the shutdown intent (synchronous, cheap). Best-effort: a
 * closed recovery store or a write failure is logged and never blocks exit.
 * The caller passes the reason resolved from the signal and the explicit
 * restart flag; fatal/crash paths must not call this.
 *
 * @param {{ signal?: string, reason?: string }} [options]
 * @returns {Record<string, any> | null} the written intent, or null
 */
export function recordShutdownIntent(options = {}) {
  try {
    const intent = writeRestartIntent({ signal: options.signal, reason: options.reason });
    shutdownIntent = intent;
    return intent;
  } catch (err) {
    logDelegationEvent('restart-intent-write-failed', {}, {
      message: err instanceof Error ? err.message : String(err || 'write_failed'),
    });
    return null;
  }
}

/** Intent written by this process, used for the per-run checkpoint. */
let shutdownIntent = null;

/**
 * Bounded flush of buffered chat history plus the per-run checkpoint. Hard
 * timeout; failures are logged and never block exit.
 *
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, timedOut: boolean, failed: string[], completed: string[], elapsedMs: number }>}
 */
export async function flushChatStateForShutdown(options = {}) {
  const tasks = [{ name: 'chat-history-buffers', run: () => flushAllRoomPersistBuffers() }];
  if (shutdownIntent) {
    tasks.push({ name: 'run-checkpoint', run: () => checkpointOpenRunsForShutdown({ intent: shutdownIntent }) });
  }
  const result = await runBoundedShutdownFlush({
    tasks,
    timeoutMs: options.timeoutMs,
    onError: (name, err) => logDelegationEvent('shutdown-flush-task-failed', {}, {
      task: name,
      message: err instanceof Error ? err.message : String(err || 'flush_failed'),
    }),
  });
  if (!result.ok) logDelegationEvent('shutdown-flush-incomplete', {}, { timedOut: result.timedOut, failed: result.failed.join(',') });
  return result;
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
  beginDelegationShutdown();
  stopDelegationRuntimeWorker();
  getPeriodicJobRunner()?.stop();
  stopHarnessUpdateCheckWorker();
  stopWakeupSchedulerSafely();
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
  closeBootRecoveryStore();
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
  for (const row of /** @type {Record<string, any>[]} */ (loadMailboxMessages())) {
    if (String(row.status || '') !== 'dispatching') continue;
    if (String(row.recipientRunId || row.runId || '').trim()) continue;
    updateMailboxMessage(row.id, {
      status: 'uncertain',
      delivery: 'uncertain',
      error: row.error || 'Server is shutting down; prompt acceptance is unconfirmed.',
    });
  }
  for (const row of /** @type {Record<string, any>[]} */ (loadDelegationsReadonly())) {
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
  // The first shutdown phase already SIGTERMed every harness child, so every
  // active job's executor run is gone. Record that durably as
  // `interrupted` / `server_restart` (retryable once) here, before exit, so
  // the next boot does not re-classify the same rows as `running_orphan`
  // (stop-only) after the orphan grace.
  const marked = interruptActiveDelegationsForServerRestart();
  if (marked.interrupted.length > 0) {
    logDelegationEvent('shutdown-interrupted-active', {}, {
      interrupted: marked.interrupted,
      untouched: marked.untouched,
    });
  }
}

/**
 * Register mock adapters over real ones. Isolated E2E only.
 */
export function installDelegationTestAdapters() {
  if (String(process.env.CRETLI_TEST_CHAT_RUN_ADAPTER || '') !== '1') return;
  return import('./chat-run-service.js').then(async (service) => {
    const mock = await import('./chat-run/mock-adapter.ts');
    const transports = service.listChatRunAdapterTransports();
    for (const transport of transports) {
      mock.registerMockChatRunAdapter(transport);
    }
    mock.registerMockChatRunAdapter('opencode');
    mock.registerMockChatRunAdapter('mock');
  });
}
