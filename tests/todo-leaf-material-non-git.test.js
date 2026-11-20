/**
 * Leaf material baseline in a workspace folder that is not a Git repository.
 */

import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { addTodo, getTodoById } from '../lib/persist/todos-legacy-adapter.js';
import { ensureLeafMaterialBase } from '../lib/todo-leaf-material.js';
import { tempDir } from './helpers/temp-git-repo.js';

test('project leaf in a non-git folder skips the baseline instead of throwing', async (t) => {
  const dataDir = tempDir('cretli-leaf-mat-nogit-data-');
  const folder = tempDir('cretli-leaf-mat-nogit-ws-');
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(folder, { recursive: true, force: true });
  });
  fs.writeFileSync(`${folder}/notes.md`, 'plan\n');
  const root = addTodo(dataDir, folder, { title: 'root', status: 'doing', executionMode: 'project' }).item;
  const leaf = addTodo(dataDir, folder, { title: 'leaf', parentId: root.id, status: 'ready', siblingIndex: 0 }).item;
  const actualResult = await ensureLeafMaterialBase({ dataDir, workspaceFolder: folder, leafId: leaf.id });
  assert.equal(actualResult, null);
  assert.equal(getTodoById(dataDir, folder, leaf.id)?.leafMaterial ?? null, null);
});
