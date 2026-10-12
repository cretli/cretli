/**
 * Leaf size classification for implement model picks.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyLeafSize,
  LEAF_SIZE_LARGE,
  LEAF_SIZE_SMALL,
  listExistingFilePathsInLeafBody,
  loadLeafSizeConfig,
} from '../lib/model-pick-leaf-size.js';
import {
  blockTodoForNoNonFlashCandidate,
  collectFlashFavoriteModelIds,
  mergeExcludeModelIds,
  TODO_BLOCKED_REASON_NO_NON_FLASH_CANDIDATE,
} from '../lib/model-pick-leaf-implement.js';
import {
  evaluateModelPickHardGates,
  MODEL_PICK_HARD_GATE_CODES,
} from '../lib/model-pick-hard-gates.js';
import { addTodo, getTodoById } from '../lib/persist/todos-persist.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('classifyLeafSize: small stage with at most three files and no keywords', () => {
  const body = [
    'Touch only:',
    '- `lib/a.js`',
    '- lib/b.js',
    '- app_front/c.js',
  ].join('\n');
  assert.equal(classifyLeafSize(body), LEAF_SIZE_SMALL);
  assert.equal(listExistingFilePathsInLeafBody(body).length, 3);
});

test('classifyLeafSize: large when more than three files', () => {
  const body = [
    'Files:',
    'lib/one.js',
    'lib/two.js',
    'lib/three.js',
    'lib/four.js',
  ].join('\n');
  assert.equal(classifyLeafSize(body), LEAF_SIZE_LARGE);
});

test('classifyLeafSize: large when keyword present', () => {
  const body = 'Update lib/x.js only. Scope includes kontrakt API routes.';
  assert.equal(classifyLeafSize(body), LEAF_SIZE_LARGE);
});

test('classifyLeafSize: no file list means large', () => {
  assert.equal(classifyLeafSize('Refactor behavior without listing paths.'), LEAF_SIZE_LARGE);
  assert.equal(listExistingFilePathsInLeafBody('No paths here.').length, 0);
});

test('loadLeafSizeConfig respects env overrides', () => {
  const config = loadLeafSizeConfig({
    env: {
      CRETLI_LEAF_SIZE_MAX_FILES: '2',
      CRETLI_LEAF_SIZE_LARGE_KEYWORDS: 'alpha|beta',
    },
  });
  assert.equal(config.maxFiles, 2);
  assert.deepEqual(config.largeKeywords, ['alpha', 'beta']);
  const body = 'lib/a.js\nlib/b.js\nlib/c.js';
  assert.equal(classifyLeafSize(body, { maxFiles: 2, largeKeywords: ['alpha', 'beta'] }), LEAF_SIZE_LARGE);
});

test('collectFlashFavoriteModelIds gathers flash favorites only', () => {
  const ids = collectFlashFavoriteModelIds({
    qwen: { items: [{ id: 'qwen3.8-flash' }, { id: 'qwen3-max' }] },
    mock: { items: [{ id: 'gemini-2.5-flash' }] },
  });
  assert.ok(ids.includes('qwen3.8-flash'));
  assert.ok(ids.includes('gemini-2.5-flash'));
  assert.ok(!ids.includes('qwen3-max'));
});

test('mergeExcludeModelIds deduplicates case-insensitively', () => {
  assert.deepEqual(
    mergeExcludeModelIds(['A-Flash'], ['a-flash', 'other']),
    ['A-Flash', 'other'],
  );
});

test('flash implement on large leaf requires pick_reason override', () => {
  const refused = evaluateModelPickHardGates({
    role: 'implement',
    harness: 'qwen',
    model: 'qwen3.8-flash',
    leafSize: LEAF_SIZE_LARGE,
    pickReason: '',
    modelRoles: ['implement'],
    favoritesConfigured: true,
    favoriteModels: ['qwen3.8-flash'],
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, MODEL_PICK_HARD_GATE_CODES.FLASH_IMPLEMENT_LARGE_LEAF);
  const allowed = evaluateModelPickHardGates({
    role: 'implement',
    harness: 'qwen',
    model: 'qwen3.8-flash',
    leafSize: LEAF_SIZE_LARGE,
    pickReason: 'Large leaf but flash is required for quota; operator approved.',
    modelRoles: ['implement'],
    favoritesConfigured: true,
    favoriteModels: ['qwen3.8-flash'],
  });
  assert.equal(allowed.ok, true);
});

test('blockTodoForNoNonFlashCandidate sets blockedReason on the leaf', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-leaf-size-'));
  const ws = path.join(dir, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const created = addTodo(dir, ws, { title: 'Leaf', body: 'kontrakt', status: 'doing' });
  const todoId = created.items.find((row) => row.title === 'Leaf')?.id;
  assert.ok(todoId);
  const before = getTodoById(dir, ws, todoId);
  const blocked = blockTodoForNoNonFlashCandidate({
    dataDir: dir,
    workspaceFolder: ws,
    todoId,
    expectedUpdatedAt: before.updatedAt,
  });
  assert.equal(blocked.ok, true);
  const after = getTodoById(dir, ws, todoId);
  assert.equal(after.blockedReason, TODO_BLOCKED_REASON_NO_NON_FLASH_CANDIDATE);
});

console.log('model-pick-leaf-size.test.js OK');
