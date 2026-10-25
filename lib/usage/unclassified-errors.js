/**
 * Read/ACK/notify layer over the unclassified run-error store
 * (`usage/unclassified-errors.jsonl`, written by `noteUnclassifiedRunError`).
 *
 * The store stays the source of truth for signatures and counts. Episode state
 * (open / acked, monotonic occurrence version) lives in the shared violation-episode
 * registry, keyed `unclassified-errors|<signature id>`. This module only:
 *   - mirrors store counters into the registry (`syncUnclassifiedErrors`),
 *   - fires one notification per opened/reopened episode through the producer,
 *   - returns a redacted list for the API/UI and applies "reviewed" (ACK).
 *
 * "Tool … not found" signatures are classified as `tool_not_found`: a prompt / MCP
 * catalog / adapter compatibility problem. They are display-only and never feed any
 * model-lockout logic (nothing here writes to the usage-limit store).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveDataPath } from '../runtime-paths.js';
import { writeJsonAtomic } from '../persist/atomic-write.js';
import { redactFailureText } from '../harness-usage-limits.js';
import { createViolationEpisodeRegistry } from '../self-check/violation-episodes.js';
import { isToolNotFoundMessage } from '../notices.js';
import { sanitizeNotificationText } from '../notifications/notification-sanitize.ts';
import { publishUnclassifiedErrorNotification } from '../notifications/notification-producers.ts';

export const UNCLASSIFIED_EPISODE_TYPE = 'unclassified-errors';
export const UNCLASSIFIED_CATEGORIES = Object.freeze(['unclassified', 'tool_not_found']);

const BARE_TOKEN_RE = /\b(?:sk|pk|ghp|gho|xox[a-z]|AKIA)[-_A-Za-z0-9]{12,}/g;
const HOME_PATH_RE = /(?:~|\/(?:home|Users|root))\/[^\s"'`,)\]]*/g;
const URL_RE = /\b(?:https?|wss?):\/\/[^\s"'`,)\]]+/gi;

/** @param {unknown} dataDir */
function usageDir(dataDir) {
  const override = String(dataDir || '').trim();
  return override ? path.join(override, 'usage') : resolveDataPath('usage');
}

/**
 * Redacts secrets, home paths and URLs for API and render output. Defence in depth
 * on top of the store-time redaction, because older rows may predate it.
 *
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function redactUnclassifiedText(value, max = 300) {
  const text = redactFailureText(value)
    .replace(BARE_TOKEN_RE, '<secret>')
    .replace(URL_RE, '<url>')
    .replace(HOME_PATH_RE, '<path>');
  return sanitizeNotificationText(text, max);
}

/** @param {unknown} message */
export function classifyUnclassifiedError(message) {
  return isToolNotFoundMessage(typeof message === 'string' ? message : String(message ?? '')) ? 'tool_not_found' : 'unclassified';
}

/**
 * Stable short id for one (harness, base model, signature) triple. It is hex only,
 * so it is safe as an episode scope and as a URL/DOM attribute.
 *
 * @param {{ harness?: unknown, model?: unknown, signature?: unknown }} row
 */
export function unclassifiedSignatureId(row) {
  const key = [row.harness, row.model, row.signature].map((v) => String(v ?? '').trim().toLowerCase()).join('\u0001');
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** @param {unknown} dataDir */
function readRows(dataDir) {
  const file = path.join(usageDir(dataDir), 'unclassified-errors.jsonl');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object' && String(row.harness || '').trim()) rows.push(row);
    } catch {
      // A corrupt line is skipped here; the writer refuses to overwrite such a store.
    }
  }
  return rows;
}

const registries = new Map();

/** @param {unknown} dataDir */
function registryFor(dataDir) {
  const dir = path.join(usageDir(dataDir), 'unclassified-episodes');
  let registry = registries.get(dir);
  if (!registry) {
    // Notifications are sent by the producer below, with its own fingerprint and rate limit.
    registry = createViolationEpisodeRegistry({ dataDir: dir, publish: async () => {} });
    registries.set(dir, registry);
  }
  return registry;
}

/**
 * Per-store sync state. `baselines[id] = { firstSeenAt, base }` records which store row
 * generation the registry counter follows: registry count = base + store count. When the
 * store evicts a row and the signature recurs, the new row has a different `firstSeenAt`
 * and a restarted count; `base` absorbs the old registry count so the registry counter
 * stays monotonic and the recurrence is counted (and reopens an ACKed episode).
 */
const syncStates = new Map();

/** @param {unknown} dataDir */
function syncStateFor(dataDir) {
  const dir = path.join(usageDir(dataDir), 'unclassified-episodes');
  let state = syncStates.get(dir);
  if (!state) {
    const file = path.join(dir, 'baselines.json');
    let baselines = {};
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && typeof raw === 'object' && raw.baselines && typeof raw.baselines === 'object') baselines = raw.baselines;
    } catch {
      /* missing or corrupt: start empty (legacy behaviour, count-reset detection below) */
    }
    state = { file, dir, baselines, chain: Promise.resolve() };
    syncStates.set(dir, state);
  }
  return state;
}

/** Test hook: drop cached registries so a fresh data dir is re-read. */
export function resetUnclassifiedRegistries() {
  registries.clear();
  syncStates.clear();
}

function normalizeRow(row) {
  const harness = String(row.harness || '').trim().toLowerCase();
  const model = String(row.model || '').trim().toLowerCase();
  const rawText = String(row.message || row.signature || '');
  const signature = String(row.signature || rawText);
  const count = Number.isSafeInteger(row.count) && row.count > 0 ? row.count : 1;
  return {
    id: unclassifiedSignatureId({ harness, model, signature }),
    harness,
    model,
    message: redactUnclassifiedText(rawText),
    category: classifyUnclassifiedError(rawText),
    count,
    firstSeenAt: String(row.firstSeenAt || row.ts || ''),
    lastSeenAt: String(row.lastSeenAt || row.firstSeenAt || row.ts || ''),
    // Optional: rows written before run context was recorded have none.
    lastContext: normalizeContext(row.lastContext),
  };
}

/** @param {unknown} value */
function normalizeContext(value) {
  if (!value || typeof value !== 'object') return null;
  const chatId = String(/** @type {any} */ (value).chatId ?? '').trim();
  const workspaceFolder = String(/** @type {any} */ (value).workspaceFolder ?? '').trim();
  return chatId || workspaceFolder ? { chatId, workspaceFolder } : null;
}

/**
 * Mirrors the store counters into the episode registry and notifies once per new
 * episode (new signature, or first occurrence after an ACK).
 *
 * @param {{ dataDir?: unknown, now?: () => number, publish?: (item: Record<string, unknown>) => Promise<unknown> }} [options]
 * @returns {Promise<{ notified: number, throttled: number }>}
 */
export function syncUnclassifiedErrors(options = {}) {
  // Syncs run one at a time per store: a parallel sync would otherwise read the same
  // `seen` counter and report the same occurrences twice, pushing the registry version
  // past the store counter (an ACK would then swallow the next real occurrence).
  const state = syncStateFor(options.dataDir);
  const run = state.chain.then(() => syncLocked(options, state));
  state.chain = run.catch(() => {});
  return run;
}

async function syncLocked(options, state) {
  const registry = registryFor(options.dataDir);
  const result = { notified: 0, throttled: 0 };
  for (const raw of readRows(options.dataDir)) {
    const row = normalizeRow(raw);
    const existing = registry.get(UNCLASSIFIED_EPISODE_TYPE, row.id);
    const registryCount = existing ? existing.count : 0;
    let baseline = state.baselines[row.id];
    // `firstSeenAt` has millisecond precision, so a recreated row can share it with the
    // evicted one. A store count below what is already mirrored (registry - base) can
    // never happen within one generation, so it also marks a recreated row.
    const mirrored = baseline ? registryCount - baseline.base : 0;
    if (!baseline || baseline.firstSeenAt !== row.firstSeenAt || row.count < mirrored) {
      // First sight of this row generation, or the store evicted and recreated the row
      // (new firstSeenAt or a lower count): everything it holds is new relative to the registry. Without a
      // recorded baseline (older registry) the registry is assumed to follow the store
      // unless the store count is already below it.
      const legacyFollows = !baseline && row.count >= registryCount;
      baseline = { firstSeenAt: row.firstSeenAt, base: legacyFollows ? 0 : registryCount };
      state.baselines[row.id] = baseline;
      try {
        fs.mkdirSync(state.dir, { recursive: true });
        writeJsonAtomic(state.file, { baselines: state.baselines });
      } catch {
        /* best effort: a lost baseline only affects the next eviction edge case */
      }
    }
    const missing = baseline.base + row.count - registryCount;
    if (missing <= 0) continue;
    // One report per new occurrence keeps the registry version equal to the store counter,
    // which is what settles an ACK against an occurrence that arrives right after it.
    const observation = { type: UNCLASSIFIED_EPISODE_TYPE, scope: row.id, status: 'violated', message: row.message };
    const events = [];
    for (let i = 0; i < missing; i += 1) events.push(...await registry.report([observation]));
    const fresh = events.find((e) => e.event === 'opened' || e.event === 'reopened');
    if (!fresh) continue;
    const ep = registry.get(UNCLASSIFIED_EPISODE_TYPE, row.id);
    const outcome = await publishUnclassifiedErrorNotification({
      harness: row.harness,
      model: row.model,
      signatureId: row.id,
      category: /** @type {'tool_not_found' | 'unclassified'} */ (row.category),
      message: row.message,
      episode: ep.episode,
      reopens: ep.reopens,
      reopened: fresh.event === 'reopened',
    }, { now: options.now, publish: options.publish });
    if (outcome === 'published') result.notified += 1;
    else if (outcome === 'rate_limited') result.throttled += 1;
  }
  return result;
}

/**
 * Redacted signature list for the API and health card. Acknowledged signatures are
 * hidden unless `includeAcked` is set; a signature seen again after its ACK is open.
 *
 * @param {{ dataDir?: unknown, harness?: string, includeAcked?: boolean, sync?: boolean, includeContext?: boolean }} [options]
 * `includeContext` adds the raw `lastContext` (operator tool only; never the HTTP API).
 */
export async function listUnclassifiedSignatures(options = {}) {
  if (options.sync !== false) await syncUnclassifiedErrors({ dataDir: options.dataDir });
  const registry = registryFor(options.dataDir);
  const harness = String(options.harness || '').trim().toLowerCase();
  const items = [];
  for (const raw of readRows(options.dataDir)) {
    const row = normalizeRow(raw);
    if (harness && row.harness !== harness) continue;
    const ep = registry.get(UNCLASSIFIED_EPISODE_TYPE, row.id);
    const acked = ep?.state === 'acked';
    if (acked && !options.includeAcked) continue;
    items.push({
      id: row.id,
      harness: row.harness,
      model: row.model,
      message: row.message,
      category: row.category,
      count: row.count,
      version: ep ? ep.count : row.count,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
      ack: { state: acked ? 'acked' : 'open', ackedAt: acked && ep.ackedAt ? new Date(ep.ackedAt).toISOString() : null },
      // Display-only: no category here ever feeds a model block / lockout decision.
      blocksModel: false,
      ...(options.includeContext ? { lastContext: row.lastContext } : {}),
    });
  }
  items.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  return items;
}

/**
 * "Reviewed": hides the signature and mutes notifications until it occurs again.
 *
 * @param {{ dataDir?: unknown, id?: unknown, version?: unknown }} input
 * @returns {{ ok: boolean, reason?: string, version?: number }}
 */
export function acknowledgeUnclassifiedSignature(input = {}) {
  const id = String(input.id || '').trim();
  if (!/^[0-9a-f]{16}$/.test(id)) return { ok: false, reason: 'invalid_id' };
  const registry = registryFor(input.dataDir);
  const version = input.version == null || input.version === '' ? undefined : Number(input.version);
  const res = registry.ack(UNCLASSIFIED_EPISODE_TYPE, id, version);
  return res.acked ? { ok: true, version: res.version } : { ok: false, reason: res.reason };
}

/**
 * Per-harness slice for the health card (sync is the caller's job).
 *
 * @param {string} harness
 * @param {unknown} [dataDir]
 */
export function summarizeUnclassifiedForHealth(harness, dataDir) {
  const registry = registryFor(dataDir);
  const wanted = String(harness || '').trim().toLowerCase();
  const out = { items: [], compat: [] };
  for (const raw of readRows(dataDir)) {
    const row = normalizeRow(raw);
    if (row.harness !== wanted) continue;
    const ep = registry.get(UNCLASSIFIED_EPISODE_TYPE, row.id);
    if (ep?.state === 'acked') continue;
    const item = {
      id: row.id, model: row.model, message: row.message, category: row.category, count: row.count,
      version: ep ? ep.count : row.count, firstSeenAt: row.firstSeenAt, lastSeenAt: row.lastSeenAt,
    };
    (row.category === 'tool_not_found' ? out.compat : out.items).push(item);
  }
  const byRecent = (a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt);
  out.items.sort(byRecent);
  out.compat.sort(byRecent);
  return out;
}

/**
 * Share of run completions with unknown timing / unknown token measurement, per
 * completion category (outcome). A missing measurement after a confirmed early
 * rejection or a cancellation can be legitimate, so the alarm is on GROWTH between
 * the earlier and later half of comparable runs (same category), not on a high share.
 *
 * @param {Array<Record<string, any>>} runEvents run-type usage events
 * @param {{ minSample?: number, growthPoints?: number }} [options]
 */
export function buildTelemetryCoverage(runEvents, options = {}) {
  const minSample = options.minSample ?? 4;
  const growth = options.growthPoints ?? 25;
  const byCategory = new Map();
  const events = (Array.isArray(runEvents) ? runEvents : [])
    .filter((e) => e && e.eventType === 'run')
    .sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  for (const e of events) {
    const cat = String(e.outcome || 'unknown').trim().toLowerCase() || 'unknown';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push({
      timingUnknown: !Number.isFinite(Number(e.latencyMs)) || e.latencyMs == null,
      measurementUnknown: e.measurementPresent !== true,
    });
  }
  const share = (rows, key) => (rows.length ? rows.filter((r) => r[key]).length / rows.length : null);
  const categories = [];
  for (const [category, rows] of byCategory) {
    const mid = Math.floor(rows.length / 2);
    const earlier = rows.slice(0, mid);
    const later = rows.slice(mid);
    const comparable = earlier.length >= minSample && later.length >= minSample;
    const delta = (key) => {
      const a = share(earlier, key);
      const b = share(later, key);
      return comparable && a != null && b != null ? Math.round((b - a) * 100) : null;
    };
    const timingGrowth = delta('timingUnknown');
    const measurementGrowth = delta('measurementUnknown');
    const alarm = (timingGrowth != null && timingGrowth >= growth)
      || (measurementGrowth != null && measurementGrowth >= growth);
    categories.push({
      category,
      total: rows.length,
      timingUnknownShare: share(rows, 'timingUnknown'),
      measurementUnknownShare: share(rows, 'measurementUnknown'),
      timingGrowthPoints: timingGrowth,
      measurementGrowthPoints: measurementGrowth,
      comparable,
      alarm,
      // A growing gap in successful runs is never a legitimate "rejected before generation".
      severity: alarm ? (category === 'ok' ? 'high' : 'low') : 'none',
    });
  }
  categories.sort((a, b) => a.category.localeCompare(b.category));
  return { categories, alarm: categories.some((c) => c.alarm) };
}
