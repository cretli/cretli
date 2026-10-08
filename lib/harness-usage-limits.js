/** Shared provider usage-limit state for harness model selection. */
import fs from 'node:fs';
import path from 'node:path';
import { resolveDataPath } from './runtime-paths.js';
import { writeJsonAtomic } from './persist/atomic-write.js';
import { decodeModelValue } from './model-catalog.js';
import { appendHarnessPlanLimitHistory } from './usage/plan-limit-history.js';

const FILE = resolveDataPath('harness-usage-limits.json');
const HISTORY_FILE = resolveDataPath('usage', 'limits.jsonl');
const DEFAULT_TTL_MS = 60 * 60 * 1000;
/** Account-wide billing failure (no credit): retry much later than a rate limit. */
const BALANCE_TTL_MS = 6 * 60 * 60 * 1000;
/** Provider no longer serves this model id: a retry within the day fails the same way. */
const MODEL_UNAVAILABLE_TTL_MS = 24 * 60 * 60 * 1000;
/** Retention bounds for the append-only lockout history. */
const HISTORY_MAX_ROWS = 5000;
const HISTORY_MAX_AGE_MS = 92 * 24 * 60 * 60 * 1000;
const HISTORY_DEDUPE_WINDOW_MS = 60 * 1000;
/** Trim every N appends even when the file is still small. */
const HISTORY_TRIM_EVERY = 100;
const HISTORY_MAX_BYTES = 1024 * 1024;

/** Parsed history rows keyed by absolute path, invalidated by mtime/size. */
const historyCache = new Map();
const MAX_CACHED_HISTORY_FILES = 8;
/** Appends since the last retention pass, keyed by absolute history path. */
const historyAppendCounts = new Map();

const key = (harness, model) => `${String(harness || '').trim().toLowerCase()}:${String(model || '').trim().toLowerCase() || '*'}`;
const baseModel = (model) => decodeModelValue(String(model || '').trim()).modelId.toLowerCase();

/**
 * Lockout stores keyed by resolved limits file. Production uses the single
 * default root; a `dataDir` override gets its own store, so tests and alternate
 * data roots never share in-memory lockout state with the default root.
 *
 * @type {Map<string, { loaded: boolean, limits: Map<string, object> }>}
 */
const stores = new Map();

/**
 * @param {unknown} dataDir
 * @returns {string}
 */
function resolveLimitsFile(dataDir) {
  const override = String(dataDir || '').trim();
  return override ? path.join(override, 'harness-usage-limits.json') : FILE;
}

/**
 * @param {unknown} dataDir
 * @returns {{ file: string, limits: Map<string, object> }}
 */
function getStore(dataDir) {
  const file = resolveLimitsFile(dataDir);
  let store = stores.get(file);
  if (!store) {
    store = { loaded: false, limits: new Map() };
    stores.set(file, store);
  }
  if (!store.loaded) {
    store.loaded = true;
    try {
      const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const row of Array.isArray(rows) ? rows : []) {
        if (row?.harness && new Date(row.resetAt).getTime() > Date.now()) {
          store.limits.set(key(row.harness, row.model), row);
        }
      }
    } catch { /* optional cache */ }
  }
  return { file, limits: store.limits };
}

/**
 * @param {string} file
 * @param {Map<string, object>} limitsMap
 * @returns {void}
 */
function save(file, limitsMap) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, [...limitsMap.values()]);
  } catch (error) {
    console.warn('[harness-usage-limits] persist failed:', error?.message || error);
  }
}

/**
 * @param {unknown} value
 * @returns {string} trimmed short code (max 64 chars), or ''
 */
function shortCode(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return text.replace(/\s+/g, ' ').slice(0, 64);
}

/**
 * Accepts epoch seconds, epoch milliseconds, or an ISO-ish string.
 *
 * @param {unknown} value
 * @returns {string} ISO timestamp or ''
 */
function normalizeResetAt(value) {
  if (value == null || value === '') return '';
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    const ms = numeric < 1e12 ? numeric * 1000 : numeric;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
  }
  const parsed = new Date(String(value).replace(' ', 'T')).getTime();
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

/**
 * Provider says the account is out of credit (DeepSeek "Insufficient Balance",
 * OpenAI/OpenRouter "insufficient_quota" / 402). Account-wide, not per model.
 *
 * @param {unknown} message
 * @returns {boolean}
 */
export function isInsufficientBalanceMessage(message) {
  const text = String(message || '').toLowerCase();
  return /insufficient[\s_-]+(?:balance|funds|credits?|quota)|payment\s+required|out\s+of\s+credits?|credit\s+balance\s+is\s+too\s+low|billing\s+(?:hard\s+)?limit|exceeded\s+your\s+current\s+quota|insufficient_quota|requires\s+more\s+credits|can\s+only\s+afford|arrearage|overdue[\s-]+payment|account\s+(?:is\s+)?(?:suspended|in\s+arrears)|low\s+balance|no\s+credits?\s+(?:left|remaining)|add\s+(?:more\s+)?credits?|purchase\s+more\s+credits?|top\s+up/.test(text)
    || /(?:status|http|code|error)\D{0,6}402\b/.test(text);
}

/**
 * Provider rejects the model id itself (CodeBuddy `400 model [x] service info
 * not found`, OpenAI-style `model_not_found`) or the account's plan does not
 * include it. Not a quota problem: the same
 * id keeps failing until the account or catalog changes, so the picker must
 * stop choosing it instead of burning one run per attempt.
 *
 * @param {unknown} message
 * @returns {boolean}
 */
export function isModelUnavailableMessage(message) {
  const text = String(message || '').toLowerCase();
  // Quota and balance wording wins: those errors have their own lockout scope.
  if (isUsageLimitMessage(text)) return false;
  // Every pattern names the model: a bare "service info not found" can come
  // from a local tool or MCP server and must not lock a working model.
  return /\bmodel\s+\[[^\]]+\]\s+service\s+info\s+not\s+found|\bmodel_not_found\b|\bmodel\s+\[[^\]]+\]\s+(?:is\s+)?not\s+(?:found|supported|available)/.test(text)
    // Plan does not cover the id (Z.ai coding plan, Codex with a ChatGPT account).
    || /subscription\s+plan\s+does\s+not\s+(?:yet\s+)?include\s+access\s+to|\bmodel\s+is\s+not\s+supported\s+when\s+using/.test(text);
}

export function isUsageLimitMessage(message) {
  const text = String(message || '').toLowerCase();
  if (isInsufficientBalanceMessage(text)) return true;
  return /usage\s+limit|session\s+limit|quota\s+(?:has\s+been\s+)?exhausted|rate\s+limit|too many requests|resource[_ ]exhausted/.test(text)
    || /\b429\b/.test(text);
}

function zonedParts(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

function localClockToTimestamp(year, month, day, hour, minute, timeZone) {
  if (!timeZone) {
    const date = new Date(year, month - 1, day, hour, minute, 0, 0);
    return date.getTime();
  }
  // Iteratively correct UTC until its rendered wall clock matches the target.
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 3; i += 1) {
    const p = zonedParts(guess, timeZone);
    const rendered = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
    const wanted = Date.UTC(year, month - 1, day, hour, minute);
    guess += wanted - rendered;
  }
  return guess;
}

/**
 * Extracts a reset timestamp that the provider actually stated. Returns '' when
 * the message carries no parseable future date; it never invents a window.
 *
 * @param {unknown} message
 * @returns {string} ISO timestamp or ''
 */
function parseResetAt(message) {
  const text = String(message || '');
  const absolute = text.match(/(?:reset|resets|reset at|reset on)\s*(?:at|on)?\s*([0-9]{4}-[0-9]{2}-[0-9]{2}(?:[ T][0-9]{2}:[0-9]{2}(?::[0-9]{2})?(?:\s*(?:UTC|Z))?)?)/i);
  const now = Date.now();
  if (absolute) {
    const timestamp = new Date(absolute[1].replace(' ', 'T')).getTime();
    if (Number.isFinite(timestamp) && timestamp > now) return new Date(timestamp).toISOString();
  }

  // Providers such as Claude say "resets 8pm (Europe/Warsaw)". Preserve the
  // provider's stated zone and infer today/next day from the current local date.
  const clock = text.match(/\breset(?:s)?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i);
  if (clock) {
    const hourText = Number(clock[1]);
    const minute = Number(clock[2] || 0);
    const meridiem = String(clock[3] || '').toLowerCase();
    const timeZone = String(clock[4] || '').trim() || undefined;
    let hour = hourText;
    if (meridiem) hour = (hourText % 12) + (meridiem === 'pm' ? 12 : 0);
    if (hour >= 0 && hour <= 23 && minute <= 59) {
      try {
        const dateParts = timeZone ? zonedParts(now, timeZone) : {
          year: String(new Date(now).getFullYear()),
          month: String(new Date(now).getMonth() + 1).padStart(2, '0'),
          day: String(new Date(now).getDate()).padStart(2, '0'),
        };
        let year = Number(dateParts.year);
        let month = Number(dateParts.month);
        let day = Number(dateParts.day);
        let timestamp = localClockToTimestamp(year, month, day, hour, minute, timeZone);
        if (timestamp <= now) {
          const next = new Date(Date.UTC(year, month - 1, day + 1));
          year = next.getUTCFullYear(); month = next.getUTCMonth() + 1; day = next.getUTCDate();
          timestamp = localClockToTimestamp(year, month, day, hour, minute, timeZone);
        }
        if (Number.isFinite(timestamp) && timestamp > now) return new Date(timestamp).toISOString();
      } catch { /* invalid provider timezone; fall through to the caller fallback */ }
    }
  }
  return '';
}

/**
 * Lockout-store reset window: an authentic provider date when the message has
 * one, otherwise the conservative TTL fallback. Only the lockout store may
 * consume the fallback; the plan-limit history must not (see
 * `noteHarnessUsageLimit`).
 *
 * @param {unknown} message
 * @returns {string} ISO timestamp
 */
function readResetAt(message) {
  return parseResetAt(message) || new Date(Date.now() + DEFAULT_TTL_MS).toISOString();
}

/**
 * @param {unknown} dataDir
 * @returns {string}
 */
function resolveHistoryFile(dataDir) {
  const override = String(dataDir || '').trim();
  return override ? path.join(override, 'usage', 'limits.jsonl') : HISTORY_FILE;
}

/**
 * @param {string} file
 * @returns {object[]}
 */
function readHistoryRows(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    historyCache.delete(file);
    return [];
  }
  const cached = historyCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.rows;
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') rows.push(parsed);
    } catch {
      // Skip a corrupt line rather than failing the whole history.
    }
  }
  if (historyCache.size >= MAX_CACHED_HISTORY_FILES) {
    const oldest = historyCache.keys().next().value;
    if (oldest) historyCache.delete(oldest);
  }
  historyCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, rows });
  return rows;
}

/**
 * True when `candidate` repeats an incident already in history: the same
 * harness+model already has an active lockout for the same resetAt, or a fully
 * identical row was written within the last 60 s.
 *
 * @param {object[]} rows
 * @param {object} candidate
 * @param {number} now
 * @returns {boolean}
 */
function isDuplicateHistoryRow(rows, candidate, now) {
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (String(row.harness || '').toLowerCase() !== candidate.harness) continue;
    if (String(row.model || '').toLowerCase() !== candidate.model) continue;
    if (String(row.resetAt || '') !== candidate.resetAt) continue;
    const resetTs = new Date(candidate.resetAt).getTime();
    if (Number.isFinite(resetTs) && resetTs > now) return true;
    const ts = Date.parse(String(row.ts || ''));
    if (!Number.isFinite(ts)) continue;
    const age = now - ts;
    if (
      age >= 0
      && age <= HISTORY_DEDUPE_WINDOW_MS
      && String(row.source || '') === candidate.source
      && String(row.code || '') === candidate.code
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Rewrites the history atomically, keeping the retention window: rows from the
 * last 92 days, capped at the newest `HISTORY_MAX_ROWS`.
 *
 * @param {string} file
 * @returns {void}
 */
function trimHistory(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  const cutoff = Date.now() - HISTORY_MAX_AGE_MS;
  const kept = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const ts = Date.parse(String(parsed.ts || ''));
    if (Number.isFinite(ts) && ts < cutoff) continue;
    kept.push(parsed);
  }
  const limited = kept.length > HISTORY_MAX_ROWS ? kept.slice(kept.length - HISTORY_MAX_ROWS) : kept;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(
      tmp,
      limited.length ? `${limited.map((row) => JSON.stringify(row)).join('\n')}\n` : '',
      'utf8',
    );
    fs.renameSync(tmp, file);
    historyAppendCounts.set(file, 0);
    historyCache.delete(file);
  } catch (error) {
    console.warn('[harness-usage-limits] history trim failed:', error?.message || error);
  }
}

/**
 * Schedules a retention pass: every `HISTORY_TRIM_EVERY` appends, or as soon as
 * the file grows past `HISTORY_MAX_BYTES`.
 *
 * @param {string} file
 * @returns {void}
 */
function maybeTrimHistory(file) {
  const appends = (historyAppendCounts.get(file) || 0) + 1;
  historyAppendCounts.set(file, appends);
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    size = 0;
  }
  if (size <= HISTORY_MAX_BYTES && appends < HISTORY_TRIM_EVERY) return;
  trimHistory(file);
}

/**
 * Appends one lockout row. Never carries the raw error text: only a short code.
 * Repeats of the same active incident are dropped, and the file is trimmed on a
 * size/count schedule so it cannot grow without bound.
 *
 * @param {object} row
 * @param {unknown} dataDir
 * @returns {void}
 */
function appendLimitHistory(row, dataDir) {
  try {
    const file = resolveHistoryFile(dataDir);
    const rows = readHistoryRows(file);
    if (isDuplicateHistoryRow(rows, row, Date.now())) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
    historyCache.delete(file);
    maybeTrimHistory(file);
  } catch (error) {
    console.warn('[harness-usage-limits] history append failed:', error?.message || error);
  }
}

/**
 * @param {unknown} value
 * @param {boolean} end
 * @returns {string}
 */
function normalizeHistoryBound(value, end) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return end ? `${raw}T23:59:59.999Z` : `${raw}T00:00:00.000Z`;
  return raw;
}

/**
 * Reads the append-only lockout history (`data/usage/limits.jsonl`).
 *
 * @param {{ from?: string, to?: string, harness?: string, limit?: number, dataDir?: string }} [query]
 * @returns {object[]}
 */
export function readHarnessUsageLimitHistory(query = {}) {
  const rows = readHistoryRows(resolveHistoryFile(query.dataDir));
  const harness = String(query.harness || '').trim().toLowerCase();
  const from = normalizeHistoryBound(query.from, false);
  const to = normalizeHistoryBound(query.to, true);
  const requestedLimit = Number.parseInt(String(query.limit ?? ''), 10);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 0;
  let filtered = rows.filter((row) => {
    if (!row || typeof row !== 'object') return false;
    if (harness && String(row.harness || '').toLowerCase() !== harness) return false;
    const ts = String(row.ts || '');
    if (from && ts < from) return false;
    if (to && ts > to) return false;
    return true;
  });
  filtered.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  if (limit > 0 && filtered.length > limit) filtered = filtered.slice(filtered.length - limit);
  return filtered;
}

/**
 * Records a lockout. `source: 'rate-limit-event'` accepts structured SDK data
 * (explicit `resetAt`, `status`); the default `error-text` path keeps the
 * original message-regex behaviour.
 *
 * @param {object} [input]
 * @returns {boolean}
 */
export function noteHarnessUsageLimit(input = {}) {
  const harness = String(input.harness || '').trim().toLowerCase();
  const message = String(input.message || '').trim();
  const balance = isInsufficientBalanceMessage(message);
  // No credit blocks the whole account, so lock the harness, not one model.
  const model = balance ? '' : String(input.model || '').trim();
  const source = input.source === 'rate-limit-event' ? 'rate-limit-event' : 'error-text';
  const status = String(input.status || '').trim().toLowerCase();
  if (!harness) return false;
  // A rejected model id is scoped to that id only; without one there is nothing
  // safe to lock (an empty model would lock the whole harness).
  const unavailable = source === 'error-text' && isModelUnavailableMessage(message);
  if (unavailable) {
    if (!model) return false;
    const detectedAt = new Date().toISOString();
    const resetAt = new Date(Date.now() + MODEL_UNAVAILABLE_TTL_MS).toISOString();
    const store = getStore(input.dataDir);
    store.limits.set(key(harness, model), {
      harness, model, message: message.slice(0, 1000),
      resetAt, detectedAt, source, code: 'model_unavailable',
    });
    save(store.file, store.limits);
    appendLimitHistory({
      ts: detectedAt, harness, model: baseModel(model), resetAt, source, code: 'model_unavailable',
    }, input.dataDir);
    return true;
  }
  if (source === 'rate-limit-event') {
    // Only a rejected window locks a model out; warnings must stay advisory.
    if (status && status !== 'rejected') return false;
    if (!status && !message) return false;
  } else if (!isUsageLimitMessage(message)) {
    return false;
  }
  // An authentic reset window is either an explicit `input.resetAt` that is
  // still in the future or a date actually parsed from the message. Only that
  // value may reach the plan-limit history; the lockout store additionally
  // accepts the conservative TTL fallback via `readResetAt`.
  const explicitResetAt = normalizeResetAt(input.resetAt);
  const authenticResetAt = explicitResetAt && new Date(explicitResetAt).getTime() > Date.now()
    ? explicitResetAt
    : parseResetAt(message);
  const resetAt = authenticResetAt
    || (balance ? new Date(Date.now() + BALANCE_TTL_MS).toISOString() : readResetAt(message));
  const code = shortCode(input.code) || (balance ? 'insufficient_balance' : source === 'rate-limit-event' ? 'rate_limit_rejected' : 'usage_limit');
  const detectedAt = new Date().toISOString();
  const store = getStore(input.dataDir);
  store.limits.set(key(harness, model), {
    harness, model, message: message.slice(0, 1000),
    resetAt, detectedAt, source, code,
  });
  save(store.file, store.limits);
  appendLimitHistory({
    ts: detectedAt,
    harness,
    model: baseModel(model),
    resetAt,
    source,
    code,
  }, input.dataDir);
  // The error-text path is source (b) of the plan-limit history: a rejected
  // reading with a parseable reset window but no fabricated utilization. A
  // `rate-limit-event` lockout is the same structured signal already recorded by
  // noteHarnessPlanLimit, so it is skipped here to avoid a double write. The
  // TTL fallback stays out of this row: a message without a stated date is
  // written without `resetsAt` rather than with an invented one.
  if (source === 'error-text') {
    appendHarnessPlanLimitHistory({
      harness,
      model,
      status: 'rejected',
      ...(authenticResetAt ? { resetsAt: authenticResetAt } : {}),
      observedAt: detectedAt,
      dataDir: input.dataDir,
    });
  }
  return true;
}

/**
 * Keeps run errors that were NOT recognised as a usage limit / balance problem
 * (`data/usage/unclassified-errors.jsonl`, capped), so unknown provider
 * messages can be reviewed and added to `isInsufficientBalanceMessage` /
 * `isUsageLimitMessage`. Dedupes by harness + normalised text.
 *
 * @param {{ harness?: string, model?: string, message?: string, dataDir?: unknown }} [input]
 * @returns {boolean} true when a new row was written
 */
export function noteUnclassifiedRunError(input = {}) {
  const harness = String(input.harness || '').trim().toLowerCase();
  const message = String(input.message || '').trim();
  // A rejected model id is recorded as a lockout only when the id is known;
  // without one it must stay visible here instead of vanishing from both stores.
  const lockedAsUnavailable = isModelUnavailableMessage(message) && Boolean(String(input.model || '').trim());
  if (!harness || !message || isUsageLimitMessage(message) || lockedAsUnavailable) return false;
  try {
    const override = String(input.dataDir || '').trim();
    const file = override ? path.join(override, 'usage', 'unclassified-errors.jsonl') : resolveDataPath('usage', 'unclassified-errors.jsonl');
    // Request ids / numbers vary per call; collapse them for dedupe.
    const signature = message.toLowerCase().replace(/[0-9a-f]{8}-[0-9a-f-]{20,}|\d+/g, '#').slice(0, 200);
    let lines = [];
    try {
      lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    } catch { /* first write */ }
    if (lines.some((line) => {
      try {
        const row = JSON.parse(line);
        return row.harness === harness && row.signature === signature;
      } catch { return false; }
    })) return false;
    lines.push(JSON.stringify({
      ts: new Date().toISOString(), harness, model: String(input.model || '').trim(), signature, message: message.slice(0, 500),
    }));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${lines.slice(-200).join('\n')}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Manual unlock used by the health UI. `model` is optional: when omitted every
 * lockout for the harness is cleared. `dataDir` selects the same store the
 * lockout was recorded into.
 *
 * @param {string} harness
 * @param {string} [model]
 * @param {unknown} [dataDir]
 * @returns {number} removed rows
 */
export function clearHarnessUsageLimit(harness, model, dataDir) {
  const store = getStore(dataDir);
  const wantedHarness = String(harness || '').trim().toLowerCase();
  if (!wantedHarness) return 0;
  const wantedModel = String(model || '').trim();
  const wantedBase = wantedModel ? baseModel(wantedModel) : '';
  let removed = 0;
  for (const [id, row] of [...store.limits]) {
    if (String(row.harness || '').toLowerCase() !== wantedHarness) continue;
    if (wantedModel && String(row.model || '').toLowerCase() !== wantedModel.toLowerCase() && baseModel(row.model) !== wantedBase) {
      continue;
    }
    store.limits.delete(id);
    removed += 1;
  }
  if (removed > 0) save(store.file, store.limits);
  return removed;
}

export function getHarnessUsageLimit(input = {}) {
  const store = getStore(input.dataDir);
  const harness = String(input.harness || '').trim().toLowerCase();
  const model = String(input.model || '').trim();
  const wantedBase = baseModel(model);
  const matches = [...store.limits.values()].filter((row) => {
    if (row.harness !== harness || new Date(row.resetAt).getTime() <= Date.now()) return false;
    if (!row.model || !model) return true;
    return row.model.toLowerCase() === model.toLowerCase() || baseModel(row.model) === wantedBase;
  });
  matches.sort((a, b) => new Date(a.resetAt) - new Date(b.resetAt));
  return matches[0] || null;
}

/**
 * @param {unknown} [dataDir]
 * @returns {object[]}
 */
export function listHarnessUsageLimits(dataDir) {
  const store = getStore(dataDir);
  for (const [id, row] of store.limits) if (new Date(row.resetAt).getTime() <= Date.now()) store.limits.delete(id);
  return [...store.limits.values()];
}
