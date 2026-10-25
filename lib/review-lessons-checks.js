/**
 * Review lessons -> deterministic checks.
 *
 * - `assertNotCommittedRuleDuplicate`: activation guard. A lesson whose text is
 *   already stated by a committed rule (`CLAUDE.md`, `.cursor/rules/*.mdc` of the
 *   lesson's own workspace) is refused with a hint to strengthen that rule.
 * - `proposeLessonCheck`: turns a `checkable` lesson into exactly one `idea`
 *   todo (idempotency key derived from the lesson id). It never writes a check.
 *
 * Every text written to a todo goes through the privacy module.
 */

import fs from 'node:fs';
import path from 'node:path';
import { addTodo, getTodoById, loadTodosData } from './persist/todos-persist.js';
import { getReviewFindingsLedger } from './persist/review-findings-ledger-persist.js';
import { listReviewLessons, ReviewLessonsError } from './persist/review-lessons-persist.js';
import { redactPrivatePaths } from './review-lessons-privacy.js';

const RULE_FILE_MAX_BYTES = 512 * 1024;
/** Shorter needles would match unrelated prose. */
const MIN_NEEDLE_CHARS = 24;
const TITLE_MAX = 80;
const EVIDENCE_SUMMARY_MAX = 200;
const MAX_EVIDENCE_LINES = 5;

/** @param {unknown} value @returns {string} lowercase letters/digits separated by single spaces */
export function normalizeRuleText(value) {
  return String(value ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * Committed rule files of a workspace, as workspace-relative paths. `ruleFiles`
 * overrides the defaults (test fixtures); every candidate is still confined to
 * the workspace folder.
 *
 * @param {string} root resolved workspace folder
 * @param {string[] | undefined} ruleFiles
 * @returns {string[]}
 */
function listRuleFiles(root, ruleFiles) {
  if (Array.isArray(ruleFiles)) return ruleFiles.map(String);
  const out = ['CLAUDE.md'];
  try {
    for (const name of fs.readdirSync(path.join(root, '.cursor', 'rules')).sort()) {
      if (name.endsWith('.mdc')) out.push(`.cursor/rules/${name}`);
    }
  } catch {
    // No rules directory: only CLAUDE.md is considered.
  }
  return out;
}

/** @returns {string | null} file text, or null when missing, oversized or outside the workspace */
function readRuleFile(/** @type {any} */ root, /** @type {any} */ rel) {
  try {
    const full = fs.realpathSync(path.resolve(root, rel));
    const realRoot = fs.realpathSync(root);
    if (full !== realRoot && !full.startsWith(realRoot + path.sep)) return null;
    const stat = fs.statSync(full);
    if (!stat.isFile() || stat.size > RULE_FILE_MAX_BYTES) return null;
    return fs.readFileSync(full, 'utf8');
  } catch {
    return null;
  }
}

/**
 * @param {string} workspaceFolder
 * @param {string} text lesson text
 * @param {{ ruleFiles?: string[] }} [options] `ruleFiles`: workspace-relative override (tests)
 * @returns {{ file: string } | null} the committed rule file that already says it
 */
export function findCommittedRuleDuplicate(workspaceFolder, text, options = {}) {
  const needle = normalizeRuleText(text);
  const folder = String(workspaceFolder || '').trim();
  if (needle.length < MIN_NEEDLE_CHARS || !folder) return null;
  const root = path.resolve(folder);
  for (const rel of listRuleFiles(root, options.ruleFiles)) {
    const content = readRuleFile(root, rel);
    if (content && normalizeRuleText(content).includes(needle)) return { file: rel.replace(/\\/g, '/') };
  }
  return null;
}

/**
 * @throws {ReviewLessonsError} code DUPLICATE_RULE when a committed rule already states the text
 */
export function assertNotCommittedRuleDuplicate(/** @type {any} */ workspaceFolder, /** @type {any} */ text, options = {}) {
  const hit = findCommittedRuleDuplicate(workspaceFolder, text, options);
  if (!hit) return;
  throw new ReviewLessonsError(`Lesson duplicates a committed rule in ${hit.file}; strengthen that rule instead of activating a lesson`, 'DUPLICATE_RULE');
}

function evidenceLines(/** @type {any} */ workspaceFolder, /** @type {any} */ lesson) {
  const lines = [];
  for (const ref of Array.isArray(lesson.evidence) ? lesson.evidence : []) {
    if (lines.length >= MAX_EVIDENCE_LINES) break;
    let summary = '';
    try {
      const row = /** @type {any} */ (getReviewFindingsLedger(workspaceFolder, ref.leafId))?.entries?.find((/** @type {any} */ entry) => entry.key === ref.ledgerKey);
      summary = String(row?.summary || '').slice(0, EVIDENCE_SUMMARY_MAX);
    } catch {
      // A damaged ledger only drops the summary; the key stays.
    }
    lines.push(`- ${ref.ledgerKey} (${ref.outcome || 'n/a'})${summary ? `: ${summary}` : ''}`);
  }
  return lines;
}

/** @returns {string} deterministic todo body (replays must hash identically) */
function buildCheckTodoBody(/** @type {any} */ workspaceFolder, /** @type {any} */ lesson) {
  const globs = (lesson.pathGlobs || []).join(', ');
  const evidence = evidenceLines(workspaceFolder, lesson);
  const parts = [
    '## Outcome',
    `Replace review lesson \`${lesson.id}\` with a deterministic check so reviewers no longer need to catch it by hand.`,
    '',
    '## Lesson',
    lesson.text,
    '',
    `Category: ${lesson.category}${globs ? `\nPath globs: ${globs}` : ''}${lesson.checkHint ? `\nCheck hint: ${lesson.checkHint}` : ''}`,
    '',
    '## Evidence',
    ...(evidence.length ? evidence : ['- none recorded']),
    '',
    '## Suggested implementation',
    'Pick the cheapest deterministic option: a lint rule, a focused test, or a test registered in the review-verify catalog.',
    'This todo only proposes the check; implement it as a normal leaf.',
    '',
    '## When done',
    `Retire the lesson with lesson_update (retired_reason: superseded_by_check, superseded_by_todo_id: <this todo id>).`,
  ];
  return redactPrivatePaths(parts.join('\n'));
}

/**
 * Create the single `idea` todo proposing a deterministic check for a lesson.
 * A repeated call returns the same todo (`created: false`).
 *
 * @param {string} workspaceFolder
 * @param {string} lessonId
 * @param {{ dataDir?: string, createdByChatId?: string }} [options]
 * @returns {{ todo: Record<string, any>, created: boolean }}
 */
export function proposeLessonCheck(workspaceFolder, lessonId, options = {}) {
  const lesson = listReviewLessons(workspaceFolder, options).find((/** @type {any} */ row) => row.id === lessonId);
  if (!lesson) throw new ReviewLessonsError('Lesson not found', 'NOT_FOUND');
  if (lesson.checkable !== true) throw new ReviewLessonsError('Only lessons marked checkable can propose a check');
  if (lesson.status === 'retired') throw new ReviewLessonsError('Retired lessons cannot propose a check');
  const idempotencyKey = `lesson-check-${lesson.id}`;
  let data;
  try {
    data = addTodo(/** @type {any} */ (options.dataDir), workspaceFolder, {
      title: redactPrivatePaths(`Deterministic check for review lesson: ${lesson.text.slice(0, TITLE_MAX)}`),
      body: buildCheckTodoBody(workspaceFolder, lesson),
      status: 'idea',
      strictStatus: true,
      idempotencyKey,
      createdByChatId: options.createdByChatId || undefined,
    });
  } catch (err) {
    if (/** @type {any} */ (err)?.code !== 'CONFLICT') throw err;
    // The lesson changed after the first proposal: the key still identifies the one todo.
    const prior = /** @type {any} */ (loadTodosData(/** @type {any} */ (options.dataDir), workspaceFolder)).idempotency?.[/** @type {any} */ (idempotencyKey)];
    const existing = prior ? getTodoById(/** @type {any} */ (options.dataDir), workspaceFolder, /** @type {any} */ (prior).todoId) : null;
    if (!existing) throw new ReviewLessonsError('A check was already proposed for this lesson with different content', 'CONFLICT');
    return { todo: existing, created: false };
  }
  return { todo: data.item, created: data.replayed !== true };
}
