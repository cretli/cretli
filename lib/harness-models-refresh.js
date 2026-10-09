/**
 * Explicit harness model catalog refresh for Settings / HTTP dispatcher.
 * Routes to existing list*Models({ refresh: true }) implementations; persists a shared snapshot.
 */

import { parseKnownAgentTransport } from './agent-transport.js';
import { listCodexModels } from './codex/codex-models.js';
import { listDeepSeekModels } from './deepseek/deepseek-models.js';
import { listQwenModels } from './qwen/qwen-models.js';
import { listClaudeModels } from './claude/claude-models.js';
import { listCodeBuddyModels } from './codebuddy/codebuddy-models.js';
import { listOpenRouterModels } from './openrouter/openrouter-models.js';
import { getEffectiveCursorApiKey } from './sdk/cursor-api-key.js';
import { loadCursorSdk } from './sdk/cursor-sdk.js';
import {
  expandSdkModelsToCatalog,
  FALLBACK_AGENT_MODELS,
  mergeModelCatalogEntries,
} from './model-catalog.js';
import {
  applyHarnessModelsSnapshotUpdate,
  readHarnessModelsSnapshotEntry,
} from './harness-models-snapshot.js';
import { publishModelsCatalogChangedNotification } from './notifications/notification-producers.js';

/** Harness ids the dispatcher can refresh (explicit user action only for inference-heavy Codex). */
export const REFRESHABLE_HARNESSES = Object.freeze([
  'codex',
  'deepseek',
  'qwen',
  'claude',
  'codebuddy',
  'openrouter',
  'sdk',
]);

/**
 * OpenCode needs a live server instance bound to a workspace folder; the shared
 * catalog read path cannot hold that context, so refresh stays out of scope here.
 */
export const NOT_REFRESHABLE_HARNESSES = Object.freeze(['opencode']);

/** @type {Map<string, Promise<object>>} */
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
 * @param {object} listed
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
  if (harness === 'codex' && source === 'live') source = 'cache';
  const warning = String(listed.modelsWarning || listed.warning || '');
  const networkInference = harness === 'codex';
  return { catalog, source, warning, networkInference };
}

/**
 * @param {string} harness
 * @param {Record<string, unknown>} deps
 * @returns {Promise<object>}
 */
async function invokeHarnessRefresh(harness, deps) {
  if (harness === 'codex') {
    const listCodex = typeof deps.listCodexModels === 'function' ? deps.listCodexModels : listCodexModels;
    return listCodex({
      refresh: true,
      runProbe: deps.runCodexProbe,
      homeDir: deps.codexHomeDir,
    });
  }
  if (harness === 'deepseek') {
    const list = typeof deps.listDeepSeekModels === 'function' ? deps.listDeepSeekModels : listDeepSeekModels;
    return list({ refresh: true });
  }
  if (harness === 'qwen') {
    const list = typeof deps.listQwenModels === 'function' ? deps.listQwenModels : listQwenModels;
    return list({ refresh: true });
  }
  if (harness === 'claude') {
    const list = typeof deps.listClaudeModels === 'function' ? deps.listClaudeModels : listClaudeModels;
    return list({ refresh: true });
  }
  if (harness === 'codebuddy') {
    const list = typeof deps.listCodeBuddyModels === 'function' ? deps.listCodeBuddyModels : listCodeBuddyModels;
    return list({ refresh: true });
  }
  if (harness === 'openrouter') {
    const list = typeof deps.listOpenRouterModels === 'function' ? deps.listOpenRouterModels : listOpenRouterModels;
    return list({ refresh: true });
  }
  if (harness === 'sdk') {
    const apiKey = getEffectiveCursorApiKey();
    if (!apiKey) {
      return {
        catalog: mergeModelCatalogEntries(FALLBACK_AGENT_MODELS, []),
        modelsSource: 'fallback',
        modelsWarning: 'Missing Cursor API key',
      };
    }
    const loadSdk = deps.loadCursorSdk || loadCursorSdk;
    const { Cursor } = await loadSdk();
    const sdkRows = await Cursor.models.list({ apiKey });
    const sdkCatalog = expandSdkModelsToCatalog(Array.isArray(sdkRows) ? sdkRows : []);
    if (sdkCatalog.length === 0) {
      return {
        catalog: mergeModelCatalogEntries(FALLBACK_AGENT_MODELS, []),
        modelsSource: 'fallback',
        modelsWarning: 'Cursor SDK returned an empty model list',
      };
    }
    return {
      catalog: mergeModelCatalogEntries(sdkCatalog, FALLBACK_AGENT_MODELS),
      modelsSource: 'sdk',
      modelsWarning: '',
    };
  }
  const err = new Error(`Harness "${harness}" is not refreshable via this endpoint`);
  err.code = 'NOT_REFRESHABLE';
  throw err;
}

/**
 * @param {string} harness
 * @param {{
 *   snapshotPath?: string,
 *   runCodexProbe?: Function,
 *   codexHomeDir?: string,
 *   loadCursorSdk?: Function,
 *   now?: () => number,
 * }} [options]
 * @returns {Promise<object>}
 */
export async function refreshHarnessModelsCatalog(harnessRaw, options = {}) {
  const harness = parseKnownAgentTransport(harnessRaw);
  if (!harness) {
    const err = new Error(String(harnessRaw || '').trim() ? `Unknown harness "${harnessRaw}"` : 'harness is required');
    err.code = 'VALIDATION';
    throw err;
  }
  if (NOT_REFRESHABLE_HARNESSES.includes(harness)) {
    const err = new Error(`Harness "${harness}" is not refreshable via this endpoint (requires a live OpenCode workspace)`);
    err.code = 'NOT_REFRESHABLE';
    throw err;
  }
  if (!REFRESHABLE_HARNESSES.includes(harness)) {
    const err = new Error(`Unknown harness "${harness}"`);
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
