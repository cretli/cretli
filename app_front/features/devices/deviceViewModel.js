/** Pure view-model helpers for the Devices panel (no DOM, no i18n lookups). */

const BADGES = Object.freeze({
  reachable: { key: 'devices.status.reachable', tone: 'success' },
  asleep: { key: 'devices.status.asleep', tone: 'warn' },
  'chrome-down': { key: 'devices.status.chromeDown', tone: 'warn' },
  timeout: { key: 'devices.status.timeout', tone: 'error' },
  unreachable: { key: 'devices.status.unreachable', tone: 'error' },
  'adb-missing': { key: 'devices.status.adbMissing', tone: 'error' },
});
const UNKNOWN_BADGE = Object.freeze({ key: 'devices.status.unknown', tone: '' });

const RUN_BADGES = Object.freeze({
  'awaiting-consent': { key: 'devices.run.awaitingConsent', tone: 'warn' },
  running: { key: 'devices.run.running', tone: 'warn' },
  success: { key: 'devices.run.success', tone: 'success' },
  failed: { key: 'devices.run.failed', tone: 'error' },
});

/** Maps a probe status to a translation key and tone; unknown values stay neutral. */
export function statusBadge(status) {
  return BADGES[status] || UNKNOWN_BADGE;
}

/** Maps a run status to a translation key and tone. */
export function runBadge(status) {
  return RUN_BADGES[status] || UNKNOWN_BADGE;
}

/** Only a reachable device can start a run or be compared meaningfully. */
export const canRun = (status) => status === 'reachable';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Rows for a before/after comparison from `GET /api/devices/runs/compare`.
 * A missing value is `null` and never becomes 0; `delta` is null unless both sides are numbers.
 * @param {{ deltas?: Record<string, { before: unknown, after: unknown, delta: unknown }> } | null} result
 */
export function comparisonRows(result) {
  return Object.entries(result?.deltas || {}).map(([metric, v]) => ({
    metric,
    before: v.before ?? null,
    after: v.after ?? null,
    delta: isNum(v.delta) ? v.delta : null,
    missing: v.before == null || v.after == null,
  })).sort((a, b) => a.metric.localeCompare(b.metric));
}

/**
 * Cross-device rows for the runs of one script. Only completed (success) runs
 * contribute a value; failed, asleep or pending runs show as missing, never 0.
 * @param {Array<{ id: string, deviceName?: string, status: string, metrics?: Record<string, unknown> | null }>} runs
 * @returns {{ columns: Array<{ id: string, name: string }>, rows: Array<{ metric: string, values: Array<number|null> }> }}
 */
export function crossDeviceRows(runs) {
  const columns = (runs || []).map((r) => ({ id: r.id, name: r.deviceName || r.id }));
  const metrics = new Set();
  for (const r of runs || []) if (r.status === 'success') Object.keys(r.metrics || {}).forEach((k) => metrics.add(k));
  const rows = [...metrics].sort().map((metric) => ({
    metric,
    values: (runs || []).map((r) => (r.status === 'success' && isNum(r.metrics?.[metric]) ? /** @type {number} */ (r.metrics[metric]) : null)),
  }));
  return { columns, rows };
}

/** Groups finished runs by script path so a comparison pairs runs of the same script. */
export function groupRunsByScript(runs) {
  const groups = new Map();
  for (const r of runs || []) {
    if (!groups.has(r.scriptPath)) groups.set(r.scriptPath, []);
    groups.get(r.scriptPath).push(r);
  }
  return [...groups.entries()].map(([scriptPath, list]) => ({ scriptPath, runs: list }));
}

/** Short hash for display; the full hash stays in the title. */
export const shortHash = (hash) => String(hash || '').slice(0, 12);

/** Keeps only runnable script files (.mjs / .cjs) from a directory listing, folders first. */
export function scriptChoices(entries) {
  return (entries || []).filter((e) => e.isDir || /\.(mjs|cjs)$/.test(e.name));
}

/** Newest run per device by `startedAt`, independent of input order. */
export function latestPerDevice(runs) {
  const best = new Map();
  for (const r of runs || []) {
    const cur = best.get(r.deviceId);
    if (!cur || String(r.startedAt) > String(cur.startedAt)) best.set(r.deviceId, r);
  }
  return [...best.values()];
}
