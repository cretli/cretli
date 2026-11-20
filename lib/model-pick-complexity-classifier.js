/**
 * Optional decision-classifier backend for the `model_pick` complexity signal
 * (shadow only).
 *
 * A backend (self-hosted basal, Jev 1.13 via OpenRouter, or the unconfirmed
 * OpenAI Decisions endpoint) answers a few typed questions about a leaf body.
 * The answers are mapped onto a closed-list {@link ComplexityShadow} record that
 * is journaled next to the heuristic `complexity` block from
 * `model-pick-complexity.js`. Nothing here feeds candidate selection, the cost
 * policy layer or `complexityPolicy`.
 *
 * Latency contract: a pick never waits for a backend. The pick reads the cache
 * synchronously; a miss schedules one fire-and-forget classification and the
 * record of that pick carries no `complexityShadow`. The next pick of the same
 * leaf body reads the cached result.
 *
 * Privacy contract: the leaf body is sent only to a backend the operator opted
 * into (`allowRemote` for anything off this machine). It is never logged,
 * journaled or used as a visible cache key (the key is a SHA-256 digest held in
 * memory only). Errors are logged by closed-list code only.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import { resolveDataPath } from './runtime-paths.js';
import { getEffectiveOpenRouterApiKey } from './providers/openrouter/openrouter-api-key.ts';

/** @typedef {'trivial' | 'standard' | 'demanding'} ShadowLevel */

export const SHADOW_LEVELS = Object.freeze(['trivial', 'standard', 'demanding']);
export const SHADOW_RISKS = Object.freeze(['none', 'contract', 'security', 'data_migration', 'concurrency']);
export const SHADOW_DOMAINS = Object.freeze(['frontend', 'backend', 'docs', 'tests', 'mixed']);
export const SHADOW_BACKENDS = Object.freeze(['basal', 'jev', 'openai-decisions']);
export const SHADOW_CONFIDENCE_BUCKETS = Object.freeze(['low', 'medium', 'high']);

/** Closed list of error codes a backend failure is reported with. */
export const SHADOW_ERROR_CODES = Object.freeze(['timeout', 'http_error', 'parse_error', 'backend_unavailable', 'network_error']);

/**
 * Backends that have a working adapter. `openai-decisions` stays in the closed
 * list for configs and records, but its API is unconfirmed: a config naming it
 * resolves to `off` with `backend_unavailable`.
 */
export const SHADOW_AVAILABLE_BACKENDS = Object.freeze(['basal', 'jev']);

export const COMPLEXITY_CLASSIFIER_DEFAULTS = Object.freeze({
  backend: 'off',
  url: 'http://127.0.0.1:8000',
  timeoutMs: 2000,
  minConfidence: 0.6,
  allowRemote: false,
});

export const SHADOW_CACHE_MAX_ENTRIES = 500;
export const SHADOW_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const SHADOW_CACHE_NULL_TTL_MS = 10 * 60 * 1000;
export const SHADOW_MAX_CONCURRENCY = 2;
export const SHADOW_MAX_QUEUE = 50;
const TIMEOUT_MIN_MS = 200;
const TIMEOUT_MAX_MS = 10_000;
const PROB_SUM_TOLERANCE = 0.02;
const CONFIDENCE_MEDIUM = 0.6;
const CONFIDENCE_HIGH = 0.85;
const BACKEND_VERSION_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', '::1', '[::1]', 'localhost']);
const JEV_MODEL_ID = 'typesafe/jev-1.13';
const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const LATENCY_SAMPLE_MAX = 200;

/**
 * @typedef {{
 *   backendId: 'basal' | 'jev' | 'openai-decisions',
 *   backendVersion: string,
 *   level: ShadowLevel,
 *   levelProbs: { trivial: number, standard: number, demanding: number },
 *   risk: string,
 *   domain: string,
 *   needsTests: boolean,
 *   confidenceBucket: 'low' | 'medium' | 'high',
 * }} ComplexityShadow
 */

/**
 * @typedef {{
 *   backend: 'off' | 'basal' | 'jev' | 'openai-decisions',
 *   url: string,
 *   timeoutMs: number,
 *   minConfidence: number,
 *   allowRemote: boolean,
 *   offReason?: string,
 * }} ComplexityClassifierConfig
 */

/**
 * @param {number} value
 * @returns {number}
 */
function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Key of the largest value, first key on a tie (list order is canonical).
 *
 * @param {Record<string, number>} probs
 * @param {readonly string[]} keys
 * @returns {string}
 */
function argmax(probs, keys) {
  let best = keys[0];
  for (const key of keys) if (probs[key] > probs[best]) best = key;
  return best;
}

/**
 * @param {number} top
 * @returns {'low' | 'medium' | 'high'}
 */
function confidenceBucketOf(top) {
  if (top >= CONFIDENCE_HIGH) return 'high';
  if (top >= CONFIDENCE_MEDIUM) return 'medium';
  return 'low';
}

/**
 * Validate a probability map over exactly `keys`; renormalize to sum 1 and
 * round to two decimals. Returns `null` on a missing/extra key, a value outside
 * [0,1] or a sum outside 1 ± 0.02.
 *
 * @param {unknown} raw
 * @param {readonly string[]} keys
 * @returns {Record<string, number> | null}
 */
function normalizeProbabilityMap(raw, keys) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entries = Object.keys(raw);
  if (entries.length !== keys.length || !keys.every((key) => entries.includes(key))) return null;
  /** @type {Record<string, number>} */
  const out = {};
  let sum = 0;
  for (const key of keys) {
    const value = /** @type {any} */ (raw)[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return null;
    out[key] = value;
    sum += value;
  }
  if (Math.abs(sum - 1) > PROB_SUM_TOLERANCE || sum <= 0) return null;
  for (const key of keys) out[key] = round2(out[key] / sum);
  return out;
}

/**
 * Normalize a stored or freshly mapped shadow record. Any field outside its
 * closed list makes the whole record `null` — never a partial record.
 *
 * @param {unknown} raw
 * @returns {ComplexityShadow | null}
 */
export function normalizeComplexityShadow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const src = /** @type {any} */ (raw);
  if (!SHADOW_BACKENDS.includes(src.backendId)) return null;
  if (typeof src.backendVersion !== 'string' || !BACKEND_VERSION_PATTERN.test(src.backendVersion)) return null;
  if (!SHADOW_LEVELS.includes(src.level)) return null;
  if (!SHADOW_RISKS.includes(src.risk)) return null;
  if (!SHADOW_DOMAINS.includes(src.domain)) return null;
  if (typeof src.needsTests !== 'boolean') return null;
  if (!SHADOW_CONFIDENCE_BUCKETS.includes(src.confidenceBucket)) return null;
  const levelProbs = normalizeProbabilityMap(src.levelProbs, SHADOW_LEVELS);
  if (!levelProbs) return null;
  // `level` is the argmax of the distribution; a mismatch is an inconsistent record.
  if (argmax(levelProbs, SHADOW_LEVELS) !== src.level) return null;
  return {
    backendId: src.backendId,
    backendVersion: src.backendVersion,
    level: src.level,
    levelProbs: /** @type {ComplexityShadow['levelProbs']} */ (levelProbs),
    risk: src.risk,
    domain: src.domain,
    needsTests: src.needsTests,
    confidenceBucket: src.confidenceBucket,
  };
}

/**
 * Map raw per-question probabilities from an adapter onto a shadow record.
 * Adapters only return probabilities; the field mapping lives here.
 *
 * @param {{
 *   backendId: string,
 *   backendVersion: string,
 *   answers: { level?: unknown, risk?: unknown, domain?: unknown, needsTests?: unknown },
 *   minConfidence?: number,
 * }} input
 * @returns {ComplexityShadow | null}
 */
export function mapAnswersToComplexityShadow(input) {
  const answers = input?.answers && typeof input.answers === 'object' ? input.answers : {};
  const levelProbs = normalizeProbabilityMap(answers.level, SHADOW_LEVELS);
  const riskProbs = normalizeProbabilityMap(answers.risk, SHADOW_RISKS);
  const domainProbs = normalizeProbabilityMap(answers.domain, SHADOW_DOMAINS);
  const testsYes = Number(answers.needsTests);
  if (!levelProbs || !riskProbs || !domainProbs) return null;
  if (typeof answers.needsTests !== 'number' || !Number.isFinite(testsYes) || testsYes < 0 || testsYes > 1) return null;
  const level = argmax(levelProbs, SHADOW_LEVELS);
  const top = levelProbs[level];
  const minConfidence = Number.isFinite(Number(input.minConfidence)) ? Number(input.minConfidence) : COMPLEXITY_CLASSIFIER_DEFAULTS.minConfidence;
  if (top < minConfidence) return null;
  return normalizeComplexityShadow({
    backendId: input.backendId,
    backendVersion: String(input.backendVersion || '').slice(0, 64),
    level,
    levelProbs,
    risk: argmax(riskProbs, SHADOW_RISKS),
    domain: argmax(domainProbs, SHADOW_DOMAINS),
    needsTests: testsYes >= 0.5,
    confidenceBucket: confidenceBucketOf(top),
  });
}

/**
 * @param {string} rawUrl
 * @returns {{ ok: boolean, loopback: boolean }}
 */
function inspectBackendUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, loopback: false };
    return { ok: true, loopback: LOOPBACK_HOSTS.includes(parsed.hostname.toLowerCase()) };
  } catch {
    return { ok: false, loopback: false };
  }
}

/**
 * @param {string} reason
 * @returns {ComplexityClassifierConfig}
 */
function offConfig(reason = '') {
  return { ...COMPLEXITY_CLASSIFIER_DEFAULTS, backend: 'off', ...(reason ? { offReason: reason } : {}) };
}

/**
 * Normalize the `complexityClassifier` block. Fail-closed: any unknown backend
 * or wrongly typed field turns the whole config `off` (with `offReason`), so a
 * typo can never enable a remote backend by accident.
 *
 * @param {unknown} raw
 * @param {{ resolveApiKey?: () => string }} [options]
 * @returns {ComplexityClassifierConfig}
 */
export function normalizeComplexityClassifierConfig(raw, options = {}) {
  if (raw == null) return offConfig();
  if (typeof raw !== 'object' || Array.isArray(raw)) return offConfig('invalid_config');
  const src = /** @type {any} */ (raw);
  const backend = src.backend === undefined ? 'off' : src.backend;
  if (backend !== 'off' && !SHADOW_BACKENDS.includes(backend)) return offConfig('invalid_config');
  if (src.url !== undefined && typeof src.url !== 'string') return offConfig('invalid_config');
  if (src.timeoutMs !== undefined && (typeof src.timeoutMs !== 'number' || !Number.isFinite(src.timeoutMs))) return offConfig('invalid_config');
  if (src.minConfidence !== undefined && (typeof src.minConfidence !== 'number' || !(src.minConfidence >= 0 && src.minConfidence <= 1))) {
    return offConfig('invalid_config');
  }
  if (src.allowRemote !== undefined && typeof src.allowRemote !== 'boolean') return offConfig('invalid_config');
  if (backend === 'off') return offConfig();
  const config = {
    backend,
    url: String(src.url ?? COMPLEXITY_CLASSIFIER_DEFAULTS.url).trim(),
    timeoutMs: Math.min(TIMEOUT_MAX_MS, Math.max(TIMEOUT_MIN_MS, Math.round(src.timeoutMs ?? COMPLEXITY_CLASSIFIER_DEFAULTS.timeoutMs))),
    minConfidence: src.minConfidence ?? COMPLEXITY_CLASSIFIER_DEFAULTS.minConfidence,
    allowRemote: src.allowRemote === true,
  };
  if (!SHADOW_AVAILABLE_BACKENDS.includes(backend)) return offConfig('backend_unavailable');
  if (backend === 'basal') {
    const url = inspectBackendUrl(config.url);
    if (!url.ok) return offConfig('invalid_config');
    // A non-loopback basal host receives leaf bodies: an explicit opt-in.
    if (!url.loopback && !config.allowRemote) return offConfig('remote_not_allowed');
    return /** @type {ComplexityClassifierConfig} */ (config);
  }
  // Hosted backends always send the leaf body to a provider.
  if (!config.allowRemote) return offConfig('remote_not_allowed');
  const resolveApiKey = typeof options.resolveApiKey === 'function' ? options.resolveApiKey : getEffectiveOpenRouterApiKey;
  let key = '';
  try { key = String(resolveApiKey() || ''); } catch { key = ''; }
  if (!key) return offConfig('missing_api_key');
  return /** @type {ComplexityClassifierConfig} */ (config);
}

/**
 * @param {string} line
 */
function defaultWarn(line) {
  if (process.env.CRETLI_TEST_DATA_DIR) return;
  console.warn('[model-pick]', line);
}

/**
 * Read `complexityClassifier` from `data/model-role-profiles.json`. A missing
 * file or key is a silent `off`; a broken JSON document or an invalid block is
 * `off` with one warning line that names the reason code, never field values.
 *
 * @param {{ filePath?: string, warn?: (line: string) => void, resolveApiKey?: () => string }} [input]
 * @returns {ComplexityClassifierConfig}
 */
export function loadComplexityClassifierConfig(input = {}) {
  const filePath = String(input.filePath || '').trim() || resolveDataPath('model-role-profiles.json');
  const warn = typeof input.warn === 'function' ? input.warn : defaultWarn;
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return offConfig();
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    warn('complexityClassifier disabled: invalid_json');
    return offConfig('invalid_json');
  }
  const config = normalizeComplexityClassifierConfig(doc?.complexityClassifier, { resolveApiKey: input.resolveApiKey });
  if (config.offReason) warn(`complexityClassifier disabled: ${config.offReason}`);
  return config;
}

/**
 * Typed questions shared by every adapter (basal `POST /v1/systemone` shape).
 */
const QUESTIONS = Object.freeze({
  level: {
    type: 'choice',
    instructions: 'How much engineering effort does this coding task need?',
    criteria: {
      trivial: 'A small, local, low-risk change (typo, one function, one file).',
      standard: 'A normal feature or fix touching a few files with ordinary risk.',
      demanding: 'A large or risky change: many files, contracts, migrations, concurrency or security.',
    },
  },
  risk: {
    type: 'choice',
    instructions: 'What is the main risk of this change?',
    criteria: {
      none: 'No special risk.',
      contract: 'Changes a public API, schema or contract other code relies on.',
      security: 'Touches authentication, secrets, permissions or input validation.',
      data_migration: 'Migrates or rewrites stored data.',
      concurrency: 'Involves locks, races, parallel work or ordering.',
    },
  },
  domain: {
    type: 'choice',
    instructions: 'Which part of the codebase does the change mostly touch?',
    criteria: {
      frontend: 'User interface code.',
      backend: 'Server, library or CLI code.',
      docs: 'Documentation only.',
      tests: 'Tests only.',
      mixed: 'Several of the above in comparable amounts.',
    },
  },
  needsTests: {
    type: 'noul',
    instructions: 'Does this change need new or updated automated tests?',
  },
});

/**
 * @param {unknown} probs
 * @param {readonly string[]} keys
 * @returns {Record<string, number> | null}
 */
function pickProbabilities(probs, keys) {
  if (!probs || typeof probs !== 'object') return null;
  /** @type {Record<string, number>} */
  const out = {};
  for (const key of keys) out[key] = Number(/** @type {any} */ (probs)[key]);
  return out;
}

/**
 * Parse a basal `/v1/systemone` response into raw answers.
 *
 * @param {any} body
 * @returns {{ answers: object, version: string }}
 */
export function parseBasalResponse(body) {
  const answers = body?.answers;
  if (!answers || typeof answers !== 'object') throw Object.assign(new Error('parse_error'), { code: 'parse_error' });
  const yes = answers.needsTests?.noul ?? answers.needsTests?.probabilities?.true;
  return {
    answers: {
      level: pickProbabilities(answers.level?.probabilities, SHADOW_LEVELS),
      risk: pickProbabilities(answers.risk?.probabilities, SHADOW_RISKS),
      domain: pickProbabilities(answers.domain?.probabilities, SHADOW_DOMAINS),
      needsTests: typeof yes === 'number' ? yes : undefined,
    },
    version: String(body?.model || 'basal').replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 64) || 'basal',
  };
}

/**
 * Parse a Jev reply (OpenRouter chat completion whose content is a JSON object
 * with the same per-question probability maps).
 *
 * @param {any} body
 * @returns {{ answers: object, version: string }}
 */
export function parseJevResponse(body) {
  const content = body?.choices?.[0]?.message?.content;
  let parsed;
  try {
    parsed = JSON.parse(String(content || '').replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw Object.assign(new Error('parse_error'), { code: 'parse_error' });
  }
  return {
    answers: {
      level: pickProbabilities(parsed?.level, SHADOW_LEVELS),
      risk: pickProbabilities(parsed?.risk, SHADOW_RISKS),
      domain: pickProbabilities(parsed?.domain, SHADOW_DOMAINS),
      needsTests: typeof parsed?.needsTests === 'number' ? parsed.needsTests : undefined,
    },
    version: 'jev-1.13',
  };
}

/**
 * @param {string} url
 * @param {object} init
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<any>}
 */
async function fetchJson(url, init, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch (err) {
    const aborted = /** @type {any} */ (err)?.name === 'AbortError';
    throw Object.assign(new Error(aborted ? 'timeout' : 'network_error'), { code: aborted ? 'timeout' : 'network_error' });
  }
  if (!response.ok) throw Object.assign(new Error('http_error'), { code: 'http_error', status: response.status });
  try {
    return await response.json();
  } catch {
    throw Object.assign(new Error('parse_error'), { code: 'parse_error' });
  }
}

/**
 * Build the adapter for a resolved (non-off) config. Each adapter takes the
 * leaf body and an abort signal and returns `{ answers, version }`.
 *
 * @param {ComplexityClassifierConfig} config
 * @param {{ fetchImpl?: typeof fetch, resolveApiKey?: () => string }} [options]
 * @returns {(input: { leafBody: string, role: string, signal: AbortSignal }) => Promise<{ answers: object, version: string }>}
 */
export function createComplexityAdapter(config, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (config.backend === 'basal') {
    const endpoint = new URL('/v1/systemone', config.url).toString();
    return async ({ leafBody, role, signal }) => parseBasalResponse(await fetchJson(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: { role, task: leafBody }, questions: QUESTIONS }),
      signal,
    }, fetchImpl));
  }
  if (config.backend === 'jev') {
    const resolveApiKey = typeof options.resolveApiKey === 'function' ? options.resolveApiKey : getEffectiveOpenRouterApiKey;
    return async ({ leafBody, role, signal }) => parseJevResponse(await fetchJson(OPENROUTER_CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resolveApiKey()}` },
      body: JSON.stringify({
        model: JEV_MODEL_ID,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: 'Answer each typed question about the coding task with calibrated probabilities. '
              + 'Reply with one JSON object: {"level":{...},"risk":{...},"domain":{...},"needsTests":<p(yes)>}. '
              + `Questions: ${JSON.stringify(QUESTIONS)}`,
          },
          { role: 'user', content: JSON.stringify({ role, task: leafBody }) },
        ],
      }),
      signal,
    }, fetchImpl));
  }
  return async () => {
    throw Object.assign(new Error('backend_unavailable'), { code: 'backend_unavailable' });
  };
}

/**
 * In-memory cache key. Never persisted or logged.
 *
 * @param {{ workspaceFolder?: string, role?: string, leafBody?: string, backendId: string, backendVersion: string }} input
 * @returns {string}
 */
export function buildComplexityShadowKey(input) {
  const digest = crypto.createHash('sha256')
    .update(`${String(input.workspaceFolder || '')}\0${String(input.role || '')}\0${String(input.leafBody || '')}`)
    .digest('hex');
  return `${digest}:${input.backendId}:${input.backendVersion}`;
}

/**
 * @param {number[]} samples
 * @param {number} q
 * @returns {number | null}
 */
function percentile(samples, q) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

/**
 * Cache + single-flight + bounded queue around one adapter.
 *
 * @param {{
 *   config: ComplexityClassifierConfig,
 *   adapter?: ReturnType<typeof createComplexityAdapter>,
 *   now?: () => number,
 *   log?: (line: string) => void,
 *   fetchImpl?: typeof fetch,
 *   resolveApiKey?: () => string,
 * }} input
 */
export function createComplexityShadowClassifier(input) {
  const config = input.config;
  const adapter = input.adapter || createComplexityAdapter(config, { fetchImpl: input.fetchImpl, resolveApiKey: input.resolveApiKey });
  const now = typeof input.now === 'function' ? input.now : Date.now;
  const log = typeof input.log === 'function' ? input.log : defaultWarn;
  /** Backend version used in the cache key; the backend id until a response names it. */
  const keyVersion = config.backend;
  /** @type {Map<string, { value: ComplexityShadow | null, expiresAt: number }>} */
  const cache = new Map();
  /** @type {Map<string, Promise<ComplexityShadow | null>>} */
  const inFlight = new Map();
  /** @type {{ key: string, leafBody: string, role: string, resolve: (v: ComplexityShadow | null) => void }[]} */
  const queue = [];
  let running = 0;
  const counters = { requests: 0, hits: 0, misses: 0, dropped: 0, errors: /** @type {Record<string, number>} */ ({}) };
  /** @type {number[]} */
  const latencies = [];

  /**
   * @param {string} key
   * @param {ComplexityShadow | null} value
   */
  function store(key, value) {
    cache.delete(key);
    cache.set(key, { value, expiresAt: now() + (value ? SHADOW_CACHE_TTL_MS : SHADOW_CACHE_NULL_TTL_MS) });
    while (cache.size > SHADOW_CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
  }

  /**
   * @param {{ leafBody: string, role: string }} job
   * @returns {Promise<ComplexityShadow | null>}
   */
  async function classify(job) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    const started = now();
    counters.requests += 1;
    try {
      const raw = await Promise.race([
        adapter({ leafBody: job.leafBody, role: job.role, signal: controller.signal }),
        new Promise((_, reject) => controller.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('timeout'), { code: 'timeout' }));
        }, { once: true })),
      ]);
      return mapAnswersToComplexityShadow({
        backendId: config.backend,
        backendVersion: raw?.version || config.backend,
        answers: raw?.answers || {},
        minConfidence: config.minConfidence,
      });
    } catch (err) {
      const status = Number(/** @type {any} */ (err)?.status);
      const raw = String(/** @type {any} */ (err)?.code || '');
      const code = SHADOW_ERROR_CODES.includes(raw) ? raw : 'parse_error';
      counters.errors[code] = (counters.errors[code] || 0) + 1;
      // Code only: never the request, the response or the leaf body.
      log(`complexityClassifier ${config.backend} failed: ${code === 'http_error' && Number.isFinite(status) ? `http_${status}` : code}`);
      return null;
    } finally {
      clearTimeout(timer);
      latencies.push(now() - started);
      if (latencies.length > LATENCY_SAMPLE_MAX) latencies.shift();
    }
  }

  function drain() {
    while (running < SHADOW_MAX_CONCURRENCY && queue.length > 0) {
      const job = /** @type {typeof queue[number]} */ (queue.shift());
      running += 1;
      classify(job).then((value) => {
        store(job.key, value);
        job.resolve(value);
      }).finally(() => {
        running -= 1;
        inFlight.delete(job.key);
        drain();
      });
    }
  }

  return {
    config,
    /**
     * @param {{ workspaceFolder?: string, role?: string, leafBody?: string }} pick
     */
    keyFor(pick) {
      return buildComplexityShadowKey({ ...pick, backendId: config.backend, backendVersion: keyVersion });
    },
    /**
     * Synchronous cache read. `undefined` = miss; `null` = cached failure.
     *
     * @param {string} key
     * @returns {ComplexityShadow | null | undefined}
     */
    getCachedShadow(key) {
      const entry = cache.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        cache.delete(key);
        return undefined;
      }
      // Refresh LRU order on a hit.
      cache.delete(key);
      cache.set(key, entry);
      return entry.value;
    },
    /**
     * Fire-and-forget classification; repeated calls for one key share one request.
     *
     * @param {string} key
     * @param {{ leafBody: string, role?: string }} job
     * @returns {Promise<ComplexityShadow | null>}
     */
    scheduleShadow(key, job) {
      const pending = inFlight.get(key);
      if (pending) return pending;
      if (queue.length >= SHADOW_MAX_QUEUE) {
        counters.dropped += 1;
        return Promise.resolve(null);
      }
      const promise = new Promise((resolve) => {
        queue.push({ key, leafBody: String(job.leafBody || ''), role: String(job.role || ''), resolve });
      });
      inFlight.set(key, /** @type {Promise<ComplexityShadow | null>} */ (promise));
      drain();
      return /** @type {Promise<ComplexityShadow | null>} */ (promise);
    },
    /**
     * Counters for the evaluation report (latency/cost come from here, not the journal).
     */
    stats() {
      return {
        backend: config.backend,
        requests: counters.requests,
        hits: counters.hits,
        misses: counters.misses,
        dropped: counters.dropped,
        errors: { ...counters.errors },
        latencyP50Ms: percentile(latencies, 0.5),
        latencyP95Ms: percentile(latencies, 0.95),
        cacheSize: cache.size,
      };
    },
    /** @internal counters for hits/misses, updated by the pick entry point. */
    countLookup(hit) {
      if (hit) counters.hits += 1;
      else counters.misses += 1;
    },
  };
}

/** @type {{ fingerprint: string, classifier: ReturnType<typeof createComplexityShadowClassifier> } | null} */
let defaultClassifier = null;

/**
 * Process-wide classifier for the current config; rebuilt (cache dropped) only
 * when the resolved config changes.
 *
 * @param {ComplexityClassifierConfig} config
 */
function classifierForConfig(config) {
  const fingerprint = JSON.stringify(config);
  if (!defaultClassifier || defaultClassifier.fingerprint !== fingerprint) {
    defaultClassifier = { fingerprint, classifier: createComplexityShadowClassifier({ config }) };
  }
  return defaultClassifier.classifier;
}

/**
 * Pick-time entry point. Returns the cached shadow record for this leaf body,
 * or `null` and schedules a background classification. Never throws, never
 * awaits, and returns `null` whenever the backend is off or there is no body.
 *
 * @param {{
 *   leafBody?: string,
 *   role?: string,
 *   workspaceFolder?: string,
 *   complexityClassifier?: ReturnType<typeof createComplexityShadowClassifier> | false,
 *   complexityClassifierConfig?: unknown,
 *   complexityClassifierFile?: string,
 * }} input
 * @returns {ComplexityShadow | null}
 */
export function resolveComplexityShadowForPick(input = {}) {
  try {
    if (input.complexityClassifier === false) return null;
    const leafBody = String(input.leafBody || '');
    if (!leafBody.trim()) return null;
    const classifier = input.complexityClassifier && typeof input.complexityClassifier === 'object'
      ? input.complexityClassifier
      : (() => {
        const config = input.complexityClassifierConfig !== undefined
          ? normalizeComplexityClassifierConfig(input.complexityClassifierConfig)
          : loadComplexityClassifierConfig({ filePath: input.complexityClassifierFile });
        return config.backend === 'off' ? null : classifierForConfig(config);
      })();
    if (!classifier || classifier.config.backend === 'off') return null;
    const key = classifier.keyFor({ workspaceFolder: input.workspaceFolder, role: input.role, leafBody });
    const cached = classifier.getCachedShadow(key);
    classifier.countLookup(cached !== undefined);
    if (cached !== undefined) return cached;
    classifier.scheduleShadow(key, { leafBody, role: input.role }).catch(() => {});
    return null;
  } catch {
    return null;
  }
}

/**
 * Counters of the process-wide classifier (or `null` when none was built).
 */
export function getComplexityShadowStats() {
  return defaultClassifier ? defaultClassifier.classifier.stats() : null;
}
