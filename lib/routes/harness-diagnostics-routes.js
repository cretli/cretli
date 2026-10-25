/**
 * Read-only Settings → Harness model diagnostics.
 *
 * `GET /api/harness-diagnostics` reproduces the picker for the current catalog
 * snapshot and returns per-model eligibility/availability/stats plus the
 * explanation of the selected model and candidate order. It never writes and
 * never starts an inference: it only reads the same catalogs, the usage ledger
 * and the delegation aggregate the picker already reads. Restricted callers
 * (widget / MCP integration) get 403, exactly like the harness catalog routes.
 */

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { getDelegationStoreBackend } from '../persist/delegation-store-backend.js';
import { resolveDataPath } from '../runtime-paths.js';
import { listHarnessCatalog, listHarnessModelsIncludingLocal } from '../harness-catalog.js';
import { buildModelPickHistory, buildDelegationOutcomes } from '../model-pick-history.js';
import { buildModelPickExploreLedger, listPurposeUses } from '../model-pick-service.js';
import { loadModelPickExploreConfig } from '../model-pick-explore.js';
import { loadUsageSummary } from '../usage/usage-ledger.ts';
import { readUsageEvents } from '../persist/usage-persist.js';
import { loadDelegationsReadonly } from '../persist/delegations-persist.js';
import { MODEL_PICK_USAGE_WINDOW_MS } from '../model-pick-policy.js';
import {
  loadAdaptiveConfig,
  loadModelRoleProfiles,
  loadRoleScoreWeights,
  loadRotationConfig,
  MODEL_PICK_ROLES,
} from '../model-role-profiles.js';
import { loadModelPickRecords } from '../persist/model-pick-decisions-persist.js';
import { inspectModelRoleProfilesConfig } from '../model-config-inspect.js';
import { buildModelDiagnostics } from '../model-diagnostics.js';
import { parseUsageRange } from './usage-routes.js';
import { msg } from '../messages.js';
import { readHarnessPlanLimits } from '../usage/harness-health.ts';
import { buildPlanPaceSnapshot } from '../model-pick-plan-window.js';
import { resolvePlanWindowSettings } from '../delegation-settings.js';

/**
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isRestrictedCaller(req) {
  return Boolean(req?.widgetAccess || req?.mcpIntegration);
}

/**
 * Favorite rows feed the picker (the same `enabledOnly: true` read the MCP
 * `model_pick` uses); the full row set is only for display, so a disabled or
 * non-favorite model stays visible without entering the pick.
 *
 * @param {Record<string, any>[]} harnesses
 * @returns {Promise<{ picker: Record<string, Record<string, any>>, all: Record<string, Record<string, any>>, meta: Record<string, Record<string, any>> }>}
 */
async function collectHarnessModels(harnesses, role) {
  /** @type {Record<string, Record<string, any>>} */
  const picker = {};
  /** @type {Record<string, Record<string, any>>} */
  const all = {};
  /** @type {Record<string, Record<string, any>>} */
  const meta = {};
  for (const harness of harnesses) {
    const id = String(harness.id || '').trim();
    if (!id) continue;
    // Every catalog row is listed for display, so a disabled harness and its
    // disabled favorites stay visible with an explicit reason.
    const everything = await listHarnessModelsIncludingLocal({ harness: id, enabledOnly: false });
    all[id] = everything;
    const delegatable = harness?.enabled === true && harness?.ready === true && harness?.can_delegate === true;
    const favorites = delegatable
      ? await listHarnessModelsIncludingLocal({ harness: id, enabledOnly: true, role })
      : null;
    if (favorites) picker[id] = favorites;
    /** @type {Record<string, any>} */
    const source = favorites || everything;
    meta[id] = {
      stale: source?.stale === true,
      lastAttemptAt: source?.lastAttemptAt ?? null,
      lastSuccessAt: source?.lastSuccessAt ?? null,
      source: source?.source || '',
      warning: source?.warning || '',
    };
  }
  return { picker, all, meta };
}

/**
 * Newest persisted proposal for a role, if any. Only the already-stored
 * `policyVersion` / `candidates` / `picks` are read back — nothing is written.
 *
 * @param {string} role
 * @returns {Record<string, any> | null}
 */
function latestProposalForRole(role) {
  try {
    const records = loadModelPickRecords();
    let best = null;
    for (const row of Object.values(records || {})) {
      if (!row || typeof row !== 'object') continue;
      if (String(row.role || '').trim().toLowerCase() !== role) continue;
      const at = Date.parse(String(row.createdAt || ''));
      const bestAt = best ? Date.parse(String(best.createdAt || '')) : NaN;
      if (!best || (Number.isFinite(at) && (!Number.isFinite(bestAt) || at > bestAt))) best = row;
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * @param {import('express').Express} app
 * @param {{ dataDir?: string, roleProfilesFile?: string }} [ctx]
 */
export function registerHarnessDiagnosticsRoutes(app, ctx = {}) {
  // Pay module loading and SDK probes during server startup, before Settings opens.
  void prepareHarnessDiagnosticsWorker().catch(() => {});
  app.get('/api/harness-diagnostics', async (req, res) => {
    if (isRestrictedCaller(req)) {
      return res.status(403).json({ ok: false, error: msg(req, 'widget.endpointUnavailable') });
    }
    const role = String(req.query?.role || 'implement').trim().toLowerCase();
    if (!MODEL_PICK_ROLES.includes(/** @type {import('../model-role-profiles.js').ModelPickRole} */ (role))) {
      return res.status(400).json({ ok: false, error: 'role must be plan, implement, review, or fix' });
    }
    const range = parseUsageRange(req.query);
    if ('error' in range) return res.status(400).json({ ok: false, error: range.error });
    try {
      return res.json(await buildHarnessDiagnosticsReport({ role, workspaceFolder: '', range, ...ctx }));
    } catch (err) {
      return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

// The worker keeps parsed stores and SDK imports across report cache misses.
let workerClient = null;
let nextRequestId = 0;

/** Start the diagnostics service independently of the first report request. */
export function prepareHarnessDiagnosticsWorker() {
  if (workerClient) return workerClient.ready;
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { harnessDiagnostics: true },
    env: { ...process.env, CRETLI_DELEGATION_STORE: getDelegationStoreBackend() },
  });
  const pending = new Map();
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const client = { worker, pending, ready, limitsSignature: null, retired: false };
  workerClient = client;
  const startupTimeout = setTimeout(() => fail(new Error('Harness diagnostics startup timed out')), 60_000);
  function fail(error) {
    clearTimeout(startupTimeout);
    if (workerClient === client) workerClient = null;
    readyReject(error);
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
    void worker.terminate();
  }
  worker.on('message', (message) => {
    if (message.ready) {
      clearTimeout(startupTimeout);
      client.limitsSignature = message.limitsSignature;
      readyResolve(client);
      if (!pending.size) worker.unref();
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timeout);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.report);
    if (!pending.size) {
      worker.unref();
      if (client.retired) void worker.terminate();
    }
  });
  worker.once('error', fail);
  worker.once('exit', (code) => fail(new Error(`Harness diagnostics worker exited (${code})`)));
  return ready;
}

async function requestWorkerReport(input) {
  let client = await prepareHarnessDiagnosticsWorker();
  // The lockout store is process-local after its first read. A changed durable
  // store needs a new worker, while already-dispatched reports may finish safely.
  if (client.limitsSignature !== input.limitsSignature) {
    if (workerClient === client) workerClient = null;
    client.retired = true;
    if (!client.pending.size) void client.worker.terminate();
    client = await prepareHarnessDiagnosticsWorker();
  }
  return new Promise((resolve, reject) => {
    const id = ++nextRequestId;
    const timeout = setTimeout(() => {
      client.pending.delete(id);
      reject(new Error('Harness diagnostics timed out'));
      // Reset the service so subsequent requests cannot queue behind stuck work.
      void client.worker.terminate();
    }, 60_000);
    client.pending.set(id, { resolve, reject, timeout });
    client.worker.ref();
    try {
      client.worker.postMessage({ id, input });
    } catch (error) {
      clearTimeout(timeout);
      client.pending.delete(id);
      if (!client.pending.size) client.worker.unref();
      reject(error);
    }
  });
}

const reportCache = new Map();
const REPORT_TTL_MS = 30_000;

// Metadata checks use asynchronous I/O so even a cold store cannot block HTTP.
async function reportStoreSignature(input) {
  const root = resolveDataPath();
  const usage = path.join(root, 'usage');
  const days = await readdir(usage).catch((err) => {
    if (err.code === 'ENOENT') return [];
    throw err;
  });
  const files = ['delegations.json', 'delegations.sqlite', 'delegations.sqlite-wal',
    'config.json', 'model-role-profiles.json', 'model-pick-decisions.json',
    'model-pick-explore.json', 'delegation-ratings.jsonl', 'harness-models-catalog.json',
    'harness-usage-limits.json', 'chats.json']
    .map((name) => path.join(root, name));
  if (input.roleProfilesFile) files.push(input.roleProfilesFile);
  files.push(...days.filter((name) => name.endsWith('.jsonl')).sort().map((name) => path.join(usage, name)));
  return Promise.all(files.map(fileSignature));
}

async function fileSignature(file) {
  try {
    const value = await stat(file, { bigint: true });
    return `${file}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
  } catch (err) {
    if (err.code === 'ENOENT') return `${file}:missing`;
    throw err;
  }
}

/**
 * Shared read-only report for Settings and external operators.
 * Identical concurrent requests share one worker and a 30-second snapshot.
 *
 * @param {{ role?: string, workspaceFolder?: string, range?: { from?: string, to?: string }, roleProfilesFile?: string, dataDir?: string, [key: string]: any }} [input]
 */
export async function buildHarnessDiagnosticsReport(input = {}) {
  const signature = await reportStoreSignature(input);
  const backend = getDelegationStoreBackend();
  const key = JSON.stringify([input, backend, signature]);
  const now = Date.now();
  for (const [oldKey, entry] of reportCache) {
    if (entry.expires <= now) reportCache.delete(oldKey);
  }
  const cached = reportCache.get(key);
  if (cached) return structuredClone(await cached.promise);
  // Bound retention for arbitrary operator-supplied ranges.
  if (reportCache.size >= 16) reportCache.delete(reportCache.keys().next().value);
  const limitsFile = resolveDataPath('harness-usage-limits.json');
  const limitsSignature = signature.find((value) => value.startsWith(`${limitsFile}:`));
  const promise = requestWorkerReport({ ...input, backend, limitsSignature });
  const entry = { expires: Infinity, promise };
  reportCache.set(key, entry);
  try {
    const report = await promise;
    entry.expires = Date.now() + REPORT_TTL_MS;
    return structuredClone(report);
  } catch (err) {
    if (reportCache.get(key) === entry) reportCache.delete(key);
    throw err;
  }
}

/** @param {{ role?: string, workspaceFolder?: string, range?: { from?: string, to?: string }, roleProfilesFile?: string, dataDir?: string, [key: string]: any }} input */
async function computeHarnessDiagnosticsReport({ role, workspaceFolder = '', range = {}, ...ctx }) {
  const { invalidateHarnessDiscoveryCache } = await import('../agent-harness/harness-snapshot-registry.ts');
  invalidateHarnessDiscoveryCache();
  const catalog = await listHarnessCatalog();
  const { picker, all, meta } = await collectHarnessModels(catalog, role);
  const now = Date.now();
  const harnessIds = (Array.isArray(catalog) ? catalog : [])
    .map((row) => String(row?.id || '').trim())
    .filter(Boolean);
  const delegationRows = loadDelegationsReadonly();
  const outcomes = buildDelegationOutcomes({ rows: delegationRows, now });
  const history = buildModelPickHistory({
    delegations: delegationRows,
    outcomes,
    role,
    harnesses: harnessIds,
    extraUses: listPurposeUses('model_pick', { now }),
  });
  const usageSummary = loadUsageSummary({ from: range.from, to: range.to });
  // The canonical stats block needs the same rows and usage events the
  // cycle/cost aggregation already reads; loading them once here keeps the
  // pure builder free of I/O. The usage window matches the pick window
  // `summarizeDelegationCycleCostMetrics` uses internally.
  const usageEvents = readUsageEvents({
    from: new Date(now - MODEL_PICK_USAGE_WINDOW_MS).toISOString(),
    to: new Date(now).toISOString(),
  });
  const report = buildModelDiagnostics({
    role,
    now,
    harnesses: catalog,
    modelsByHarness: picker,
    allModelsByHarness: all,
    harnessMeta: meta,
    history,
    profiles: loadModelRoleProfiles(),
    weights: loadRoleScoreWeights(),
    rotation: loadRotationConfig(),
    adaptive: loadAdaptiveConfig(),
    exploreLedger: buildModelPickExploreLedger({ now, delegations: delegationRows }),
    exploreConfig: loadModelPickExploreConfig(),
    outcomes,
    delegationRows,
    usageEvents,
    usageSummary,
    usageRange: { from: range.from, to: range.to },
    config: inspectModelRoleProfilesConfig({ filePath: ctx.roleProfilesFile }),
    latestProposal: latestProposalForRole(role),
  });
  const planLimits = readHarnessPlanLimits('', { dataDir: ctx.dataDir, now });
  const planConfig = workspaceFolder ? resolvePlanWindowSettings(workspaceFolder, { dataDir: ctx.dataDir }) : undefined;
  report.plan_pace = Object.fromEntries((report.selection?.candidates || []).map((candidate) => [
    `${candidate.harness}:${candidate.model}`,
    buildPlanPaceSnapshot({ planLimits, harnessId: candidate.harness, modelId: candidate.model, now, costTier: candidate.cost_tier, config: planConfig }),
  ]));
  return report;
}

// Only workers explicitly created by this module initialize harness registries.
if (!isMainThread && workerData?.harnessDiagnostics === true) {
  const { loadOptionalHarnessPlugins } = await import('../agent-harness/optional-harness-plugins.ts');
  await loadOptionalHarnessPlugins();
  const limitsSignature = await fileSignature(resolveDataPath('harness-usage-limits.json'));
  await listHarnessCatalog();
  // Normalize the durable snapshot at service startup, not on the first HTTP request.
  // A malformed store still reaches the request's normal error response and can recover.
  try { loadDelegationsReadonly(); } catch { /* Retried by the report builder. */ }
  let queue = Promise.resolve();
  parentPort.on('message', (message) => {
    queue = queue.then(async () => {
      try {
        process.env.CRETLI_DELEGATION_STORE = message.input.backend;
        const report = await computeHarnessDiagnosticsReport(message.input);
        parentPort.postMessage({ id: message.id, report });
      } catch (err) {
        parentPort.postMessage({ id: message.id, error: err instanceof Error ? err.message : String(err) });
      }
    });
  });
  parentPort.postMessage({ ready: true, limitsSignature });
}
