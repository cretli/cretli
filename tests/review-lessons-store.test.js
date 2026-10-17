import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addReviewLesson, deleteReviewLesson, getReviewLessonsDataPath, listReviewLessons, updateReviewLesson } from '../lib/persist/review-lessons-persist.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-lessons-'));
const ws = path.join(root, 'workspace');
const dataDir = path.join(root, 'data');
fs.mkdirSync(ws); fs.mkdirSync(dataDir);
const input = { audience: 'implementer', kind: 'do', text: 'Add a regression test for each bug fix.', category: 'missing-test' };

test('lesson store adds, lists, deduplicates, updates with CAS, deletes, and reloads', () => {
  const first = addReviewLesson(ws, input, { dataDir });
  assert.equal(listReviewLessons(ws, { dataDir }).length, 1);
  const duplicate = addReviewLesson(ws, { ...input, text: '  Add a regression test   for each bug fix. ' }, { dataDir });
  assert.equal(duplicate.id, first.id);
  assert.throws(() => updateReviewLesson(ws, first.id, { text: 'Update callers together.' }, 0, { dataDir }), { code: 'CONFLICT' });
  const updated = updateReviewLesson(ws, first.id, { status: 'active' }, first.revision, { dataDir });
  assert.equal(updated.status, 'active');
  assert.equal(listReviewLessons(ws, { dataDir })[0].revision, 2);
  assert.equal(deleteReviewLesson(ws, first.id, { dataDir }).deleted, true);
  addReviewLesson(ws, input, { dataDir });
  assert.equal(listReviewLessons(ws, { dataDir }).length, 1);
});

test('update whitelists patch keys and keeps unset fields', () => {
  const row = addReviewLesson(ws, { ...input, text: 'Whitelist patch keys.', pathGlobs: ['a/**'], appliesToModels: ['m'] }, { dataDir });
  const next = updateReviewLesson(ws, row.id, { status: 'active', pathGlobs: undefined, path_globs: undefined, stats: { injected: 5 }, evidence: [{ ledgerKey: 'x' }], origin: 'backfill', revision: 50 }, row.revision, { dataDir });
  assert.deepEqual(next.pathGlobs, ['a/**']);
  assert.deepEqual(next.appliesToModels, ['m']);
  assert.equal(next.stats.injected, 0);
  assert.deepEqual(next.evidence, []);
  assert.equal(next.origin, 'manual');
  assert.equal(next.revision, row.revision + 1);
  assert.throws(() => updateReviewLesson(ws, row.id, { status: 'bogus' }, next.revision, { dataDir }), { code: 'VALIDATION' });
  const mapped = updateReviewLesson(ws, row.id, { path_globs: ['b/**'], retired_reason: 'done' }, next.revision, { dataDir });
  assert.deepEqual(mapped.pathGlobs, ['b/**']);
  assert.equal(mapped.retiredReason, 'done');
  assert.equal('path_globs' in mapped, false);
});

test('corrupt lesson file is reported and preserved for recovery', () => {
  const file = getReviewLessonsDataPath(ws, { dataDir });
  fs.writeFileSync(file, '{broken');
  assert.throws(() => listReviewLessons(ws, { dataDir }), { code: 'CORRUPT' });
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  fs.rmSync(file);
});

// FU-D: patch normalisation touches only the fields the patch names, so a legacy
// row (invalid category, malformed appliesToModels) is still retirable, while an
// explicitly invalid patch value is refused.
test('a legacy row is retirable and an invalid patch value still fails', () => {
  const file = getReviewLessonsDataPath(ws, { dataDir });
  fs.writeFileSync(file, JSON.stringify({
    v: 1, workspaceFolder: ws, revision: 0, updatedAt: '',
    lessons: [{
      id: 'legacy-row', audience: 'reviewer', kind: 'do', text: 'Legacy row stored before the guard.',
      category: 'legacy-category', appliesToModels: 'broken', pathGlobs: [], status: 'candidate',
      evidence: [], revision: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }],
  }));
  const retired = updateReviewLesson(ws, 'legacy-row', { status: 'retired', retired_reason: 'obsolete' }, 1, { dataDir });
  assert.equal(retired.status, 'retired');
  assert.equal(retired.retiredReason, 'obsolete');
  assert.equal(listReviewLessons(ws, { dataDir }).find((row) => row.id === 'legacy-row').status, 'retired');
  assert.throws(() => updateReviewLesson(ws, 'legacy-row', { appliesToModels: 'broken' }, retired.revision, { dataDir }), { code: 'VALIDATION' });
  assert.throws(() => updateReviewLesson(ws, 'legacy-row', { retiredReason: 7 }, retired.revision, { dataDir }), { code: 'VALIDATION' });
  assert.throws(() => addReviewLesson(ws, { ...input, text: 'Model list.', appliesToModels: 'm1' }, { dataDir }), { code: 'VALIDATION' });
  assert.throws(() => addReviewLesson(ws, { ...input, text: 'Reason type.', retiredReason: 7 }, { dataDir }), { code: 'VALIDATION' });
});
