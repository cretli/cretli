/**
 * Explicit harness model catalog refresh for Settings / HTTP dispatcher.
 * Routes to each backend's `refreshModels` (builtin-harness-backends.js);
 * persists a shared snapshot.
 */

import { parseKnownAgentTransport } from './agent-transport.js';
import { getBuiltinHarnessBackend, listBuiltinHarnessBackends } from './agent-harness/builtin-harness-backends.ts';
import {
  applyHarnessModelsSnapshotUpdate,
  readHarnessModelsSnapshotEntry,
} from './harness-models-snapshot.js';
import { publishModelsCatalogChangedNotification } from './notifications/notification-producers.ts';

/**
 * Harness ids the dispatcher can refresh (explicit user action only for inference-heavy Codex).
 * Read per call: repo harness plugins join the backend registry at boot, after this module loads.
 *
 * @returns {string[]}
 */
export function listRefreshableHarnesses() {
  return listBuiltinHarnessBackends().filter((backend) => backend.refreshModels).map((backend) => backend.id);
}

/**
 * Known harnesses the shared endpoint cannot refresh (see each backend's `notRefreshableReason`).
 *
 * @returns {string[]}
 */
export function listNotRefreshableHarnesses() {
  return listBuiltinHarnessBackends().filter((backend) => !backend.refreshModels).map((backend) => backend.id);
}

/** @type {Map<string, Promise<Record<string, any>>>} */
const inFlightByHarness = new Map();

/**
 * @param {string} modelsSource
 * @returns {boolean}
 */
function isSuccessfulCatalogSource(modelsSource) {
  return modelsSource === 'live'
    || modelsSource === 'session'
    || modelsSource === 'sdk'
    || modelsSource === 'cache';
}

/**
 * @param {import('./model-catalog.js').ModelCatalogEntry[] | undefined} entries
 * @returns {string[]}
 */
function catalogModelIds(entries) {
  const ids = (Array.isArray(entries) ? entries : [])
    .map((row) => String(row?.value || row?.modelId || '').trim())
    .filter(Boolean);
  return [...new Set(ids)].sort();
}

/**
 * @param {string} harness
 * @param {Record<string, any>} listed
 * @returns {{
 *   catalog: import('./model-catalog.js').ModelCatalogEntry[],
 *   source: string,
 *   warning: string,
 *   networkInference: boolean,
 * }}
 */
function normalizeListedResult(harness, listed) {
  const catalog = Array.isArray(listed.catalog) ? listed.catalog : [];
  let source = String(listed.modelsSource || 'fallback');
  // A refresh that runs model inference (Codex) reports its probe result as cached.
  const networkInference = getBuiltinHarnessBackend(harness)?.refreshIsNetworkInference === true;
  if (networkInference && source === 'live') source = 'cache';
  const warning = String(listed.modelsWarning || listed.warning || '');
  return { catalog, source, warning, networkInference };
}

/**
 * @param {string} harness
 * @param {Record<string, unknown>} deps
 * @returns {Promise<Record<string, any>>}
 */
async function invokeHarnessRefresh(harness, deps) {
  const refreshModels = getBuiltinHarnessBackend(harness)?.refreshModels;
  if (refreshModels) return refreshModels(deps);
  const err = /** @type {Error & { code?: string }} */ (new Error(`Harness "${harness}" is not refreshable via this endpoint`));
  err.code = 'NOT_REFRESHABLE';
  throw err;
}

/**
 * @param {unknown} harnessRaw
 * @param {{
 *   snapshotPath?: string,
 *   runCodexProbe?: Function,
 *   codexHomeDir?: string,
 *   loadCursorSdk?: Function,
 *   now?: () => number,
 * }} [options]
 * @returns {Promise<Record<string, any>>}
 */
export async function refreshHarnessModelsCatalog(harnessRaw, options = {}) {
  const harness = parseKnownAgentTransport(harnessRaw);
  if (!harness) {
    const err = /** @type {Error & { code?: string }} */ (new Error(String(harnessRaw || '').trim() ? `Unknown harness "${harnessRaw}"` : 'harness is required'));
    err.code = 'VALIDATION';
    throw err;
  }
  if (listNotRefreshableHarnesses().includes(harness)) {
    const reason = getBuiltinHarnessBackend(harness)?.notRefreshableReason;
    const err = /** @type {Error & { code?: string }} */ (new Error(`Harness "${harness}" is not refreshable via this endpoint${reason ? ` (${reason})` : ''}`));
    err.code = 'NOT_REFRESHABLE';
    throw err;
  }
  if (!listRefreshableHarnesses().includes(harness)) {
    const err = /** @type {Error & { code?: string }} */ (new Error(`Unknown harness "${harness}"`));
    err.code = 'VALIDATION';
    throw err;
  }
  const existingFlight = inFlightByHarness.get(harness);
  if (existingFlight) return existingFlight;
  const work = (async () => {
    const nowIso = new Date(options.now ? options.now() : Date.now()).toISOString();
    const prior = readHarnessModelsSnapshotEntry(harness, { snapshotPath: options.snapshotPath });
    const priorModelIds = catalogModelIds(prior?.entries);
    try {
      const listed = await invokeHarnessRefresh(harness, options);
      const normalized = normalizeListedResult(harness, listed);
      const success = normalized.catalog.length > 0 && isSuccessfulCatalogSource(normalized.source);
      const stale = !success;
      const warning = normalized.warning
        || (success ? '' : 'Refresh did not produce a live catalog; previous snapshot kept.');
      const lastSuccessAt = success ? nowIso : (prior?.lastSuccessAt ?? null);
      let snapshotPath;
      let responseWarning = warning;
      try {
        snapshotPath = await applyHarnessModelsSnapshotUpdate(harness, {
          entries: normalized.catalog,
          source: normalized.source,
          stale,
          lastAttemptAt: nowIso,
          lastSuccessAt,
          warning,
          persistEntries: success,
        }, { snapshotPath: options.snapshotPath });
      } catch (snapErr) {
        // Listing succeeded; do not fail the refresh or mark live data stale in the HTTP response.
        const snapMessage = snapErr?.message ? String(snapErr.message) : String(snapErr);
        responseWarning = responseWarning
          ? `${responseWarning} Snapshot persist failed: ${snapMessage}`
          : `Snapshot persist failed: ${snapMessage}`;
      }
      if (success) {
        const nextModelIds = catalogModelIds(normalized.catalog);
        void publishModelsCatalogChangedNotification(harness, priorModelIds, nextModelIds).catch((err) => {
          console.warn(
            '[notifications] models-catalog publish failed:',
            err instanceof Error ? err.message : String(err),
          );
        });
      }
      return {
        ok: true,
        harness,
        refreshable: true,
        source: normalized.source,
        stale,
        lastAttemptAt: nowIso,
        lastSuccessAt,
        warning: responseWarning,
        networkInference: normalized.networkInference,
        itemCount: success ? normalized.catalog.length : (prior?.entries?.length || 0),
        snapshotPath,
      };
    } catch (err) {
      const message = err?.message ? String(err.message) : String(err);
      await applyHarnessModelsSnapshotUpdate(harness, {
        source: prior?.source || 'fallback',
        stale: true,
        lastAttemptAt: nowIso,
        lastSuccessAt: prior?.lastSuccessAt ?? null,
        warning: message,
        persistEntries: false,
      }, { snapshotPath: options.snapshotPath });
      throw err;
    } finally {
      inFlightByHarness.delete(harness);
    }
  })();
  inFlightByHarness.set(harness, work);
  return work;
}
