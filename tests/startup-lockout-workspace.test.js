import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { workspaceKeyFromCwd } from '../lib/persist/todos-persist.js';
import { mutateWorktreeRegistry } from '../lib/persist/worktree-registry-persist.js';
import { createWorktreeRecord } from '../lib/worktree/worktree-record.js';
import {
  resolveLogicalWorkspaceFolder,
  resolveStartupLockoutWorkspaceKey,
} from '../lib/startup-lockout-workspace.js';

test('worktree execution folder maps to the logical workspace for lockouts', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cr-wt-lockout-'));
  const logical = mkdtempSync(path.join(tmpdir(), 'cr-logical-'));
  const worktree = mkdtempSync(path.join(tmpdir(), 'cr-worktree-'));
  try {
    const record = createWorktreeRecord({
      todoId: 'todo-lockout-wt',
      workspaceFolder: logical,
      worktreePath: worktree,
      branch: 'feature/test',
      baseCommit: 'a'.repeat(40),
    });
    mutateWorktreeRegistry((draft) => {
      draft.items[record.todoId] = record;
    }, { dataDir });
    const resolved = resolveLogicalWorkspaceFolder({
      workspaceFolder: logical,
      executionFolder: worktree,
      dataDir,
    });
    assert.equal(resolved, path.resolve(logical));
    assert.equal(
      resolveStartupLockoutWorkspaceKey({ executionFolder: worktree, dataDir }),
      workspaceKeyFromCwd(logical),
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
