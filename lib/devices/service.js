/**
 * Devices service: registry CRUD plus live status, connect help and the
 * REST-only "launch Chrome" action. Shared by the REST routes and the
 * read-only MCP tools.
 */

import { loadSettings } from '../persist/settings.js';
import { createDevicesStore } from './store.js';
import { generateConnectHelp } from './commands.js';
import { launchChrome, probeDevice } from './probe.js';

const ADB_PATH_RE = /^[A-Za-z0-9._/\\: -]{1,200}$/;

/** Configured adb binary (settings `devicesAdbPath`, then env), default `adb`. */
export function resolveAdbPath() {
  let configured = '';
  try { configured = String(/** @type {any} */ (loadSettings())?.devicesAdbPath || ''); } catch { /* defaults */ }
  const value = configured || String(process.env.CRETLI_ADB_PATH || '');
  return value && ADB_PATH_RE.test(value) ? value : 'adb';
}

/** @param {Record<string, any>} device @param {string} [workspace] */
const visible = (device, workspace) => !device.workspace || (workspace && device.workspace === workspace);

/**
 * @param {{ store?: ReturnType<typeof createDevicesStore>, probe?: typeof probeDevice, launch?: typeof launchChrome, getAdbPath?: () => string, probeOptions?: Record<string, any> }} [options]
 */
export function createDevicesService(options = {}) {
  const store = options.store || createDevicesStore();
  const probe = options.probe || probeDevice;
  const launch = options.launch || launchChrome;
  const getAdbPath = options.getAdbPath || resolveAdbPath;
  /** @param {number} status @param {string} error @param {string} message */
  const fail = (status, error, message) => ({ ok: false, status, error, message });

  return {
    store,
    /** Devices that are global or scoped to `workspace`. */
    /** @param {{ workspace?: string }} [opts] */
    list({ workspace } = {}) {
      return { ok: true, devices: store.list().filter((d) => visible(d, workspace)) };
    },
    create(input) {
      /** @type {any} */
      const r = store.create(input);
      return r.ok ? { ok: true, device: r.device } : { ...fail(400, 'invalid-device', r.errors.join('; ')), errors: r.errors };
    },
    update(id, patch) {
      /** @type {any} */
      const r = store.update(id, patch);
      if (r.ok) return { ok: true, device: r.device };
      return r.notFound ? fail(404, 'device-not-found', 'No such device.') : { ...fail(400, 'invalid-device', r.errors.join('; ')), errors: r.errors };
    },
    remove(id) {
      return store.remove(id) ? { ok: true } : fail(404, 'device-not-found', 'No such device.');
    },
    /** @param {string} id @param {{ workspace?: string, passive?: boolean }} [opts] */
    async status(id, { workspace, passive = false } = {}) {
      const device = store.get(id);
      if (!device || !visible(device, workspace)) return fail(404, 'device-not-found', 'No such device.');
      const result = await probe(device, { adbPath: getAdbPath(), ...(options.probeOptions || {}), passive });
      if (result.status === 'reachable' && result.hardware) {
        // Keep earlier facts for any field this refresh could not read.
        const merged = { ...(device.hardware || {}) };
        for (const [k, v] of Object.entries(result.hardware)) if (v !== null && v !== undefined) merged[k] = v;
        store.setHardware(id, merged);
      }
      return { ok: true, id, status: result.status, detail: result.detail, hardware: store.get(id)?.hardware || null, checkedAt: new Date().toISOString() };
    },
    /** @param {string} id @param {{ platform?: string, host?: string, port?: number, cdpPort?: number }} [opts] */
    connectHelp(id, { platform, host, port, cdpPort } = {}) {
      const device = id ? store.get(id) : null;
      if (id && !device) return fail(404, 'device-not-found', 'No such device.');
      return { ok: true, help: generateConnectHelp({ platform: device?.platform || platform, host: device?.host || host, port: device?.port || port, cdpPort: device?.cdpPort || cdpPort, adbPath: getAdbPath() }) };
    },
    async launchChrome(id) {
      const device = store.get(id);
      if (!device) return fail(404, 'device-not-found', 'No such device.');
      const r = await launch(device, { adbPath: getAdbPath(), ...(options.probeOptions || {}) });
      return r.ok ? { ok: true, detail: r.detail } : fail(502, 'launch-failed', r.detail);
    },
  };
}

let shared = null;
/** Process-wide service (lazy, so tests importing the module do not touch data/). */
export function getDevicesService() {
  if (!shared) shared = createDevicesService();
  return shared;
}
export function setDevicesService(service) { shared = service; }
