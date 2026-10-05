/**
 * Durable per-workspace watcher state for the Workspace Watcher (stage A).
 *
 * `data/workspace-watchers.json` shape:
 *   { v: 1, updatedAt, revision, items: { "<normalizedWorkspaceFolder>": row } }
 *
 * The map is keyed by the normalized workspace folder so a lookup never scans
 * rows. Stage A ticks only in `observe`. `off` and stored `autopilot` are inert
 * until a later stage enables autonomous cycles.
 *
 * Each row carries the singleton lease, policy, bounded decision log and the
 * future-cycle fields so later stages can grow into the same file without a
 * migration.
 *
 * Cycles live in `activeCycles` (up to `policy.maxParallel`, hard-capped by
 * `WORKSPACE_WATCHER_MAX_ACTIVE_CYCLES`). `activeCycle` is kept as a mirror of
 * slot 0 so an older server reading the file never mistakes a busy workspace for
 * an idle one; reads accept either shape, so a v1 file migrates lazily.
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

export const WORKSPACE_WATCHERS_SCHEMA_VERSION = 1;
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
export const WORKSPACE_WATCHER_MAX_ACTIVE_CYCLES = 5;
export const WORKSPACE_WATCHER_MAX_PARALLEL = 5;
export const WORKSPACE_WATCHER_PICK_ROLES = Object.freeze(['plan', 'implement', 'review']);
/**
 * Scout discovery categories. The set is closed so the prompt, the parser, the
 * policy allow-list and the UI never drift into different literals.
 */
export const WORKSPACE_SCOUT_CATEGORIES = Object.freeze([
  'bug',
  'improvement',
  'security',
  'opportunity',
  'documentation',
]);
/** Lifecycle of a Scout proposal: the user resolves pending → accepted/rejected. */
export const WORKSPACE_SCOUT_FINDING_STATUSES = Object.freeze(['pending', 'accepted', 'rejected']);
/** Bounded so a misbehaving scan can never grow the watcher row without limit. */
export const WORKSPACE_WATCHER_MAX_PENDING_SCOUT_FINDINGS = 200;
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
    files,
    status,
    createdAt: at,
    updatedAt: serverOwned ? at : updatedAt,
    dedupeKey: workspaceScoutFindingDedupeKey({ title, category }),
  };
  if (!serverOwned) {
    const sourceRef = source.source;
    if (sourceRef && typeof sourceRef === 'object' && !Array.isArray(sourceRef)) {
      const ref = /** @type {Record<string, unknown>} */ (sourceRef);
      const scanner = String(ref.scanner ?? '').trim();
      const chatId = String(ref.chatId ?? '').trim();
      const runId = String(ref.runId ?? '').trim();
      if (scanner || chatId || runId) finding.source = { scanner, chatId, runId };
    }
    const todoId = String(source.todoId ?? '').trim();
    if (todoId) finding.todoId = todoId;
  }
  return finding;
}

/**
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
  return out.slice(-WORKSPACE_WATCHER_MAX_PENDING_SCOUT_FINDINGS);
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
 * @param {unknown} raw
 * @returns {{ scanId: string, chatId: string, startedAt: string, expiresAt: string, submitToken: string }}
 */
export function normalizeActiveScoutScan(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? /** @type {Record<string, unknown>} */ (raw)
    : {};
  return {
    scanId: String(source.scanId ?? '').trim(),
    chatId: String(source.chatId ?? '').trim(),
    startedAt: String(source.startedAt ?? '').trim(),
    expiresAt: String(source.expiresAt ?? '').trim(),
    submitToken: String(source.submitToken ?? '').trim(),
  };
}

/**
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
 * @returns {{ at: string, kind: string, reason: string, readyTodoCount: number, activeAgentCount: number, shouldNotify: boolean, nextTodoId: string, unknownAgentCount?: number, unknownChats?: Array<{ chatId: string, reason: string }>, slotHolders?: string[] } | null}
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
  /** @type {{ at: string, kind: string, reason: string, readyTodoCount: number, activeAgentCount: number, shouldNotify: boolean, nextTodoId: string, unknownAgentCount?: number, unknownChats?: Array<{ chatId: string, reason: string }>, slotChats?: Array<{ chatId: string, cycleId: string }>, slotHolders?: string[] }} */
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
    reports: normalizeReports(source.reports),
    cycleChats: normalizeCycleChats(source.cycleChats),
    decisions: normalizeDecisionLog(source.decisions),
    // Scout state lives on the same row but never in `activeCycles`/`cycles`:
    // a scan is not a watcher cycle, so it must not consume `maxParallel` or the
    // per-day cycle budget. `lastScoutAt` + `scoutScans` are its own schedule.
    lastScoutAt: String(source.lastScoutAt ?? '').trim(),
    scoutScans: normalizeWorkspaceScoutScans(source.scoutScans),
    activeScoutScan: normalizeActiveScoutScan(source.activeScoutScan),
    pendingScoutFindings: normalizeWorkspaceScoutFindings(source.pendingScoutFindings),
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
      const merged = normalizeWorkspaceWatcherRow({
        ...current,
        ...patch,
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
    const expanded = expandLegacyActiveCyclePatch(row, nextPatch);
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
