/**
 * Durable per-workspace watcher state for the Workspace Watcher (stage A).
 *
 * `data/workspace-watchers.json` shape (v2):
 *   { v: 2, updatedAt, revision, items: { "<normalizedWorkspaceFolder>": row } }
 *
 * The map is keyed by the normalized workspace folder so a lookup never scans
 * rows. Stage A ticks only in `observe`. `off` and stored `autopilot` are inert
 * until a later stage enables autonomous cycles.
 *
 * Each row carries the singleton lease, policy, bounded decision log, the
 * versioned `scoutProfiles` collection and the Scout scan state. Cycles live in
 * `activeCycles` (up to `policy.maxParallel`, hard-capped by
 * `WORKSPACE_WATCHER_MAX_ACTIVE_CYCLES`); `activeCycle` is kept as a mirror of
 * slot 0 so an older server reading the file never mistakes a busy workspace for
 * an idle one. Scout scans live in `activeScoutScans`, one record per `scanId`
 * (they never consume a cycle slot); the legacy v1 singleton `activeScoutScan`
 * is migrated lazily into that collection and then kept only as a derived mirror
 * of its first entry for older clients. Bounded `scoutScanHistory` records the
 * outcome of past scans for the future per-profile history view.
 *
 * Writers serialize on `workspace-watchers.lock.sqlite` next to the document:
 * an intentionally empty database whose only job is to hold SQLite's write
 * lock across the revision check and the rename, so a crashed writer cannot
 * keep the store locked and a live writer cannot be robbed of the lock.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { writeJsonAtomic } from './atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';
import { normalizeDelegationWorkspaceKey } from '../delegation-workspace-guard.js';

/**
 * Store schema version.
 *
 * v1: single implicit Scout configuration carried by `policy.scout*` and the
 *     singleton `activeScoutScan` row state.
 * v2: adds the versioned `scoutProfiles` collection, the `activeScoutScans`
 *     collection (one record per live/reconciled scan) and the bounded
 *     `scoutScanHistory` log on every row. Loading v1 lazily normalizes it into
 *     a v2 document (the singleton becomes a collection record and keeps its
 *     `activeScoutScan` mirror); writes always emit v2.
 */
export const WORKSPACE_WATCHERS_SCHEMA_VERSION = 2;
export const WORKSPACE_WATCHER_MODES = Object.freeze(['off', 'observe', 'autopilot']);
export const WORKSPACE_WATCHER_TICK_MODES = Object.freeze(['observe', 'autopilot']);
export const WORKSPACE_WATCHER_MAX_DECISIONS = 50;
/** Max blocking chats stored on a decision log entry (matches tick summary). */
export const WORKSPACE_WATCHER_MAX_UNKNOWN_CHATS_IN_DECISION = 3;
/** Max chat ids / `delegation:<id>` tokens stored on a `max_parallel` decision. */
export const WORKSPACE_WATCHER_MAX_SLOT_HOLDERS_IN_DECISION = 8;
export const WORKSPACE_WATCHER_MAX_REPORTS = 20;
export const WORKSPACE_WATCHER_MAX_CYCLE_CHATS = 20;
export const WORKSPACE_WATCHER_CYCLE_OUTCOMES = Object.freeze(['success', 'blocked', 'failure']);
export const WORKSPACE_WATCHER_DEFAULT_LEASE_TTL_MS = 30_000;
/** Max time one cycle may stay in `starting` before reconcile may roll back. */
export const WORKSPACE_WATCHER_CYCLE_START_DEADLINE_MS = 120_000;
/**
 * Hard ceiling on concurrently live cycles, and the upper bound accepted for
 * `policy.maxParallel`. The store needs a ceiling of its own: a mixed-version
 * write (or a hand-edited file) must never grow `activeCycles` without limit,
 * because every slot holds a todo claim and a lease.
 */
export const WORKSPACE_WATCHER_MAX_ACTIVE_CYCLES = 10;
export const WORKSPACE_WATCHER_MAX_PARALLEL = 10;
export const WORKSPACE_WATCHER_PICK_ROLES = Object.freeze(['plan', 'implement', 'review']);
/**
 * Scout discovery categories. The set is closed so the prompt, the parser, the
 * policy allow-list and the UI never drift into different literals.
 */
export const WORKSPACE_SCOUT_CATEGORIES = Object.freeze([
  'bug',
  'improvement',
  'refactor',
  'security',
  'opportunity',
  'documentation',
]);
/** Lifecycle of a Scout proposal: the user resolves pending → accepted/rejected. */
export const WORKSPACE_SCOUT_FINDING_STATUSES = Object.freeze(['pending', 'accepted', 'rejected']);
/**
 * Lifecycle of one Scout scan attempt. `reserved`/`running`/`uncertain` are
 * non-terminal and keep a parallel slot; the rest are settled. Shared by the
 * active-scan collection and the scan history so the two never drift.
 */
export const WORKSPACE_SCOUT_SCAN_STATUSES = Object.freeze([
  'reserved',
  'running',
  'completed',
  'failed',
  'skipped',
  'interrupted',
  'uncertain',
]);
/**
 * Lifecycle statuses that still occupy a Scout slot and must never be dropped by
 * retention or treated as settled. Exported so the scheduler, drain and runtime
 * status share one definition instead of re-deriving it.
 */
export const WORKSPACE_SCOUT_SCAN_NON_TERMINAL_STATUSES = Object.freeze(['reserved', 'running', 'uncertain']);
/** Bounded so a misbehaving scan can never grow the watcher row without limit. */
export const WORKSPACE_WATCHER_MAX_PENDING_SCOUT_FINDINGS = 200;
/**
 * Bound on the durable resolved-finding decision history. Kept separate from the
 * pending cap: resolving a proposal frees a pending slot, but the decision must
 * outlive pending retention and scan-history cleanup so a rejected idea is never
 * silently re-proposed by a later scan.
 */
export const WORKSPACE_WATCHER_MAX_SCOUT_FINDING_DECISIONS = 500;
/** Hard ceiling on concurrent Scout scan records stored on one row. */
export const WORKSPACE_WATCHER_MAX_ACTIVE_SCOUT_SCANS = 50;
/** Start deadline of one reservation, separate from the submit TTL. */
export const WORKSPACE_SCOUT_SCAN_START_DEADLINE_MS = 120_000;
/** Completed-scan history retention: newest N per Scout and overall. */
export const WORKSPACE_SCOUT_SCAN_HISTORY_MAX_PER_PROFILE = 100;
export const WORKSPACE_SCOUT_SCAN_HISTORY_MAX_PER_WORKSPACE = 1000;
/**
 * Hard cap on the server-owned attribution entries kept on one Scout finding.
 * Older entries fall off first; the newest scan attribution always survives.
 */
export const WORKSPACE_WATCHER_MAX_SCOUT_FINDING_SOURCES = 20;
/**
 * Signal sources a Scout profile may read. Closed set so the prompt, the
 * scope resolver, the API and the UI never drift into different literals.
 */
export const WORKSPACE_SCOUT_PROFILE_SOURCES = Object.freeze([
  'diff',
  'gitHistory',
  'todoMarkers',
  'testResults',
  'logs',
]);
/** How a profile decides when it may run automatically. */
export const WORKSPACE_SCOUT_PROFILE_SCHEDULE_MODES = Object.freeze(['manual', 'interval']);
/** How a profile bounds the files it inspects. */
export const WORKSPACE_SCOUT_PROFILE_SCOPE_MODES = Object.freeze(['changes', 'area']);
/**
 * Deterministic identity of the virtual general Scout. A workspace with no
 * stored profile reads this profile without ever writing it to the store; the
 * legacy migration also materializes exactly this id.
 */
export const SCOUT_GENERAL_PROFILE_ID = 'scout-general';
/** Upper bound on stored Scout profiles per workspace. */
const WORKSPACE_SCOUT_PROFILE_MAX_PER_WORKSPACE = 50;
/** Exported so the control layer can keep derived names (e.g. a copy) valid. */
export const WORKSPACE_SCOUT_PROFILE_MAX_NAME_LENGTH = 120;
const WORKSPACE_SCOUT_PROFILE_MAX_TEXT_LENGTH = 8000;
const WORKSPACE_SCOUT_PROFILE_MAX_GLOB_LENGTH = 500;
const WORKSPACE_SCOUT_PROFILE_MAX_GLOBS = 200;
const WORKSPACE_SCOUT_PROFILE_MAX_PER_DAY = 100;
const WORKSPACE_SCOUT_PROFILE_MAX_FINDINGS_PER_SCAN = WORKSPACE_WATCHER_MAX_PENDING_SCOUT_FINDINGS;
const WORKSPACE_SCOUT_PROFILE_MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const WORKSPACE_SCOUT_PROFILE_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
/** Fixed timestamp so the virtual default profile is byte-for-byte stable. */
const WORKSPACE_SCOUT_PROFILE_DEFAULT_TIMESTAMP = '1970-01-01T00:00:00.000Z';
/**
 * Legacy `policy` keys that mark a v1 row as carrying an implicit Scout
 * configuration. Only their presence — not their value — triggers migration,
 * because an explicit `scoutEnabled: false` is still a configured Scout.
 */
const LEGACY_SCOUT_POLICY_KEYS = Object.freeze([
  'scoutEnabled',
  'scoutIntervalHours',
  'scoutCategories',
  'scoutAllowedHarnesses',
  'scoutMaxPerDay',
  'scoutMaxPerScan',
  'orchestrator',
]);
/** How long a writer waits for the cross-process document lock. */
export const WORKSPACE_WATCHERS_LOCK_TIMEOUT_MS = 5_000;
/** Lock database: a namespace for SQLite write locks, never for watcher data. */
const WORKSPACE_WATCHERS_LOCK_DB_NAME = 'workspace-watchers.lock.sqlite';
const WORKSPACE_WATCHERS_LOCK_BUSY_ERRCODE = 5;
const WORKSPACE_WATCHERS_LOCK_BACKOFF_MIN_MS = 2;
const WORKSPACE_WATCHERS_LOCK_BACKOFF_MAX_MS = 50;
const WATCHER_DOCUMENT_CAS_MAX_ATTEMPTS = 8;
/**
 * A COMMIT on the empty lock database can still answer SQLITE_BUSY when another
 * connection holds a read lock at the instant the RESERVED lock is handed back.
 * Nothing is stored in this database, so the retry/rollback below is about the
 * lock lifecycle only, never about losing data.
 */
const WORKSPACE_WATCHERS_LOCK_COMMIT_RETRIES = 4;

export class WorkspaceWatchersCorruptError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'WorkspaceWatchersCorruptError';
    this.code = 'WORKSPACE_WATCHERS_CORRUPT';
  }
}

export class WorkspaceWatchersLockError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'WorkspaceWatchersLockError';
    this.code = 'WORKSPACE_WATCHERS_LOCKED';
  }
}

/**
 * @param {string} raw
 * @returns {boolean}
 */
function isDriveLetterPath(raw) {
  return /^[a-zA-Z]:[/\\]/.test(String(raw || '').trim());
}

/**
 * Canonical workspace folder key (resolve + realpath when possible), with slash
 * normalization so watcher rows and delegation snapshots stay aligned.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeWorkspaceFolder(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (isDriveLetterPath(raw) && process.platform !== 'win32') {
    const collapsed = raw.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    const trimmed = collapsed.replace(/\/+$/, '');
    return trimmed || '/';
  }
  const canonical = normalizeDelegationWorkspaceKey(raw);
  if (!canonical) {
    const collapsed = raw.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    const trimmed = collapsed.replace(/\/+$/, '');
    return trimmed || '/';
  }
  const normalized = canonical.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return normalized || '/';
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function normalizeCount(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeStringList(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {string[]} */
  const out = [];
  for (const item of raw) {
    const value = String(item ?? '').trim();
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

/**
 * A finite, non-negative number, or the fallback. Used for Scout schedules
 * because an interval in hours is legitimately fractional (for example 0.5).
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function normalizeNonNegativeNumber(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

/**
 * Stable dedupe identity for a Scout finding: the normalized title with
 * punctuation collapsed. Two proposals with the same title in a different case
 * or with different spacing are the same work item.
 *
 * @param {{ title?: unknown } | null | undefined} finding
 * @returns {string}
 */
export function workspaceScoutFindingDedupeKey(finding) {
  const titleKey = String(finding?.title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!titleKey) return '';
  const category = normalizeWorkspaceScoutCategory(finding?.category);
  return category ? `${category}:${titleKey}` : titleKey;
}

/**
 * Resolve a Scout finding file path to a workspace-relative POSIX path, or null
 * when the path escapes the workspace root.
 *
 * @param {string} workspaceFolder
 * @param {unknown} filePath
 * @returns {string | null}
 */
export function resolveWorkspaceScoutFilePath(workspaceFolder, filePath) {
  const root = normalizeWorkspaceFolder(workspaceFolder);
  const raw = String(filePath ?? '').trim();
  if (!root || !raw) return null;
  const posix = raw.replace(/\\/g, '/');
  if (posix.includes('..')) return null;
  if (path.isAbsolute(raw) || /^[a-zA-Z]:[/\\]/.test(raw)) {
    const resolved = path.resolve(raw);
    const rel = path.relative(root, resolved);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join('/');
  }
  const joined = path.resolve(root, raw);
  const rel = path.relative(root, joined);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeWorkspaceScoutCategory(value) {
  const category = String(value ?? '').trim().toLowerCase();
  return WORKSPACE_SCOUT_CATEGORIES.includes(category) ? category : '';
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeWorkspaceScoutFindingStatus(value) {
  const status = String(value ?? '').trim().toLowerCase();
  return WORKSPACE_SCOUT_FINDING_STATUSES.includes(status) ? status : '';
}

/**
 * Fields of one `sources[]` attribution entry. Stable order so a normalized
 * entry always serializes the same way and a merge never drops a field.
 */
const WORKSPACE_SCOUT_FINDING_SOURCE_FIELDS = Object.freeze([
  'scoutId',
  'scoutRevision',
  'scanId',
  'chatId',
  'runId',
  'scanner',
  'harness',
  'model',
  'at',
]);

/**
 * Normalize one `sources[]` entry. Text fields default to `''` and are never
 * invented; `scoutRevision` is a number that stays `0` when absent so a migrated
 * legacy `source` cannot masquerade as revision 1. A completely empty entry is
 * dropped.
 *
 * @param {unknown} raw
 * @returns {object | null}
 */
function normalizeWorkspaceScoutSourceEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = /** @type {Record<string, unknown>} */ (raw);
  const revisionValue = Number(source.scoutRevision);
  const scoutRevision = Number.isFinite(revisionValue) && revisionValue >= 1
    ? Math.floor(revisionValue)
    : 0;
  const entry = {
    scoutId: String(source.scoutId ?? '').trim(),
    scoutRevision,
    scanId: String(source.scanId ?? '').trim(),
    chatId: String(source.chatId ?? '').trim(),
    runId: String(source.runId ?? '').trim(),
    scanner: String(source.scanner ?? '').trim(),
    harness: String(source.harness ?? '').trim(),
    model: String(source.model ?? '').trim(),
    at: String(source.at ?? '').trim(),
  };
  return WORKSPACE_SCOUT_FINDING_SOURCE_FIELDS.some((field) => entry[field]) ? entry : null;
}

/**
 * Stable identity of one attribution entry. A scan id is globally unique and a
 * scan submits at most once, so two entries with the same non-empty `scanId` are
 * the same source even when a replay re-stamps the time or a later write fills
 * in a field the earlier one lacked. Legacy entries without a `scanId` fall back
 * to `chatId|at|scanner`.
 *
 * @param {object} entry
 * @returns {string}
 */
function workspaceScoutSourceKey(entry) {
  const scanId = String(entry.scanId ?? '');
  if (scanId) return `scan:${scanId}`;
  return ['legacy', entry.chatId, entry.at, entry.scanner]
    .map((value) => String(value ?? ''))
    .join('|');
}

/**
 * Fold a colliding attribution entry into the existing one without losing data:
 * an existing non-empty field always wins, an empty one is filled in.
 *
 * @param {object} existing
 * @param {object} incoming
 * @returns {object}
 */
function mergeWorkspaceScoutSourceEntry(existing, incoming) {
  const merged = { ...existing };
  for (const field of WORKSPACE_SCOUT_FINDING_SOURCE_FIELDS) {
    if (!merged[field] && incoming[field]) merged[field] = incoming[field];
  }
  return merged;
}

/**
 * Normalize a stored `sources[]` list: only the documented fields (text, with
 * `scoutRevision` numeric), dedupe by `scanId` (or the legacy
 * `chatId|at|scanner` key) and a hard cap. Never throws; a malformed list
 * normalizes to `[]`.
 *
 * @param {unknown} raw
 * @returns {object[]}
 */
export function normalizeWorkspaceScoutFindingSources(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {Map<string, object>} */
  const byKey = new Map();
  for (const item of raw) {
    const entry = normalizeWorkspaceScoutSourceEntry(item);
    if (!entry) continue;
    const key = workspaceScoutSourceKey(entry);
    if (byKey.has(key)) byKey.set(key, mergeWorkspaceScoutSourceEntry(byKey.get(key), entry));
    else byKey.set(key, entry);
  }
  return [...byKey.values()].slice(-WORKSPACE_WATCHER_MAX_SCOUT_FINDING_SOURCES);
}

/**
 * Add/merge one attribution entry onto a finding's `sources[]`. Pure: returns
 * the next bounded list. An entry that collides with an existing one is merged
 * instead of duplicated; the server re-stamping the same scan stays idempotent.
 *
 * @param {unknown} current
 * @param {object} entry
 * @returns {object[]}
 */
export function appendWorkspaceScoutFindingSource(current, entry) {
  return normalizeWorkspaceScoutFindingSources([
    ...(Array.isArray(current) ? current : []),
    entry,
  ]);
}

/**
 * One Scout proposal, normalized. A record without a usable title is dropped by
 * the caller so a malformed scan cannot poison the list.
 *
 * @param {unknown} raw
 * @param {{
 *   now?: number,
 *   createdAt?: string,
 *   workspaceFolder?: string,
 *   defaultCategory?: string,
 *   forcePending?: boolean,
 * }} [options]
 * @returns {object | null}
 */
export function normalizeWorkspaceScoutFinding(raw, options = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = /** @type {Record<string, unknown>} */ (raw);
  const title = String(source.title ?? '').trim();
  if (!title) return null;
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const fallbackAt = new Date(now).toISOString();
  const createdAt = String(options.createdAt ?? source.createdAt ?? '').trim() || fallbackAt;
  const updatedAt = String(source.updatedAt ?? '').trim() || createdAt;
  const categoryProvided = source.category != null && String(source.category).trim() !== '';
  let category = '';
  if (categoryProvided) {
    category = normalizeWorkspaceScoutCategory(source.category);
    if (!category) return null;
  } else {
    category = normalizeWorkspaceScoutCategory(options.defaultCategory) || 'improvement';
  }
  if (options.forcePending === true) {
    const smuggled = normalizeWorkspaceScoutFindingStatus(source.status);
    if (smuggled && smuggled !== 'pending') return null;
  }
  const serverOwned = options.forcePending === true;
  const status = serverOwned
    ? 'pending'
    : (normalizeWorkspaceScoutFindingStatus(source.status) || 'pending');
  const workspaceFolder = normalizeWorkspaceFolder(options.workspaceFolder);
  /** @type {string[]} */
  const files = [];
  for (const file of normalizeStringList(source.files).slice(0, 50)) {
    const resolved = workspaceFolder
      ? resolveWorkspaceScoutFilePath(workspaceFolder, file)
      : String(file).trim();
    if (resolved) files.push(resolved);
  }
  const at = serverOwned ? fallbackAt : createdAt;
  const finding = {
    id: serverOwned ? randomUUID() : (String(source.id ?? '').trim() || randomUUID()),
    title: title.slice(0, 300),
    category,
    rationale: String(source.rationale ?? '').trim().slice(0, 8000),
    planMarkdown: String(source.plan_markdown ?? source.planMarkdown ?? '').trim().slice(0, 16000),
    files,
    status,
    createdAt: at,
    updatedAt: serverOwned ? at : updatedAt,
    dedupeKey: workspaceScoutFindingDedupeKey({ title, category }),
    // Server-owned attribution. An untrusted submit cannot set it: the server
    // appends its own entry from the active scan after this normalization, so
    // the list starts empty here.
    sources: [],
  };
  if (!serverOwned) {
    const scanId = String(source.scanId ?? '').trim();
    const sourceChatId = String(source.sourceChatId ?? '').trim();
    if (scanId) finding.scanId = scanId;
    if (sourceChatId) finding.sourceChatId = sourceChatId;
    // The v1 singleton `source` is kept for compatibility and, only when the
    // `sources` collection is absent, migrated from the fields it actually
    // carries. Nothing is invented: a missing id stays empty.
    let legacySource = null;
    const sourceRef = source.source;
    if (sourceRef && typeof sourceRef === 'object' && !Array.isArray(sourceRef)) {
      const ref = /** @type {Record<string, unknown>} */ (sourceRef);
      const scanner = String(ref.scanner ?? '').trim();
      const chatId = String(ref.chatId ?? '').trim();
      const runId = String(ref.runId ?? '').trim();
      if (scanner || chatId || runId) legacySource = { scanner, chatId, runId };
    }
    if (legacySource) finding.source = legacySource;
    finding.sources = Array.isArray(source.sources)
      ? normalizeWorkspaceScoutFindingSources(source.sources)
      : normalizeWorkspaceScoutFindingSources(legacySource ? [legacySource] : []);
    const todoId = String(source.todoId ?? '').trim();
    if (todoId) finding.todoId = todoId;
  }
  return finding;
}

/**
 * Normalize a stored `pendingScoutFindings` list. Deliberately unbounded: the
 * 200-proposal limit is a write-time capacity gate (new unique findings are
 * rejected with `capacity_exceeded`), never a silent truncation that would drop
 * the oldest pending proposal during normalization or migration.
 *
 * @param {unknown} raw
 * @param {{ now?: number }} [options]
 * @returns {object[]}
 */
export function normalizeWorkspaceScoutFindings(raw, options = {}) {
  if (!Array.isArray(raw)) return [];
  /** @type {object[]} */
  const out = [];
  for (const item of raw) {
    const finding = normalizeWorkspaceScoutFinding(item, options);
    if (finding) out.push(finding);
  }
  return out;
}

/**
 * Normalize one durable resolved-finding decision. Only terminal states
 * (`accepted`/`rejected`) belong to the decision history; a `pending` record is
 * skipped because it still lives in the pending list. Never throws.
 *
 * @param {unknown} raw
 * @returns {object | null}
 */
export function normalizeWorkspaceScoutFindingDecision(raw) {
  const finding = normalizeWorkspaceScoutFinding(raw);
  if (!finding || finding.status === 'pending') return null;
  const source = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? /** @type {Record<string, unknown>} */ (raw)
    : {};
  const decidedAt = String(source.decidedAt ?? '').trim() || finding.updatedAt;
  return { ...finding, decidedAt };
}

/**
 * Normalize the stored decision history. Dedupes by dedupe key (last wins, so a
 * re-resolved proposal replaces its earlier decision) and applies the bounded
 * retention cap. The minimum attribution (`scoutId`/`scanId`/revision) travels
 * with the decision so it survives scan-history cleanup.
 *
 * @param {unknown} raw
 * @returns {object[]}
 */
export function normalizeWorkspaceScoutFindingDecisions(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {Map<string, object>} */
  const byKey = new Map();
  for (const item of raw) {
    const decision = normalizeWorkspaceScoutFindingDecision(item);
    if (!decision) continue;
    const key = decision.dedupeKey || decision.id;
    if (!key) continue;
    // Re-insert so a later duplicate both replaces and moves to the end.
    if (byKey.has(key)) byKey.delete(key);
    byKey.set(key, decision);
  }
  return [...byKey.values()].slice(-WORKSPACE_WATCHER_MAX_SCOUT_FINDING_DECISIONS);
}

/**
 * Minimal durable tombstone for one resolved proposal. The detailed decision
 * history is bounded to 500 entries, so once a key rolls off, dedupe would no
 * longer see it and a later scan could silently re-propose a rejected idea.
 * This index keeps only `dedupeKey`/`status`/`decidedAt`, which is all dedupe
 * needs, and is deliberately NOT subject to the detail cap. It accepts both the
 * compact tombstone shape and a full finding-shaped decision (migration), and
 * never throws.
 *
 * @param {unknown} raw
 * @returns {Array<{ dedupeKey: string, status: string, decidedAt: string }>}
 */
export function normalizeWorkspaceScoutDecisionIndex(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {Map<string, { dedupeKey: string, status: string, decidedAt: string }>} */
  const byKey = new Map();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const source = /** @type {Record<string, unknown>} */ (item);
    const status = normalizeWorkspaceScoutFindingStatus(source.status);
    if (status !== 'accepted' && status !== 'rejected') continue;
    const dedupeKey = String(source.dedupeKey ?? '').trim()
      || workspaceScoutFindingDedupeKey(source)
      || String(source.id ?? '').trim();
    if (!dedupeKey) continue;
    const decidedAt = String(source.decidedAt ?? source.updatedAt ?? '').trim();
    // Re-insert so a later decision replaces the earlier tombstone.
    if (byKey.has(dedupeKey)) byKey.delete(dedupeKey);
    byKey.set(dedupeKey, { dedupeKey, status, decidedAt });
  }
  return [...byKey.values()];
}

/**
 * @param {unknown} raw
 * @returns {{ day: string, count: number }}
 */
export function normalizeWorkspaceScoutScans(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? /** @type {Record<string, unknown>} */ (raw)
    : {};
  return {
    day: String(source.day ?? '').trim(),
    count: normalizeCount(source.count, 0),
  };
}

/**
 * Normalize the optional profile snapshot carried by a scan record. Returns
 * `null` when there is no snapshot (legacy records) instead of inventing one,
 * and never throws. A snapshot without an `id` is dropped because normalizing
 * it would mint a fresh random id on every read and break idempotency.
 *
 * @param {unknown} raw
 * @returns {object | null}
 */
function normalizeActiveScoutScanSnapshot(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = /** @type {Record<string, unknown>} */ (raw);
  if (!String(source.id ?? '').trim()) return null;
  return normalizeWorkspaceScoutProfile(source, { now: 0 });
}

/**
 * One record of the `activeScoutScans` collection. Never throws and keeps
 * backwards compatibility: a bare v1 singleton
 * `{ scanId, chatId, startedAt, expiresAt, submitToken }` still normalizes.
 *
 * @param {unknown} raw
 * @returns {{
 *   scanId: string,
 *   scoutId: string,
 *   scoutRevision: number,
 *   chatId: string,
 *   startedAt: string,
 *   expiresAt: string,
 *   submitToken: string,
 *   status: string,
 *   snapshot: object | null,
 *   attemptId: string,
 *   ownerInstance: string,
 *   requestId: string,
 *   reservedAt: string,
 *   startDeadlineAt: string,
 *   launchIssued: boolean,
 *   acceptedAt: string,
 * }}
 */
export function normalizeActiveScoutScan(raw) {
  const source = asPlainRecord(raw);
  const scanId = String(source.scanId ?? '').trim();
  const chatId = String(source.chatId ?? '').trim();
  const startedAt = String(source.startedAt ?? '').trim();
  const statusRaw = String(source.status ?? '').trim().toLowerCase();
  const status = WORKSPACE_SCOUT_SCAN_STATUSES.includes(statusRaw)
    ? statusRaw
    : (chatId ? 'running' : 'reserved');
  const reservedAt = String(source.reservedAt ?? '').trim() || startedAt;
  const reservedAtMs = Date.parse(reservedAt);
  const startDeadlineAt = String(source.startDeadlineAt ?? '').trim()
    || (Number.isFinite(reservedAtMs)
      ? new Date(reservedAtMs + WORKSPACE_SCOUT_SCAN_START_DEADLINE_MS).toISOString()
      : '');
  const revisionValue = Number(source.scoutRevision);
  const scoutRevision = Number.isFinite(revisionValue) && revisionValue >= 1
    ? Math.floor(revisionValue)
    : 1;
  return {
    scanId,
    scoutId: String(source.scoutId ?? '').trim(),
    scoutRevision,
    chatId,
    startedAt,
    expiresAt: String(source.expiresAt ?? '').trim(),
    submitToken: String(source.submitToken ?? '').trim(),
    status,
    snapshot: normalizeActiveScoutScanSnapshot(source.snapshot),
    attemptId: String(source.attemptId ?? '').trim(),
    ownerInstance: String(source.ownerInstance ?? '').trim(),
    requestId: String(source.requestId ?? '').trim(),
    reservedAt,
    startDeadlineAt,
    launchIssued: source.launchIssued === true,
    acceptedAt: String(source.acceptedAt ?? '').trim(),
    // Stored at reservation time so `refundOrphanedScoutReservation` can
    // restore the workspace/profile stamps exactly like `rollbackScoutScan`.
    previousLastScoutAt: String(source.previousLastScoutAt ?? '').trim(),
    previousScheduleLastRunAt: String(source.previousScheduleLastRunAt ?? '').trim(),
    previousScheduleNextRunAt: String(source.previousScheduleNextRunAt ?? '').trim(),
  };
}

/**
 * Normalize the stored `activeScoutScans` collection. Drops records without a
 * `scanId`, dedupes by `scanId` (last one wins, matching the "newest write is
 * the truth" rule) and caps the list.
 *
 * @param {unknown} raw
 * @returns {object[]}
 */
export function normalizeActiveScoutScans(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {Map<string, object>} */
  const byId = new Map();
  for (const item of raw) {
    const scan = normalizeActiveScoutScan(item);
    if (!scan.scanId) continue;
    // Re-insert so a later duplicate both replaces and moves to the end.
    if (byId.has(scan.scanId)) byId.delete(scan.scanId);
    byId.set(scan.scanId, scan);
  }
  return [...byId.values()].slice(0, WORKSPACE_WATCHER_MAX_ACTIVE_SCOUT_SCANS);
}

/**
 * The row's Scout scan records, accepting either shape so callers that work on
 * an unnormalized row (a v1 fixture, a test patch) stay correct: the explicit
 * collection wins, else the legacy singleton is adapted. The collection key is
 * authoritative even when it is present but empty — once a row migrated, an
 * empty collection means "no scans", not "read the stale singleton again".
 *
 * @param {object | null | undefined} row
 * @returns {object[]}
 */
export function getActiveScoutScans(row) {
  if (row && Object.prototype.hasOwnProperty.call(row, 'activeScoutScans')) {
    return normalizeActiveScoutScans(row.activeScoutScans);
  }
  const legacy = normalizeActiveScoutScan(row?.activeScoutScan);
  return legacy.scanId ? [legacy] : [];
}

/**
 * @param {object | null | undefined} row
 * @param {unknown} scanId
 * @returns {object | null}
 */
export function getActiveScoutScanByScanId(row, scanId) {
  const wanted = String(scanId ?? '').trim();
  if (!wanted) return null;
  return getActiveScoutScans(row).find((scan) => scan.scanId === wanted) || null;
}

/**
 * @param {object | null | undefined} row
 * @param {unknown} chatId
 * @returns {object | null}
 */
export function getActiveScoutScanByChatId(row, chatId) {
  const wanted = String(chatId ?? '').trim();
  if (!wanted) return null;
  return getActiveScoutScans(row).find((scan) => scan.chatId === wanted) || null;
}

/**
 * Runtime scheduling state of one Scout profile: when it last ran, when it may
 * next run and the UTC-day counter of automatic scans. Kept OUT of the versioned
 * profile itself on purpose: a running scan snapshots the profile revision, and
 * a schedule tick must never mutate (or bump) that configuration. Never throws.
 *
 * @param {unknown} raw
 * @returns {{ lastRunAt: string, nextRunAt: string, day: string, count: number, updatedAt: string }}
 */
export function normalizeWorkspaceScoutScheduleState(raw) {
  const source = asPlainRecord(raw);
  return {
    lastRunAt: String(source.lastRunAt ?? '').trim(),
    nextRunAt: String(source.nextRunAt ?? '').trim(),
    day: String(source.day ?? '').trim(),
    count: normalizeCount(source.count, 0),
    updatedAt: String(source.updatedAt ?? '').trim(),
  };
}

/**
 * Normalize the `scoutSchedules` map (scoutId -> schedule state). Empty keys and
 * unknown-shaped entries are dropped, never invented.
 *
 * @param {unknown} raw
 * @returns {Record<string, object>}
 */
export function normalizeWorkspaceScoutSchedules(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  /** @type {Record<string, object>} */
  const out = {};
  for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (raw))) {
    const id = String(key ?? '').trim();
    if (!id) continue;
    out[id] = normalizeWorkspaceScoutScheduleState(value);
  }
  return out;
}

/**
 * The row's per-profile schedule map (never `undefined`).
 *
 * @param {object | null | undefined} row
 * @returns {Record<string, object>}
 */
export function getWorkspaceScoutSchedules(row) {
  return normalizeWorkspaceScoutSchedules(row?.scoutSchedules);
}

/**
 * Schedule state for one profile, or the neutral zero state.
 *
 * @param {object | null | undefined} row
 * @param {unknown} scoutId
 * @returns {{ lastRunAt: string, nextRunAt: string, day: string, count: number, updatedAt: string }}
 */
export function getWorkspaceScoutScheduleState(row, scoutId) {
  const id = String(scoutId ?? '').trim();
  const state = id ? getWorkspaceScoutSchedules(row)[id] : null;
  return state || normalizeWorkspaceScoutScheduleState(null);
}

/**
 * Patch helper: the row write that replaces the whole `scoutSchedules` map.
 *
 * @param {unknown} schedules
 * @returns {{ scoutSchedules: Record<string, object> }}
 */
export function workspaceWatcherScoutSchedulesPatch(schedules) {
  return { scoutSchedules: normalizeWorkspaceScoutSchedules(schedules) };
}

/**
 * One record of `scoutScanHistory`. `usage` stays `null` when there is no
 * measurement (a missing ledger entry is not zero) and `merged` counts findings
 * folded into an existing proposal.
 *
 * @param {unknown} raw
 * @returns {object | null}
 */
function normalizeScoutScanHistoryEntry(raw) {
  const source = asPlainRecord(raw);
  const scanId = String(source.scanId ?? '').trim();
  if (!scanId) return null;
  const statusRaw = String(source.status ?? '').trim().toLowerCase();
  const status = WORKSPACE_SCOUT_SCAN_STATUSES.includes(statusRaw) ? statusRaw : 'completed';
  const executor = asPlainRecord(source.executor);
  const revisionValue = Number(source.scoutRevision);
  const scoutRevision = Number.isFinite(revisionValue) && revisionValue >= 1
    ? Math.floor(revisionValue)
    : 1;
  return {
    scanId,
    scoutId: String(source.scoutId ?? '').trim(),
    scoutRevision,
    status,
    startedAt: String(source.startedAt ?? '').trim(),
    finishedAt: String(source.finishedAt ?? '').trim(),
    executor: {
      harness: String(executor.harness ?? '').trim(),
      model: String(executor.model ?? '').trim(),
    },
    added: normalizeCount(source.added, 0),
    merged: normalizeCount(source.merged, 0),
    dropped: normalizeCount(source.dropped, 0),
    reasons: normalizeStringList(source.reasons),
    error: String(source.error ?? '').trim(),
    chatId: String(source.chatId ?? '').trim(),
    runId: String(source.runId ?? '').trim(),
    usage: normalizeScoutScanUsage(source.usage),
    scopeResolution: normalizeScoutScopeResolution(source.scopeResolution),
  };
}

/** Bounded audit of the actual Git base and scope failure, independent of profile edits. */
function normalizeScoutScopeResolution(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return {
    status: String(raw.status ?? '').slice(0, 40),
    requestedBase: String(raw.requestedBase ?? '').slice(0, 200),
    resolvedBase: String(raw.resolvedBase ?? '').slice(0, 200),
    baseCommit: String(raw.baseCommit ?? '').slice(0, 64),
    diagnostics: (Array.isArray(raw.diagnostics) ? raw.diagnostics : []).slice(0, 10).map((entry) => ({
      code: String(entry?.code ?? '').slice(0, 80),
      message: String(entry?.message ?? '').slice(0, 2000),
    })),
  };
}

/**
 * @param {unknown} raw
 * @returns {object | null}
 */
function normalizeScoutScanUsage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (raw))) {
    if (value == null || value === '') continue;
    if (typeof value === 'number' && !Number.isFinite(value)) continue;
    out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Retain every non-terminal record plus the newest terminal records per Scout
 * (100) and overall (1000). A settled record is never dropped while its scan is
 * still reserved/running/uncertain.
 *
 * @param {object[]} entries
 * @returns {object[]}
 */
function pruneWorkspaceScoutScanHistory(entries) {
  /** @type {Map<string, object[]>} */
  const byProfile = new Map();
  for (const entry of entries) {
    const key = entry.scoutId || '';
    if (!byProfile.has(key)) byProfile.set(key, []);
    byProfile.get(key).push(entry);
  }
  /** @type {Set<object>} */
  const keep = new Set();
  for (const list of byProfile.values()) {
    /** @type {object[]} */
    const terminal = [];
    for (const entry of list) {
      if (WORKSPACE_SCOUT_SCAN_NON_TERMINAL_STATUSES.includes(entry.status)) keep.add(entry);
      else terminal.push(entry);
    }
    for (const entry of terminal.slice(-WORKSPACE_SCOUT_SCAN_HISTORY_MAX_PER_PROFILE)) keep.add(entry);
  }
  let kept = entries.filter((entry) => keep.has(entry));
  if (kept.length > WORKSPACE_SCOUT_SCAN_HISTORY_MAX_PER_WORKSPACE) {
    const overflow = kept.length - WORKSPACE_SCOUT_SCAN_HISTORY_MAX_PER_WORKSPACE;
    /** @type {Set<object>} */
    const drop = new Set();
    for (const entry of kept) {
      if (drop.size >= overflow) break;
      if (WORKSPACE_SCOUT_SCAN_NON_TERMINAL_STATUSES.includes(entry.status)) continue;
      drop.add(entry);
    }
    if (drop.size > 0) kept = kept.filter((entry) => !drop.has(entry));
  }
  return kept;
}

/**
 * Normalize the stored `scoutScanHistory` log. Dedupes by `scanId` (last wins)
 * and applies the retention caps without ever dropping a non-terminal scan.
 *
 * @param {unknown} raw
 * @returns {object[]}
 */
export function normalizeWorkspaceScoutScanHistory(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {Map<string, object>} */
  const byId = new Map();
  for (const item of raw) {
    const entry = normalizeScoutScanHistoryEntry(item);
    if (!entry) continue;
    if (byId.has(entry.scanId)) byId.delete(entry.scanId);
    byId.set(entry.scanId, entry);
  }
  return pruneWorkspaceScoutScanHistory([...byId.values()]);
}

/**
 * Merge one history entry into the row's bounded log. Pure: returns the patch
 * for the caller to persist. An existing `scanId` is updated field-by-field so
 * a later status/finish note never wipes the earlier reservation details.
 *
 * @param {object | null | undefined} row
 * @param {object} entry
 * @param {{ now?: number }} [_options]
 * @returns {{ scoutScanHistory: object[] }}
 */
export function appendWorkspaceScoutScanHistory(row, entry, _options = {}) {
  const current = normalizeWorkspaceScoutScanHistory(row?.scoutScanHistory);
  const normalized = normalizeScoutScanHistoryEntry(entry);
  if (!normalized) return { scoutScanHistory: current };
  const source = asPlainRecord(entry);
  const index = current.findIndex((existing) => existing.scanId === normalized.scanId);
  let next;
  if (index === -1) {
    next = [...current, normalized];
  } else {
    const existing = current[index];
    const merged = { ...existing };
    for (const field of [
      'scoutId', 'scoutRevision', 'status', 'startedAt', 'finishedAt',
      'added', 'merged', 'dropped', 'error', 'chatId', 'runId',
    ]) {
      if (source[field] !== undefined) merged[field] = normalized[field];
    }
    if (source.reasons !== undefined) merged.reasons = normalized.reasons;
    if (source.executor !== undefined) merged.executor = normalized.executor;
    if (source.usage !== undefined) merged.usage = normalized.usage;
    if (source.scopeResolution !== undefined) merged.scopeResolution = normalized.scopeResolution;
    next = current.slice();
    next[index] = merged;
  }
  return { scoutScanHistory: normalizeWorkspaceScoutScanHistory(next) };
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function asPlainRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
function clampScoutProfileText(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

/**
 * A scope glob is workspace-relative and must not escape it. Returns a readable
 * reason, or an empty string when the glob is acceptable.
 *
 * @param {unknown} value
 * @returns {string}
 */
function invalidScoutGlobReason(value) {
  if (typeof value !== 'string') return 'glob musi być tekstem';
  const glob = value.trim();
  if (!glob) return 'glob nie może być pusty';
  if (glob.length > WORKSPACE_SCOUT_PROFILE_MAX_GLOB_LENGTH) {
    return `glob przekracza ${WORKSPACE_SCOUT_PROFILE_MAX_GLOB_LENGTH} znaków`;
  }
  for (let i = 0; i < glob.length; i += 1) {
    const code = glob.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return 'glob zawiera znaki sterujące';
  }
  if (glob.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(glob)) {
    return 'glob musi być względny wobec workspace';
  }
  if (glob.split(/[\\/]/).includes('..')) return 'glob nie może wychodzić poza workspace';
  return '';
}

/**
 * Normalize one Scout profile into its full stored shape. Never throws: a
 * garbage record becomes a usable profile with safe defaults and revision >= 1.
 * Validation (lengths, closed sets, executor consistency) is a separate step so
 * a caller can report why a user payload was rejected instead of silently
 * clamping it.
 *
 * @param {unknown} raw
 * @param {{ now?: number }} [options]
 * @returns {object}
 */
export function normalizeWorkspaceScoutProfile(raw, options = {}) {
  const source = asPlainRecord(raw);
  const now = Number.isFinite(options?.now) ? Number(options.now) : Date.now();
  const fallbackAt = new Date(now).toISOString();
  const scope = asPlainRecord(source.scope);
  const executor = asPlainRecord(source.executor);
  const schedule = asPlainRecord(source.schedule);
  const limits = asPlainRecord(source.limits);

  const id = String(source.id ?? '').trim() || randomUUID();
  const revisionValue = Number(source.revision);
  const revision = Number.isFinite(revisionValue) && revisionValue >= 1 ? Math.floor(revisionValue) : 1;

  const scopeModeRaw = String(scope.mode ?? '').trim().toLowerCase();
  const scopeMode = WORKSPACE_SCOUT_PROFILE_SCOPE_MODES.includes(scopeModeRaw) ? scopeModeRaw : 'changes';
  const scheduleModeRaw = String(schedule.mode ?? '').trim().toLowerCase();
  const scheduleMode = WORKSPACE_SCOUT_PROFILE_SCHEDULE_MODES.includes(scheduleModeRaw) ? scheduleModeRaw : 'manual';

  const sources = (() => {
    const requested = normalizeStringList(source.sources)
      .filter((value) => WORKSPACE_SCOUT_PROFILE_SOURCES.includes(value));
    return requested.length ? requested : [...WORKSPACE_SCOUT_PROFILE_SOURCES];
  })();
  const categories = (() => {
    /** @type {string[]} */
    const requested = [];
    for (const value of normalizeStringList(source.categories)) {
      const category = normalizeWorkspaceScoutCategory(value);
      if (category && !requested.includes(category)) requested.push(category);
    }
    return requested.length ? requested : [...WORKSPACE_SCOUT_CATEGORIES];
  })();
  const normalizeGlobs = (value) => normalizeStringList(value)
    .slice(0, WORKSPACE_SCOUT_PROFILE_MAX_GLOBS)
    .map((glob) => glob.slice(0, WORKSPACE_SCOUT_PROFILE_MAX_GLOB_LENGTH));

  return {
    id,
    revision,
    name: clampScoutProfileText(source.name, WORKSPACE_SCOUT_PROFILE_MAX_NAME_LENGTH),
    description: clampScoutProfileText(source.description, WORKSPACE_SCOUT_PROFILE_MAX_TEXT_LENGTH),
    enabled: source.enabled === true,
    archivedAt: String(source.archivedAt ?? '').trim(),
    templateId: String(source.templateId ?? '').trim(),
    templateVersion: String(source.templateVersion ?? '').trim(),
    objective: clampScoutProfileText(source.objective, WORKSPACE_SCOUT_PROFILE_MAX_TEXT_LENGTH),
    instructions: clampScoutProfileText(source.instructions, WORKSPACE_SCOUT_PROFILE_MAX_TEXT_LENGTH),
    scope: {
      mode: scopeMode,
      base: String(scope.base ?? '').trim() || 'main',
      include: normalizeGlobs(scope.include),
      exclude: normalizeGlobs(scope.exclude),
    },
    sources,
    categories,
    executor: (() => {
      const auto = executor.auto !== false;
      return {
        auto,
        // A profile in automatic mode never stores an explicit executor: the
        // runner ignores `harness`/`model` there, so keeping them would make the
        // preview claim an override the scan never uses.
        harness: auto ? '' : String(executor.harness ?? '').trim(),
        model: auto ? '' : String(executor.model ?? '').trim(),
        allowedHarnesses: normalizeStringList(executor.allowedHarnesses),
      };
    })(),
    schedule: {
      mode: scheduleMode,
      intervalHours: normalizeNonNegativeNumber(schedule.intervalHours, 6),
    },
    limits: {
      maxPerDay: Math.min(WORKSPACE_SCOUT_PROFILE_MAX_PER_DAY, normalizeCount(limits.maxPerDay, 4)),
      maxFindingsPerScan: Math.min(
        WORKSPACE_SCOUT_PROFILE_MAX_FINDINGS_PER_SCAN,
        normalizeCount(limits.maxFindingsPerScan, 10),
      ),
      timeoutMs: Math.min(
        WORKSPACE_SCOUT_PROFILE_MAX_TIMEOUT_MS,
        normalizeCount(limits.timeoutMs, WORKSPACE_SCOUT_PROFILE_DEFAULT_TIMEOUT_MS),
      ),
    },
    createdAt: String(source.createdAt ?? '').trim() || fallbackAt,
    updatedAt: String(source.updatedAt ?? '').trim() || fallbackAt,
  };
}

/**
 * @param {{ profileCount?: unknown, existingCount?: unknown, existingProfiles?: unknown, profiles?: unknown }} [options]
 * @returns {number | null}
 */
function resolveExistingScoutProfileCount(options = {}) {
  const direct = Number(options?.profileCount);
  if (Number.isFinite(direct)) return Math.max(0, Math.floor(direct));
  const alias = Number(options?.existingCount);
  if (Number.isFinite(alias)) return Math.max(0, Math.floor(alias));
  const list = options?.existingProfiles ?? options?.profiles;
  if (Array.isArray(list)) return list.length;
  return null;
}

/**
 * Validate a user-supplied (or merged) Scout profile. Reads the raw values, so
 * an over-long name or an empty category list is reported instead of being
 * silently clamped by `normalizeWorkspaceScoutProfile`.
 *
 * @param {unknown} profile
 * @param {{
 *   profileCount?: number,
 *   existingCount?: number,
 *   existingProfiles?: unknown[],
 *   profiles?: unknown[],
 *   isUpdate?: boolean,
 * }} [options]
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateWorkspaceScoutProfile(profile, options = {}) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    return { ok: false, errors: ['profil musi być obiektem'] };
  }
  const source = /** @type {Record<string, unknown>} */ (profile);
  /** @type {string[]} */
  const errors = [];

  const name = typeof source.name === 'string' ? source.name.trim() : '';
  if (!name) errors.push('name jest wymagane');
  else if (name.length > WORKSPACE_SCOUT_PROFILE_MAX_NAME_LENGTH) {
    errors.push(`name może mieć najwyżej ${WORKSPACE_SCOUT_PROFILE_MAX_NAME_LENGTH} znaków`);
  }

  const objective = typeof source.objective === 'string' ? source.objective.trim() : '';
  if (!objective) errors.push('objective jest wymagane');
  else if (objective.length > WORKSPACE_SCOUT_PROFILE_MAX_TEXT_LENGTH) {
    errors.push(`objective może mieć najwyżej ${WORKSPACE_SCOUT_PROFILE_MAX_TEXT_LENGTH} znaków`);
  }

  for (const field of ['description', 'instructions']) {
    const value = source[field];
    if (value == null) continue;
    if (typeof value !== 'string') {
      errors.push(`${field} musi być tekstem`);
      continue;
    }
    if (value.trim().length > WORKSPACE_SCOUT_PROFILE_MAX_TEXT_LENGTH) {
      errors.push(`${field} może mieć najwyżej ${WORKSPACE_SCOUT_PROFILE_MAX_TEXT_LENGTH} znaków`);
    }
  }

  const categories = source.categories;
  if (!Array.isArray(categories) || categories.length === 0) {
    errors.push('categories musi być niepustą listą kategorii');
  } else {
    for (const value of categories) {
      if (!normalizeWorkspaceScoutCategory(value)) {
        const label = String(value ?? '').trim().slice(0, 40) || '(pusta)';
        errors.push(`nieznana kategoria: ${label}`);
      }
    }
  }

  if (source.sources != null) {
    if (!Array.isArray(source.sources)) {
      errors.push('sources musi być listą źródeł');
    } else {
      for (const value of source.sources) {
        const sourceId = String(value ?? '').trim();
        if (!WORKSPACE_SCOUT_PROFILE_SOURCES.includes(sourceId)) {
          errors.push(`nieznane źródło: ${sourceId.slice(0, 40) || '(puste)'}`);
        }
      }
    }
  }

  const scope = asPlainRecord(source.scope);
  if (source.scope != null && source.scope !== scope) {
    errors.push('scope musi być obiektem');
  }
  const scopeMode = String(scope.mode ?? '').trim().toLowerCase();
  if (scopeMode && !WORKSPACE_SCOUT_PROFILE_SCOPE_MODES.includes(scopeMode)) {
    errors.push(`scope.mode musi być jednym z: ${WORKSPACE_SCOUT_PROFILE_SCOPE_MODES.join(', ')}`);
  }
  for (const field of ['include', 'exclude']) {
    const value = scope[field];
    if (value == null) continue;
    if (!Array.isArray(value)) {
      errors.push(`scope.${field} musi być listą globów`);
      continue;
    }
    // Reported instead of letting `normalizeWorkspaceScoutProfile` silently
    // truncate the list with `slice(0, WORKSPACE_SCOUT_PROFILE_MAX_GLOBS)`.
    if (value.length > WORKSPACE_SCOUT_PROFILE_MAX_GLOBS) {
      errors.push(`scope.${field} może mieć najwyżej ${WORKSPACE_SCOUT_PROFILE_MAX_GLOBS} globów`);
    }
    for (const glob of value) {
      const reason = invalidScoutGlobReason(glob);
      if (reason) errors.push(`scope.${field}: ${reason}`);
    }
  }

  const schedule = asPlainRecord(source.schedule);
  if (source.schedule != null && source.schedule !== schedule) {
    errors.push('schedule musi być obiektem');
  }
  const scheduleMode = String(schedule.mode ?? '').trim().toLowerCase();
  if (scheduleMode && !WORKSPACE_SCOUT_PROFILE_SCHEDULE_MODES.includes(scheduleMode)) {
    errors.push(`schedule.mode musi być jednym z: ${WORKSPACE_SCOUT_PROFILE_SCHEDULE_MODES.join(', ')}`);
  }
  if ((scheduleMode || 'manual') === 'interval') {
    const hours = Number(schedule.intervalHours);
    if (!Number.isFinite(hours) || hours <= 0) {
      errors.push('schedule.intervalHours musi być większe od 0');
    }
  }

  const limits = asPlainRecord(source.limits);
  if (source.limits != null && source.limits !== limits) {
    errors.push('limits musi być obiektem');
  }
  const limitCaps = {
    maxPerDay: WORKSPACE_SCOUT_PROFILE_MAX_PER_DAY,
    maxFindingsPerScan: WORKSPACE_SCOUT_PROFILE_MAX_FINDINGS_PER_SCAN,
    timeoutMs: WORKSPACE_SCOUT_PROFILE_MAX_TIMEOUT_MS,
  };
  for (const [field, cap] of Object.entries(limitCaps)) {
    const raw = limits[field];
    if (raw == null) continue;
    const value = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isInteger(value) || value < 0) {
      errors.push(`limits.${field} musi być nieujemną liczbą całkowitą`);
    } else if (value > cap) {
      errors.push(`limits.${field} przekracza maksimum ${cap}`);
    }
  }

  const executor = asPlainRecord(source.executor);
  if (source.executor != null && source.executor !== executor) {
    errors.push('executor musi być obiektem');
  }
  if (executor.allowedHarnesses != null && !Array.isArray(executor.allowedHarnesses)) {
    errors.push('executor.allowedHarnesses musi być listą');
  }
  const harness = String(executor.harness ?? '').trim();
  const allowedHarnesses = normalizeStringList(executor.allowedHarnesses);
  // Manual mode is an explicit executor, so a missing harness is a contradiction
  // the runner would otherwise resolve by silently falling back to auto.
  if (executor.auto === false && !harness) {
    errors.push('executor.harness jest wymagane, gdy executor.auto = false');
  }
  // An empty allow-list means "no extra restriction"; a non-empty one is a hard
  // filter, so an explicit harness outside it can never start.
  if (harness && allowedHarnesses.length > 0 && !allowedHarnesses.includes(harness)) {
    errors.push(`executor.harness "${harness}" nie należy do executor.allowedHarnesses`);
  }

  const existingCount = resolveExistingScoutProfileCount(options);
  if (existingCount != null
    && existingCount >= WORKSPACE_SCOUT_PROFILE_MAX_PER_WORKSPACE
    && options?.isUpdate !== true) {
    errors.push(`limit ${WORKSPACE_SCOUT_PROFILE_MAX_PER_WORKSPACE} profili na workspace został osiągnięty`);
  }

  return { ok: errors.length === 0, errors };
}

/**
 * The virtual general Scout: deterministic, disabled, scoped to workspace
 * changes against `main`. It is never stored unless the operator configures it;
 * `listWorkspaceScoutProfiles` returns it for a workspace with no stored profile.
 *
 * @param {object} [overrides]
 * @returns {object}
 */
export function defaultWorkspaceScoutProfile(overrides = {}) {
  const base = {
    id: SCOUT_GENERAL_PROFILE_ID,
    revision: 1,
    name: 'Scout ogólny',
    description: '',
    enabled: false,
    archivedAt: '',
    templateId: '',
    templateVersion: '',
    objective: 'Wykrywaj błędy, ryzyka i propozycje usprawnień w całym workspace.',
    instructions: '',
    scope: { mode: 'changes', base: 'main', include: [], exclude: [] },
    sources: [...WORKSPACE_SCOUT_PROFILE_SOURCES],
    categories: [...WORKSPACE_SCOUT_CATEGORIES],
    executor: { auto: true, harness: '', model: '', allowedHarnesses: [] },
    schedule: { mode: 'manual', intervalHours: 6 },
    limits: {
      maxPerDay: 4,
      maxFindingsPerScan: 10,
      timeoutMs: WORKSPACE_SCOUT_PROFILE_DEFAULT_TIMEOUT_MS,
    },
    createdAt: WORKSPACE_SCOUT_PROFILE_DEFAULT_TIMESTAMP,
    updatedAt: WORKSPACE_SCOUT_PROFILE_DEFAULT_TIMESTAMP,
  };
  return normalizeWorkspaceScoutProfile({ ...base, ...asPlainRecord(overrides) }, { now: 0 });
}

/**
 * True when a raw v1 `policy` object carries any implicit Scout configuration.
 *
 * @param {unknown} rawPolicy
 * @returns {boolean}
 */
function hasLegacyScoutPolicy(rawPolicy) {
  const policy = asPlainRecord(rawPolicy);
  return LEGACY_SCOUT_POLICY_KEYS.some((key) => Object.prototype.hasOwnProperty.call(policy, key));
}

/**
 * Build the single migrated "Scout ogólny" from a legacy v1 row. Called only by
 * `normalizeWorkspaceWatcherRow` and only when the raw row has no
 * `scoutProfiles` field at all.
 *
 * @param {Record<string, unknown>} source raw row
 * @param {unknown} rawPolicy raw `policy` object
 * @returns {object}
 */
function buildLegacyWorkspaceScoutProfile(source, rawPolicy) {
  const policy = normalizeWorkspaceWatcherPolicy(rawPolicy);
  const base = defaultWorkspaceScoutProfile();
  const explicitExecutor = Boolean(policy.orchestrator.harness || policy.orchestrator.model);
  const rowAt = String(source.updatedAt ?? '').trim()
    || String(source.createdAt ?? '').trim()
    || base.createdAt;
  return normalizeWorkspaceScoutProfile({
    ...base,
    id: SCOUT_GENERAL_PROFILE_ID,
    revision: 1,
    enabled: policy.scoutEnabled === true,
    // Legacy had no explicit source selection: it always read every signal.
    sources: [...WORKSPACE_SCOUT_PROFILE_SOURCES],
    categories: [...policy.scoutCategories],
    executor: {
      auto: !explicitExecutor,
      harness: policy.orchestrator.harness,
      model: explicitExecutor ? policy.orchestrator.model : '',
      allowedHarnesses: [...policy.scoutAllowedHarnesses],
    },
    // Legacy scheduled the general Scout by interval; `enabled` carries whether
    // automatic scans are on.
    schedule: {
      mode: 'interval',
      intervalHours: policy.scoutIntervalHours > 0 ? policy.scoutIntervalHours : 6,
    },
    limits: {
      maxPerDay: policy.scoutMaxPerDay,
      maxFindingsPerScan: policy.scoutMaxPerScan,
      timeoutMs: base.limits.timeoutMs,
    },
    createdAt: rowAt,
    updatedAt: rowAt,
  });
}

/**
 * Normalize the stored `scoutProfiles` collection, deduping by id and bounding
 * the list.
 *
 * @param {unknown} raw
 * @returns {object[]}
 */
function normalizeWorkspaceScoutProfilesList(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {object[]} */
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const profile = normalizeWorkspaceScoutProfile(item);
    if (!profile.id || seen.has(profile.id)) continue;
    seen.add(profile.id);
    out.push(profile);
    if (out.length >= WORKSPACE_SCOUT_PROFILE_MAX_PER_WORKSPACE) break;
  }
  return out;
}

/**
 * @param {object} left
 * @param {object} right
 * @returns {number}
 */
function compareWorkspaceScoutProfiles(left, right) {
  const leftAt = String(left?.createdAt ?? '');
  const rightAt = String(right?.createdAt ?? '');
  if (leftAt < rightAt) return -1;
  if (leftAt > rightAt) return 1;
  return String(left?.id ?? '').localeCompare(String(right?.id ?? ''));
}

/**
 * @param {unknown} rawPolicy
 * @returns {object}
 */
export function defaultWorkspaceWatcherPolicy() {
  return {
    maxParallel: 1,
    maxCyclesPerDay: 20,
    maxConsecutiveFailures: 3,
    maxSameFindings: 2,
    cooldownMs: 30_000,
    backoffBaseMs: 60_000,
    backoffCapMs: 6 * 60 * 60_000,
    requirePlanApproval: true,
    // 'leaf' (default) requires approval per leaf todo; 'root' generates and
    // approves one plan at the subtree root, unblocking all its leaves at once.
    planApprovalScope: 'leaf',
    allowedHarnesses: [],
    pickRoles: [...WORKSPACE_WATCHER_PICK_ROLES],
    quietHours: { start: '', end: '' },
    // Scout is a separate periodic LLM scan (never a watcher cycle). Disabled by
    // default: it only runs once an operator opts in, respects the same quiet
    // hours, and has its own interval budget that is independent of
    // `maxCyclesPerDay`.
    scoutEnabled: false,
    scoutIntervalHours: 6,
    scoutAutoCreate: false,
    scoutAllowedHarnesses: [],
    scoutCategories: [...WORKSPACE_SCOUT_CATEGORIES],
    scoutMaxPerDay: 4,
    scoutMaxPerScan: 10,
    // Scout chats (the scan and its review children) never occupy a todo slot.
    // This is how many of those scout agents may run at once.
    scoutMaxParallel: 1,
    // Bounded, opt-in failing-test probe (default OFF so the heartbeat worker
    // is never blocked by a suite the operator did not approve).
    scoutTestProbe: false,
    scoutTestCommand: [],
    // Explicit orchestrator executor. Empty harness = resolve a cheap
    // "implement"-role pick; a set harness/model is a hard override so an
    // operator can pin the watcher onto a specific cheap model instead of the
    // premium default. Never edited implicitly.
    orchestrator: { harness: '', model: '' },
    // When true, an executor chat confirmed idle but still open becomes
    // `recoverable` (default keeps `user_action` so the operator archives first).
    recoverIdleOpenChat: false,
    // Unknown `doing` rows escalate to the operator after this many heartbeat
    // observations (each ~DELEGATION_RUNTIME_TICK_MS, default 6 → ~30s).
    unknownEscalationObservations: 6,
  };
}

/**
 * @param {unknown} raw
 * @returns {object}
 */
export function normalizeWorkspaceWatcherPolicy(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? /** @type {Record<string, unknown>} */ (raw)
    : {};
  const quiet = source.quietHours && typeof source.quietHours === 'object' && !Array.isArray(source.quietHours)
    ? /** @type {Record<string, unknown>} */ (source.quietHours)
    : {};
  const roles = normalizeStringList(source.pickRoles).filter((role) => WORKSPACE_WATCHER_PICK_ROLES.includes(role));
  const orchestrator = source.orchestrator && typeof source.orchestrator === 'object' && !Array.isArray(source.orchestrator)
    ? /** @type {Record<string, unknown>} */ (source.orchestrator)
    : {};
  return {
    // Capped: since `activeCycles` may hold at most this many live cycles, an
    // unbounded value would let one workspace fan out without any ceiling.
    maxParallel: Math.min(WORKSPACE_WATCHER_MAX_PARALLEL, Math.max(1, normalizeCount(source.maxParallel, 1))),
    maxCyclesPerDay: normalizeCount(source.maxCyclesPerDay, 20),
    // The failure ceiling is the one guardrail the tick applies as a plain
    // count, so it must survive the write→read→write round-trip. Default 3 so a
    // repeatedly-failing todo stops crowding out fresh work without an operator
    // having to set it. `0` is stored as-is and means "never skip on failures".
    maxConsecutiveFailures: normalizeCount(source.maxConsecutiveFailures, 3),
    // Consecutive identical review findings before the autopilot stops dragging
    // the same loop. `0` disables the guard.
    maxSameFindings: normalizeCount(source.maxSameFindings, 2),
    // Explicit stored values (including a legacy 60s row) are preserved as-is;
    // this fallback only applies when `cooldownMs` is absent/invalid.
    cooldownMs: normalizeCount(source.cooldownMs, 30_000),
    backoffBaseMs: normalizeCount(source.backoffBaseMs, 60_000),
    backoffCapMs: normalizeCount(source.backoffCapMs, 6 * 60 * 60_000),
    requirePlanApproval: source.requirePlanApproval !== false,
    planApprovalScope: source.planApprovalScope === 'root' ? 'root' : 'leaf',
    allowedHarnesses: normalizeStringList(source.allowedHarnesses),
    pickRoles: roles.length ? roles : [...WORKSPACE_WATCHER_PICK_ROLES],
    quietHours: {
      start: String(quiet.start ?? '').trim(),
      end: String(quiet.end ?? '').trim(),
    },
    // Scout opt-in and its own schedule/budget. `scoutCategories` is filtered to
    // the closed set; an empty/blank value falls back to all categories so a
    // partial policy patch can never silently disable every proposal.
    scoutEnabled: source.scoutEnabled === true,
    scoutIntervalHours: normalizeNonNegativeNumber(source.scoutIntervalHours, 6),
    // `autoCreateScoutTodos` is the historical name from the task brief; accept
    // it as an alias so an older settings payload cannot silently disable it.
    scoutAutoCreate: source.scoutAutoCreate === true || source.autoCreateScoutTodos === true,
    scoutAllowedHarnesses: normalizeStringList(source.scoutAllowedHarnesses),
    scoutCategories: (() => {
      const requested = normalizeStringList(source.scoutCategories)
        .map((value) => normalizeWorkspaceScoutCategory(value))
        .filter(Boolean);
      return requested.length ? [...new Set(requested)] : [...WORKSPACE_SCOUT_CATEGORIES];
    })(),
    scoutMaxPerDay: normalizeCount(source.scoutMaxPerDay, 4),
    scoutMaxPerScan: Math.max(1, normalizeCount(source.scoutMaxPerScan, 10)),
    scoutMaxParallel: Math.min(
      WORKSPACE_WATCHER_MAX_PARALLEL,
      Math.max(1, normalizeCount(source.scoutMaxParallel, 1)),
    ),
    // Bounded opt-in failing-test probe. `scoutTestCommand` is preserved as-is
    // (an argv array, or a raw string the probe refuses to execute) so a
    // misconfigured shell-style command is reported, not silently run.
    scoutTestProbe: source.scoutTestProbe === true,
    scoutTestCommand: Array.isArray(source.scoutTestCommand)
      ? normalizeStringList(source.scoutTestCommand)
      : (typeof source.scoutTestCommand === 'string' ? source.scoutTestCommand : []),
    orchestrator: {
      harness: String(orchestrator.harness ?? '').trim(),
      model: String(orchestrator.model ?? '').trim(),
    },
    recoverIdleOpenChat: source.recoverIdleOpenChat === true,
    unknownEscalationObservations: Math.max(
      1,
      normalizeCount(source.unknownEscalationObservations, 6),
    ),
  };
}

/**
 * @param {unknown} raw
 * @returns {{ ownerPid: number, token: string, expiresAt: string }}
 */
export function normalizeWorkspaceWatcherLease(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? /** @type {Record<string, unknown>} */ (raw)
    : {};
  const pid = Number(source.ownerPid);
  return {
    ownerPid: Number.isInteger(pid) && pid > 0 ? pid : 0,
    token: String(source.token ?? '').trim(),
    expiresAt: String(source.expiresAt ?? '').trim(),
  };
}

/**
 * @param {unknown} lease
 * @param {number} [now]
 * @returns {boolean}
 */
export function isWorkspaceWatcherLeaseActive(lease, now = Date.now()) {
  const normalized = normalizeWorkspaceWatcherLease(lease);
  if (!normalized.token) return false;
  const expiresAt = Date.parse(normalized.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

/**
 * Acquire or renew the single-writer lease. A live lease owned by a different
 * token is never stolen; an expired lease is.
 *
 * @param {object} row
 * @param {{ ownerPid?: number, token?: string, ttlMs?: number, now?: number }} [options]
 * @returns {{ acquired: boolean, renewed: boolean, lease: { ownerPid: number, token: string, expiresAt: string } }}
 */
export function acquireWorkspaceWatcherLease(row, options = {}) {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const token = String(options.token ?? '').trim();
  const current = normalizeWorkspaceWatcherLease(row?.lease);
  if (!token) {
    return { acquired: false, renewed: false, lease: current };
  }
  if (isWorkspaceWatcherLeaseActive(current, now) && current.token !== token) {
    return { acquired: false, renewed: false, lease: current };
  }
  const ttlMs = Number.isFinite(options.ttlMs) && Number(options.ttlMs) > 0
    ? Number(options.ttlMs)
    : WORKSPACE_WATCHER_DEFAULT_LEASE_TTL_MS;
  const ownerPid = Number.isInteger(options.ownerPid) && Number(options.ownerPid) > 0
    ? Number(options.ownerPid)
    : process.pid;
  return {
    acquired: true,
    renewed: isWorkspaceWatcherLeaseActive(current, now) && current.token === token,
    lease: {
      ownerPid,
      token,
      expiresAt: new Date(now + ttlMs).toISOString(),
    },
  };
}

/**
 * Drop the lease only when the caller still owns it.
 *
 * @param {object} row
 * @param {{ token?: string }} [options]
 * @returns {{ ownerPid: number, token: string, expiresAt: string }}
 */
export function releaseWorkspaceWatcherLease(row, options = {}) {
  const current = normalizeWorkspaceWatcherLease(row?.lease);
  const token = String(options.token ?? '').trim();
  if (!token || current.token !== token) return current;
  return { ownerPid: 0, token: '', expiresAt: '' };
}

/**
 * Occupying cycle chats attached to a `wait_active` / `cycle_active` decision.
 *
 * @param {unknown} raw
 * @returns {Array<{ chatId: string, cycleId: string }>}
 */
function normalizeSlotChatsList(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {Array<{ chatId: string, cycleId: string }>} */
  const out = [];
  for (const row of raw) {
    if (out.length >= WORKSPACE_WATCHER_MAX_ACTIVE_CYCLES) break;
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const source = /** @type {Record<string, unknown>} */ (row);
    const chatId = String(source.chatId ?? '').trim();
    const cycleId = String(source.cycleId ?? '').trim();
    if (!chatId && !cycleId) continue;
    out.push({ chatId, cycleId });
  }
  return out;
}

/**
 * Chat ids and `delegation:<id>` tokens that filled `maxParallel`.
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeSlotHoldersList(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {string[]} */
  const out = [];
  for (const row of raw) {
    if (out.length >= WORKSPACE_WATCHER_MAX_SLOT_HOLDERS_IN_DECISION) break;
    const token = String(row ?? '').trim();
    if (!token || out.includes(token)) continue;
    out.push(token);
  }
  return out;
}

/**
 * @param {unknown} raw
 * @param {number} [limit]
 * @returns {Array<{ chatId: string, reason: string }>}
 */
function normalizeUnknownChatsList(raw, limit = WORKSPACE_WATCHER_MAX_UNKNOWN_CHATS_IN_DECISION) {
  if (!Array.isArray(raw)) return [];
  const capped = Math.max(0, Math.floor(Number(limit) || 0));
  /** @type {Array<{ chatId: string, reason: string }>} */
  const out = [];
  for (const row of raw) {
    if (out.length >= capped) break;
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const chatId = String(/** @type {Record<string, unknown>} */ (row).chatId ?? '').trim();
    if (!chatId) continue;
    const reason = String(/** @type {Record<string, unknown>} */ (row).reason ?? '').trim() || 'unknown';
    out.push({ chatId, reason });
  }
  return out;
}

/**
 * @param {unknown} raw
 * @returns {{ at: string, kind: string, reason: string, readyTodoCount: number, activeAgentCount: number, shouldNotify: boolean, nextTodoId: string, unknownAgentCount?: number, unknownChats?: Array<{ chatId: string, reason: string }>, slotHolders?: string[], modelSelection?: object } | null}
 */
export function normalizeWorkspaceWatcherDecision(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = /** @type {Record<string, unknown>} */ (raw);
  const at = String(source.at ?? '').trim();
  const kind = String(source.kind ?? '').trim();
  if (!at || !kind) return null;
  const unknownAgentCount = normalizeCount(source.unknownAgentCount, 0);
  const unknownChats = normalizeUnknownChatsList(source.unknownChats);
  const slotChats = normalizeSlotChatsList(source.slotChats);
  const slotHolders = normalizeSlotHoldersList(source.slotHolders);
  /** @type {{ at: string, kind: string, reason: string, readyTodoCount: number, activeAgentCount: number, shouldNotify: boolean, nextTodoId: string, unknownAgentCount?: number, unknownChats?: Array<{ chatId: string, reason: string }>, slotChats?: Array<{ chatId: string, cycleId: string }>, slotHolders?: string[], modelSelection?: object }} */
  const entry = {
    at,
    kind,
    reason: String(source.reason ?? '').trim(),
    readyTodoCount: normalizeCount(source.readyTodoCount, 0),
    activeAgentCount: normalizeCount(source.activeAgentCount, 0),
    shouldNotify: source.shouldNotify === true,
    // Observation only: which todo *would* be claimed. It never changes the
    // todo status; the claim itself is an explicit API call, not a tick.
    nextTodoId: String(source.nextTodoId ?? '').trim(),
  };
  const scoutAgentCount = normalizeCount(source.scoutAgentCount, 0);
  if (scoutAgentCount > 0) entry.scoutAgentCount = scoutAgentCount;
  if (unknownAgentCount > 0) entry.unknownAgentCount = unknownAgentCount;
  if (unknownChats.length) entry.unknownChats = unknownChats;
  if (slotChats.length) entry.slotChats = slotChats;
  if (slotHolders.length) entry.slotHolders = slotHolders;
  const selection = source.modelSelection && typeof source.modelSelection === 'object'
    ? /** @type {Record<string, unknown>} */ (source.modelSelection)
    : null;
  if (selection) {
    const selected = selection.selected && typeof selection.selected === 'object'
      ? /** @type {Record<string, unknown>} */ (selection.selected)
      : {};
    const candidates = Array.isArray(selection.candidates) ? selection.candidates : [];
    const excludedHarnesses = Array.isArray(selection.excludedHarnesses) ? selection.excludedHarnesses : [];
    entry.modelSelection = {
      role: String(selection.role ?? '').slice(0, 24),
      mode: String(selection.mode ?? '').slice(0, 24),
      rotation: String(selection.rotation ?? '').slice(0, 24),
      selected: {
        harness: String(selected.harness ?? '').slice(0, 80),
        model: String(selected.model ?? '').slice(0, 160),
        score: selected.score != null && Number.isFinite(Number(selected.score)) ? Number(selected.score) : null,
        reason: String(selected.reason ?? '').slice(0, 240),
        favorite: selected.favorite === true,
      },
      candidates: candidates.slice(0, 8).map((candidate, index) => ({
        harness: String(candidate?.harness ?? '').slice(0, 80),
        model: String(candidate?.model ?? '').slice(0, 160),
        rank: normalizeCount(candidate?.rank, index + 1),
        score: candidate?.score != null && Number.isFinite(Number(candidate.score)) ? Number(candidate.score) : null,
        reason: String(candidate?.reason ?? '').slice(0, 240),
        favorite: candidate?.favorite === true,
        roleUses7d: normalizeCount(candidate?.roleUses7d, 0),
        modelUses7d: normalizeCount(candidate?.modelUses7d, 0),
      })).filter((candidate) => candidate.harness && candidate.model),
      excludedHarnesses: excludedHarnesses.slice(0, 12).map((candidate) => ({
        harness: String(candidate?.harness ?? '').slice(0, 80),
        reason: String(candidate?.reason ?? '').slice(0, 80),
      })).filter((candidate) => candidate.harness),
    };
  }
  return entry;
}

/**
 * @param {unknown} raw
 * @returns {object[]}
 */
function normalizeDecisionLog(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => normalizeWorkspaceWatcherDecision(entry))
    .filter(Boolean)
    .slice(-WORKSPACE_WATCHER_MAX_DECISIONS);
}

/**
 * One record of `activeCycles`. Returns null for an empty/placeholder object so
 * a slot never survives as a phantom claim.
 *
 * @param {unknown} raw
 * @returns {{ cycleId: string, todoIds: string[], startedAt: string, chatId: string, runId: string } | null}
 */
function normalizeActiveCycle(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = /** @type {Record<string, unknown>} */ (raw);
  const todoIds = normalizeStringList(source.todoIds);
  const startedAt = String(source.startedAt ?? '').trim();
  const chatId = String(source.chatId ?? '').trim();
  const runId = String(source.runId ?? '').trim();
  // Durable identity minted *before* the orchestrator chat is created and
  // reused as its start requestId, so a restart replays the same cycle instead
  // of spawning a duplicate.
  const cycleId = String(source.cycleId ?? '').trim();
  const phaseRaw = String(source.phase ?? '').trim().toLowerCase();
  const phase = phaseRaw === 'starting' || phaseRaw === 'running' ? phaseRaw : (runId ? 'running' : '');
  const startDeadlineAt = String(source.startDeadlineAt ?? '').trim();
  const planOnly = source.planOnly === true;
  const reportedOutcomeRaw = String(source.reportedOutcome ?? '').trim().toLowerCase();
  const reportedOutcome = WORKSPACE_WATCHER_CYCLE_OUTCOMES.includes(reportedOutcomeRaw) ? reportedOutcomeRaw : '';
  const reportedAt = String(source.reportedAt ?? '').trim();
  const reportId = String(source.reportId ?? '').trim();
  const roomGoneSinceRaw = String(source.roomGoneSince ?? '').trim();
  const roomGoneSinceMs = Date.parse(roomGoneSinceRaw);
  if (!todoIds.length && !startedAt && !chatId && !cycleId) return null;
  return {
    cycleId,
    todoIds,
    startedAt,
    chatId,
    runId,
    phase: phase || (chatId && !runId ? 'starting' : 'running'),
    startDeadlineAt,
    planOnly,
    reportedOutcome,
    reportedAt,
    reportId,
    harness: String(source.harness ?? '').trim(),
    // First time autopilot reconcile saw the orchestrator room as gone.
    // Absent until that happens; cleared when the room is visible again.
    ...(Number.isFinite(roomGoneSinceMs) ? { roomGoneSince: new Date(roomGoneSinceMs).toISOString() } : {}),
  };
}

/**
 * Structural identity of one normalized cycle record, for callers that patch the
 * list without a durable `cycleId` (v1 writers and hand-edited rows).
 *
 * @param {object | null | undefined} cycle
 * @returns {string}
 */
function activeCycleSlotKey(cycle) {
  const todoIds = (Array.isArray(cycle?.todoIds) ? cycle.todoIds : [])
    .map((id) => String(id ?? '').trim())
    .filter(Boolean)
    .sort();
  const cycleId = String(cycle?.cycleId ?? '').trim();
  if (cycleId) return `id:${cycleId}`;
  return `chat:${String(cycle?.chatId ?? '').trim()}|${String(cycle?.startedAt ?? '').trim()}|${todoIds.join(',')}`;
}

/**
 * @param {object} left
 * @param {object} right
 * @returns {boolean}
 */
function isSameActiveCycleSlot(left, right) {
  return activeCycleSlotKey(left) === activeCycleSlotKey(right);
}

/**
 * @param {unknown[]} raw
 * @returns {object[]}
 */
function normalizeActiveCycleList(raw) {
  /** @type {object[]} */
  const out = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    const cycle = normalizeActiveCycle(entry);
    if (!cycle) continue;
    if (out.some((existing) => isSameActiveCycleSlot(existing, cycle))) continue;
    out.push(cycle);
  }
  return out.slice(0, WORKSPACE_WATCHER_MAX_ACTIVE_CYCLES);
}

/**
 * The row's live cycles, reconciling the two shapes that can arrive here.
 *
 * A v1 file (or a v1-style patch) carries only `activeCycle`: it becomes slot 0,
 * which is the lazy read migration. A v1-style *update* of a slot that already
 * exists in `activeCycles` (same `cycleId`, or same chat/startedAt/todoIds when
 * no id was minted) is applied to that slot, so an older writer still addresses
 * the cycle it means instead of being dropped. An empty list with a non-null
 * `activeCycle` is the same case on a fresh row.
 *
 * @param {Record<string, unknown>} source
 * @returns {object[]}
 */
function reconcileActiveCycles(source) {
  const hasExplicitList = Array.isArray(source.activeCycles);
  const list = normalizeActiveCycleList(source.activeCycles);
  const legacy = normalizeActiveCycle(source.activeCycle);
  if (!legacy) return list;
  const index = list.findIndex((entry) => isSameActiveCycleSlot(entry, legacy));
  if (index === -1) {
    // A v1 payload carries only `activeCycle` — it describes at most one live cycle.
    if (!hasExplicitList) return [legacy];
    return [legacy, ...list].slice(0, WORKSPACE_WATCHER_MAX_ACTIVE_CYCLES);
  }
  const next = list.slice();
  next[index] = legacy;
  return next;
}

/**
 * Expand a v1-style patch (`activeCycle` without `activeCycles`) into an explicit
 * list before merge. A v1 writer replaces the singleton cycle instead of appending.
 *
 * @param {object} row
 * @param {Record<string, unknown>} patch
 * @returns {Record<string, unknown>}
 */
function expandLegacyActiveCyclePatch(row, patch) {
  if (!patch || typeof patch !== 'object' || !('activeCycle' in patch) || 'activeCycles' in patch) {
    return patch;
  }
  const legacy = normalizeActiveCycle(patch.activeCycle);
  if (!legacy) {
    return { ...patch, activeCycles: [] };
  }
  const existing = getWorkspaceWatcherActiveCycles(row);
  const index = existing.findIndex((entry) => isSameActiveCycleSlot(entry, legacy));
  if (index === -1) {
    return { ...patch, activeCycles: [legacy] };
  }
  const next = existing.slice();
  next[index] = legacy;
  return { ...patch, activeCycles: next };
}

/**
 * Fill the v2-only fields of a migrated legacy singleton: it belongs to the
 * general Scout and carries a stable snapshot of that profile, taken at the
 * moment of migration. The five v1 fields are always preserved.
 *
 * @param {object} legacy normalized legacy scan
 * @param {object[]} scoutProfiles normalized profiles of the same row
 * @returns {object}
 */
function buildLegacyActiveScoutScan(legacy, scoutProfiles) {
  const general = (Array.isArray(scoutProfiles) ? scoutProfiles : [])
    .find((profile) => profile.id === SCOUT_GENERAL_PROFILE_ID)
    || defaultWorkspaceScoutProfile();
  // A v1 record that already has a chatId represents a launched/running scan:
  // set launchIssued so reconciliation treats it as an active process rather
  // than a stale reservation that can be refunded on boot.
  const launchIssued = legacy.launchIssued === true || Boolean(String(legacy.chatId ?? '').trim());
  return normalizeActiveScoutScan({
    ...legacy,
    launchIssued,
    scoutId: legacy.scoutId || SCOUT_GENERAL_PROFILE_ID,
    scoutRevision: legacy.scoutRevision || general.revision,
    // A deep copy so the snapshot never aliases the live profile collection.
    snapshot: legacy.snapshot || normalizeWorkspaceScoutProfile(general, { now: 0 }),
  });
}

/**
 * Expand a v1-style patch (`activeScoutScan` without `activeScoutScans`) into an
 * explicit collection before merge. A v1 writer owns the singleton and replaces
 * it, so the translated patch replaces the whole collection; concurrent old and
 * new writers on one store are not a supported combination (v2 writers mutate
 * the collection directly and are therefore untouched by this adapter).
 *
 * @param {object} row
 * @param {Record<string, unknown>} patch
 * @returns {Record<string, unknown>}
 */
function expandLegacyActiveScoutScanPatch(row, patch) {
  if (!patch || typeof patch !== 'object' || !('activeScoutScan' in patch) || 'activeScoutScans' in patch) {
    return patch;
  }
  const legacy = normalizeActiveScoutScan(patch.activeScoutScan);
  if (!legacy.scanId) {
    return { ...patch, activeScoutScans: [] };
  }
  return { ...patch, activeScoutScans: [legacy] };
}

/**
 * Canonical patch for a mutated active-scan collection. It writes ONLY the
 * explicit list: `normalizeWorkspaceWatcherRow` derives the `activeScoutScan`
 * mirror on every write, so no internal call site writes the v1 singleton.
 *
 * @param {object[]} scans
 * @returns {{ activeScoutScans: object[] }}
 */
export function workspaceWatcherActiveScoutScansPatch(scans) {
  return { activeScoutScans: normalizeActiveScoutScans(scans) };
}

/**
 * Canonical dual-write patch: every mutation of the cycle list goes through
 * here so `activeCycle` can never drift from slot 0.
 *
 * @param {object[]} cycles
 * @returns {{ activeCycles: object[], activeCycle: object | null }}
 */
export function workspaceWatcherActiveCyclesPatch(cycles) {
  const list = normalizeActiveCycleList(cycles);
  return { activeCycles: list, activeCycle: list[0] || null };
}

/**
 * The row's live cycles, accepting either shape so callers that work on an
 * unnormalized row (a presence payload, a test fixture) stay correct.
 *
 * @param {object | null | undefined} row
 * @returns {object[]}
 */
export function getWorkspaceWatcherActiveCycles(row) {
  if (Array.isArray(row?.activeCycles) && row.activeCycles.length) {
    return normalizeActiveCycleList(row.activeCycles);
  }
  const legacy = normalizeActiveCycle(row?.activeCycle);
  return legacy ? [legacy] : [];
}

/**
 * @param {object | null | undefined} row
 * @param {{ cycleId?: string, chatId?: string }} matcher
 * @returns {object | null}
 */
export function findWorkspaceWatcherCycle(row, matcher = {}) {
  const cycles = getWorkspaceWatcherActiveCycles(row);
  const cycleId = String(matcher.cycleId ?? '').trim();
  const chatId = String(matcher.chatId ?? '').trim();
  // `cycleId` wins because it is minted before the chat exists; the chat id is
  // unique per cycle too, so a caller that only knows the chat still lands on
  // exactly one slot.
  if (cycleId) return cycles.find((cycle) => cycle.cycleId === cycleId) || null;
  if (chatId) return cycles.find((cycle) => cycle.chatId === chatId) || null;
  return null;
}

/**
 * Locate the slot represented by a cycle object. A v1 row has no `cycleId`, so
 * its structural key (chat + startedAt + todoIds) is the only durable handle,
 * including for a slot that has neither a chat nor an id yet.
 *
 * @param {object | null | undefined} row
 * @param {object | null | undefined} expected
 * @returns {object | null}
 */
export function findWorkspaceWatcherCycleBySlot(row, expected) {
  if (!expected) return null;
  const cycles = getWorkspaceWatcherActiveCycles(row);
  const cycleId = String(expected.cycleId ?? '').trim();
  if (cycleId) return cycles.find((cycle) => cycle.cycleId === cycleId) || null;
  return cycles.find((cycle) => isSameActiveCycleSlot(cycle, expected)) || null;
}

/**
 * @param {object | null | undefined} row
 * @param {{ cycleId?: string, chatId?: string }} matcher
 * @param {object} nextCycle
 * @returns {{ activeCycles: object[], activeCycle: object | null }}
 */
export function replaceWorkspaceWatcherCycle(row, matcher, nextCycle) {
  const cycles = getWorkspaceWatcherActiveCycles(row);
  const current = findWorkspaceWatcherCycle({ activeCycles: cycles }, matcher);
  if (!current) return workspaceWatcherActiveCyclesPatch(cycles);
  return workspaceWatcherActiveCyclesPatch(
    cycles.map((cycle) => (isSameActiveCycleSlot(cycle, current) ? nextCycle : cycle)),
  );
}

/**
 * @param {object | null | undefined} row
 * @param {object} cycle
 * @returns {{ activeCycles: object[], activeCycle: object | null }}
 */
export function appendWorkspaceWatcherCycle(row, cycle) {
  return workspaceWatcherActiveCyclesPatch([...getWorkspaceWatcherActiveCycles(row), cycle]);
}

/**
 * Drop one slot. Matching falls back to the structural slot key because a v1 row
 * has no `cycleId`, and a closed slot must not survive as a phantom claim.
 *
 * @param {object | null | undefined} row
 * @param {object | null | undefined} cycle
 * @returns {{ activeCycles: object[], activeCycle: object | null }}
 */
export function removeWorkspaceWatcherCycle(row, cycle) {
  if (!cycle) return workspaceWatcherActiveCyclesPatch(getWorkspaceWatcherActiveCycles(row));
  const cycles = getWorkspaceWatcherActiveCycles(row)
    .filter((entry) => !isSameActiveCycleSlot(entry, cycle));
  return workspaceWatcherActiveCyclesPatch(cycles);
}

/**
 * Every orchestrator chat id with a live cycle, for snapshot exclusions.
 *
 * @param {object | null | undefined} row
 * @returns {string[]}
 */
export function workspaceWatcherCycleChatIds(row) {
  return getWorkspaceWatcherActiveCycles(row)
    .map((cycle) => String(cycle.chatId || '').trim())
    .filter(Boolean);
}

/**
 * Orchestrator chats whose cycle already closed. A chat that still has a live
 * slot on this row is omitted.
 *
 * @param {object | null | undefined} row
 * @returns {string[]}
 */
export function workspaceWatcherClosedCycleChatIds(row) {
  const live = new Set(workspaceWatcherCycleChatIds(row));
  /** @type {string[]} */
  const ids = [];
  for (const entry of Array.isArray(row?.cycleChats) ? row.cycleChats : []) {
    const id = String(entry?.id || '').trim();
    if (!id || live.has(id) || ids.includes(id)) continue;
    ids.push(id);
  }
  return ids;
}

/**
 * True when `chatId` is a closed-cycle orchestrator and is not a live cycle
 * chat on any watcher row. A store read failure returns false so callers keep
 * the conservative path (deliver the mailbox, count the chat).
 *
 * @param {unknown} chatId
 * @param {{ dataDir?: string }} [options]
 * @returns {boolean}
 */
export function isClosedWorkspaceWatcherCycleChat(chatId, options = {}) {
  const id = String(chatId ?? '').trim();
  if (!id) return false;
  let rows;
  try {
    rows = loadWorkspaceWatchers(options);
  } catch {
    return false;
  }
  let closed = false;
  for (const row of rows) {
    if (workspaceWatcherCycleChatIds(row).includes(id)) return false;
    if (!closed && workspaceWatcherClosedCycleChatIds(row).includes(id)) closed = true;
  }
  return closed;
}

/**
 * Chats allowed to act as this workspace's watcher orchestrator.
 *
 * While at least one cycle is live, ONLY the live cycles' `chatId`s authorize:
 * `orchestratorChatId` is the "last known" mirror, it is not cleared when a slot
 * closes and may point at a replaced/closed cycle, so it must never widen the
 * live owner set. With no live cycle (idle row) the mirror is the only owner,
 * which keeps the v1 operator path for an `observe`/configure call that has no
 * cycle yet, and is the exact behavior the MCP tests pin.
 *
 * @param {object | null | undefined} row
 * @returns {string[]}
 */
export function workspaceWatcherOrchestratorChatIds(row) {
  const cycles = getWorkspaceWatcherActiveCycles(row);
  if (cycles.length > 0) return workspaceWatcherCycleChatIds(row);
  const idle = String(row?.orchestratorChatId ?? '').trim();
  return idle ? [idle] : [];
}

/**
 * Durable cycle reports. One entry per reported cycle, bounded. `deferred` means
 * the report arrived while a child delegation was still live, so the cycle was
 * not closed yet (the claim stays with the child) and reconcile closes it later
 * using this outcome.
 *
 * @param {unknown} raw
 * @returns {Array<{ reportId: string, cycleId: string, chatId: string, outcome: string, todoIds: string[], at: string, deferred: boolean, message: string }>}
 */
function normalizeReports(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {Array<{ reportId: string, cycleId: string, chatId: string, outcome: string, todoIds: string[], at: string, deferred: boolean, message: string }>} */
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const source = /** @type {Record<string, unknown>} */ (item);
    const reportId = String(source.reportId ?? '').trim();
    if (!reportId) continue;
    const outcomeRaw = String(source.outcome ?? '').trim().toLowerCase();
    out.push({
      reportId,
      cycleId: String(source.cycleId ?? '').trim(),
      chatId: String(source.chatId ?? '').trim(),
      outcome: WORKSPACE_WATCHER_CYCLE_OUTCOMES.includes(outcomeRaw) ? outcomeRaw : 'failure',
      todoIds: normalizeStringList(source.todoIds),
      at: String(source.at ?? '').trim(),
      deferred: source.deferred === true,
      message: String(source.message ?? '').trim().slice(0, 500),
    });
  }
  return out.slice(-WORKSPACE_WATCHER_MAX_REPORTS);
}

/**
 * Previous orchestrator chats (one per closed cycle), bounded. Used to link a
 * fresh short-lived orchestrator to the history it must not redo.
 *
 * `startedAt` is the moment the cycle was reserved (mirrored from the live
 * `activeCycles` slot at close); `at` stays the close time. A legacy entry has an
 * empty `startedAt`, which the dashboard renders as "no duration" instead of a
 * zero-length bar, so the Gantt stays honest across old rows.
 *
 * @param {unknown} raw
 * @returns {Array<{ id: string, cycleId: string, todoIds: string[], startedAt: string, at: string, outcome: string }>}
 */
function normalizeCycleChats(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {Array<{ id: string, cycleId: string, todoIds: string[], startedAt: string, at: string, outcome: string }>} */
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const source = /** @type {Record<string, unknown>} */ (item);
    const id = String(source.id ?? '').trim();
    if (!id) continue;
    const outcomeRaw = String(source.outcome ?? '').trim().toLowerCase();
    out.push({
      id,
      cycleId: String(source.cycleId ?? '').trim(),
      todoIds: normalizeStringList(source.todoIds),
      startedAt: String(source.startedAt ?? '').trim(),
      at: String(source.at ?? '').trim(),
      outcome: WORKSPACE_WATCHER_CYCLE_OUTCOMES.includes(outcomeRaw) ? outcomeRaw : '',
      harness: String(source.harness ?? '').trim(),
    });
  }
  return out.slice(-WORKSPACE_WATCHER_MAX_CYCLE_CHATS);
}

/**
 * @param {unknown} raw
 * @returns {Record<string, number>}
 */
function normalizeFailures(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  /** @type {Record<string, number>} */
  const out = {};
  for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (raw))) {
    const todoId = String(key ?? '').trim();
    const count = normalizeCount(value, 0);
    if (todoId && count > 0) out[todoId] = count;
  }
  return out;
}

/**
 * Per-UTC-day cycle budget. `day` is `YYYY-MM-DD`. Normalization preserves the
 * stored value verbatim; the guardrail decides staleness (a `day` that is not
 * today counts as 0) so the reset stays deterministic under an injected clock.
 *
 * @param {unknown} raw
 * @returns {{ day: string, count: number }}
 */
function normalizeCycles(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { day: '', count: 0 };
  const source = /** @type {Record<string, unknown>} */ (raw);
  return {
    day: String(source.day ?? '').trim(),
    count: normalizeCount(source.count, 0),
  };
}

/**
 * Per-todo rolling "same findings" guard (hash + consecutive streak).
 *
 * @param {unknown} raw
 * @returns {{ byTodo: Record<string, { hash: string, streak: number }> }}
 */
function normalizeFindings(raw) {
  /** @type {Record<string, { hash: string, streak: number, summary?: string }>} */
  const byTodo = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { byTodo };
  const source = /** @type {Record<string, unknown>} */ (raw);
  const nested = source.byTodo;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (nested))) {
      const todoId = String(key ?? '').trim();
      if (!todoId || !value || typeof value !== 'object' || Array.isArray(value)) continue;
      const row = /** @type {Record<string, unknown>} */ (value);
      const hash = String(row.hash ?? '').trim();
      const streak = normalizeCount(row.streak, 0);
      if (!hash || streak <= 0) continue;
      const summary = String(row.summary ?? '').trim().slice(0, 2000);
      byTodo[todoId] = summary ? { hash, streak, summary } : { hash, streak };
    }
    return { byTodo };
  }
  return { byTodo };
}

/**
 * Todos for which a plan-only cycle has already been requested. This is the
 * anti-loop memory of the plan gate: without it every tick would spawn another
 * plan cycle for the same unapproved todo. Cleared when the plan is approved
 * (or explicitly by an operator).
 *
 * @param {unknown} raw
 * @returns {Record<string, string>}
 */
function normalizePlanRequests(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (raw))) {
    const todoId = String(key ?? '').trim();
    const at = String(value ?? '').trim();
    if (todoId && at) out[todoId] = at;
  }
  return out;
}

/**
 * Notification dedupe memory. One entry per fixed channel holding an opaque
 * signature of the last state we pushed for it; the tick sends only when the
 * current signature differs, so a state that persists across many ticks is
 * announced once and a later change announces again. The channel set is closed
 * on purpose, so the map never grows with the todo count.
 */
export const WORKSPACE_WATCHER_NOTIFY_CHANNELS = Object.freeze(['stopped', 'plan_approval', 'blocked']);

/**
 * @param {unknown} raw
 * @returns {Record<string, string>}
 */
function normalizeNotified(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  /** @type {Record<string, string>} */
  const out = {};
  for (const channel of WORKSPACE_WATCHER_NOTIFY_CHANNELS) {
    const signature = String(/** @type {Record<string, unknown>} */ (raw)[channel] ?? '').trim();
    if (signature) out[channel] = signature.slice(0, 200);
  }
  return out;
}

/**
 * @param {unknown} raw
 * @returns {Record<string, { signature: string, count: number, escalatedSignature: string }>}
 */
function normalizeUnknownTodoEscalations(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  /** @type {Record<string, { signature: string, count: number, escalatedSignature: string }>} */
  const out = {};
  for (const [todoId, value] of Object.entries(/** @type {Record<string, unknown>} */ (raw))) {
    const id = String(todoId ?? '').trim();
    if (!id || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = /** @type {Record<string, unknown>} */ (value);
    out[id] = {
      signature: String(row.signature ?? '').trim().slice(0, 200),
      count: Math.max(0, normalizeCount(row.count, 0)),
      escalatedSignature: String(row.escalatedSignature ?? '').trim().slice(0, 200),
    };
  }
  return out;
}

/**
 * @param {unknown} raw
 * @returns {object | null}
 */
export function normalizeWorkspaceWatcherRow(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = /** @type {Record<string, unknown>} */ (raw);
  const workspaceFolder = normalizeWorkspaceFolder(source.workspaceFolder);
  if (!workspaceFolder) return null;
  const rawMode = String(source.mode ?? '').trim().toLowerCase();
  const mode = WORKSPACE_WATCHER_MODES.includes(rawMode)
    ? rawMode
    : rawMode
      ? 'off'
      : source.enabled === true
        ? 'observe'
        : 'off';
  const activeCycles = reconcileActiveCycles(source);
  // Scout profiles are additive to the legacy `policy.scout*` fields: a v1 row
  // without a `scoutProfiles` key materializes exactly one general profile, and
  // once the key exists (even as []) it is never synthesized again, so a
  // read/normalize/write cycle cannot duplicate it.
  let scoutProfiles;
  if (source.scoutProfiles !== undefined) {
    scoutProfiles = normalizeWorkspaceScoutProfilesList(source.scoutProfiles);
  } else if (hasLegacyScoutPolicy(source.policy)) {
    scoutProfiles = [buildLegacyWorkspaceScoutProfile(source, source.policy)];
  } else {
    scoutProfiles = [];
  }
  // Active Scout scans are additive the same way. A v1 row without an
  // `activeScoutScans` key migrates its singleton into the collection exactly
  // once; once the key exists (even as []) it is never synthesized again, so a
  // read/normalize/write cycle cannot duplicate the record.
  let activeScoutScans = normalizeActiveScoutScans(source.activeScoutScans);
  if (source.activeScoutScans === undefined) {
    const legacyScan = normalizeActiveScoutScan(source.activeScoutScan);
    if (legacyScan.scanId) {
      activeScoutScans = [buildLegacyActiveScoutScan(legacyScan, scoutProfiles)];
    }
  }
  // Durable decision history, distinct from the pending mailbox. Terminal
  // findings stored by an older server still sit in `pendingScoutFindings`; the
  // split below migrates them out exactly once so a normalized read never counts
  // a resolved proposal against the 200-slot pending capacity.
  const normalizedPending = normalizeWorkspaceScoutFindings(source.pendingScoutFindings);
  const pendingScoutFindings = normalizedPending.filter((finding) => finding.status === 'pending');
  // Derive the tombstone index from the RAW decisions (before the 500-entry
  // detail cap) so a legacy row that already overflowed migrates every key, not
  // only the newest 500. The stored index is kept first; fresh decisions
  // override it on dedupe-key collision.
  const rawDecisionFindings = [
    ...(Array.isArray(source.scoutFindingDecisions) ? source.scoutFindingDecisions : []),
    ...normalizedPending.filter((finding) => finding.status !== 'pending'),
  ];
  const scoutFindingDecisions = normalizeWorkspaceScoutFindingDecisions(rawDecisionFindings);
  const scoutFindingDecisionIndex = normalizeWorkspaceScoutDecisionIndex([
    ...(Array.isArray(source.scoutFindingDecisionIndex) ? source.scoutFindingDecisionIndex : []),
    ...rawDecisionFindings,
  ]);
  return {
    workspaceFolder,
    mode,
    enabled: mode !== 'off',
    orchestratorChatId: String(source.orchestratorChatId ?? '').trim(),
    // Durable "pinned workspace chat" id. Empty means "not materialized yet";
    // `ensurePinnedChat` creates and stores it. It survives mode changes so a
    // chat recreated after a manual delete is recovered, not duplicated.
    pinnedChatId: String(source.pinnedChatId ?? '').trim(),
    lease: normalizeWorkspaceWatcherLease(source.lease),
    lastTickAt: String(source.lastTickAt ?? '').trim(),
    lastCycleAt: String(source.lastCycleAt ?? '').trim(),
    cycleCount: normalizeCount(source.cycleCount, 0),
    cycles: normalizeCycles(source.cycles),
    backoffUntil: String(source.backoffUntil ?? '').trim(),
    // Episode flag for the observe "idle, there is work" push: set once per
    // idle-with-work episode and cleared when the episode ends, so the notify
    // dedupe is durable across ticks and restarts instead of in-memory.
    idleNotifiedAt: String(source.idleNotifiedAt ?? '').trim(),
    activeCycles,
    // v1 downgrade mirror. An older server only knows `activeCycle`; reading
    // slot 0 keeps it from declaring a busy workspace idle and starting a
    // duplicate cycle. Never read back inside this module — `activeCycles` is
    // the source of truth.
    activeCycle: activeCycles[0] || null,
    policy: normalizeWorkspaceWatcherPolicy(source.policy),
    // Global pause: halts decision-making without touching failures, backoff,
    // findings, plan requests or the live cycles, so resuming continues exactly
    // where the workspace left off. Independent of `stopReason`, which is the
    // operator/loop stop that still reconciles an in-flight cycle.
    paused: source.paused === true,
    stopReason: String(source.stopReason ?? '').trim(),
    failures: normalizeFailures(source.failures),
    findings: normalizeFindings(source.findings),
    planRequests: normalizePlanRequests(source.planRequests),
    // Dedupe memory for the stopped / plan-approval / blocked pushes; see
    // `normalizeNotified`. Empty means "nothing announced for that channel".
    notified: normalizeNotified(source.notified),
    unknownTodoEscalations: normalizeUnknownTodoEscalations(source.unknownTodoEscalations),
    reports: normalizeReports(source.reports),
    cycleChats: normalizeCycleChats(source.cycleChats),
    decisions: normalizeDecisionLog(source.decisions),
    // Scout state lives on the same row but never in `activeCycles`/`cycles`:
    // a scan is not a watcher cycle, so it must not consume `maxParallel` or the
    // per-day cycle budget. `lastScoutAt` + `scoutScans` are its own schedule.
    lastScoutAt: String(source.lastScoutAt ?? '').trim(),
    scoutScans: normalizeWorkspaceScoutScans(source.scoutScans),
    activeScoutScans,
    // v1 downgrade mirror, same convention as `activeCycle`: an older client
    // only knows the singleton, so it keeps reading the first collection entry.
    // Never read back inside this module — `activeScoutScans` is the source of
    // truth and every internal writer publishes the collection directly.
    activeScoutScan: activeScoutScans[0] || normalizeActiveScoutScan(null),
    // Per-profile runtime schedule (lastRunAt/nextRunAt + UTC-day counter). Kept
    // separate from the versioned `scoutProfiles` so a tick never edits config.
    scoutSchedules: normalizeWorkspaceScoutSchedules(source.scoutSchedules),
    scoutScanHistory: normalizeWorkspaceScoutScanHistory(source.scoutScanHistory),
    scoutProfiles,
    pendingScoutFindings,
    scoutFindingDecisions,
    scoutFindingDecisionIndex,
    updatedAt: String(source.updatedAt ?? '').trim(),
  };
}

/**
 * @param {{ dataDir?: string }} [options]
 * @returns {string}
 */
function dataFilePath(options = {}) {
  const configured = String(options.dataDir ?? '').trim();
  const dir = configured || resolveDataPath();
  return path.join(dir, 'workspace-watchers.json');
}

/**
 * @param {{ dataDir?: string }} [options]
 * @returns {string}
 */
export function getWorkspaceWatchersDataPath(options = {}) {
  return dataFilePath(options);
}

/**
 * @param {string} filePath
 * @returns {void}
 */
function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Re-entrant per-document cross-process mutex.
 *
 * The revision check and the write must not interleave with another process,
 * otherwise two writers can both accept the same revision and the loser
 * silently drops the winner's rows (lost update over the whole map).
 *
 * The mutex is SQLite's write lock. A dedicated database in the data dir is
 * opened only to run `BEGIN IMMEDIATE` ... `COMMIT` around the critical
 * section: BEGIN IMMEDIATE takes the RESERVED lock on that file and keeps it
 * until the transaction ends, so exactly one process is inside at a time and a
 * second one is refused with SQLITE_BUSY. That lock is an OS record lock on an
 * open file descriptor, so a holder that crashes or is killed loses it in the
 * kernel and the next acquirer rolls back the journal by itself. There is no
 * stale-lock detector, no grace period and no owner token to re-check, because
 * nothing here ever removes lock state: a lock kept in a file has to be
 * deleted to be recovered, and in the window between reading an owner token
 * and unlinking it the lock can already belong to a fresh owner.
 *
 * The document CAS check runs inside the same critical section as a second
 * line of defence against a nested mutation in this process.
 */

/** @type {Map<string, DatabaseSync>} */
const watcherLockDbs = new Map();

/** @type {Map<string, number>} */
const heldWatcherLocks = new Map();

/**
 * Optional observer for the (non-fatal) COMMIT/ROLLBACK fallback in the lock
 * release path. Tests inject it to prove a release under contention neither
 * throws nor loses the lock. `null` in production keeps the release silent.
 * @type {((detail: { lockDbPath: string, message: string }) => void) | null}
 */
let workspaceWatchersReleaseFailureHook = null;

/**
 * @param {(detail: { lockDbPath: string, message: string }) => void | null} hook
 * @returns {void}
 */
export function setWorkspaceWatchersReleaseFailureHook(hook) {
  workspaceWatchersReleaseFailureHook = typeof hook === 'function' ? hook : null;
}

/**
 * @param {string} documentPath
 * @returns {string}
 */
function watcherLockDbPath(documentPath) {
  return path.join(path.dirname(documentPath), WORKSPACE_WATCHERS_LOCK_DB_NAME);
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeWatcherLockError(error) {
  return error instanceof Error ? error.message : String(error ?? 'unknown error');
}

/**
 * SQLITE_BUSY (5) is the "someone else is inside" answer; `code` is
 * ERR_SQLITE_ERROR for every SQLite failure, so the errcode decides.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isWatcherLockBusyError(error) {
  if (!error || typeof error !== 'object') return false;
  const source = /** @type {{ errcode?: unknown, message?: unknown }} */ (error);
  if (Number(source.errcode) === WORKSPACE_WATCHERS_LOCK_BUSY_ERRCODE) return true;
  return /database is locked/i.test(String(source.message ?? ''));
}

/**
 * Open the lock database once per path. SQLite's own busy handler is switched
 * off because this call owns the waiting: the deadline is `lockTimeoutMs`.
 *
 * @param {string} lockDbPath
 * @returns {DatabaseSync}
 */
function openWatcherLockDb(lockDbPath) {
  const cached = watcherLockDbs.get(lockDbPath);
  if (cached) return cached;
  ensureDir(lockDbPath);
  let database = null;
  try {
    database = new DatabaseSync(lockDbPath);
    database.exec('PRAGMA busy_timeout = 0;');
  } catch (error) {
    if (database) {
      try {
        database.close();
      } catch {
        // The connection is already unusable.
      }
    }
    throw new WorkspaceWatchersLockError(
      `Could not open the workspace watcher store lock (${lockDbPath}: ${describeWatcherLockError(error)})`,
    );
  }
  watcherLockDbs.set(lockDbPath, database);
  return database;
}

/**
 * Forget a connection we can no longer reason about. Closing it returns the
 * file descriptor to the OS, which drops the write lock along with it.
 *
 * @param {string} lockDbPath
 * @returns {void}
 */
function dropWatcherLockDb(lockDbPath) {
  const database = watcherLockDbs.get(lockDbPath);
  watcherLockDbs.delete(lockDbPath);
  if (!database) return;
  try {
    database.close();
  } catch {
    // Already closed; the lock left with the descriptor.
  }
}

/**
 * @param {number} ms
 * @returns {void}
 */
function sleepWatcherLock(ms) {
  if (!(ms > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Begin the transaction that *is* the lock and hand back the release callback.
 * Waiting is this call's job: another process inside the critical section is
 * answered with SQLITE_BUSY, never with a stolen lock.
 *
 * @param {DatabaseSync} database
 * @param {string} lockDbPath
 * @param {{ lockTimeoutMs?: number }} options
 * @returns {() => void}
 */
function acquireWatcherLock(database, lockDbPath, options) {
  const configuredTimeout = Number(options.lockTimeoutMs);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout >= 0
    ? configuredTimeout
    : WORKSPACE_WATCHERS_LOCK_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let backoff = WORKSPACE_WATCHERS_LOCK_BACKOFF_MIN_MS;
  for (;;) {
    try {
      database.exec('BEGIN IMMEDIATE');
      break;
    } catch (error) {
      if (!isWatcherLockBusyError(error)) {
        dropWatcherLockDb(lockDbPath);
        throw new WorkspaceWatchersLockError(
          `Could not acquire the workspace watcher store lock (${lockDbPath}: ${describeWatcherLockError(error)})`,
        );
      }
      if (Date.now() >= deadline) {
        throw new WorkspaceWatchersLockError(
          `Timed out waiting for the workspace watcher store lock (${lockDbPath}).`,
        );
      }
      sleepWatcherLock(backoff);
      backoff = Math.min(WORKSPACE_WATCHERS_LOCK_BACKOFF_MAX_MS, Math.round(backoff * 1.6));
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // The document rename already happened inside the critical section, so this
    // COMMIT only ends the transaction that *is* the lock. A COMMIT can still
    // answer SQLITE_BUSY when a reader holds a shared lock at the instant the
    // RESERVED lock is handed back. Retry briefly, then fall back to ROLLBACK:
    // the lock database is intentionally empty, so rolling back ends the
    // transaction and releases the write lock with no data at risk. Exclusivity
    // is not lost either way — no other writer can enter until this transaction
    // ends, and every path here ends it. If both fail the connection is
    // unusable, so close it: the kernel drops the OS record lock with the fd.
    let lastError = null;
    for (let attempt = 0; attempt < WORKSPACE_WATCHERS_LOCK_COMMIT_RETRIES; attempt += 1) {
      try {
        database.exec('COMMIT');
        return;
      } catch (error) {
        lastError = error;
        if (!isWatcherLockBusyError(error)) break;
        sleepWatcherLock(WORKSPACE_WATCHERS_LOCK_BACKOFF_MIN_MS * (attempt + 1));
      }
    }
    try {
      database.exec('ROLLBACK');
      return;
    } catch (error) {
      if (!isWatcherLockBusyError(error)) lastError = error;
    }
    // Neither COMMIT nor ROLLBACK cleared the transaction. Returning the fd to
    // the OS is the only guaranteed release, and it drops the lock with it.
    dropWatcherLockDb(lockDbPath);
    // A commit/rollback failure here never means the document write failed —
    // that already completed atomically. Surface it as a lock warning in the
    // event log rather than throwing, so a successful mutation is not reported
    // as an error and the caller's critical-section bookkeeping stays balanced.
    logWorkspaceWatchersLockReleaseFailure(lockDbPath, lastError);
  };
}

/**
 * Best-effort, non-fatal record of a lock-release fallback. Kept internal and
 * guarded so the release path can never throw from logging itself.
 *
 * @param {string} lockDbPath
 * @param {unknown} error
 * @returns {void}
 */
function logWorkspaceWatchersLockReleaseFailure(lockDbPath, error) {
  // No-op sink by default; tests may observe via `onWorkspaceWatchersLockReleaseFailure`.
  const hook = workspaceWatchersReleaseFailureHook;
  if (!hook) return;
  try {
    hook({ lockDbPath, message: describeWatcherLockError(error) });
  } catch {
    // Logging must never break the release path.
  }
}

/**
 * Run `work` while holding the cross-process lock of the watcher document.
 * Re-entrant inside one process so a mutator may nest another store mutation.
 *
 * @template T
 * @param {() => T} work
 * @param {{ dataDir?: string, lockTimeoutMs?: number }} [options]
 * @returns {T}
 */
export function withWorkspaceWatchersFileLock(work, options = {}) {
  const filePath = dataFilePath(options);
  const held = heldWatcherLocks.get(filePath);
  if (held != null) {
    heldWatcherLocks.set(filePath, held + 1);
    try {
      return work();
    } finally {
      const next = (heldWatcherLocks.get(filePath) || 1) - 1;
      if (next > 0) heldWatcherLocks.set(filePath, next);
      else heldWatcherLocks.delete(filePath);
    }
  }
  const lockDbPath = watcherLockDbPath(filePath);
  const release = acquireWatcherLock(openWatcherLockDb(lockDbPath), lockDbPath, options);
  heldWatcherLocks.set(filePath, 1);
  try {
    return work();
  } finally {
    heldWatcherLocks.delete(filePath);
    release();
  }
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function normalizeDocumentRevision(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return 0;
  return n;
}

/**
 * @param {{ updatedAt?: string, revision?: number }} doc
 * @returns {{ updatedAt: string, revision: number }}
 */
export function workspaceWatchersDocumentCasToken(doc) {
  return {
    updatedAt: String(doc?.updatedAt ?? '').trim(),
    revision: normalizeDocumentRevision(doc?.revision),
  };
}

/**
 * @returns {{ v: number, updatedAt: string, revision: number, items: Record<string, object> }}
 */
function emptyDocument() {
  return { v: WORKSPACE_WATCHERS_SCHEMA_VERSION, updatedAt: '', revision: 0, items: {} };
}

/**
 * The map key of a damaged file is untrusted input, so control characters are
 * flattened and the text is length-capped before it reaches an error message.
 *
 * @param {string} key
 * @returns {string}
 */
function describeWatcherItemKey(key) {
  const raw = String(key ?? '');
  let flat = '';
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    flat += code < 0x20 || code === 0x7f ? ' ' : raw[i];
  }
  return flat.length > 120 ? `${flat.slice(0, 117)}...` : flat;
}

/**
 * Every record of the stored document must be representable: a row that will
 * not normalize is reported instead of being skipped, because the next save
 * would write the loaded rows back and drop the unreadable one silently.
 *
 * @param {{ dataDir?: string }} [options]
 * @returns {{ v: number, updatedAt: string, revision: number, items: Record<string, object> }}
 */
export function loadWorkspaceWatchersDocument(options = {}) {
  const filePath = dataFilePath(options);
  ensureDir(filePath);
  if (!fs.existsSync(filePath)) return emptyDocument();
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new WorkspaceWatchersCorruptError(
      `Could not read workspace watcher store (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new WorkspaceWatchersCorruptError(
      `Workspace watcher file is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WorkspaceWatchersCorruptError('Workspace watcher file is not an object');
  }
  const rawItems = /** @type {Record<string, unknown>} */ (parsed).items;
  if (rawItems != null && (typeof rawItems !== 'object' || Array.isArray(rawItems))) {
    throw new WorkspaceWatchersCorruptError('Workspace watcher items must be an object keyed by workspace folder');
  }
  /** @type {Record<string, object>} */
  const items = {};
  /** @type {string[]} */
  const unusable = [];
  for (const [key, value] of Object.entries(rawItems || {})) {
    const record = value && typeof value === 'object' && !Array.isArray(value)
      ? /** @type {Record<string, unknown>} */ (value)
      : null;
    const row = record
      ? normalizeWorkspaceWatcherRow({ ...record, workspaceFolder: record.workspaceFolder || key })
      : null;
    if (!row) {
      unusable.push(record
        ? `"${describeWatcherItemKey(key)}" has no usable workspace folder`
        : `"${describeWatcherItemKey(key)}" is ${value === null ? 'null' : `a ${typeof value}`}, not a row`);
      continue;
    }
    if (items[row.workspaceFolder]) {
      throw new WorkspaceWatchersCorruptError(
        `Workspace watcher file has two records for "${row.workspaceFolder}" under different keys; loading one would drop the other`,
      );
    }
    items[row.workspaceFolder] = row;
  }
  if (unusable.length > 0) {
    throw new WorkspaceWatchersCorruptError(
      `Workspace watcher file has ${unusable.length} record(s) that are not watcher rows `
      + `(${unusable.slice(0, 3).join(', ')}); refusing to rewrite it over the next save`,
    );
  }
  return {
    v: WORKSPACE_WATCHERS_SCHEMA_VERSION,
    updatedAt: String(parsed.updatedAt ?? '').trim(),
    revision: normalizeDocumentRevision(parsed.revision),
    items,
  };
}

/**
 * @param {{ dataDir?: string }} [options]
 * @returns {object[]}
 */
export function loadWorkspaceWatchers(options = {}) {
  const doc = loadWorkspaceWatchersDocument(options);
  return Object.keys(doc.items)
    .sort()
    .map((key) => doc.items[key]);
}

/**
 * @param {unknown} workspaceFolder
 * @param {{ dataDir?: string }} [options]
 * @returns {object | null}
 */
export function getWorkspaceWatcher(workspaceFolder, options = {}) {
  const key = normalizeWorkspaceFolder(workspaceFolder);
  if (!key) return null;
  return loadWorkspaceWatchersDocument(options).items[key] || null;
}

/**
 * Read the Scout profiles of one workspace. This is a pure read: a workspace
 * with no row, or with an empty stored collection, gets the deterministic
 * virtual general profile and nothing is written to disk.
 *
 * @param {unknown} workspaceFolder
 * @param {{ dataDir?: string }} [options]
 * @returns {object[]}
 */
export function listWorkspaceScoutProfiles(workspaceFolder, options = {}) {
  const key = normalizeWorkspaceFolder(workspaceFolder);
  if (!key) return [defaultWorkspaceScoutProfile()];
  const row = getWorkspaceWatcher(key, options);
  const profiles = Array.isArray(row?.scoutProfiles) ? row.scoutProfiles : [];
  if (profiles.length === 0) return [defaultWorkspaceScoutProfile()];
  return [...profiles].sort(compareWorkspaceScoutProfiles);
}

/**
 * Read one Scout profile by id, or null. The virtual general profile is
 * reachable on an empty workspace; it is never mixed into a non-empty list.
 *
 * @param {unknown} workspaceFolder
 * @param {unknown} scoutId
 * @param {{ dataDir?: string }} [options]
 * @returns {object | null}
 */
export function getWorkspaceScoutProfile(workspaceFolder, scoutId, options = {}) {
  const id = String(scoutId ?? '').trim();
  if (!id) return null;
  return listWorkspaceScoutProfiles(workspaceFolder, options).find((profile) => profile.id === id) || null;
}

/**
 * Create or update one Scout profile under the document-wide CAS lock, so two
 * concurrent writers cannot lose each other's changes.
 *
 * New profile: `revision` starts at 1. Existing profile: the caller must pass
 * `options.expectedRevision` equal to the stored `revision`, or the write fails
 * with `reason: 'revision_conflict'`. Every accepted write bumps `revision` and
 * stamps `updatedAt`. A profile that does not validate fails with
 * `reason: 'invalid'` and readable `errors`.
 *
 * @param {unknown} workspaceFolder
 * @param {object} profile
 * @param {{ dataDir?: string, expectedRevision?: number, maxAttempts?: number, lockTimeoutMs?: number }} [options]
 * @returns {{ ok: boolean, profile?: object, reason?: string, errors?: string[] }}
 */
export function upsertWorkspaceScoutProfile(workspaceFolder, profile, options = {}) {
  const key = normalizeWorkspaceFolder(workspaceFolder);
  if (!key) {
    return { ok: false, reason: 'invalid_workspace', errors: ['workspaceFolder jest wymagany'] };
  }
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    return { ok: false, reason: 'invalid', errors: ['profil musi być obiektem'] };
  }
  const input = /** @type {Record<string, unknown>} */ (profile);
  const requestedId = String(input.id ?? '').trim();
  // `id`, `revision` and the timestamps are server-owned: a payload must never
  // force them, especially not to bypass the revision CAS.
  const mutableInput = { ...input };
  for (const field of ['id', 'revision', 'createdAt', 'updatedAt']) delete mutableInput[field];
  /** @type {{ ok: boolean, reason?: string, errors?: string[] } | null} */
  let failure = null;
  let savedId = '';

  const result = mutateWorkspaceWatcherRow(key, ({ row }) => {
    const profiles = Array.isArray(row.scoutProfiles) ? row.scoutProfiles : [];
    const index = requestedId ? profiles.findIndex((candidate) => candidate.id === requestedId) : -1;
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    // Undefined keys never erase a stored value during a partial update.
    const applyInput = (base) => {
      const merged = { ...base };
      for (const [field, value] of Object.entries(mutableInput)) {
        if (value !== undefined) merged[field] = value;
      }
      return merged;
    };

    if (index === -1) {
      const expected = Number(options.expectedRevision);
      if (Number.isInteger(expected) && options.materializeVirtual !== true) {
        failure = {
          ok: false,
          reason: 'revision_conflict',
          errors: [`oczekiwano revision (stored profile), otrzymano ${String(options.expectedRevision ?? '')}`],
        };
        return false;
      }
      const initialRevision = options.materializeVirtual === true && Number.isInteger(expected)
        ? expected + 1
        : 1;
      const raw = applyInput({
        id: requestedId || undefined,
        revision: initialRevision,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      const validation = validateWorkspaceScoutProfile(raw, {
        profileCount: profiles.length,
        isUpdate: false,
      });
      if (!validation.ok) {
        failure = { ok: false, reason: 'invalid', errors: validation.errors };
        return false;
      }
      const candidate = normalizeWorkspaceScoutProfile(raw, { now });
      if (profiles.some((existing) => existing.id === candidate.id)) {
        failure = { ok: false, reason: 'invalid', errors: ['profil o tym id już istnieje'] };
        return false;
      }
      savedId = candidate.id;
      return { scoutProfiles: [...profiles, candidate] };
    }

    const current = profiles[index];
    const expected = Number(options.expectedRevision);
    if (!Number.isInteger(expected) || expected !== current.revision) {
      failure = {
        ok: false,
        reason: 'revision_conflict',
        errors: [`oczekiwano revision ${current.revision}, otrzymano ${String(options.expectedRevision ?? '')}`],
      };
      return false;
    }
    const raw = applyInput({
      ...current,
      id: current.id,
      revision: current.revision + 1,
      createdAt: current.createdAt,
      updatedAt: nowIso,
    });
    const validation = validateWorkspaceScoutProfile(raw, {
      profileCount: profiles.length,
      isUpdate: true,
    });
    if (!validation.ok) {
      failure = { ok: false, reason: 'invalid', errors: validation.errors };
      return false;
    }
    const candidate = normalizeWorkspaceScoutProfile(raw, { now });
    savedId = candidate.id;
    const next = [...profiles];
    next[index] = candidate;
    return { scoutProfiles: next };
  }, options);

  if (failure) return failure;
  if (!result.ok || !result.row) {
    return { ok: false, reason: result.reason || 'cas_conflict' };
  }
  const saved = (result.row.scoutProfiles || []).find((candidate) => candidate.id === savedId) || null;
  return { ok: true, profile: saved };
}

/**
 * Revision check plus write under the cross-process lock. The lock makes the
 * check meaningful: without it another process can pass the same check and
 * rename its own document over this one between the read and the write.
 *
 * @param {{ updatedAt: string, revision: number }} expectedCas
 * @param {{ v: number, updatedAt: string, revision: number, items: Record<string, object> }} nextDoc
 * @param {{ dataDir?: string, lockTimeoutMs?: number }} [options]
 * @returns {boolean}
 */
function compareAndSaveWorkspaceWatchersDocument(expectedCas, nextDoc, options = {}) {
  return withWorkspaceWatchersFileLock(() => {
    const filePath = dataFilePath(options);
    ensureDir(filePath);
    const expectedUpdatedAt = String(expectedCas.updatedAt || '').trim();
    const expectedRevision = normalizeDocumentRevision(expectedCas.revision);
    if (fs.existsSync(filePath)) {
      let onDiskUpdatedAt = '';
      let onDiskRevision = 0;
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        onDiskUpdatedAt = String(parsed?.updatedAt ?? '').trim();
        onDiskRevision = normalizeDocumentRevision(parsed?.revision);
      } catch {
        return false;
      }
      if (onDiskRevision !== expectedRevision) return false;
      if (onDiskUpdatedAt !== expectedUpdatedAt) return false;
    } else if (expectedUpdatedAt || expectedRevision > 0) {
      return false;
    }
    writeJsonAtomic(filePath, {
      v: WORKSPACE_WATCHERS_SCHEMA_VERSION,
      updatedAt: nextDoc.updatedAt,
      revision: normalizeDocumentRevision(nextDoc.revision),
      items: nextDoc.items,
    });
    return true;
  }, options);
}

/**
 * Document-level CAS for map-wide changes (for example remove). The whole
 * read-modify-write runs under the cross-process lock so a concurrent row
 * mutation cannot drop or resurrect a map entry.
 *
 * @param {(doc: { v: number, updatedAt: string, revision: number, items: Record<string, object> }) => { items: Record<string, object> } | null | false} mutator
 * @param {{ dataDir?: string, maxAttempts?: number, lockTimeoutMs?: number }} [options]
 * @returns {{ ok: boolean, doc?: object, reason?: string }}
 */
export function mutateWorkspaceWatchersDocument(mutator, options = {}) {
  const maxAttempts = Math.max(1, Number(options.maxAttempts) || WATCHER_DOCUMENT_CAS_MAX_ATTEMPTS);
  return withWorkspaceWatchersFileLock(() => {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const doc = loadWorkspaceWatchersDocument(options);
      const expectedCas = workspaceWatchersDocumentCasToken(doc);
      const patch = mutator(doc);
      if (patch === null) return { ok: false, reason: 'aborted' };
      if (patch === false) return { ok: false, reason: 'skipped' };
      const nextDoc = {
        v: WORKSPACE_WATCHERS_SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
        revision: expectedCas.revision + 1,
        items: patch.items,
      };
      if (!compareAndSaveWorkspaceWatchersDocument(expectedCas, nextDoc, options)) continue;
      return { ok: true, doc: nextDoc };
    }
    return { ok: false, reason: 'cas_conflict' };
  }, options);
}

/**
 * Read-modify-write one row with document-level CAS so parallel processes cannot
 * clobber the whole map or steal an active lease slot. The load, the mutator and
 * the write all run under the cross-process lock, so a competing process never
 * observes a half-updated document and a CAS conflict can only come from a
 * nested same-process mutation.
 *
 * @param {unknown} workspaceFolder
 * @param {(ctx: { row: object, docUpdatedAt: string, docRevision: number }) => object | null | false} mutator
 * @param {{ dataDir?: string, maxAttempts?: number, lockTimeoutMs?: number, createIfMissing?: boolean }} [options]
 * @returns {{ ok: boolean, row?: object, reason?: string }}
 */
export function mutateWorkspaceWatcherRow(workspaceFolder, mutator, options = {}) {
  const key = normalizeWorkspaceFolder(workspaceFolder);
  if (!key) throw new WorkspaceWatchersCorruptError('workspaceFolder is required');
  const maxAttempts = Math.max(1, Number(options.maxAttempts) || WATCHER_DOCUMENT_CAS_MAX_ATTEMPTS);
  // Default keeps the upsert semantics every caller relies on. The autopilot
  // tick passes `createIfMissing: false` so a row removed between the caller's
  // pre-read and this lock never gets resurrected by a late tick.
  const createIfMissing = options.createIfMissing !== false;
  return withWorkspaceWatchersFileLock(() => {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const doc = loadWorkspaceWatchersDocument(options);
      const expectedCas = workspaceWatchersDocumentCasToken(doc);
      const current = doc.items[key]
        || (createIfMissing ? normalizeWorkspaceWatcherRow({ workspaceFolder: key }) : null);
      if (!current) return { ok: false, reason: 'no_row' };
      const patch = mutator({ row: current, docUpdatedAt: expectedCas.updatedAt, docRevision: expectedCas.revision });
      if (patch === null) return { ok: false, reason: 'aborted' };
      if (patch === false) return { ok: false, reason: 'skipped' };
      // A v1-style partial patch that still writes the `activeScoutScan`
      // singleton is translated before merge; internal writers patch
      // `activeScoutScans` directly. Same adapter as the legacy cycle patch.
      const expandedPatch = expandLegacyActiveScoutScanPatch(current, patch);
      const merged = normalizeWorkspaceWatcherRow({
        ...current,
        ...expandedPatch,
        workspaceFolder: key,
        updatedAt: new Date().toISOString(),
      });
      if (!merged) return { ok: false, reason: 'invalid_row' };
      const nextDoc = {
        v: WORKSPACE_WATCHERS_SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
        revision: expectedCas.revision + 1,
        items: { ...doc.items, [key]: merged },
      };
      if (!compareAndSaveWorkspaceWatchersDocument(expectedCas, nextDoc, options)) continue;
      return { ok: true, row: merged };
    }
    return { ok: false, reason: 'cas_conflict' };
  }, options);
}

/**
 * Merge a patch into the row for one workspace, creating the row (mode off)
 * when it does not exist yet.
 *
 * @param {unknown} workspaceFolder
 * @param {object} [patch]
 * @param {{ dataDir?: string }} [options]
 * @returns {object}
 */
export function upsertWorkspaceWatcher(workspaceFolder, patch = {}, options = {}) {
  const key = normalizeWorkspaceFolder(workspaceFolder || patch?.workspaceFolder);
  if (!key) throw new WorkspaceWatchersCorruptError('workspaceFolder is required');
  const nextPatch = { ...patch };
  if (nextPatch.mode == null && typeof nextPatch.enabled === 'boolean') {
    nextPatch.mode = nextPatch.enabled ? 'observe' : 'off';
  }
  const result = mutateWorkspaceWatcherRow(key, ({ row }) => {
    const expanded = expandLegacyActiveScoutScanPatch(
      row,
      expandLegacyActiveCyclePatch(row, nextPatch),
    );
    const merged = normalizeWorkspaceWatcherRow({
      ...row,
      ...expanded,
      workspaceFolder: key,
    });
    if (!merged) return false;
    return merged;
  }, options);
  if (!result.ok || !result.row) {
    throw new WorkspaceWatchersCorruptError(String(result.reason || 'cas_conflict'));
  }
  return result.row;
}

/**
 * Append one decision-log entry (bounded). Returns the updated row, or null
 * when no watcher row exists for the workspace.
 *
 * @param {unknown} workspaceFolder
 * @param {object} decision
 * @param {{ dataDir?: string }} [options]
 * @returns {object | null}
 */
export function appendWorkspaceWatcherDecision(workspaceFolder, decision, options = {}) {
  const key = normalizeWorkspaceFolder(workspaceFolder);
  if (!key) return null;
  if (!getWorkspaceWatcher(key, options)) return null;
  const entry = normalizeWorkspaceWatcherDecision(decision);
  if (!entry) return getWorkspaceWatcher(key, options);
  const result = mutateWorkspaceWatcherRow(key, ({ row }) => ({
    decisions: [...row.decisions, entry].slice(-WORKSPACE_WATCHER_MAX_DECISIONS),
  }), options);
  if (!result.ok || !result.row) return null;
  return result.row;
}

/**
 * @param {unknown} workspaceFolder
 * @param {{ dataDir?: string }} [options]
 * @returns {boolean}
 */
export function removeWorkspaceWatcher(workspaceFolder, options = {}) {
  const key = normalizeWorkspaceFolder(workspaceFolder);
  if (!key) return false;
  const result = mutateWorkspaceWatchersDocument((doc) => {
    if (!doc.items[key]) return false;
    const items = { ...doc.items };
    delete items[key];
    return { items };
  }, options);
  return result.ok === true;
}
