import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeJsonAtomic } from './atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';
import { workspaceMemoryKey } from './workspace-memory-persist.js';
import { withWorkspaceWatchersFileLock } from './workspace-watchers-persist.js';
import { containsPrivateData } from '../review-lessons-privacy.js';

export class ReviewLessonsError extends Error {
  constructor(message, code = 'VALIDATION') { super(message); this.name = 'ReviewLessonsError'; this.code = code; }
}
export const REVIEW_LESSON_AUDIENCES = Object.freeze(['implementer', 'reviewer', 'planner']);
export const REVIEW_LESSON_KINDS = Object.freeze(['do', 'avoid', 'suppress']);
export const REVIEW_LESSON_STATUSES = Object.freeze(['candidate', 'active', 'retired']);
export const REVIEW_LESSON_ORIGINS = Object.freeze(['manual', 'distilled', 'backfill']);

export function getReviewLessonsDataPath(workspaceFolder, options = {}) {
  const key = workspaceMemoryKey(workspaceFolder);
  if (!key) throw new ReviewLessonsError('workspaceFolder is required');
  return path.join(options.dataDir || resolveDataPath(), 'review-lessons', `${key}.json`);
}

function readDocument(folder, options = {}) {
  const file = getReviewLessonsDataPath(folder, options);
  if (!fs.existsSync(file)) return { v: 1, workspaceFolder: path.resolve(folder), revision: 0, updatedAt: '', lessons: [] };
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { throw new ReviewLessonsError(`Review lessons file is unreadable: ${err.message}`, 'CORRUPT'); }
  if (!doc || !Array.isArray(doc.lessons)) throw new ReviewLessonsError('Review lessons document has no lessons array', 'CORRUPT');
  return doc;
}

/** Writable lesson fields; stats, evidence, origin and timestamps are store-owned. */
const PATCHABLE_KEYS = Object.freeze(['audience', 'kind', 'text', 'category', 'pathGlobs', 'appliesToModels', 'checkable', 'checkHint', 'status', 'retiredReason', 'supersededByTodoId']);
const PATCH_KEY_ALIASES = Object.freeze({ path_globs: 'pathGlobs', applies_to_models: 'appliesToModels', retired_reason: 'retiredReason', superseded_by_todo_id: 'supersededByTodoId', check_hint: 'checkHint' });

/**
 * Reduce a caller patch to writable, defined, camelCase fields. This is the
 * only place snake_case transport keys are mapped, so REST and in-process
 * callers behave identically.
 */
export function sanitizeLessonPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new ReviewLessonsError('patch must be an object');
  const out = {};
  for (const [rawKey, value] of Object.entries(patch)) {
    const key = PATCH_KEY_ALIASES[rawKey] || rawKey;
    if (value === undefined || !PATCHABLE_KEYS.includes(key)) continue;
    out[key] = value;
  }
  return out;
}

function normalizeEvidence(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new ReviewLessonsError('evidence must be an array');
  return raw.map((ref) => ({ ledgerKey: String(ref?.ledgerKey ?? ''), leafId: String(ref?.leafId ?? ''), outcome: String(ref?.outcome ?? ''), actor: String(ref?.actor ?? '') }));
}

function normalizeInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ReviewLessonsError('lesson must be an object');
  const row = raw;
  if (!REVIEW_LESSON_AUDIENCES.includes(row.audience)) throw new ReviewLessonsError(`audience must be one of: ${REVIEW_LESSON_AUDIENCES.join(', ')}`);
  if (!REVIEW_LESSON_KINDS.includes(row.kind)) throw new ReviewLessonsError(`kind must be one of: ${REVIEW_LESSON_KINDS.join(', ')}`);
  const text = String(row.text ?? '').trim();
  if (!text || text.length > 300) throw new ReviewLessonsError('text is required and must be at most 300 characters');
  if (/[\r\n]/.test(text)) throw new ReviewLessonsError('text must be one imperative rule');
  if (containsPrivateData(text)) throw new ReviewLessonsError('text must not contain private paths or LAN IP addresses');
  const pathGlobs = Array.isArray(row.pathGlobs) ? row.pathGlobs.map((x) => String(x).trim()).filter(Boolean) : [];
  if (pathGlobs.some(containsPrivateData)) throw new ReviewLessonsError('pathGlobs must not contain private paths or LAN IP addresses');
  const category = String(row.category ?? '').trim().toLowerCase();
  if (!category) throw new ReviewLessonsError('category is required');
  if (containsPrivateData(row.checkHint)) throw new ReviewLessonsError('checkHint must not contain private paths or LAN IP addresses');
  const status = row.status || 'candidate';
  if (!REVIEW_LESSON_STATUSES.includes(status)) throw new ReviewLessonsError(`status must be one of: ${REVIEW_LESSON_STATUSES.join(', ')}`);
  const normalized = {
    audience: row.audience, kind: row.kind, text, category,
    pathGlobs,
    appliesToModels: Array.isArray(row.appliesToModels) ? row.appliesToModels.map(String) : [],
    checkable: row.checkable === true, checkHint: String(row.checkHint || ''), status, origin: row.origin || 'manual',
  };
  if (!REVIEW_LESSON_ORIGINS.includes(normalized.origin)) throw new ReviewLessonsError(`origin must be one of: ${REVIEW_LESSON_ORIGINS.join(', ')}`);
  if (row.retiredReason != null) normalized.retiredReason = String(row.retiredReason);
  if (row.supersededByTodoId != null) normalized.supersededByTodoId = String(row.supersededByTodoId);
  return normalized;
}

function mutate(folder, fn, options = {}) {
  const file = getReviewLessonsDataPath(folder, options);
  return withWorkspaceWatchersFileLock(() => {
    const doc = readDocument(folder, options);
    const next = fn(doc);
    if (next === null) return null;
    const saved = { ...doc, v: 1, workspaceFolder: path.resolve(folder), revision: Number(doc.revision || 0) + 1, updatedAt: new Date().toISOString(), lessons: next };
    writeJsonAtomic(file, saved);
    return saved;
  }, options);
}

export function listReviewLessons(folder, options = {}) { return readDocument(folder, options).lessons; }
export function addReviewLesson(folder, input, options = {}) {
  const normalized = normalizeInput(input);
  const now = new Date().toISOString();
  let result;
  mutate(folder, (doc) => {
    const normText = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
    const duplicate = doc.lessons.find((x) => normText(x.text) === normText(normalized.text) && x.category === normalized.category);
    if (duplicate) { result = duplicate; return doc.lessons; }
    const evidence = normalizeEvidence(input.evidence);
    result = { ...normalized, id: randomUUID(), evidence, createdAt: now, updatedAt: now, lastEvidenceAt: evidence.length ? now : '', stats: { injected: 0, recurred: 0, cleanAfterInjection: 0 }, revision: 1 };
    return [...doc.lessons, result];
  }, options);
  return result;
}
export function updateReviewLesson(folder, id, patch, expectedRevision, options = {}) {
  let result;
  const safePatch = sanitizeLessonPatch(patch);
  mutate(folder, (current) => {
    const row = current.lessons.find((x) => x.id === id);
    if (!row) throw new ReviewLessonsError('Lesson not found', 'NOT_FOUND');
    if (Number(row.revision) !== Number(expectedRevision)) throw new ReviewLessonsError('Lesson revision conflict', 'CONFLICT');
    const merged = normalizeInput({ ...row, ...safePatch });
    const now = new Date().toISOString();
    result = { ...row, ...merged, id: row.id, createdAt: row.createdAt, updatedAt: now, revision: row.revision + 1 };
    // Keep the status reason in step with a manual status change (retired keeps its reason).
    if (merged.status !== row.status || merged.status === 'retired') {
      result.statusReason = merged.status === 'retired' ? String(merged.retiredReason || '') : '';
      if (merged.status !== row.status) result.statusChangedAt = now;
    }
    return current.lessons.map((x) => x.id === id ? result : x);
  }, options);
  return result;
}
export function deleteReviewLesson(folder, id, options = {}) {
  let removed = null;
  mutate(folder, (doc) => { removed = doc.lessons.find((x) => x.id === id) || null; return removed ? doc.lessons.filter((x) => x.id !== id) : null; }, options);
  return { deleted: !!removed, lesson: removed };
}

/** Applied-round keys kept for replay protection of the feedback transaction. */
const APPLIED_KEYS_MAX = 1000;
const STAT_KEYS = Object.freeze(['injected', 'recurred', 'cleanAfterInjection']);

/**
 * Internal feedback transaction (effectiveness counters and automatic status
 * transitions). It is the only writer of `stats`, `lastInjectedAt`,
 * `statusReason` and automatic status changes; plain lesson patches cannot
 * reach them. Everything runs under the store lock against the freshest rows,
 * so deltas are applied relative to the current revision (no lost updates) and
 * a repeated `dedupeKey` is a no-op.
 *
 * `plan(lessons)` returns updates `{ id, stats?: {injected,recurred,cleanAfterInjection deltas},
 * lastInjectedAt?, status?, statusReason?, retiredReason? }`. A status update
 * is honoured only for `active -> candidate` and `active|candidate -> retired`;
 * a retired lesson never changes again.
 *
 * @returns {{ applied: boolean, replayed: boolean, changes: { before: object, after: object }[] }}
 */
export function applyReviewLessonsFeedback(folder, dedupeKey, plan, options = {}) {
  const key = String(dedupeKey || '').trim();
  const changes = [];
  let replayed = false;
  mutate(folder, (doc) => {
    const applied = Array.isArray(doc.appliedFeedbackKeys) ? doc.appliedFeedbackKeys : [];
    if (key && applied.includes(key)) { replayed = true; return null; }
    const updates = plan(doc.lessons) || [];
    const now = new Date().toISOString();
    const byId = new Map(updates.map((u) => [u.id, u]));
    const lessons = doc.lessons.map((row) => {
      const u = byId.get(row.id);
      if (!u || row.status === 'retired') return row;
      const next = { ...row, stats: { ...row.stats } };
      for (const stat of STAT_KEYS) next.stats[stat] = Number(next.stats[stat] || 0) + Math.max(0, Math.trunc(Number(u.stats?.[stat]) || 0));
      if (u.lastInjectedAt) next.lastInjectedAt = u.lastInjectedAt;
      const allowed = (row.status === 'active' && (u.status === 'candidate' || u.status === 'retired')) || (row.status === 'candidate' && u.status === 'retired');
      if (allowed) {
        next.status = u.status;
        next.statusReason = String(u.statusReason || '');
        next.statusChangedAt = now;
        if (u.status === 'retired') next.retiredReason = String(u.retiredReason || u.statusReason || '');
      }
      next.updatedAt = now;
      next.revision = Number(row.revision || 0) + 1;
      changes.push({ before: row, after: next });
      return next;
    });
    doc.appliedFeedbackKeys = key ? [...applied, key].slice(-APPLIED_KEYS_MAX) : applied;
    return lessons;
  }, options);
  return { applied: !replayed, replayed, changes };
}
