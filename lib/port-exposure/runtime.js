/**
 * Process-wide wiring of the port exposure service: ledger, policy from server
 * settings, the stage-1 report as backend/listener source, the app-stop hook and
 * the periodic TTL + reconcile job. On WSL2 the Windows helper (cretli-netd) is
 * reached through netd-client.js; when it is missing or fails, WSL backends fall
 * back to `manual`. `setPortExposureExecutor` overrides it (tests).
 */

import { execFile } from 'node:child_process';
import os from 'node:os';
import { getDefaultNetdClient, isWslHost } from './netd-client.js';
import { createPortExposureService } from './service.js';
import { createExposureLedger } from './ledger.js';
import { loadPortExposurePolicy } from './policy.js';
import { createNetEnvService } from '../net-env/index.js';
import { isLanExposed } from '../auth.js';
import { resolveBindHost } from '../bind-host.js';
import { getLanHost } from '../lan-host.js';
import { onAppStopped } from '../apps/runtime.js';
import { listChatListUpdateClients, sendChatListClientMessage, broadcastPortExposeConsentChanged } from '../chat-list-updates.js';
import { onChatArchived } from '../persist/chats-persist.js';
import { createExposeConsentRegistry } from './expose-consent.js';

const DEFAULT_RECONCILE_INTERVAL_MS = 30_000;
const MIN_RECONCILE_INTERVAL_MS = 5_000;

/** @type {ReturnType<typeof createPortExposureService> | null} */
let service = null;
/** @type {any} */
let helperExecutor = null;
let unsubscribeAppStop = null;
let unsubscribeChatArchived = null;
/** @type {ReturnType<typeof createExposeConsentRegistry> | null} */
let consent = null;
/** @type {ReturnType<typeof createNetEnvService> | null} */
let netEnvService = null;

/** Overrides the Windows helper executor (tests); by default WSL2 hosts use the cretli-netd client. */
export function setPortExposureExecutor(executor) {
  helperExecutor = executor || null;
}

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 1500, windowsHide: true }, (error, stdout) => resolve(error ? null : String(stdout)));
  });
}

/** Linux-side executor: only detects an active firewall so a command can be suggested. */
const linuxDetector = {
  async detectFirewall() {
    const ufw = await run('ufw', ['status']);
    if (ufw && /Status:\s*active/i.test(ufw)) return 'ufw';
    const fw = await run('firewall-cmd', ['--state']);
    if (fw && /running/i.test(fw)) return 'firewalld';
    return null;
  },
};

export function broadcastPortExposureEvent(event) {
  const message = JSON.stringify(event);
  for (const [ws] of listChatListUpdateClients()) sendChatListClientMessage(ws, message);
}

/** @param {Partial<Parameters<typeof createPortExposureService>[0]>} [overrides] */
export function configurePortExposureRuntime(overrides = {}) {
  const wsl = isWslHost(process.platform, os.release());
  const netEnv = createNetEnvService({ getHost: getLanHost, getBind: resolveBindHost, getLanExposed: isLanExposed,
    getHelper: () => getDefaultNetdClient().status() });
  netEnvService = netEnv;
  service = createPortExposureService({
    ledger: createExposureLedger(),
    getPolicy: loadPortExposurePolicy,
    getReport: (opts) => netEnv.getReport(opts),
    // An explicit override wins; on WSL2 the cretli-netd client applies the rules (any failure falls
    // back to `manual` inside the backends); elsewhere the Linux detector serves the `linux` backend.
    get executor() { return helperExecutor || (wsl ? getDefaultNetdClient().executor : linuxDetector); },
    broadcast: broadcastPortExposureEvent,
    ...overrides,
  });
  unsubscribeAppStop?.();
  unsubscribeAppStop = onAppStopped((appId) => { void service?.closeForApp(appId).catch(() => {}); });
  // Archiving a chat denies its consent cards and closes the exposures it owns.
  unsubscribeChatArchived?.();
  unsubscribeChatArchived = onChatArchived((chatId) => {
    getExposeConsentRegistry().clearChat(chatId);
    void service?.closeForChat(chatId).catch(() => {});
  });
  return service;
}

/** Process-wide consent registry for agent `port_expose` calls (policy `ask`). */
export function getExposeConsentRegistry() {
  if (!consent) {
    consent = createExposeConsentRegistry({
      onChange: ({ chatId }) => {
        broadcastPortExposeConsentChanged({ chatId });
      },
    });
  }
  return consent;
}

/** Replaces the consent registry (tests). */
export function setExposeConsentRegistry(registry) {
  consent = registry || null;
}

/** Cached stage-1 network report shared with the exposure service. */
export function getNetEnvReport(opts) {
  if (!netEnvService) configurePortExposureRuntime();
  return /** @type {NonNullable<typeof netEnvService>} */ (netEnvService).getReport(opts);
}

export function getPortExposureService() {
  return service || configurePortExposureRuntime();
}

export function resolveReconcileIntervalMs(env = process.env) {
  const n = Number(env.CRETLI_PORT_EXPOSURE_RECONCILE_INTERVAL_MS);
  return Number.isFinite(n) && n > 0 ? Math.max(MIN_RECONCILE_INTERVAL_MS, Math.floor(n)) : DEFAULT_RECONCILE_INTERVAL_MS;
}

/**
 * Periodic job: TTL sweep and reconcile. Runs once at boot, so a restart closes
 * expired entries and repairs rules after a WSL address change.
 * @param {{ intervalMs?: number, getService?: () => { tick: () => Promise<unknown> } | null }} [options]
 */
export function createPortExposureJob(options = {}) {
  const getService = options.getService || getPortExposureService;
  return {
    id: 'port_exposure_reconcile',
    label: 'Port exposure TTL and reconcile',
    settingKey: 'CRETLI_PORT_EXPOSURE_RECONCILE_INTERVAL_MS',
    intervalMs: options.intervalMs || resolveReconcileIntervalMs(),
    runOnStart: true,
    jitterMs: 1000,
    isEnabled: () => Boolean(getService()),
    run: async () => (await getService()?.tick()) ?? null,
  };
}
