/**
 * GET /api/git/commit-plan and POST /api/git/commit: run only in throwaway repositories under the OS temp dir
 * (never the project checkout).
 */
import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runGitCommandAsync } from '../lib/git-cli.js';
import { looksLikeSecretFile, registerGitRoutes } from '../lib/routes/git-routes.js';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], { cwd, encoding: 'utf8' });
const IDLE = { loadChats: () => [], listActiveDelegations: () => [], loadWorkspaceWatchers: () => [] };
const dirs = [];

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-git-commit-'));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-q', '-m', 'init');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
  return dir;
}

const tempIndexes = (repo) => fs.readdirSync(path.join(repo, '.git')).filter((name) => name.startsWith('cretli-voice-index'));

test.after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

function makeApi(repo, { scope, guard = IDLE, hooks } = {}) {
  assert.notEqual(path.resolve(repo), path.resolve(process.cwd()), 'must not touch the project checkout');
  const handlers = new Map();
  registerGitRoutes({ get: (p, fn) => handlers.set(`GET ${p}`, fn), post: (p, fn) => handlers.set(`POST ${p}`, fn) }, {
    getCurrentCwd: () => repo,
    gitGuardDeps: guard,
    commitHooks: hooks,
    resolveScope: scope || (() => ({ ok: true, source: 'workspace', chatId: '', todoId: '', workspaceFolder: repo, executionFolder: repo, isWorktree: false })),
  });
  return (method, route, req = {}) => new Promise((resolve) => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { resolve({ status: this.statusCode, body }); } };
    handlers.get(`${method} ${route}`)({ params: {}, query: {}, body: {}, ...req }, res);
  });
}

const plan = async (api) => (await api('GET', '/api/git/commit-plan')).body;
const commit = (api, body) => api('POST', '/api/git/commit', { body }).then((res) => res.body);

test('plan counts untracked files one by one, expands directories and keeps paths out of the answer', async () => {
  const repo = makeRepo();
  const api = makeApi(repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  fs.mkdirSync(path.join(repo, 'dump'));
  for (const name of ['1', '2', '3', '4']) fs.writeFileSync(path.join(repo, 'dump', `${name}.sql`), name);
  const result = await plan(api);
  assert.equal(result.ok, true);
  assert.equal(result.changed, 1);
  assert.equal(result.untracked, 4, 'an untracked directory is counted per file');
  assert.match(result.fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.paths, ['a.txt', 'dump/1.sql', 'dump/2.sql', 'dump/3.sql', 'dump/4.sql'], 'the exact path list the commit will stage');
  assert.equal(result.items, undefined);
});

test('commit: refuses an empty message, a missing fingerprint, a clean tree; commits exactly the read-back state', async () => {
  const repo = makeRepo();
  const api = makeApi(repo);
  assert.equal((await commit(api, { message: '  ', fingerprint: 'x' })).code, 'no_message');
  assert.equal((await commit(api, { message: 'x'.repeat(501), fingerprint: 'x' })).code, 'message_too_long');
  assert.equal((await commit(api, { message: 'm' })).code, 'no_fingerprint');
  assert.equal((await commit(api, { message: 'm', fingerprint: 'x' })).code, 'nothing_to_commit');

  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  fs.writeFileSync(path.join(repo, 'new.txt'), 'new\n');
  const { fingerprint } = await plan(api);
  const result = await commit(api, { message: '"quoted" -n; $(touch pwned)', fingerprint });
  assert.equal(result.ok, true);
  assert.match(result.head, /^[0-9a-f]{4,}$/);
  assert.equal(git(repo, 'status', '--porcelain').trim(), '');
  assert.equal(git(repo, 'log', '-1', '--format=%s').trim(), '"quoted" -n; $(touch pwned)');
  assert.equal(fs.existsSync(path.join(repo, 'pwned')), false);
});

test('F2: a file that appears between the steps refuses the commit with tree_changed', async () => {
  const repo = makeRepo();
  const api = makeApi(repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  const { fingerprint } = await plan(api);
  fs.mkdirSync(path.join(repo, 'late'));
  fs.writeFileSync(path.join(repo, 'late', 'extra.txt'), 'added by an agent');
  const result = await commit(api, { message: 'm', fingerprint });
  assert.equal(result.code, 'tree_changed');
  assert.equal(git(repo, 'rev-list', '--count', 'HEAD').trim(), '1', 'nothing was committed');
  assert.equal(git(repo, 'diff', '--cached', '--name-only').trim(), '', 'nothing was staged');
  // A second edit of a file that already shows as modified keeps the status lines but changes the state.
  fs.rmSync(path.join(repo, 'late'), { recursive: true, force: true });
  const before = await plan(api);
  await new Promise((resolve) => setTimeout(resolve, 20));
  fs.writeFileSync(path.join(repo, 'a.txt'), 'three, edited later\n');
  const after = await plan(api);
  assert.equal(after.changed, before.changed);
  assert.notEqual(after.fingerprint, before.fingerprint);
});

test('F2: secret-looking and very large files are refused; templates are fine', async () => {
  const repo = makeRepo();
  const api = makeApi(repo);
  fs.writeFileSync(path.join(repo, '.env'), 'TOKEN=1');
  let result = await plan(api);
  assert.equal(result.sensitiveFiles, 1);
  assert.equal((await commit(api, { message: 'm', fingerprint: result.fingerprint })).code, 'sensitive_files');
  assert.equal(git(repo, 'diff', '--cached', '--name-only').trim(), '');
  fs.rmSync(path.join(repo, '.env'));

  fs.writeFileSync(path.join(repo, '.env.example'), 'TOKEN=');
  fs.writeFileSync(path.join(repo, 'big.bin'), Buffer.alloc(5 * 1024 * 1024 + 1));
  result = await plan(api);
  assert.equal(result.sensitiveFiles, 0);
  assert.equal(result.largeFiles, 1);
  assert.equal((await commit(api, { message: 'm', fingerprint: result.fingerprint })).code, 'large_files');
  fs.rmSync(path.join(repo, 'big.bin'));
  result = await plan(api);
  assert.equal((await commit(api, { message: 'ok', fingerprint: result.fingerprint })).ok, true);

  for (const name of ['server.pem', 'a/b/id_rsa', 'id_ed25519.pub', 'credentials.json', 'secrets.yml', 'x.p12', 'cert.key', '.env.production']) {
    assert.equal(looksLikeSecretFile(name), true, name);
  }
  for (const name of ['readme.md', '.env.example', 'keyboard.js', 'environment.ts']) assert.equal(looksLikeSecretFile(name), false, name);
});

test('F3: running work and task worktrees refuse both the plan and the commit with workspace_busy', async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  const busy = makeApi(repo, {
    guard: { loadChats: () => [{ id: 'c1', executionFolder: repo }], probeChatRunLiveness: () => ({ known: true, busy: true }), listActiveDelegations: () => [], loadWorkspaceWatchers: () => [] },
  });
  assert.equal((await plan(busy)).code, 'workspace_busy');
  assert.equal((await commit(busy, { message: 'm', fingerprint: 'x' })).code, 'workspace_busy');
  const worktree = makeApi(repo, {
    scope: () => ({ ok: true, source: 'worktree', chatId: '', todoId: 't1', workspaceFolder: repo, executionFolder: repo, isWorktree: true }),
  });
  assert.equal((await plan(worktree)).code, 'workspace_busy');
  assert.equal((await commit(worktree, { message: 'm', fingerprint: 'x' })).code, 'workspace_busy');
  assert.equal(git(repo, 'rev-list', '--count', 'HEAD').trim(), '1');
});

test('F4: the voice path does not run commit hooks and leaves the real index and working tree alone', async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  fs.writeFileSync(path.join(repo, 'new.txt'), 'new\n');
  fs.writeFileSync(path.join(repo, 'staged.txt'), 'user work\n');
  git(repo, 'add', 'staged.txt'); // staged before the voice commit
  fs.writeFileSync(path.join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const api = makeApi(repo);
  const { fingerprint } = await plan(api);
  const result = await commit(api, { message: 'm', fingerprint });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.indexRefreshed, true);
  assert.equal(git(repo, 'status', '--porcelain').trim(), '', 'committed paths are clean, nothing shows as a staged revert');
  assert.deepEqual(tempIndexes(repo), []);
});

test('F4: a missing git identity is a clear error, nothing moves and the temp index is gone', async () => {
  const repo = makeRepo();
  // An empty name in the repo config overrides any global identity, so git refuses to author the commit.
  git(repo, 'config', 'user.name', '');
  git(repo, 'config', 'user.email', '');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  const head = git(repo, 'rev-parse', 'HEAD');
  const api = makeApi(repo);
  const { fingerprint } = await plan(api);
  const prior = { GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME, GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME };
  delete process.env.GIT_AUTHOR_NAME;
  delete process.env.GIT_COMMITTER_NAME;
  try {
    const result = await commit(api, { message: 'm', fingerprint });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'identity_missing');
  } finally {
    for (const [key, value] of Object.entries(prior)) if (value !== undefined) process.env[key] = value;
  }
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  assert.deepEqual(tempIndexes(repo), []);
});

test('F4: git steps have a timeout', async () => {
  const repo = makeRepo();
  const started = Date.now();
  const result = await runGitCommandAsync(['-c', 'alias.slow=!sleep 5', 'slow'], repo, { timeoutMs: 300 });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 4000);
});

test('F6: scope refusals and non-repository folders', async () => {
  const repo = makeRepo();
  const refused = makeApi(repo, { scope: () => ({ ok: false, code: 'chat_not_found', error: 'no chat' }) });
  const planRefusal = await refused('GET', '/api/git/commit-plan');
  assert.equal(planRefusal.status, 404);
  assert.equal(planRefusal.body.code, 'chat_not_found');
  const commitRefusal = await refused('POST', '/api/git/commit', { body: { message: 'm', fingerprint: 'x' } });
  assert.equal(commitRefusal.status, 404);
  assert.equal(git(repo, 'rev-list', '--count', 'HEAD').trim(), '1');

  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-git-plain-'));
  dirs.push(plain);
  const none = makeApi(plain, { scope: () => ({ ok: true, source: 'workspace', workspaceFolder: plain, executionFolder: plain, isWorktree: false }) });
  assert.equal((await plan(none)).code, 'no_repo');
  assert.equal((await commit(none, { message: 'm', fingerprint: 'x' })).code, 'no_repo');
});

test('F2: files edited or added between the fingerprint check and staging give tree_changed and an untouched index', async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  fs.writeFileSync(path.join(repo, 'new.txt'), 'new\n');
  const indexBefore = git(repo, 'write-tree').trim();
  const edit = makeApi(repo, { hooks: { beforeStage: (root) => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'edited after the question\n');
    fs.writeFileSync(path.join(root, '.env'), 'TOKEN=1');
  } } });
  const { fingerprint } = await plan(edit);
  const rewritten = await commit(edit, { message: 'm', fingerprint });
  assert.equal(rewritten.code, 'tree_changed');
  assert.equal(git(repo, 'write-tree').trim(), indexBefore, 'the real index was never touched');
  assert.equal(git(repo, 'rev-list', '--count', 'HEAD').trim(), '1');
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'edited after the question\n', 'the working tree is never touched');
  assert.deepEqual(tempIndexes(repo), [], 'the temp index is cleaned after a refusal');
});

test('F2: a file staged in the REAL index during the flow is neither committed nor lost', async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  const api = makeApi(repo, { hooks: { afterVerify: (root) => {
    fs.writeFileSync(path.join(root, 'sneaky.txt'), 'concurrent');
    git(root, 'add', 'sneaky.txt');
  } } });
  const { fingerprint } = await plan(api);
  const result = await commit(api, { message: 'm', fingerprint });
  assert.equal(result.ok, true, result.error);
  assert.equal(git(repo, 'show', '--name-only', '--format=', 'HEAD').trim(), 'a.txt', 'only the planned path is in the commit');
  assert.equal(git(repo, 'diff', '--cached', '--name-only').trim(), 'sneaky.txt', 'the concurrent staging survived');
  assert.deepEqual(tempIndexes(repo), []);
});

test('F2: editing a planned file after verification does not change the committed blob', async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  const api = makeApi(repo, { hooks: { afterVerify: (root) => fs.writeFileSync(path.join(root, 'a.txt'), 'changed after verification\n') } });
  const { fingerprint } = await plan(api);
  assert.equal((await commit(api, { message: 'm', fingerprint })).ok, true);
  assert.equal(git(repo, 'show', 'HEAD:a.txt'), 'two\n');
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'changed after verification\n', 'the later edit stays in the working tree');
  assert.match(git(repo, 'status', '--porcelain'), / M a\.txt/);
});

test('F2: HEAD moving during the flow gives head_moved and no ref change', async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  const api = makeApi(repo, { hooks: { beforeUpdateRef: (root) => git(root, 'commit', '-q', '--allow-empty', '-m', 'someone else') } });
  const { fingerprint } = await plan(api);
  const result = await commit(api, { message: 'mine', fingerprint });
  assert.equal(result.code, 'head_moved');
  assert.equal(git(repo, 'log', '-1', '--format=%s').trim(), 'someone else');
  assert.equal(git(repo, 'rev-list', '--count', 'HEAD').trim(), '2');
  assert.deepEqual(tempIndexes(repo), []);
});

test('F2: an unborn branch gets its first commit', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-git-unborn-'));
  dirs.push(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'first.txt'), '1\n');
  const api = makeApi(repo);
  const { fingerprint } = await plan(api);
  const result = await commit(api, { message: 'first', fingerprint });
  assert.equal(result.ok, true, result.error);
  assert.equal(git(repo, 'log', '--format=%s').trim(), 'first');
  assert.equal(git(repo, 'status', '--porcelain').trim(), '');
  assert.deepEqual(tempIndexes(repo), []);
});

test('F2: mode change and deletion are committed as planned', async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'tool.sh'), '#!/bin/sh\n');
  git(repo, 'add', 'tool.sh');
  git(repo, 'commit', '-q', '-m', 'tool');
  fs.chmodSync(path.join(repo, 'tool.sh'), 0o755);
  fs.rmSync(path.join(repo, 'a.txt'));
  const api = makeApi(repo);
  const { fingerprint } = await plan(api);
  assert.equal((await commit(api, { message: 'mode+delete', fingerprint })).ok, true);
  assert.match(git(repo, 'ls-tree', 'HEAD'), /100755 blob [0-9a-f]+\ttool\.sh/);
  assert.doesNotMatch(git(repo, 'ls-tree', 'HEAD'), /a\.txt/);
  assert.equal(git(repo, 'status', '--porcelain').trim(), '');
});

test('F2: only the planned paths are staged (no add -A); deletions and exec bits are committed as planned', async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
  git(repo, 'add', 'b.txt');
  git(repo, 'commit', '-q', '-m', 'b');
  fs.rmSync(path.join(repo, 'b.txt'));
  fs.writeFileSync(path.join(repo, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(repo, 'with space.txt'), 'x');
  fs.writeFileSync(path.join(repo, '*.md'), 'glob-looking name');
  const api = makeApi(repo);
  const { fingerprint } = await plan(api);
  assert.equal((await commit(api, { message: 'mixed', fingerprint })).ok, true);
  assert.equal(git(repo, 'status', '--porcelain').trim(), '');
  const tree = git(repo, 'ls-tree', '-r', 'HEAD');
  assert.match(tree, /100755 blob [0-9a-f]+\trun\.sh/);
  assert.match(tree, /\*\.md/);
  assert.doesNotMatch(tree, /b\.txt/);
});

test('F2: symlinks and nested repositories are refused as unsupported_files', async () => {
  const repo = makeRepo();
  fs.symlinkSync('a.txt', path.join(repo, 'link'));
  const api = makeApi(repo);
  const result = await plan(api);
  assert.equal(result.unsupportedFiles, 1);
  assert.equal((await commit(api, { message: 'm', fingerprint: result.fingerprint })).code, 'unsupported_files');
  assert.equal(git(repo, 'diff', '--cached', '--name-only').trim(), '');
});

test('R4-N1: a merge with conflicts, a merge in progress or a rebase refuses the plan and the commit; nothing moves', async () => {
  const repo = makeRepo();
  const api = makeApi(repo);
  git(repo, 'checkout', '-q', '-b', 'side');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'side\n');
  git(repo, 'commit', '-q', '-am', 'side');
  git(repo, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'main\n');
  git(repo, 'commit', '-q', '-am', 'main');
  assert.throws(() => git(repo, 'merge', '-q', 'side'));
  const head = git(repo, 'rev-parse', 'HEAD').trim();
  const conflicted = await plan(api);
  assert.equal(conflicted.operationInProgress, true);
  assert.equal((await commit(api, { message: 'm', fingerprint: conflicted.fingerprint })).code, 'operation_in_progress');

  // Conflict resolved in the working tree but the merge not concluded: MERGE_HEAD alone still refuses.
  fs.writeFileSync(path.join(repo, 'a.txt'), 'merged\n');
  git(repo, 'add', 'a.txt');
  const resolved = await plan(api);
  assert.equal(resolved.operationInProgress, true);
  assert.equal((await commit(api, { message: 'm', fingerprint: resolved.fingerprint })).code, 'operation_in_progress');
  assert.equal(git(repo, 'rev-parse', 'HEAD').trim(), head);
  assert.ok(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD')), 'the merge state is left for the user');
  assert.match(git(repo, 'diff', '--cached', '--name-only'), /a\.txt/, 'the real index keeps the resolution');
  assert.deepEqual(tempIndexes(repo), []);

  git(repo, 'merge', '--abort');
  fs.mkdirSync(path.join(repo, '.git', 'rebase-merge'));
  fs.writeFileSync(path.join(repo, 'a.txt'), 'later\n');
  assert.equal((await plan(api)).operationInProgress, true);
  fs.rmSync(path.join(repo, '.git', 'rebase-merge'), { recursive: true });
  const clean = await plan(api);
  assert.equal(clean.operationInProgress, false);
  assert.equal((await commit(api, { message: 'm', fingerprint: clean.fingerprint })).ok, true);
});

test('FU2: a partially staged file is flagged in the plan and refused; HEAD and the index stay untouched', async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'staged version\n');
  git(repo, 'add', 'a.txt');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'working version\n');
  const head = git(repo, 'rev-parse', 'HEAD');
  const indexBefore = git(repo, 'ls-files', '-s');
  const api = makeApi(repo);
  const result = await plan(api);
  assert.equal(result.partiallyStaged, 1);
  const refused = await commit(api, { message: 'm', fingerprint: result.fingerprint });
  assert.equal(refused.code, 'partially_staged');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  assert.equal(git(repo, 'ls-files', '-s'), indexBefore);
  // Fully staged (or only modified) files are not "partial".
  git(repo, 'add', 'a.txt');
  assert.equal((await plan(api)).partiallyStaged, 0);
});

test('FU2: a path staged differently in the real index meanwhile keeps its staged version after the commit', async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'bee\n');
  const api = makeApi(repo, { hooks: { afterVerify: (root) => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'staged meanwhile\n');
    git(root, 'add', 'a.txt');
    fs.writeFileSync(path.join(root, 'a.txt'), 'two\n');
  } } });
  const { fingerprint } = await plan(api);
  const result = await commit(api, { message: 'm', fingerprint });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.indexRefreshed, false);
  assert.equal(result.staleIndexPaths, 1);
  assert.equal(git(repo, 'show', 'HEAD:a.txt'), 'two\n');
  assert.equal(git(repo, 'show', ':a.txt'), 'staged meanwhile\n', 'the staged version was not reset away');
  assert.equal(git(repo, 'ls-files', '-s', 'b.txt').includes('\tb.txt'), true);
});

test('FU3: commit.gpgsign=true refuses with signing_required before anything is staged', async () => {
  const repo = makeRepo();
  git(repo, 'config', 'commit.gpgsign', 'true');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  const head = git(repo, 'rev-parse', 'HEAD');
  const api = makeApi(repo);
  const result = await plan(api);
  assert.equal(result.signingRequired, true);
  assert.equal((await commit(api, { message: 'm', fingerprint: result.fingerprint })).code, 'signing_required');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  assert.deepEqual(tempIndexes(repo), []);
  git(repo, 'config', 'commit.gpgsign', 'false');
  assert.equal((await plan(api)).signingRequired, false);
});

test('FU4: a blob that is large only after filters is refused by the single cat-file --batch-check', async () => {
  const repo = makeRepo();
  // The working file is tiny (the plan's stat check passes) but the clean filter makes the stored blob > 5 MB.
  git(repo, 'config', 'filter.grow.clean', "sh -c 'cat; head -c 6000000 /dev/zero'");
  fs.writeFileSync(path.join(repo, '.gitattributes'), '*.grow filter=grow\n');
  git(repo, 'add', '.gitattributes');
  git(repo, 'commit', '-q', '-m', 'attrs');
  fs.writeFileSync(path.join(repo, 'x.grow'), 'tiny\n');
  const api = makeApi(repo);
  const result = await plan(api);
  assert.equal(result.largeFiles, 0);
  const head = git(repo, 'rev-parse', 'HEAD');
  assert.equal((await commit(api, { message: 'm', fingerprint: result.fingerprint })).code, 'large_files');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  assert.deepEqual(tempIndexes(repo), []);
});

test('FU4: many files go through one batch-check and a stdin input reaches git', async () => {
  const repo = makeRepo();
  for (let index = 0; index < 250; index += 1) fs.writeFileSync(path.join(repo, `f${index}.txt`), `file ${index}\n`);
  const api = makeApi(repo);
  const { fingerprint } = await plan(api);
  const result = await commit(api, { message: 'many', fingerprint });
  assert.equal(result.ok, true, result.error);
  assert.equal(git(repo, 'ls-tree', '-r', '--name-only', 'HEAD').trim().split('\n').length, 251);

  const blob = git(repo, 'rev-parse', 'HEAD:f7.txt').trim();
  const batch = await runGitCommandAsync(['cat-file', '--batch-check=%(objectname) %(objectsize)'], repo, { input: `${blob}\n${'0'.repeat(blob.length)}\n` });
  assert.equal(batch.ok, true);
  assert.match(batch.stdout, new RegExp(`^${blob} 7\\n`));
  assert.match(batch.stdout, /missing/);
});

test('FU2: the real-index refresh holds git\'s index lock, so a concurrent git add cannot be lost in between', async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  let concurrentAdd = null;
  const api = makeApi(repo, { hooks: { beforeIndexWrite: (root) => {
    // Between the inspection and the write: another git process tries to stage a new version.
    fs.writeFileSync(path.join(root, 'a.txt'), 'racing\n');
    try {
      git(root, 'add', 'a.txt');
      concurrentAdd = 'written';
    } catch {
      concurrentAdd = 'refused';
    }
    fs.writeFileSync(path.join(root, 'a.txt'), 'two\n');
  } } });
  const { fingerprint } = await plan(api);
  const result = await commit(api, { message: 'm', fingerprint });
  assert.equal(result.ok, true, result.error);
  assert.equal(concurrentAdd, 'refused', 'the index lock blocks other writers during the refresh');
  assert.equal(result.indexRefreshed, true);
  assert.equal(git(repo, 'status', '--porcelain'), '', 'committed path refreshed, nothing staged lost silently');
  assert.ok(!fs.existsSync(path.join(repo, '.git', 'index.lock')));
  assert.deepEqual(fs.readdirSync(path.join(repo, '.git')).filter((name) => name.startsWith('cretli-voice-')), []);
});

test('FU2: an index.lock held by another process is never touched; the commit stands and the refresh is skipped', async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  const api = makeApi(repo, { hooks: { beforeUpdateRef: (root) => fs.writeFileSync(path.join(root, '.git', 'index.lock'), 'someone else') } });
  const { fingerprint } = await plan(api);
  const indexBefore = fs.readFileSync(path.join(repo, '.git', 'index'));
  const result = await commit(api, { message: 'm', fingerprint });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.indexRefreshed, false);
  assert.equal(git(repo, 'show', 'HEAD:a.txt'), 'two\n');
  assert.equal(fs.readFileSync(path.join(repo, '.git', 'index.lock'), 'utf8'), 'someone else', 'a foreign lock is left as it was');
  assert.deepEqual(fs.readFileSync(path.join(repo, '.git', 'index')), indexBefore, 'the real index is untouched');
  fs.rmSync(path.join(repo, '.git', 'index.lock'));
});

test('FU2: a refresh that fails after the commit still reports the commit; the index and temp files are left clean', async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  const indexFile = path.join(repo, '.git', 'index');
  let indexBefore = null;
  const api = makeApi(repo, { hooks: { beforeIndexWrite: () => {
    // Make the final rename impossible: the index path becomes a non-empty directory.
    indexBefore = fs.readFileSync(indexFile);
    fs.rmSync(indexFile);
    fs.mkdirSync(indexFile);
    fs.writeFileSync(path.join(indexFile, 'keep'), 'x');
  } } });
  const { fingerprint } = await plan(api);
  const result = await commit(api, { message: 'm', fingerprint });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.indexRefreshed, false);
  assert.equal(git(repo, 'show', 'HEAD:a.txt'), 'two\n', 'the commit stands');
  assert.ok(!fs.existsSync(`${indexFile}.lock`), 'our own lock is released');
  assert.deepEqual(fs.readdirSync(path.join(repo, '.git')).filter((name) => name.startsWith('cretli-voice-')), []);
  fs.rmSync(indexFile, { recursive: true });
  fs.writeFileSync(indexFile, indexBefore);
});

test('FU2: a cleanup step that throws after the commit does not hide the commit', async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  const gitDir = path.join(repo, '.git');
  let blocker = '';
  const api = makeApi(repo, { hooks: { beforeIndexWrite: () => {
    // rmSync(<scratch>.lock, { force: true }) throws on a non-empty directory.
    const scratch = fs.readdirSync(gitDir).find((name) => name.startsWith('cretli-voice-refresh-') && !name.endsWith('.lock'));
    blocker = path.join(gitDir, `${scratch}.lock`);
    fs.mkdirSync(blocker);
    fs.writeFileSync(path.join(blocker, 'keep'), 'x');
  } } });
  const { fingerprint } = await plan(api);
  const result = await commit(api, { message: 'm', fingerprint });
  assert.equal(result.ok, true, result.error);
  assert.equal(git(repo, 'show', 'HEAD:a.txt'), 'two\n');
  assert.ok(!fs.existsSync(path.join(gitDir, 'index.lock')), 'the other cleanup steps still ran');
  fs.rmSync(blocker, { recursive: true });
});
