/**
 * Process-wide wiring of the apps service and its periodic monitor job. The
 * routes configure the runtime once; the shared periodic runner (registered in
 * lib/delegation-runtime-boot.js) picks the job up and ticks it.
 */

import { createAppsService } from './service.js';
import { createAppsStateStore } from './state-store.js';
import { createListenerSnapshotter, resolveMonitorIntervalMs } from './monitor.js';
import { createTaskLauncher } from './task-launcher.js';
import { listChatListUpdateClients, sendChatListClientMessage } from '../chat-list-updates.js';
import { publishNotification } from '../notifications/notification-store.ts';
import { canAcceptNewRun } from '../update-gate.js';

/** @type {ReturnType<typeof createAppsService> | null} */
let service = null;

/** @type {Set<(appId: string) => void>} */
const appStopListeners = new Set();

/**
 * Subscribes to "app stopped or exited" events (used to close the app's port exposures).
 * @param {(appId: string) => void} listener
 * @returns {() => void} unsubscribe
 */
export function onAppStopped(listener) {
  appStopListeners.add(listener);
  return () => appStopListeners.delete(listener);
}

/** Broadcasts to the WebSocket clients and fans stop events out to subscribers. */
function broadcastAndNotify(event) {
  broadcastAppsEvent(event);
  if (event?.appId && (event.reason === 'stopped' || event.reason === 'exited')) {
    for (const listener of appStopListeners) {
      try { listener(event.appId); } catch { /* A failing subscriber must not break app control. */ }
    }
  }
}

/** Pushes `{ type: 'appsChanged' }` frames over the global chat-list WebSocket channel. */
export function broadcastAppsEvent(event) {
  const message = JSON.stringify(event);
  for (const [ws] of listChatListUpdateClients()) sendChatListClientMessage(ws, message);
}

/**
 * @param {Parameters<typeof createTaskLauncher>[0] & {
 *   getWorkspaceDir: () => string,
 *   loadTasksForWorkspace?: (input: any) => any,
 * }} ctx
 * @param {Partial<Parameters<typeof createAppsService>[0]>} [overrides]
 */
export function configureAppsRuntime(ctx, overrides = {}) {
  service = createAppsService({
    getWorkspaceDir: ctx.getWorkspaceDir,
    taskRuns: ctx.taskRuns,
    launchTask: createTaskLauncher(ctx),
    loadTasksForWorkspace: ctx.loadTasksForWorkspace,
    snapshot: createListenerSnapshotter(),
    state: createAppsStateStore(),
    broadcast: broadcastAndNotify,
    notify: (payload) => publishNotification(payload),
    ...overrides,
  });
  return service;
}

export function getAppsService() {
  return service;
}

/**
 * @param {{ intervalMs?: number, getService?: () => { refresh: () => Promise<unknown>, monitorTick?: () => Promise<unknown> } | null }} [options]
 * Periodic job for lib/periodic-job-runner.js: one listener snapshot (one `ss`) per tick.
 */
export function createAppsMonitorJob(options = {}) {
  const getService = options.getService || getAppsService;
  return {
    id: 'apps_monitor',
    label: 'Workspace apps port monitor',
    settingKey: 'CRETLI_APPS_MONITOR_INTERVAL_MS',
    intervalMs: options.intervalMs || resolveMonitorIntervalMs(),
    runOnStart: false,
    jitterMs: 1000,
    isEnabled: () => Boolean(getService()),
    run: async () => {
      const svc = /** @type {any} */ (getService());
      await (svc?.monitorTick || svc?.refresh)?.();
      return null;
    },
  };
}

/** Schedules one detached boot pass over autoStart apps in registry order. */
export function createAppsAutoStartJob(options = {}) {
  const getService = options.getService || getAppsService;
  const accept = options.canAcceptNewRun || canAcceptNewRun;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now || Date.now;
  const log = options.log || (() => {});
  let scheduled = false;
  const waitForGate = async () => {
    const deadline = now() + (options.maxWaitMs ?? 10 * 60 * 1000);
    while (!accept() && now() < deadline) await sleep(Math.min(options.pollMs ?? 5000, deadline - now()));
    if (!accept()) {
      log('apps-auto-start-gate-timeout', {});
      return false;
    }
    return true;
  };
  async function runQueue() {
    const service = getService();
    if (!service) return;
    const { apps = [] } = service.list();
    for (const app of apps) {
      if (!app.autoStart || app.start.external) continue;
      if (!await waitForGate()) return;
      try {
        const status = await service.status({ dir: service.getWorkspaceDir?.() });
        const current = status.apps?.find((item) => item.id === app.id);
        if (current?.status === 'running') continue;
        const result = await service.start(app.id);
        if (!result.ok && ['port-in-use', 'app-starting'].includes(result.error)) {
          log('apps-auto-start-skipped', { appId: app.id, error: result.error });
          continue;
        }
        if (!result.ok) log('apps-auto-start-failed', { appId: app.id, error: result.error || 'start-failed' });
      } catch (err) {
        log('apps-auto-start-failed', { appId: app.id, error: String(err?.message || err) });
      }
    }
  }
  return {
    id: 'apps_auto_start', label: 'Start autoStart apps on boot', intervalMs: options.intervalMs || 60_000, runOnStart: true, jitterMs: 0,
    isEnabled: () => Boolean(getService()),
    run: () => {
      if (scheduled) return null;
      scheduled = true;
      setImmediate(() => { runQueue().catch((err) => log('apps-auto-start-failed', { error: String(err?.message || err) })); });
      return null;
    },
  };
}

/**
 * Queues the one-shot autoStart pass. Called by the boot sequence only on its success path
 * (after runtime-ready), so it never runs while the runtime is degraded.
 */
export function startAppsAutoStart(options = {}) {
  return createAppsAutoStartJob(options).run();
}
