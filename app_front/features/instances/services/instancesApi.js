/**
 * Client instances REST calls and pure formatters.
 */

import { t } from '../../../i18n/index.js';
import { cretliApiFetch } from '../../../lib/cretliApiRequest.js';

export const LOG_LIMIT = 200;

/**
 * @param {number} timestamp
 * @returns {string}
 */
export function formatRelativeAge(timestamp) {
  const ageMs = Math.max(0, Date.now() - Number(timestamp || 0));
  if (ageMs < 5000) return t('instances.justNow');
  const sec = Math.floor(ageMs / 1000);
  if (sec < 60) return t('instances.secondsAgo', { count: String(sec) });
  const min = Math.floor(sec / 60);
  if (min < 60) return t('instances.minutesAgo', { count: String(min) });
  const hours = Math.floor(min / 60);
  return t('instances.hoursAgo', { count: String(hours) });
}

/**
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function fetchInstances() {
  const res = await cretliApiFetch(`${window.location.origin || ''}/api/client-instances`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data?.ok || !Array.isArray(data.instances)) throw new Error('Invalid response');
  return data.instances;
}

/**
 * @param {string} id
 * @returns {Promise<{ lines: string[], totalBytes: number }>}
 */
export async function fetchInstanceLogs(id) {
  const url = `${window.location.origin || ''}/api/client-instances/${encodeURIComponent(id)}/logs?limit=${LOG_LIMIT}`;
  const res = await cretliApiFetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data?.ok || !Array.isArray(data.lines)) throw new Error('Invalid response');
  return { lines: data.lines, totalBytes: Number(data.totalBytes) || 0 };
}
