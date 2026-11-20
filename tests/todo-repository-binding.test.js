import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { validateTodoRepositoryBinding } from '../lib/todo-repository-binding.js';
import { createTempRepo, tempDir } from './helpers/temp-git-repo.js';

test('repository binding rejects a real foreign Git directory and ignores non-repository references', (t) => {
  const workspace = createTempRepo();
  const foreign = createTempRepo();
  const outside = tempDir('cretli-not-repo-');
  const file = path.join(outside, 'notes.md');
  fs.writeFileSync(file, 'notes');
  t.after(() => {
    fs.rmSync(workspace.dir, { recursive: true, force: true });
    fs.rmSync(foreign.dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  const rejected = validateTodoRepositoryBinding({
    workspaceFolder: workspace.dir,
    todo: { id: 'root', body: `Repository: ${foreign.dir}` },
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'repository_mismatch');

  for (const reference of [`See file://${file}`, `Repository: ${path.join(outside, 'missing')}`, `repo: ${outside}`]) {
    const accepted = validateTodoRepositoryBinding({ workspaceFolder: workspace.dir, todo: { id: 'root', body: reference } });
    assert.equal(accepted.ok, true, reference);
  }
});
