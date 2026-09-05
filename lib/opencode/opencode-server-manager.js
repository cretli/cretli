/**
 * One OpenCode server instance per workspace folder (lazy init, ref-count, idle shutdown).
 */

import { createHash } from 'crypto';
import { mkdirSync } from 'fs';
import { createOpencode, createOpencodeClient } from '@opencode-ai/sdk';
import { readEnvAlias } from '../env-alias.js';
import { getEffectiveOpenCodeApiKey, hasOpenCodeCredentials } from './opencode-api-key.js';
import { getEffectiveOpenCodeZaiApiKey, getOpenCodeZaiProvider } from './opencode-zai-api-key.js';
import { dedupeOpenCodeModelsForChat } from './opencode-model-resolve.js';
import {
  applyOpenCodeSpawnPath,
  resolveOpenCodeUserHome,
} from './opencode-spawn-path.js';
import { loadSettings } from '../persist/settings.js';

const OPENCODE_HOSTNAME = '127.0.0.1';
const ATTACH_HEALTH_TIMEOUT_MS = 4000;
const OPENCODE_ZEN_PROVIDER_IDS = ['opencode', 'opencode-go'];

const IDLE_SHUTDOWN_MS = 90000;
const DEFAULT_PORT_BASE = 4096;
const DEFAULT_START_TIMEOUT_MS = 120000;

/** @type {Map<string, {
 *   client: import('@opencode-ai/sdk').OpencodeClient,
 *   server: { url: string, close(): void },
 *   baseUrl: string,
 *   refCount: number,
 *   port: number,
 *   workspaceFolder: string,
 *   _idleTimer: ReturnType<typeof setTimeout> | null,
 * }>} */
const instances = new Map();

/** @type {Map<string, Promise<void>>} */
const pendingCreates = new Map();

let loggedOpenCodeBin = '';

/**
 * When the process runs with a non-root UID and HOME incorrectly points to /root,
 * OpenCode may fail to create its local state directory.
 *
 * @param {{ uid?: number | null, home?: string, fallbackHome?: string }} [options]
 * @returns {string}
 */
export function resolveOpenCodeRuntimeHome(options = {}) {
  const uid = Number.isFinite(options.uid) ? Number(options.uid) : null;
  const home = String(options.home || '').trim();
  const fallbackHome = String(options.fallbackHome || '').trim();
  if (uid !== null && uid !== 0 && home.startsWith('/root') && fallbackHome) {
    return fallbackHome;
  }
  return home;
}

function applyOpenCodeRuntimeEnvironment() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const uidLabel = Number.isFinite(uid) ? String(uid) : 'unknown';
  /**
   * @param {string} homePath
   * @returns {boolean}
   */
  const ensureOpenCodeHomeWritable = (homePath) => {
    const normalizedHome = String(homePath || '').trim();
    if (!normalizedHome) return false;
    try {
      mkdirSync(normalizedHome, { recursive: true });
      mkdirSync(`${normalizedHome}/.local/state`, { recursive: true });
      return true;
    } catch {
      return false;
    }
  };
  const currentHome = String(process.env.HOME || '').trim();
  const fallbackHome = readEnvAlias({
    current: 'CRETLI_RUNTIME_HOME',
    legacy: 'CURSOR_REMOTE_RUNTIME_HOME',
    defaultValue: resolveOpenCodeUserHome(),
  }).trim();
  const resolvedHome = resolveOpenCodeRuntimeHome({
    uid,
    home: currentHome,
    fallbackHome,
  });
  if (resolvedHome && resolvedHome !== currentHome) {
    process.env.HOME = resolvedHome;
  }
  let effectiveHome = String(process.env.HOME || '').trim();
  if (uid !== 0 && !ensureOpenCodeHomeWritable(effectiveHome)) {
    const fallbackCandidates = [fallbackHome, `/tmp/cretli-home-${uidLabel}`];
    for (const candidate of fallbackCandidates) {
      if (!candidate) continue;
      if (!ensureOpenCodeHomeWritable(candidate)) continue;
      process.env.HOME = candidate;
      effectiveHome = candidate;
      break;
    }
  }
  const configuredDataHome = String(
    readEnvAlias({ current: 'CRETLI_OPENCODE_DATA_HOME', legacy: 'CURSOR_REMOTE_OPENCODE_DATA_HOME' }) || process.env.XDG_DATA_HOME || ''
  ).trim();
  const preferredDataHome = configuredDataHome || (effectiveHome ? `${effectiveHome}/.opencode-data` : '');
  if (preferredDataHome) {
    try {
      mkdirSync(preferredDataHome, { recursive: true });
      process.env.XDG_DATA_HOME = preferredDataHome;
      return;
    } catch {
      // fall through to fallback
    }
  }
  const tmpFallbackDataHome = `/tmp/cretli-opencode-${uidLabel}`;
  mkdirSync(tmpFallbackDataHome, { recursive: true });
  process.env.XDG_DATA_HOME = tmpFallbackDataHome;
}

/**
 * Reuse an opencode serve already listening on the workspace port (e.g. after server restart).
 * @param {number} port
 * @returns {Promise<{ server: { url: string, close(): void } } | null>}
 */
async function tryAttachExistingOpenCodeServer(port) {
  const baseUrl = `http://${OPENCODE_HOSTNAME}:${port}`;
  const healthUrl = `${baseUrl.replace(/\/$/, '')}/global/health`;
  try {
    const healthResponse = await fetch(healthUrl, {
      signal: AbortSignal.timeout(ATTACH_HEALTH_TIMEOUT_MS),
    });
    if (!healthResponse.ok) return null;
    const health = /** @type {{ healthy?: boolean }} */ (await healthResponse.json());
    if (health?.healthy !== true) return null;
    return {
      server: {
        url: baseUrl,
        close() {
          // External process — do not kill on release.
        },
      },
    };
  } catch {
    return null;
  }
}

/**
 * @param {string} workspaceFolder
 * @param {number} port
 * @param {number} timeout
 * @returns {Promise<void>}
 */
async function createOpenCodeInstanceEntry(workspaceFolder, port, timeout) {
  const existing = instances.get(workspaceFolder);
  if (existing?.client) return;
  applyOpenCodeRuntimeEnvironment();
  const settings = loadSettings();
  const opencodeBin = typeof settings.opencodeBin === 'string' ? settings.opencodeBin.trim() : '';
  const resolvedBin = applyOpenCodeSpawnPath({
    configuredBin: opencodeBin,
    homeDirs: [String(process.env.HOME || '').trim(), resolveOpenCodeUserHome()],
  });
  if (resolvedBin && resolvedBin !== loggedOpenCodeBin) {
    loggedOpenCodeBin = resolvedBin;
    console.log(`[opencode] using ${resolvedBin}`);
  }
  const apiKey = getEffectiveOpenCodeApiKey();
  if (apiKey) {
    process.env.OPENCODE_API_KEY = apiKey;
  }
  const zaiApiKey = getEffectiveOpenCodeZaiApiKey();
  const attached = await tryAttachExistingOpenCodeServer(port);
  const started = attached ?? await createOpencode({
    hostname: OPENCODE_HOSTNAME,
    port,
    timeout,
  });
  const server = started.server;
  const client = createOpencodeClient({
    baseUrl: server.url,
    directory: workspaceFolder,
  });
  if (attached) {
    console.log(`[opencode] attached to existing server on port ${port} (${workspaceFolder})`);
  }
  if (apiKey) {
    try {
      await applyOpenCodeProviderCredentials(client, workspaceFolder, OPENCODE_ZEN_PROVIDER_IDS, apiKey);
    } catch (err) {
      console.warn('[opencode] auth.set failed:', err?.message || err);
    }
  }
  if (zaiApiKey) {
    try {
      await applyOpenCodeProviderCredentials(client, workspaceFolder, [getOpenCodeZaiProvider()], zaiApiKey);
    } catch (err) {
      console.warn('[opencode] z.ai auth.set failed:', err?.message || err);
    }
  }
  instances.set(workspaceFolder, {
    client,
    server,
    baseUrl: server.url,
    refCount: 0,
    port,
    workspaceFolder,
    _idleTimer: null,
  });
}

/**
 * @returns {number}
 */
function resolvePortBase() {
  const settings = loadSettings();
  const fromEnv = Number.parseInt(String(process.env.OPENCODE_PORT_BASE ?? ''), 10);
  const fromSettings = Number.parseInt(String(settings.opencodePortBase ?? ''), 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  if (Number.isFinite(fromSettings) && fromSettings > 0) return fromSettings;
  return DEFAULT_PORT_BASE;
}

/**
 * @param {string} workspaceFolder
 * @returns {number}
 */
function allocatePort(workspaceFolder) {
  const base = resolvePortBase();
  const hash = createHash('sha256').update(workspaceFolder).digest();
  const offset = hash.readUInt16BE(0) % 2000;
  return base + offset;
}

/**
 * @param {unknown} result
 * @returns {Record<string, unknown> | null}
 */
function unwrapSdkData(result) {
  if (!result || typeof result !== 'object') return null;
  if ('data' in result && result.data && typeof result.data === 'object') {
    return /** @type {Record<string, unknown>} */ (result.data);
  }
  return /** @type {Record<string, unknown>} */ (result);
}

/**
 * @param {import('@opencode-ai/sdk').OpencodeClient} client
 * @param {string} workspaceFolder
 * @param {string[]} providerIds
 * @param {string} apiKey
 */
async function applyOpenCodeProviderCredentials(client, workspaceFolder, providerIds, apiKey) {
  const key = String(apiKey || '').trim();
  if (!key || !client?.auth?.set) return;
  for (const providerId of providerIds) {
    try {
      await client.auth.set({
        path: { id: providerId },
        query: { directory: workspaceFolder },
        body: { type: 'api', key },
      });
    } catch (err) {
      console.warn(`[opencode] auth.set failed for ${providerId}:`, err?.message || err);
    }
  }
}

/**
 * @param {{ workspaceFolder: string }} options
 * @returns {Promise<{
 *   client: import('@opencode-ai/sdk').OpencodeClient,
 *   baseUrl: string,
 *   workspaceFolder: string,
 *   release: () => void,
 * }>}
 */
export async function getOrCreateOpenCodeInstance(options) {
  const workspaceFolder = String(options?.workspaceFolder || '').trim();
  if (!workspaceFolder) {
    throw new Error('workspaceFolder is required');
  }
  let entry = instances.get(workspaceFolder);
  if (entry?.client) {
    entry.refCount += 1;
    if (entry._idleTimer) {
      clearTimeout(entry._idleTimer);
      entry._idleTimer = null;
    }
    return {
      client: entry.client,
      baseUrl: entry.baseUrl,
      workspaceFolder,
      release: () => releaseOpenCodeInstance(workspaceFolder),
    };
  }
  const port = allocatePort(workspaceFolder);
  const timeoutRaw = Number.parseInt(String(process.env.OPENCODE_START_TIMEOUT_MS ?? ''), 10);
  const timeout = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DEFAULT_START_TIMEOUT_MS;
  let pending = pendingCreates.get(workspaceFolder);
  if (!pending) {
    pending = createOpenCodeInstanceEntry(workspaceFolder, port, timeout).finally(() => {
      pendingCreates.delete(workspaceFolder);
    });
    pendingCreates.set(workspaceFolder, pending);
  }
  try {
    await pending;
  } catch (err) {
    instances.delete(workspaceFolder);
    throw err;
  }
  entry = instances.get(workspaceFolder);
  if (!entry?.client) {
    throw new Error('OpenCode instance failed to initialize');
  }
  entry.refCount += 1;
  if (entry._idleTimer) {
    clearTimeout(entry._idleTimer);
    entry._idleTimer = null;
  }
  return {
    client: entry.client,
    baseUrl: entry.baseUrl,
    workspaceFolder,
    release: () => releaseOpenCodeInstance(workspaceFolder),
  };
}

/**
 * @param {string} workspaceFolder
 */
export function releaseOpenCodeInstance(workspaceFolder) {
  const key = String(workspaceFolder || '').trim();
  const entry = instances.get(key);
  if (!entry) return;
  entry.refCount = Math.max(0, (entry.refCount || 1) - 1);
  if (entry.refCount > 0) return;
  if (entry._idleTimer) clearTimeout(entry._idleTimer);
  entry._idleTimer = setTimeout(() => {
    const current = instances.get(key);
    if (!current || current.refCount > 0) return;
    try {
      current.server?.close();
    } catch {
      // ignore shutdown errors
    }
    instances.delete(key);
  }, IDLE_SHUTDOWN_MS);
}

/**
 * @param {string} workspaceFolder
 * @returns {Promise<{
 *   ok: boolean,
 *   opencodeReady?: boolean,
 *   healthy?: boolean,
 *   version?: string,
 *   connectedProviders?: string[],
 *   error?: string,
 * }>}
 */
export async function getOpenCodeHealth(workspaceFolder) {
  const folder = String(workspaceFolder || '').trim();
  if (!folder) {
    return { ok: false, opencodeReady: false, error: 'Missing workspace folder' };
  }
  let instance = null;
  try {
    instance = await getOrCreateOpenCodeInstance({ workspaceFolder: folder });
    const healthUrl = `${instance.baseUrl.replace(/\/$/, '')}/global/health`;
    const healthResponse = await fetch(healthUrl);
    if (!healthResponse.ok) {
      throw new Error(`OpenCode health HTTP ${healthResponse.status}`);
    }
    const health = /** @type {{ healthy?: boolean, version?: string }} */ (await healthResponse.json());
    const healthy = health?.healthy === true;
    let connectedProviders = [];
    if (healthy) {
      try {
        const providersResult = await instance.client.config.providers({
          query: { directory: folder },
        });
        const providersPayload = unwrapSdkData(providersResult);
        const providers = Array.isArray(providersPayload?.providers) ? providersPayload.providers : [];
        connectedProviders = providers
          .map((row) => (row && typeof row.id === 'string' ? row.id : ''))
          .filter(Boolean);
      } catch {
        connectedProviders = [];
      }
    }
    return {
      ok: true,
      opencodeReady: healthy && hasOpenCodeCredentials(),
      healthy,
      version: typeof health?.version === 'string' ? health.version : undefined,
      connectedProviders,
    };
  } catch (err) {
    return {
      ok: false,
      opencodeReady: false,
      healthy: false,
      error: err?.message || String(err),
    };
  } finally {
    instance?.release();
  }
}

/**
 * @param {string} workspaceFolder
 * @returns {Promise<Array<{ id: string, name: string, providerId: string, modelId: string, contextWindowTokens: number | null }>>}
 */
export async function listOpenCodeModels(workspaceFolder) {
  const folder = String(workspaceFolder || '').trim();
  if (!folder) return [];
  const instance = await getOrCreateOpenCodeInstance({ workspaceFolder: folder });
  try {
    const providersResult = await instance.client.config.providers({
      query: { directory: folder },
    });
    const payload = unwrapSdkData(providersResult);
    const providers = Array.isArray(payload?.providers) ? payload.providers : [];
    /**
     * @param {unknown} modelInfo
     * @returns {number | null}
     */
    const resolveContextWindowTokens = (modelInfo) => {
      if (!modelInfo || typeof modelInfo !== 'object') return null;
      const limit =
        modelInfo.limit && typeof modelInfo.limit === 'object'
          ? modelInfo.limit
          : null;
      if (!limit) return null;
      const inputLimit = Number(limit.input);
      if (Number.isFinite(inputLimit) && inputLimit > 0) return Math.round(inputLimit);
      const contextLimit = Number(limit.context);
      if (Number.isFinite(contextLimit) && contextLimit > 0) return Math.round(contextLimit);
      return null;
    };
    /** @type {Array<{ id: string, name: string, providerId: string, modelId: string, contextWindowTokens: number | null }>} */
    const models = [];
    for (const provider of providers) {
      const providerId = typeof provider?.id === 'string' ? provider.id.trim() : '';
      if (!providerId) continue;
      const modelMap = provider?.models && typeof provider.models === 'object' ? provider.models : {};
      for (const [modelId, modelInfo] of Object.entries(modelMap)) {
        const trimmedModelId = String(modelId || '').trim();
        if (!trimmedModelId) continue;
        const name = typeof modelInfo?.name === 'string' ? modelInfo.name : trimmedModelId;
        models.push({
          id: `${providerId}/${trimmedModelId}`,
          name,
          providerId,
          modelId: trimmedModelId,
          contextWindowTokens: resolveContextWindowTokens(modelInfo),
        });
      }
    }
    models.sort((a, b) => a.name.localeCompare(b.name));
    return dedupeOpenCodeModelsForChat(models, {
      preferredZaiProvider: getOpenCodeZaiProvider(),
    });
  } finally {
    instance.release();
  }
}

/**
 * Pre-start OpenCode when a Zen or Z.AI key is configured (first chat/model request is faster).
 * @param {string} [workspaceFolder]
 */
export async function warmUpOpenCodeFromSettings(workspaceFolder) {
  if (!hasOpenCodeCredentials()) return { ok: false, skipped: true };
  const settings = loadSettings();
  const folder = String(workspaceFolder || settings.workspaceFolder || process.cwd()).trim();
  if (!folder) return { ok: false, error: 'Missing workspace folder' };
  const health = await getOpenCodeHealth(folder);
  return { ok: health.opencodeReady === true, ...health };
}

/**
 * Force-close all OpenCode instances (e.g. after API key change).
 */
export function disposeAllOpenCodeInstances() {
  for (const [key, entry] of instances.entries()) {
    if (entry._idleTimer) clearTimeout(entry._idleTimer);
    try {
      entry.server?.close();
    } catch {
      // ignore shutdown errors
    }
    instances.delete(key);
  }
}

/**
 * @param {string} workspaceFolder
 * @returns {{ running: boolean, refCount: number, port?: number } | null}
 */
export function getOpenCodeInstanceDiag(workspaceFolder) {
  const entry = instances.get(String(workspaceFolder || '').trim());
  if (!entry) return null;
  return {
    running: true,
    refCount: entry.refCount,
    port: entry.port,
  };
}
