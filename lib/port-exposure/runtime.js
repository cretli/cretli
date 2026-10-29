/**
 * Process-wide wiring of the port exposure service: ledger, policy from server
 * settings, the stage-1 report as backend/listener source, the app-stop hook and
 * the periodic TTL + reconcile job. The stage-4 Windows helper plugs in through
 * `setPortExposureExecutor`; until then WSL backends behave like `manual`.
 */

import { execFile } from 'node:child_process';
import { createPortExposureService } from './service.js';
import { createExposureLedger } from './ledger.js';
import { loadPortExposurePolicy } from './policy.js';
import { createNetEnvService } from '../net-env/index.js';
import { isLanExposed } from '../auth.js';
import { resolveBindHost } from '../bind-host.js';
import { getLanHost } from '../lan-host.js';
import { onAppStopped } from '../apps/runtime.js';
import { listChatListUpdateClients, sendChatListClientMessage } from '../chat-list-updates.js';

const DEFAULT_RECONCILE_INTERVAL_MS = 30_000;
const MIN_RECONCILE_INTERVAL_MS = 5_000;

/** @type {ReturnType<typeof createPortExposureService> | null} */
let service = null;
/** @type {any} */
let helperExecutor = null;
let unsubscribeAppStop = null;

/** Stage-4 hook: installs the executor that really applies Windows rules. */
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
  const netEnv = createNetEnvService({ getHost: getLanHost, getBind: resolveBindHost, getLanExposed: isLanExposed });
  service = createPortExposureService({
    ledger: createExposureLedger(),
    getPolicy: loadPortExposurePolicy,
    getReport: (opts) => netEnv.getReport(opts),
    // The helper executor wins; otherwise the Linux detector serves the `linux` backend only.
    get executor() { return helperExecutor || linuxDetector; },
    broadcast: broadcastPortExposureEvent,
    ...overrides,
  });
  unsubscribeAppStop?.();
  unsubscribeAppStop = onAppStopped((appId) => { void service?.closeForApp(appId).catch(() => {}); });
  return service;
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
