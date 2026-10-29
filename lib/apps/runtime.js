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
 * @param {{ intervalMs?: number, getService?: () => { refresh: () => Promise<unknown> } | null }} [options]
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
      await getService()?.refresh();
      return null;
    },
  };
}
