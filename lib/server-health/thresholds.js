/** Defaults; each is overridable through the named environment variable. */
export const LOAD_THRESHOLD_DEFAULTS = Object.freeze({
  eventLoopP99Ms: 200,
  routeP95Ms: 2000,
  childProcesses: 60,
  minFreeDiskMb: 2048,
  loadAvgPerCpu: 1.5,
});

const ENV_NAMES = {
  eventLoopP99Ms: 'CRETLI_HEALTH_EVENT_LOOP_P99_MS',
  routeP95Ms: 'CRETLI_HEALTH_ROUTE_P95_MS',
  childProcesses: 'CRETLI_HEALTH_MAX_CHILD_PROCESSES',
  minFreeDiskMb: 'CRETLI_HEALTH_MIN_FREE_DISK_MB',
  loadAvgPerCpu: 'CRETLI_HEALTH_LOAD_AVG_PER_CPU',
};

/**
 * @param {Record<string, string|undefined>} [env]
 * @param {Partial<typeof LOAD_THRESHOLD_DEFAULTS>} [overrides]
 * @returns {typeof LOAD_THRESHOLD_DEFAULTS & { env: typeof ENV_NAMES }}
 */
export function resolveLoadThresholds(env = process.env, overrides = {}) {
  const out = { ...LOAD_THRESHOLD_DEFAULTS };
  for (const key of Object.keys(LOAD_THRESHOLD_DEFAULTS)) {
    const fromOverride = Number(overrides[key]);
    const fromEnv = Number(env[ENV_NAMES[key]]);
    if (Number.isFinite(fromOverride) && fromOverride > 0) out[key] = fromOverride;
    else if (env[ENV_NAMES[key]] != null && Number.isFinite(fromEnv) && fromEnv > 0) out[key] = fromEnv;
  }
  return { ...out, env: ENV_NAMES };
}

/**
 * @param {{ eventLoopLagMs?: {p99:number}, routeP95Ms?: number, children?: {total:number}, disk?: {freeMb:number|null}, loadAvg?: number[], cpus?: number }} m
 * @param {ReturnType<typeof resolveLoadThresholds>} t
 * @returns {string[]} Alarm ids that are currently breached.
 */
export function evaluateLoadAlarms(m, t) {
  const alarms = [];
  if ((m.eventLoopLagMs?.p99 ?? 0) > t.eventLoopP99Ms) alarms.push('eventLoopP99');
  if ((m.routeP95Ms ?? 0) > t.routeP95Ms) alarms.push('routeP95');
  if ((m.children?.total ?? 0) > t.childProcesses) alarms.push('childProcesses');
  if (m.disk && m.disk.freeMb != null && m.disk.freeMb < t.minFreeDiskMb) alarms.push('lowDisk');
  const cpus = Math.max(1, Number(m.cpus) || 1);
  if ((m.loadAvg?.[0] ?? 0) / cpus > t.loadAvgPerCpu) alarms.push('loadAvg');
  return alarms;
}
