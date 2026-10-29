/**
 * Compaction dry-run on the SQLite backend: it must leave the store directory
 * untouched (no -wal/-shm, same mtimes) and report the same retention plan as
 * the in-process pass.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = 'scripts/compact-delegation-store.js';

/** Seed a schema-current SQLite store with one old finished job and a delivered mailbox row. */
const SEED = `
const { createDelegationRecord, updateDelegationRecord } = await import('./lib/persist/delegations-persist.js');
const { closeDelegationSqlite } = await import('./lib/persist/delegation-sqlite.js');
createDelegationRecord({ id: 'c-1', parentChatId: 'p', childChatId: 'c', harness: 'claude', model: 'm', task: 't' });
updateDelegationRecord('c-1', {
  status: 'completed',
  finishedAt: new Date(Date.now() - 5 * 86400000).toISOString(),
  report: 'finding line\\n'.repeat(400) + 'VERDICT: FAIL',
  sourceText: 'the original task',
});
closeDelegationSqlite();
`;

/** Same pass the CLI dry run wraps, run directly against the real directory. */
const DIRECT_PLAN = `
const { applyDelegationRetention } = await import('./lib/delegation-retention.js');
console.log(JSON.stringify(await applyDelegationRetention({ dryRun: true })));
`;

/**
 * @param {string[]} args
 * @param {string} dir
 * @param {Record<string, string>} [extraEnv]
 */
function runNode(args, dir, extraEnv = {}) {
  return spawnSync(process.execPath, args, {
    env: { ...process.env, CRETLI_DELEGATION_STORE: 'sqlite', CRETLI_DATA_DIR: dir, ...extraEnv },
    encoding: 'utf8',
  });
}

/** @param {string} dir */
function snapshot(dir) {
  return Object.fromEntries(fs.readdirSync(dir).sort().map((name) => [name, fs.statSync(path.join(dir, name)).mtimeMs]));
}

test('sqlite dry-run leaves the directory listing and mtimes unchanged and keeps the plan', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-compact-dry-'));
  try {
    const seed = runNode(['--input-type=module', '-e', SEED], dir);
    assert.equal(seed.status, 0, seed.stderr);
    // Normalise: drop any sidecars the seeding process left behind.
    for (const name of fs.readdirSync(dir)) if (/-(wal|shm)$/.test(name)) fs.rmSync(path.join(dir, name));
    assert.ok(fs.existsSync(path.join(dir, 'delegations.sqlite')));
    const old = new Date(Date.now() - 3600_000);
    fs.utimesSync(path.join(dir, 'delegations.sqlite'), old, old);

    const before = snapshot(dir);
    const cli = runNode([SCRIPT, '--data-dir', dir, '--json'], dir);
    assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual(snapshot(dir), before);
    assert.ok(!fs.readdirSync(dir).some((n) => /-(wal|shm)$/.test(n)));

    // Comparison: same plan as the pass run directly (its own run is allowed to open the file).
    const report = JSON.parse(cli.stdout);
    const direct = runNode(['--input-type=module', '-e', DIRECT_PLAN], dir);
    assert.equal(direct.status, 0, direct.stderr);
    const plan = JSON.parse(direct.stdout.trim().split('\n').pop());
    assert.equal(report.mode, 'dry-run');
    assert.equal(report.dataDir, dir);
    for (const key of ['archived', 'trimmed', 'mailboxTrimmed', 'savedChars']) assert.equal(report[key], plan[key], key);
    assert.equal(report.archived, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Seed: one job whose leaf is `done` in the workspace todos, finished 5 days
 * ago. Only a probe that can read todos/ archives it before the 30-day ceiling.
 * argv: [workspaceFolder]
 */
const SEED_DONE_LEAF = `
const workspace = process.argv[1];
const { addTodo, updateTodo, loadTodosData } = await import('./lib/persist/todos-legacy-adapter.js');
const { resolveDataPath } = await import('./lib/runtime-paths.js');
const dataDir = resolveDataPath();
const todo = addTodo(dataDir, workspace, { title: 'leaf', status: 'ready' });
const id = (todo.item || todo).id;
updateTodo(dataDir, workspace, id, { status: 'done' });
const { createDelegationRecord, updateDelegationRecord } = await import('./lib/persist/delegations-persist.js');
const { closeDelegationSqlite } = await import('./lib/persist/delegation-sqlite.js');
createDelegationRecord({ id: 'leaf-1', parentChatId: 'p', childChatId: 'c', harness: 'claude', model: 'm', task: 't', leafId: id, workspaceFolder: workspace });
updateDelegationRecord('leaf-1', {
  status: 'completed',
  finishedAt: new Date(Date.now() - 5 * 86400000).toISOString(),
  report: 'finding line\\n'.repeat(400) + 'VERDICT: PASS',
  sourceText: 'the original task',
});
closeDelegationSqlite();
`;

/** @param {string} dir */
function seedDoneLeaf(dir) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-compact-ws-'));
  const seed = runNode(['--input-type=module', '-e', SEED_DONE_LEAF, workspace], dir);
  assert.equal(seed.status, 0, seed.stderr);
  for (const name of fs.readdirSync(dir)) if (/-(wal|shm)$/.test(name)) fs.rmSync(path.join(dir, name));
  return workspace;
}

test('dry-run plan equals the --apply result when the leaf is done (todos/ is visible)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-compact-leaf-'));
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-compact-tmproot-'));
  const workspace = seedDoneLeaf(dir);
  try {
    const env = { TMPDIR: tmpRoot };
    const dry = runNode([SCRIPT, '--data-dir', dir, '--json'], dir, env);
    assert.equal(dry.status, 0, dry.stderr);
    // The temp copy is gone once the run ends.
    assert.deepEqual(fs.readdirSync(tmpRoot), []);
    const apply = runNode([SCRIPT, '--data-dir', dir, '--apply', '--json'], dir, env);
    assert.equal(apply.status, 0, apply.stderr);
    const a = JSON.parse(apply.stdout);
    const d = JSON.parse(dry.stdout);
    assert.equal(d.mode, 'dry-run');
    assert.equal(a.mode, 'apply');
    assert.equal(d.archived, 1);
    for (const key of ['archived', 'trimmed', 'mailboxTrimmed']) assert.equal(d[key], a[key], key);
  } finally {
    for (const d of [dir, tmpRoot, workspace]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('a relative --data-dir resolves against the cwd', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-compact-rel-'));
  try {
    fs.mkdirSync(path.join(base, 'store'));
    const run = spawnSync(process.execPath, [path.resolve(SCRIPT), '--data-dir', 'store', '--json'], {
      cwd: base,
      env: { ...process.env, CRETLI_DELEGATION_STORE: 'sqlite' },
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(fs.realpathSync(JSON.parse(run.stdout).dataDir), fs.realpathSync(path.join(base, 'store')));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('the temp copy is removed when the copy step fails', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-compact-fail-'));
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-compact-tmproot-'));
  try {
    // A directory where a store file is expected makes copyFileSync throw.
    fs.mkdirSync(path.join(dir, 'delegations.json'));
    const run = runNode([SCRIPT, '--data-dir', dir], dir, { TMPDIR: tmpRoot });
    assert.equal(run.status, 1);
    assert.deepEqual(fs.readdirSync(tmpRoot), []);
  } finally {
    for (const d of [dir, tmpRoot]) fs.rmSync(d, { recursive: true, force: true });
  }
});
