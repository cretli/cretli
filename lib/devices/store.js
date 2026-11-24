/**
 * Device registry persisted in `data/devices.json` (store.devices in
 * docs/storage-registry.json). Only whitelisted fields are stored, so an ADB
 * pairing code (a human-supplied, short-lived secret) can never reach the file.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { writeJsonAtomic } from '../persist/atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';
import { isValidHostSyntax, isValidPort, isValidSerial } from './endpoint-guard.js';

export const DEVICES_FILE = 'devices.json';
export const DEVICES_SCHEMA_VERSION = 1;
export const PLATFORMS = Object.freeze(['android', 'macos', 'windows', 'ios']);
export const CONNECTION_KINDS = Object.freeze(['adb-wifi', 'chrome-cdp']);

/** @typedef {{ id: string, name: string, platform: string, kind: string, host: string, port: number, cdpPort: number|null, serial: string, workspace: string, notes: string, separateProfile: boolean, hardware: Record<string, any>|null, createdAt: string, updatedAt: string }} Device */

/**
 * Validates and normalizes user input into a stored entry.
 * @param {Record<string, any>} input
 * @returns {{ ok: true, value: Omit<Device, 'id'|'createdAt'|'updatedAt'|'hardware'> } | { ok: false, errors: string[] }}
 */
export function validateDeviceInput(input) {
  const errors = [];
  const src = input && typeof input === 'object' ? input : {};
  const name = String(src.name ?? '').trim();
  if (!name || name.length > 80) errors.push('name must be 1-80 characters');
  if (!PLATFORMS.includes(src.platform)) errors.push(`platform must be one of ${PLATFORMS.join(', ')}`);
  if (!CONNECTION_KINDS.includes(src.kind)) errors.push(`kind must be one of ${CONNECTION_KINDS.join(', ')}`);
  const host = String(src.host ?? '').trim();
  if (host && !isValidHostSyntax(host)) errors.push('host has invalid characters');
  const port = src.port === undefined || src.port === null || src.port === '' ? 0 : Number(src.port);
  if (port && !isValidPort(port)) errors.push('port must be 1-65535');
  const cdpRaw = src.cdpPort;
  const cdpPort = cdpRaw === undefined || cdpRaw === null || cdpRaw === '' ? null : Number(cdpRaw);
  if (cdpPort !== null && !isValidPort(cdpPort)) errors.push('cdpPort must be 1-65535');
  const serial = String(src.serial ?? '').trim();
  if (serial && !isValidSerial(serial)) errors.push('serial has invalid characters');
  if (src.separateProfile !== undefined && typeof src.separateProfile !== 'boolean') errors.push('separateProfile must be boolean');
  const notes = String(src.notes ?? '');
  if (notes.length > 2000) errors.push('notes too long');
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: { separateProfile: src.separateProfile === true, name, platform: src.platform, kind: src.kind, host, port, cdpPort, serial, workspace: String(src.workspace ?? '').trim(), notes },
  };
}

/** @param {{ file?: string }} [options] */
export function createDevicesStore(options = {}) {
  const file = options.file || resolveDataPath(DEVICES_FILE);
  /** @type {Device[] | null} */
  let cache = null;

  function load() {
    if (cache) return cache;
    cache = [];
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (doc && Array.isArray(doc.devices)) {
        for (const d of doc.devices) {
          const v = validateDeviceInput(d);
          if (v.ok && typeof d.id === 'string' && d.id) {
            cache.push({ ...v.value, id: d.id, hardware: d.hardware && typeof d.hardware === 'object' ? d.hardware : null, createdAt: String(d.createdAt || ''), updatedAt: String(d.updatedAt || '') });
          }
        }
      }
    } catch { /* Missing or corrupt file starts empty. */ }
    return cache;
  }

  function save() {
    writeJsonAtomic(file, { schemaVersion: DEVICES_SCHEMA_VERSION, devices: load() });
  }

  return {
    file,
    list: () => load().map((d) => ({ ...d })),
    get: (id) => { const d = load().find((x) => x.id === id); return d ? { ...d } : null; },
    create(input) {
      const v = validateDeviceInput(input);
      if (!v.ok) return v;
      const now = new Date().toISOString();
      const device = { ...v.value, id: crypto.randomUUID(), hardware: null, createdAt: now, updatedAt: now };
      load().push(device);
      save();
      return { ok: true, device: { ...device } };
    },
    update(id, patch) {
      const list = load();
      const idx = list.findIndex((x) => x.id === id);
      if (idx < 0) return { ok: false, notFound: true, errors: ['device not found'] };
      const v = validateDeviceInput({ ...list[idx], ...(patch || {}) });
      if (!v.ok) return v;
      list[idx] = { ...list[idx], ...v.value, updatedAt: new Date().toISOString() };
      save();
      return { ok: true, device: { ...list[idx] } };
    },
    setHardware(id, hardware) {
      const d = load().find((x) => x.id === id);
      if (!d) return false;
      d.hardware = hardware;
      save();
      return true;
    },
    remove(id) {
      const list = load();
      const idx = list.findIndex((x) => x.id === id);
      if (idx < 0) return false;
      list.splice(idx, 1);
      save();
      return true;
    },
  };
}
