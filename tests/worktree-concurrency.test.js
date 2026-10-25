import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readWorktreeRegistry } from '../lib/persist/worktree-registry-persist.js';
import { createTempRepo, git, tempDir, worktreeConfig } from './helpers/temp-git-repo.js';

const MANAGER_URL = new URL('../lib/worktree-manager.js', import.meta.url).href;
const TODO_ID = '33333333-3333-3333-3333-333333333333';

/**
 * @param {string} scriptPath
 * @param {object} payload
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function runChild(scriptPath, payload) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, JSON.stringify(payload)], {
      cwd: path.dirname(fileURLToPath(import.meta.url)),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CRETLI_DATA_DIR: payload.registryOptions.dataDir },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

test('concurrent processes create exactly one worktree binding', async (t) => {
  const base = tempDir('cretli-wt-conc-');
  const repo = createTempRepo().dir;
  const config = worktreeConfig(base);
  const dataDir = tempDir('cretli-wt-conc-data-');
  const registryOptions = { dataDir, lockTimeoutMs: 20_000 };
  const scriptPath = path.join(base, 'ensure-child.mjs');
  fs.writeFileSync(
    scriptPath,
    [
      `import { ensureWorktree } from ${JSON.stringify(MANAGER_URL)};`,
      'const payload = JSON.parse(process.argv[2]);',
      'try {',
      '  const result = ensureWorktree(payload);',
      '  process.stdout.write(JSON.stringify({ ok: true, created: result.created, worktreePath: result.record.worktreePath, branch: result.record.branch, baseCommit: result.record.baseCommit }));',
      '} catch (error) {',
      '  process.stdout.write(JSON.stringify({ ok: false, code: error?.code || "", message: error?.message || String(error) }));',
      '  process.exitCode = 1;',
      '}',
      '',
    ].join('\n'),
  );
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const payload = {
    todoId: TODO_ID,
    workspaceFolder: repo,
    mode: 'worktree',
    config,
    registryOptions,
  };
  const runs = await Promise.all(Array.from({ length: 4 }, () => runChild(scriptPath, payload)));
  for (const run of runs) {
    assert.equal(run.code, 0, `child failed: ${run.stderr}\n${run.stdout}`);
  }
  const results = runs.map((run) => JSON.parse(run.stdout));
  assert.ok(results.every((result) => result.ok));
  assert.equal(results.filter((result) => result.created).length, 1);
  const paths = new Set(results.map((result) => result.worktreePath));
  const branches = new Set(results.map((result) => result.branch));
  const bases = new Set(results.map((result) => result.baseCommit));
  assert.equal(paths.size, 1);
  assert.equal(branches.size, 1);
  assert.equal(bases.size, 1);

  const worktreeLines = git(repo, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree '));
  assert.equal(worktreeLines.length, 2);
  assert.equal(Object.keys(readWorktreeRegistry(registryOptions).items).length, 1);
});
