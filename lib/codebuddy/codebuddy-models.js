/**
 * CodeBuddy model catalog: live account list from a CLI 400 probe, then the
 * international-site account catalog. product.json stays available for
 * diagnostics but is not the picker source (it lags the live account).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { loadSettings } from '../persist/settings.js';
import { buildCodeBuddyProcessEnv, getEffectiveCodeBuddyApiKey } from './codebuddy-api-key.js';
import {
  resolveBundledCodeBuddyCli,
  resolveCodeBuddyCli,
  resolveCodeBuddyCliForSpawn,
} from './codebuddy-cli.js';

const require = createRequire(import.meta.url);

/** Official CodeBuddy scenario alias — always present on Tencent accounts. */
export const DEFAULT_CODEBUDDY_MODEL = 'default-model';

const LIVE_CATALOG_TIMEOUT_MS = 15000;
const LIVE_CATALOG_CACHE_TTL_MS = 15 * 60 * 1000;
const ACCOUNT_PROBE_MODEL = '__cretli_probe_invalid__';

/**
 * International-site account catalog returned by CodeBuddy API 400s
 * (`Currently supported models for your account`).
 * @type {ReadonlyArray<{ id: string, name: string }>}
 */
const INTERNATIONAL_ACCOUNT_MODELS = Object.freeze([
  { id: 'default-model', name: 'Default' },
  { id: 'fast-model', name: 'Fast' },
  { id: 'balanced-model', name: 'Balanced' },
  { id: 'primary-model', name: 'Primary' },
  { id: 'deep-model', name: 'Deep' },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
  { id: 'gpt-5.5', name: 'GPT-5.5' },
  { id: 'gpt-5.4', name: 'GPT-5.4' },
  { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
  { id: 'glm-5.3', name: 'GLM-5.3' },
  { id: 'glm-5.2', name: 'GLM-5.2' },
  { id: 'kimi-k3', name: 'Kimi K3' },
  { id: 'kimi-k2.6', name: 'Kimi K2.6' },
  { id: 'minimax-m3', name: 'MiniMax M3' },
]);

/** @type {ReadonlyArray<import('../model-catalog.js').ModelCatalogEntry>} */
export const CODEBUDDY_FALLBACK_MODELS = Object.freeze(
  INTERNATIONAL_ACCOUNT_MODELS.map((row) => {
    const provider = inferCodeBuddyProvider(row.id);
    return {
      value: row.id,
      label: row.name,
      modelId: row.id,
      group: row.name,
      provider,
    };
  }),
);

/** @type {{ at: number, catalog: import('../model-catalog.js').ModelCatalogEntry[] } | null} */
let liveCatalogCache = null;

/**
 * @returns {string}
 */
export function resolveDefaultCodeBuddyModel() {
  const fromEnv = (process.env.CODEBUDDY_DEFAULT_MODEL || '').trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_CODEBUDDY_MODEL;
}

/**
 * @param {string} modelId
 * @param {string} [vendor]
 * @returns {string}
 */
export function inferCodeBuddyProvider(modelId, vendor = '') {
  const rawVendor = String(vendor || '').trim();
  if (rawVendor && rawVendor.length > 1 && !/^[a-z]$/i.test(rawVendor)) {
    return rawVendor.toLowerCase();
  }
  const id = String(modelId || '').toLowerCase();
  if (id.startsWith('gpt-') || id.startsWith('o')) return 'openai';
  if (id.startsWith('gemini-')) return 'google';
  if (id.startsWith('glm-')) return 'zhipu';
  if (id.startsWith('kimi-')) return 'moonshot';
  if (id.startsWith('minimax-')) return 'minimax';
  if (id.startsWith('deepseek-')) return 'deepseek';
  return 'codebuddy';
}

/**
 * @param {unknown} row
 * @returns {import('../model-catalog.js').ModelCatalogEntry | null}
 */
export function catalogEntryFromCodeBuddyRow(row) {
  if (!row || typeof row !== 'object') return null;
  const record = /** @type {Record<string, unknown>} */ (row);
  const value = String(record.value || record.modelId || record.id || '').trim();
  if (!value) return null;
  const label = String(record.displayName || record.name || record.label || value).trim() || value;
  const vendor = String(record.vendor || '').trim();
  const provider = inferCodeBuddyProvider(value, vendor);
  const contextWindowTokens = Number(record.maxInputTokens ?? record.contextWindowTokens);
  /** @type {import('../model-catalog.js').ModelCatalogEntry} */
  const entry = {
    value,
    label,
    modelId: value,
    group: label,
    provider,
  };
  if (Number.isFinite(contextWindowTokens) && contextWindowTokens > 0) {
    entry.contextWindowTokens = Math.round(contextWindowTokens);
  }
  return entry;
}

/**
 * @param {unknown} rows
 * @returns {import('../model-catalog.js').ModelCatalogEntry[]}
 */
export function catalogEntriesFromCodeBuddyRows(rows) {
  if (!Array.isArray(rows)) return [];
  const seen = new Set();
  /** @type {import('../model-catalog.js').ModelCatalogEntry[]} */
  const out = [];
  for (const row of rows) {
    const entry = catalogEntryFromCodeBuddyRow(row);
    if (!entry) continue;
    if (seen.has(entry.value)) continue;
    seen.add(entry.value);
    out.push(entry);
  }
  return out;
}

/**
 * @returns {string}
 */
function resolveProductFileName() {
  const edition = (process.env.CODEBUDDY_INTERNET_ENVIRONMENT || '').trim().toLowerCase();
  if (edition === 'internal') return 'product.internal.json';
  if (edition === 'ioa') return 'product.ioa.json';
  if (edition === 'cloudhosted') return 'product.cloudhosted.json';
  if (edition === 'selfhosted') return 'product.selfhosted.json';
  return 'product.json';
}

/**
 * @param {string} startPath
 * @param {string} fileName
 * @returns {string}
 */
function findProductJsonNear(startPath, fileName) {
  if (!startPath || !path.isAbsolute(startPath)) return '';
  let dir = fs.existsSync(startPath) && fs.statSync(startPath).isFile()
    ? path.dirname(startPath)
    : startPath;
  for (let i = 0; i < 5 && dir; i += 1) {
    const candidate = path.join(dir, fileName);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '';
}

/**
 * @returns {string}
 */
export function resolveCodeBuddyProductJsonPath() {
  const fileName = resolveProductFileName();
  const fromCli = findProductJsonNear(resolveCodeBuddyCli(), fileName);
  if (fromCli) return fromCli;
  const bundledCli = resolveBundledCodeBuddyCli();
  const fromBundledCli = findProductJsonNear(bundledCli, fileName);
  if (fromBundledCli) return fromBundledCli;
  try {
    const sdkEntry = require.resolve('@tencent-ai/agent-sdk');
    const pkgRoot = path.resolve(path.dirname(sdkEntry), '..');
    const candidate = path.join(pkgRoot, 'cli', fileName);
    if (fs.existsSync(candidate)) return candidate;
  } catch {
    return '';
  }
  return '';
}

/**
 * Catalog shipped with the CodeBuddy CLI for this edition.
 * @returns {import('../model-catalog.js').ModelCatalogEntry[]}
 */
export function listProductCodeBuddyModels() {
  const productPath = resolveCodeBuddyProductJsonPath();
  if (!productPath) return [];
  try {
    const raw = fs.readFileSync(productPath, 'utf8');
    const payload = JSON.parse(raw);
    return catalogEntriesFromCodeBuddyRows(payload?.models);
  } catch {
    return [];
  }
}

/**
 * @returns {import('../model-catalog.js').ModelCatalogEntry[]}
 */
export function listFallbackCodeBuddyModels() {
  const defaultModel = resolveDefaultCodeBuddyModel();
  const rows = CODEBUDDY_FALLBACK_MODELS.map((row) => ({ ...row }));
  if (!rows.some((row) => row.value === defaultModel)) {
    rows.unshift({
      value: defaultModel,
      label: defaultModel,
      modelId: defaultModel,
      group: defaultModel,
      provider: inferCodeBuddyProvider(defaultModel),
    });
  }
  return rows;
}

export function invalidateCodeBuddyModelsCache() {
  liveCatalogCache = null;
}

/**
 * @param {string} modelId
 * @returns {string}
 */
function labelForAccountModel(modelId) {
  const known = INTERNATIONAL_ACCOUNT_MODELS.find((row) => row.id === modelId);
  if (known) return known.name;
  return modelId;
}

/**
 * Parse Tencent's 400 body: "Currently supported models for your account:".
 * @param {string} text
 * @returns {string[]}
 */
export function parseAccountModelsFromCodeBuddyError(text) {
  const src = String(text || '');
  const marker = /Currently supported models for your account:\s*/i;
  const match = src.match(marker);
  if (!match || match.index === undefined) return [];
  const rest = src.slice(match.index + match[0].length);
  const ids = [];
  for (const rawLine of rest.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[-*]\s+/, '');
    if (!line) {
      if (ids.length > 0) break;
      continue;
    }
    if (/^please use/i.test(line)) break;
    const parts = line.split(/[,\s]+/).map((part) => part.trim()).filter(Boolean);
    let added = false;
    for (const part of parts) {
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(part)) {
        return ids;
      }
      ids.push(part);
      added = true;
    }
    if (!added && ids.length > 0) break;
  }
  return ids;
}

/**
 * International chats stored the old SDK-docs default. Remap unless China edition.
 * @param {string} [modelId]
 * @returns {string}
 */
export function resolveCodeBuddyRunModel(modelId) {
  const raw = String(modelId || '').trim();
  const edition = (process.env.CODEBUDDY_INTERNET_ENVIRONMENT || '').trim();
  if (!raw || (raw === 'deepseek-v3.1' && !edition)) {
    return resolveDefaultCodeBuddyModel();
  }
  return raw;
}

/**
 * @param {string} cliPath
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<{ stdout: string, stderr: string, code: number | null }>}
 */
function runCodeBuddyPrint(cliPath, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cliPath, args, {
      cwd: os.tmpdir(),
      env: { ...process.env, ...buildCodeBuddyProcessEnv() },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ stdout, stderr, code: -1 });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: `${stderr}\n${err.message}`, code: -1 });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

/**
 * Account catalog from a cheap invalid-model print probe (not SDK initialize).
 * @returns {Promise<import('../model-catalog.js').ModelCatalogEntry[]>}
 */
async function listLiveCodeBuddyModels() {
  if (!getEffectiveCodeBuddyApiKey()) return [];
  const cliPath = resolveCodeBuddyCliForSpawn();
  const result = await runCodeBuddyPrint(cliPath, [
    '-p',
    '--output-format', 'text',
    '--model', ACCOUNT_PROBE_MODEL,
    '--permission-mode', 'bypassPermissions',
    'x',
  ], LIVE_CATALOG_TIMEOUT_MS);
  const blob = `${result.stdout}\n${result.stderr}`;
  const ids = parseAccountModelsFromCodeBuddyError(blob);
  if (ids.length === 0) return [];
  return catalogEntriesFromCodeBuddyRows(
    ids.map((id) => ({ id, name: labelForAccountModel(id) })),
  );
}

/**
 * @param {{ refresh?: boolean }} [options]
 * @returns {Promise<{
 *   catalog: import('../model-catalog.js').ModelCatalogEntry[],
 *   models: Array<{ id: string, name: string, contextWindowTokens: number | null }>,
 *   defaultModel: string,
 *   modelsSource: 'live' | 'product' | 'fallback',
 * }>}
 */
export async function listCodeBuddyModels(options = {}) {
  const refresh = options.refresh === true;
  if (refresh) invalidateCodeBuddyModelsCache();
  const defaultModel = resolveDefaultCodeBuddyModel();
  if (!refresh && liveCatalogCache && Date.now() - liveCatalogCache.at < LIVE_CATALOG_CACHE_TTL_MS) {
    return {
      catalog: liveCatalogCache.catalog,
      models: toClientModels(liveCatalogCache.catalog),
      defaultModel,
      modelsSource: 'live',
    };
  }
  try {
    const live = await listLiveCodeBuddyModels();
    if (live.length > 0) {
      liveCatalogCache = { at: Date.now(), catalog: live };
      return {
        catalog: live,
        models: toClientModels(live),
        defaultModel,
        modelsSource: 'live',
      };
    }
  } catch (err) {
    const message = err && typeof err === 'object' && 'message' in err
      ? String(err.message)
      : String(err);
    console.warn('[codebuddy-models] live catalog failed:', message);
  }
  const fallback = listFallbackCodeBuddyModels();
  return {
    catalog: fallback,
    models: toClientModels(fallback),
    defaultModel,
    modelsSource: 'fallback',
  };
}

/**
 * @param {import('../model-catalog.js').ModelCatalogEntry[]} catalog
 * @returns {Array<{ id: string, name: string, contextWindowTokens: number | null }>}
 */
function toClientModels(catalog) {
  return catalog.map((row) => ({
    id: row.value,
    name: row.label,
    contextWindowTokens: row.contextWindowTokens || null,
  }));
}

/**
 * @returns {string[]}
 */
export function getCodeBuddyChatEnabledModels() {
  const settings = loadSettings();
  const raw = settings.codebuddyChatEnabledModels;
  if (!Array.isArray(raw)) return [];
  return raw.map((value) => String(value || '').trim()).filter(Boolean);
}
