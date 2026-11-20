/** Runtime discovery for the optional official Z.ai Python SDK. */

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const SDK_PROBE_TIMEOUT_MS = 8_000;
const SDK_PROBE_CACHE_MS = 30_000;
let cachedSdkProbe = { at: 0, available: false };

/**
 * @returns {string}
 */
export function resolveZaiPythonExecutable() {
  const configured = String(process.env.ZAI_PYTHON_BIN || '').trim();
  if (configured) return configured;
  const managed = resolve(process.cwd(), 'data/zai-sdk-venv/bin/python');
  return existsSync(managed) ? managed : 'python3';
}

/**
 * @returns {boolean}
 */
export function isZaiSdkAvailable() {
  if (Date.now() - cachedSdkProbe.at < SDK_PROBE_CACHE_MS) return cachedSdkProbe.available;
  const result = spawnSync(resolveZaiPythonExecutable(), ['-c', 'from zai import ZaiClient'], {
    encoding: 'utf8',
    timeout: SDK_PROBE_TIMEOUT_MS,
    windowsHide: true,
  });
  cachedSdkProbe = { at: Date.now(), available: !result.error && result.status === 0 };
  return cachedSdkProbe.available;
}

/** @returns {void} */
export function invalidateZaiSdkAvailability() {
  cachedSdkProbe = { at: 0, available: false };
}
