/**
 * Cutover preparation (stage 3): code candidates, the quiesced cutover sequence, pre-ACK rollback, post-check and
 * rollback rehearsal. Everything is synthetic: temp git repos, a temp data root and a fake backup record. Nothing
 * here touches a real installation, data/ or conversation text.
 */
import './helpers/isolated-data-dir.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assistantRec, makeTempDir, userRec } from './fixtures/storage-history-synthetic.js';
import { chatIdOf, makeCoordinator } from './fixtures/storage-history-adapter-harness.js';
import { resolveChatHistoryPaths } from '../lib/persist/chat-history-service.js';
import { openChatHistoryRuntime } from '../lib/persist/chat-history-runtime.js';
import { readHistoryBackendMarker } from '../lib/persist/chat-history-backend-marker.js';
import { applyCodeCandidates, planCodeCandidates, revertCodeApply } from '../lib/storage/cutover-code.js';
import { DatabaseSync } from 'node:sqlite';
import { resolveCutoverPaths, runQuiescedCutover } from '../lib/storage/cutover-history.js';

const CLI = fileURLToPath(new URL('../scripts/storage-history-cutover.mjs', import.meta.url));
const worlds = [];
afterEach(() => {
  while (worlds.length) fs.rmSync(worlds.pop(), { recursive: true, force: true });
});

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
const write = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const lines = (...rows) => `${rows.join('\n')}\n`;

/** main = a git checkout whose HEAD moved after the worktree branched; the worktree carries the reviewed change. */
function makeCodeWorld() {
  const root = makeTempDir('cretli-cutover-code-');
  worlds.push(root);
  const main = path.join(root, 'main');
  fs.mkdirSync(main);
  git(main, 'init', '-q', '-b', 'master');
  const base = {
    'lib/copy.js': lines('a', 'b', 'c'),
    'lib/merge.js': lines('one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'),
    'lib/conflict.js': lines('x'),
    'lib/gone.js': lines('gone'),
    'lib/user-dirty.js': lines('committed'),
    'tests/user-new.test.js': undefined,
  };
  for (const [rel, text] of Object.entries(base)) if (text !== undefined) write(main, rel, text);
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'base');
  const work = path.join(root, 'work');
  execFileSync('git', ['clone', '-q', main, work]);
  const baseRev = git(work, 'rev-parse', 'HEAD').trim();
  // The reviewed change in the worktree.
  write(work, 'lib/copy.js', lines('a', 'b', 'c', 'worktree-line'));
  write(work, 'lib/merge.js', lines('ONE', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'));
  write(work, 'lib/conflict.js', lines('from-worktree'));
  fs.rmSync(path.join(work, 'lib/gone.js'));
  write(work, 'lib/brand-new.js', lines('new file'));
  write(work, 'lib/user-dirty.js', lines('worktree version'));
  // Main moved on: a new commit elsewhere, plus uncommitted user work.
  write(main, 'lib/elsewhere.js', lines('unrelated'));
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'main moved');
  write(main, 'lib/merge.js', lines('one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'TEN'));
  write(main, 'lib/conflict.js', lines('from-main'));
  write(main, 'lib/user-dirty.js', lines('user uncommitted work'));
  write(main, 'tests/user-new.test.js', lines('untracked user file'));
  return { root, main, work, baseRev };
}

describe('code candidates (three-way, per path)', () => {
  it('classifies copy / merge / delete / conflict / protected without touching main, and never reports restored files as changes', () => {
    const w = makeCodeWorld();
    const before = { dirty: sha(fs.readFileSync(path.join(w.main, 'lib/user-dirty.js'))), untracked: sha(fs.readFileSync(path.join(w.main, 'tests/user-new.test.js'))) };
    const { manifest } = planCodeCandidates({
      codeRoot: w.work, mainRoot: w.main, candidatesDir: path.join(w.root, 'cand'), protectedPaths: ['lib/user-dirty.js', 'tests/user-new.test.js'],
    });
    const byPath = Object.fromEntries(manifest.entries.map((entry) => [entry.path, entry]));
    assert.equal(byPath['lib/copy.js'].action, 'copy');
    assert.equal(byPath['lib/merge.js'].action, 'merge');
    assert.equal(byPath['lib/conflict.js'].action, 'conflict');
    assert.equal(byPath['lib/gone.js'].action, 'delete');
    assert.equal(byPath['lib/brand-new.js'].action, 'copy');
    assert.equal(byPath['lib/user-dirty.js'].action, 'protected-skip');
    assert.equal(byPath['lib/elsewhere.js'], undefined, 'a path only main changed is not in the worktree scope');
    assert.deepEqual(manifest.protectedPaths.map((item) => item.path), ['lib/user-dirty.js', 'tests/user-new.test.js']);
    // Planning never writes to main.
    assert.equal(sha(fs.readFileSync(path.join(w.main, 'lib/user-dirty.js'))), before.dirty);
    assert.equal(sha(fs.readFileSync(path.join(w.main, 'tests/user-new.test.js'))), before.untracked);
    assert.equal(read(w.main, 'lib/copy.js'), lines('a', 'b', 'c'));
  });

  it('plans under a minimal environment against checkouts owned by another uid, without touching global git config', (t) => {
    if (typeof process.getuid !== 'function' || process.getuid() !== 0) t.skip('needs root to create a differently owned fixture');
    const w = makeCodeWorld();
    for (const dir of [w.main, w.work]) execFileSync('chown', ['-R', '1000:1000', dir]);
    const saved = { ...process.env };
    const home = path.join(w.root, 'no-home');
    try {
      for (const key of Object.keys(process.env)) delete process.env[key];
      process.env.PATH = saved.PATH;
      process.env.LC_ALL = 'C';
      assert.throws(() => execFileSync('git', ['-C', w.main, 'rev-parse', 'HEAD'], { stdio: 'pipe' }), /dubious ownership|safe\.directory/, 'precondition: plain git refuses');
      const { manifest } = planCodeCandidates({ codeRoot: w.work, mainRoot: w.main, candidatesDir: path.join(w.root, 'cand-uid') });
      assert.equal(manifest.entries.find((entry) => entry.path === 'lib/copy.js').action, 'copy');
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, saved);
    }
    assert.equal(fs.existsSync(home), false);
    assert.equal(fs.existsSync(path.join(saved.HOME ?? '/nonexistent', '.gitconfig-cretli-probe')), false);
  });

  it('treats a path whose main copy already equals the worktree as applied, and a restored base as the merge base', () => {
    const w = makeCodeWorld();
    // main already received the identical change; and a restored file: worktree = main HEAD version edited on top.
    write(w.main, 'lib/copy.js', lines('a', 'b', 'c', 'worktree-line'));
    write(w.work, 'lib/elsewhere.js', lines('unrelated', 'plus a reviewed line'));
    const { manifest } = planCodeCandidates({ codeRoot: w.work, mainRoot: w.main, candidatesDir: path.join(w.root, 'cand') });
    const byPath = Object.fromEntries(manifest.entries.map((entry) => [entry.path, entry]));
    assert.equal(byPath['lib/copy.js'].action, 'already-applied');
    assert.equal(byPath['lib/elsewhere.js'].action, 'copy', 'untracked in the worktree HEAD, committed in main: main HEAD is the base');
    assert.equal(byPath['lib/elsewhere.js'].reason, 'main-equals-restored-base');
  });

  it('applies atomically with a checkpoint, preserves protected files byte for byte and reverts exactly', () => {
    const w = makeCodeWorld();
    const cand = path.join(w.root, 'cand');
    const { manifest } = planCodeCandidates({ codeRoot: w.work, mainRoot: w.main, candidatesDir: cand, protectedPaths: ['lib/user-dirty.js', 'tests/user-new.test.js'] });
    // Conflicts block the apply entirely: nothing is written.
    assert.throws(() => applyCodeCandidates({ mainRoot: w.main, manifest, candidatesDir: cand, checkpointDir: path.join(w.root, 'ck'), journalFile: path.join(w.root, 'j.json') }), (e) => e.code === 'code_plan_has_conflicts');
    assert.equal(read(w.main, 'lib/copy.js'), lines('a', 'b', 'c'));
    // The reviewer resolves the conflict by taking main's version into the worktree, then plans again.
    write(w.work, 'lib/conflict.js', lines('from-main'));
    const plan = planCodeCandidates({ codeRoot: w.work, mainRoot: w.main, candidatesDir: path.join(w.root, 'cand2'), protectedPaths: ['lib/user-dirty.js', 'tests/user-new.test.js'] });
    const originals = Object.fromEntries(['lib/copy.js', 'lib/merge.js', 'lib/gone.js', 'lib/user-dirty.js', 'tests/user-new.test.js'].map((rel) => [rel, fs.readFileSync(path.join(w.main, rel))]));
    const options = { mainRoot: w.main, manifest: plan.manifest, candidatesDir: path.join(w.root, 'cand2'), checkpointDir: path.join(w.root, 'ck'), journalFile: path.join(w.root, 'j.json') };
    const result = applyCodeCandidates(options);
    assert.deepEqual(result, { applied: 3, deleted: 1 });
    assert.equal(read(w.main, 'lib/copy.js'), lines('a', 'b', 'c', 'worktree-line'));
    assert.equal(read(w.main, 'lib/merge.js'), lines('ONE', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'TEN'), 'both sides kept');
    assert.equal(fs.existsSync(path.join(w.main, 'lib/gone.js')), false);
    assert.equal(read(w.main, 'lib/brand-new.js'), lines('new file'));
    for (const rel of ['lib/user-dirty.js', 'tests/user-new.test.js']) assert.deepEqual(fs.readFileSync(path.join(w.main, rel)), originals[rel], `${rel} is byte-identical`);
    assert.equal(git(w.main, 'log', '--oneline').trim().split('\n').length, 2, 'no commit was made');
    const report = revertCodeApply({ mainRoot: w.main, checkpointDir: options.checkpointDir, journalFile: options.journalFile });
    assert.deepEqual(report.refused, []);
    for (const rel of ['lib/copy.js', 'lib/merge.js', 'lib/gone.js']) assert.deepEqual(fs.readFileSync(path.join(w.main, rel)), originals[rel], `${rel} restored`);
    assert.equal(fs.existsSync(path.join(w.main, 'lib/brand-new.js')), false);
  });

  it('refuses when main HEAD, a target or a protected file changed after the plan, and reverts a half-applied run', () => {
    const w = makeCodeWorld();
    write(w.work, 'lib/conflict.js', lines('from-main'));
    const make = (suffix) => planCodeCandidates({ codeRoot: w.work, mainRoot: w.main, candidatesDir: path.join(w.root, `cand-${suffix}`), protectedPaths: ['lib/user-dirty.js'] });
    const ctx = (plan, suffix) => ({ mainRoot: w.main, manifest: plan.manifest, candidatesDir: path.join(w.root, `cand-${suffix}`), checkpointDir: path.join(w.root, `ck-${suffix}`), journalFile: path.join(w.root, `j-${suffix}.json`) });
    const a = make('a');
    write(w.main, 'lib/copy.js', lines('a', 'b', 'c', 'someone edited main meanwhile'));
    assert.throws(() => applyCodeCandidates(ctx(a, 'a')), (e) => e.code === 'code_target_changed');
    const b = make('b');
    write(w.main, 'lib/user-dirty.js', lines('user kept typing'));
    assert.throws(() => applyCodeCandidates(ctx(b, 'b')), (e) => e.code === 'code_protected_path_changed');
    const c = make('c');
    git(w.main, 'add', '-A');
    git(w.main, 'commit', '-q', '-m', 'main moved again');
    assert.throws(() => applyCodeCandidates(ctx(c, 'c')), (e) => e.code === 'code_main_head_changed');
    // Fault in the middle of a real apply: everything already published is reverted.
    write(w.main, 'lib/copy.js', lines('a', 'b', 'c'));
    write(w.main, 'lib/user-dirty.js', lines('user uncommitted work'));
    const d = make('d');
    const options = ctx(d, 'd');
    const originals = Object.fromEntries(['lib/copy.js', 'lib/merge.js'].map((rel) => [rel, fs.readFileSync(path.join(w.main, rel))]));
    let entries = 0;
    assert.throws(() => applyCodeCandidates({ ...options, faultHook: (point) => { if (point === 'after-entry' && (entries += 1) === 2) throw Object.assign(new Error('boom'), { code: 'injected' }); } }), (e) => e.code === 'injected');
    for (const rel of Object.keys(originals)) assert.deepEqual(fs.readFileSync(path.join(w.main, rel)), originals[rel]);
    assert.equal(fs.existsSync(path.join(w.main, 'lib/brand-new.js')), false);
  });
});

const CHATS = [
  { id: chatIdOf(1), events: [userRec('synthetic question one'), assistantRec('synthetic answer one')] },
  { id: chatIdOf(2), events: [userRec('synthetic question two')] },
  { id: chatIdOf(3), events: [userRec('synthetic question three'), assistantRec('a'), assistantRec('b')] },
];

/** A full synthetic installation: legacy history (+ protected ignore files), code repos, a fake published backup. */
function makeCutoverWorld() {
  const code = makeCodeWorld();
  write(code.work, 'lib/conflict.js', lines('from-main'));
  const dataRoot = path.join(code.root, 'data');
  const legacyDir = path.join(dataRoot, 'chat-history');
  fs.mkdirSync(legacyDir, { recursive: true });
  for (const chat of CHATS) {
    const doc = { v: 1, chatId: chat.id, cursorSessionId: 'sess', headSeq: chat.events.length, updatedAt: '2026-10-05T00:00:00.000Z', events: chat.events.map((rec, index) => ({ seq: index + 1, rec })) };
    fs.writeFileSync(path.join(legacyDir, `${chat.id}.json`), JSON.stringify(doc, null, 2));
  }
  fs.writeFileSync(path.join(legacyDir, '.cursorignore'), '*\n');
  fs.writeFileSync(path.join(legacyDir, '.rgignore'), '*\n');
  fs.writeFileSync(path.join(dataRoot, 'auth.json'), '{"unrelated":"state"}');
  const backupDir = path.join(code.root, 'backup', 'cretli-snapshot-test');
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const archive = Buffer.from('synthetic archive bytes');
  fs.writeFileSync(path.join(backupDir, 'cretli-snapshot-test.tar.gz'), archive);
  fs.writeFileSync(path.join(backupDir, 'cretli-snapshot-test.tar.gz.sha256'), `${sha(archive)}  cretli-snapshot-test.tar.gz\n`);
  const writeBackupStatus = (patch = {}) => fs.writeFileSync(path.join(backupDir, 'status.json'), JSON.stringify({
    state: 'published', finishedAt: new Date().toISOString(), restart: { outcome: 'running-verified' },
    result: { archive: 'cretli-snapshot-test.tar.gz', bytes: archive.length, sha256: sha(archive), files: 3 }, ...patch,
  }));
  writeBackupStatus();
  return { ...code, dataRoot, legacyDir, backupDir, writeBackupStatus, opsDir: path.join(code.root, 'ops') };
}

/** @param {string[]} args */
function cli(args, env = {}) {
  const run = spawnSync(process.execPath, ['--no-warnings', CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  let json = null;
  try {
    json = JSON.parse(run.stdout);
  } catch { /* not JSON */ }
  let error = null;
  try {
    error = JSON.parse(run.stderr);
  } catch { /* not JSON */ }
  return { status: run.status, json, error, stdout: run.stdout, stderr: run.stderr };
}

function prepareArgs(w, extra = []) {
  return ['prepare', '--code-root', w.work, '--main-root', w.main, '--data-root', w.dataRoot, '--ops-dir', w.opsDir, '--backup-op-dir', w.backupDir,
    '--min-chats', '3', '--backup-not-before', new Date(Date.now() - 60_000).toISOString(), '--protect', 'lib/user-dirty.js', '--protect', 'tests/user-new.test.js', ...extra];
}

const treeHash = (dir) => {
  const rows = [];
  const walk = (current) => {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      if (fs.lstatSync(full).isDirectory()) walk(full);
      else rows.push([path.relative(dir, full), sha(fs.readFileSync(full))]);
    }
  };
  walk(dir);
  return JSON.stringify(rows);
};

describe('cutover operation (CLI, synthetic)', () => {
  it('uses the directory names the server derives from the data root', () => {
    const paths = resolveChatHistoryPaths('/data/example');
    const mine = resolveCutoverPaths('/data/example');
    assert.deepEqual([mine.controlDir, mine.dbDir, mine.pendingDir], [paths.controlDir, paths.dbDir, paths.pendingDir]);
  });

  it('prepare is read-only for main/data, verify passes, a stale backup or a moved main is refused before any stop', () => {
    const w = makeCutoverWorld();
    const mainBefore = treeHash(w.main.replace(/$/, ''));
    const legacyBefore = treeHash(w.legacyDir);
    const prep = cli(prepareArgs(w));
    assert.equal(prep.status, 0, prep.stderr);
    assert.match(prep.json.manifestHash, /^[0-9a-f]{64}$/);
    assert.equal(prep.json.code.counts.conflict, undefined);
    assert.ok(prep.json.code.counts.copy >= 2);
    assert.ok(!prep.stdout.includes(w.root), 'private paths stay out of the printed report');
    assert.equal(treeHash(w.legacyDir), legacyBefore);
    assert.equal(treeHash(w.main).length > 0, true);
    assert.equal(fs.existsSync(path.join(w.main, 'lib/brand-new.js')), false, 'prepare never writes main');
    void mainBefore;
    const hash = prep.json.manifestHash;
    assert.equal(cli(['preview', '--ops-dir', w.opsDir]).status, 0);
    const verified = cli(['verify', '--ops-dir', w.opsDir, '--confirm-manifest-hash', hash]);
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(cli(['verify', '--ops-dir', w.opsDir, '--confirm-manifest-hash', 'f'.repeat(64)]).error.code, 'cutover_manifest_not_confirmed');
    w.writeBackupStatus({ finishedAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString() });
    assert.equal(cli(['verify', '--ops-dir', w.opsDir, '--confirm-manifest-hash', hash]).error.code, 'backup_stale');
    w.writeBackupStatus();
    write(w.main, 'lib/copy.js', lines('main changed after prepare'));
    assert.equal(cli(['verify', '--ops-dir', w.opsDir, '--confirm-manifest-hash', hash]).error.code, 'code_target_changed');
  });

  it('refuses to prepare with an unresolved conflict only at apply time and refuses an ops dir inside the repo', () => {
    const w = makeCutoverWorld();
    const inside = cli(prepareArgs({ ...w, opsDir: path.join(w.main, 'ops') }));
    assert.equal(inside.status, 1);
    assert.match(inside.stderr, /outside/);
  });

  it('cutover: strict plan -> import -> verify -> code -> store -> marker; legacy bytes and unrelated state untouched; runtime serves new writes, fork and restart; post-check and rollback rehearsal', async () => {
    const w = makeCutoverWorld();
    const prep = cli(prepareArgs(w));
    assert.equal(prep.status, 0, prep.stderr);
    const hash = prep.json.manifestHash;
    const legacyBefore = treeHash(w.legacyDir);
    const authBefore = read(w.dataRoot, 'auth.json');
    const protectedBefore = { dirty: fs.readFileSync(path.join(w.main, 'lib/user-dirty.js')), untracked: fs.readFileSync(path.join(w.main, 'tests/user-new.test.js')) };
    const run = cli(['cutover', '--ops-dir', w.opsDir, '--confirm-manifest-hash', hash]);
    assert.equal(run.status, 0, run.stderr + run.stdout);
    assert.equal(run.json.source.chats, 3);
    assert.equal(run.json.marker.backend, 'sqlite');
    assert.equal(treeHash(w.legacyDir), legacyBefore, 'the legacy directory (incl. protected ignore files) is byte-identical');
    assert.equal(read(w.dataRoot, 'auth.json'), authBefore);
    assert.deepEqual(fs.readFileSync(path.join(w.main, 'lib/user-dirty.js')), protectedBefore.dirty);
    assert.deepEqual(fs.readFileSync(path.join(w.main, 'tests/user-new.test.js')), protectedBefore.untracked);
    assert.equal(read(w.main, 'lib/copy.js'), lines('a', 'b', 'c', 'worktree-line'));
    assert.equal(fs.statSync(path.join(w.dataRoot, 'storage')).mode & 0o777, 0o700);
    const status = JSON.parse(read(w.opsDir, 'cutover-status.json'));
    assert.equal(status.state, 'cutover-committed');
    // The marker is sqlite, a second cutover is refused (no clean slate).
    const paths = resolveCutoverPaths(w.dataRoot);
    assert.equal(readHistoryBackendMarker(paths.controlDir, { traceDirs: paths }).backend, 'sqlite');
    assert.equal(cli(['cutover', '--ops-dir', w.opsDir, '--confirm-manifest-hash', hash]).error.code, 'cutover_not_clean_slate');
    assert.equal(readHistoryBackendMarker(paths.controlDir, { traceDirs: paths }).backend, 'sqlite', 'a refused second run does not undo the committed one');
    assert.equal(read(w.main, 'lib/copy.js'), lines('a', 'b', 'c', 'worktree-line'));

    // The server's runtime opens the published store: imported history readable, new writes, fork, restart.
    const open = async () => {
      const coordinator = makeCoordinator(paths.controlDir);
      coordinator.acquire();
      const runtime = await openChatHistoryRuntime({ ...paths, coordinator, hostOptions: { restartBackoffMs: { initial: 5, max: 20 } } });
      return { runtime, coordinator, close: async () => { await runtime.close(); coordinator.release(); } };
    };
    const first = await open();
    try {
      assert.equal(first.runtime.recovery.unresolved.length, 0);
      const imported = await first.runtime.adapter.getChatHistorySince(chatIdOf(1), 0, 10);
      assert.equal(imported.events.length, 2);
      const appended = await first.runtime.adapter.appendChatHistoryEvents(chatIdOf(1), 'sess', [{ rec: userRec('written after cutover') }]);
      assert.equal(appended.ok, true);
      const forked = await first.runtime.adapter.copyChatHistory(chatIdOf(1), chatIdOf(9));
      assert.ok(forked);
    } finally {
      await first.close();
    }
    const evidencePath = path.join(w.root, 'evidence-1.json');
    const check1 = cli(['post-check', '--ops-dir', w.opsDir, '--out', evidencePath]);
    assert.equal(check1.status, 0, check1.stdout);
    assert.ok(check1.json.newEventCount >= 1);
    // Restart: the earlier write is still there, counts never shrink.
    const second = await open();
    try {
      assert.equal((await second.runtime.adapter.getChatHistorySince(chatIdOf(1), 0, 10)).events.length, 3);
    } finally {
      await second.close();
    }
    const check2 = cli(['post-check', '--ops-dir', w.opsDir, '--previous', evidencePath]);
    assert.equal(check2.status, 0, check2.stdout);
    // The pre-ACK rollback refuses: durable writes exist. Only the read-only rollback export remains.
    const refused = cli(['rollback-precutover', '--ops-dir', w.opsDir, '--confirm-manifest-hash', hash]);
    assert.equal(refused.error.code, 'rollback_post_cutover_ack_exists');
    assert.equal(readHistoryBackendMarker(paths.controlDir, { traceDirs: paths }).backend, 'sqlite');
    const rehearsal = cli(['rehearse-rollback', '--ops-dir', w.opsDir, '--scratch-dir', path.join(w.root, 'rehearsal')]);
    assert.equal(rehearsal.status, 0, rehearsal.stderr);
    assert.equal(rehearsal.json.includesPostCutoverWrites, true);
    assert.equal(rehearsal.json.verified, true);
  });

  it('pre-ACK rollback restores the legacy default and the old code exactly; nothing is deleted', () => {
    const w = makeCutoverWorld();
    const hash = cli(prepareArgs(w)).json.manifestHash;
    const copyBefore = fs.readFileSync(path.join(w.main, 'lib/copy.js'));
    assert.equal(cli(['cutover', '--ops-dir', w.opsDir, '--confirm-manifest-hash', hash]).status, 0);
    const back = cli(['rollback-precutover', '--ops-dir', w.opsDir, '--confirm-manifest-hash', hash]);
    assert.equal(back.status, 0, back.stderr);
    assert.equal(back.json.backend, 'legacy');
    const paths = resolveCutoverPaths(w.dataRoot);
    assert.equal(readHistoryBackendMarker(paths.controlDir, { traceDirs: paths }).source, 'default');
    assert.deepEqual(fs.readFileSync(path.join(w.main, 'lib/copy.js')), copyBefore);
    assert.equal(fs.existsSync(path.join(w.main, 'lib/brand-new.js')), false);
    assert.ok(fs.readdirSync(path.join(w.opsDir, 'aborted')).length === 1, 'the store was moved aside, not deleted');
  });

  it('every failure before the marker undoes code and store and leaves the legacy backend authoritative', () => {
    for (const point of ['after-source-plan', 'after-verify-import', 'after-code-apply', 'after-publish-store']) {
      const w = makeCutoverWorld();
      const prepared = cli(prepareArgs(w));
      const manifest = JSON.parse(read(w.opsDir, 'cutover-manifest.json'));
      const legacyBefore = treeHash(w.legacyDir);
      const copyBefore = fs.readFileSync(path.join(w.main, 'lib/copy.js'));
      assert.throws(() => runQuiescedCutover({ manifest, confirmManifestHash: prepared.json.manifestHash, faultHook: (p) => { if (p === point) throw Object.assign(new Error('injected'), { code: 'injected' }); } }), (e) => e.code === 'injected', point);
      const paths = resolveCutoverPaths(w.dataRoot);
      assert.equal(readHistoryBackendMarker(paths.controlDir, { traceDirs: paths }).source, 'default', `${point}: legacy default`);
      assert.equal(fs.existsSync(paths.dbDir), false, `${point}: no store`);
      assert.deepEqual(fs.readFileSync(path.join(w.main, 'lib/copy.js')), copyBefore, `${point}: old code`);
      assert.equal(treeHash(w.legacyDir), legacyBefore);
      const expectedState = ['after-code-apply', 'after-publish-store'].includes(point) ? 'aborted-before-marker' : 'failed-before-writes';
      assert.equal(JSON.parse(read(w.opsDir, 'cutover-status.json')).state, expectedState, point);
    }
  });

  it('refuses without a published fresh backup, a corrupt source, or a tool change; recover aborts a half-published run', () => {
    const w = makeCutoverWorld();
    const prepared = cli(prepareArgs(w));
    const hash = prepared.json.manifestHash;
    fs.writeFileSync(path.join(w.backupDir, 'cretli-snapshot-test.tar.gz'), 'tampered archive bytes!!');
    assert.equal(cli(['cutover', '--ops-dir', w.opsDir, '--confirm-manifest-hash', hash]).error.code, 'backup_archive_mismatch');
    fs.writeFileSync(path.join(w.backupDir, 'cretli-snapshot-test.tar.gz'), 'synthetic archive bytes');
    // Corrupt source: strict validation refuses, nothing is written.
    fs.writeFileSync(path.join(w.legacyDir, `${chatIdOf(2)}.json`), '{ not json');
    const corrupt = cli(['cutover', '--ops-dir', w.opsDir, '--confirm-manifest-hash', hash]);
    assert.equal(corrupt.error.code, 'source_plan_refused');
    assert.equal(fs.existsSync(path.join(w.dataRoot, 'storage')), false);
    // recover on a clean slate is a no-op that changes nothing.
    const recover = cli(['recover', '--ops-dir', w.opsDir, '--confirm-manifest-hash', hash]);
    assert.equal(recover.status, 0, recover.stderr);
  });

  it('recover aborts a run that died between the witness and the marker, and refuses to touch a committed one', () => {
    const w = makeCutoverWorld();
    const hash = cli(prepareArgs(w)).json.manifestHash;
    assert.equal(cli(['cutover', '--ops-dir', w.opsDir, '--confirm-manifest-hash', hash]).status, 0);
    const paths = resolveCutoverPaths(w.dataRoot);
    const committed = cli(['recover', '--ops-dir', w.opsDir, '--confirm-manifest-hash', hash]);
    assert.equal(committed.json.action, 'none', 'a committed marker is never undone by recover');
    // Simulate the crash window: store published and witness written, marker not.
    fs.rmSync(path.join(paths.controlDir, 'history-backend.json'));
    assert.throws(() => readHistoryBackendMarker(paths.controlDir, { traceDirs: paths }), (e) => e.code === 'history_backend_marker_missing');
    const recovered = cli(['recover', '--ops-dir', w.opsDir, '--confirm-manifest-hash', hash]);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(recovered.json.action, 'aborted');
    assert.equal(readHistoryBackendMarker(paths.controlDir, { traceDirs: paths }).source, 'default');
    assert.equal(fs.existsSync(path.join(w.main, 'lib/brand-new.js')), false, 'the code of the dead run was reverted too');
  });

  it('hook-spec pins the script and the manifest, and the spec parses for the snapshot tool', () => {
    const w = makeCutoverWorld();
    const hash = cli(prepareArgs(w)).json.manifestHash;
    const out = path.join(w.root, 'spec.json');
    const made = cli(['hook-spec', '--ops-dir', w.opsDir, '--confirm-manifest-hash', hash, '--mode', 'cutover', '--out', out]);
    assert.equal(made.status, 0, made.stderr);
    const spec = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(spec.scriptSha256, sha(fs.readFileSync(CLI)));
    assert.equal(made.json.specSha256, sha(fs.readFileSync(out)));
    assert.deepEqual(spec.args.slice(0, 1), ['cutover']);
    assert.equal(cli(['hook-spec', '--ops-dir', w.opsDir, '--confirm-manifest-hash', hash, '--mode', 'bogus', '--out', out]).status, 1);
  });
});

const proofEnv = (w) => ({ CRETLI_HOOK_PROOF_PATH: path.join(w.root, 'hook-proof.json'), CRETLI_HOOK_ATTEMPT: 'attempt-nonce-1', CRETLI_HOOK_OP_ID: 'helper-op' });
const readProof = (w) => (fs.existsSync(path.join(w.root, 'hook-proof.json')) ? JSON.parse(fs.readFileSync(path.join(w.root, 'hook-proof.json'), 'utf8')) : null);

describe('hook proof (fail-closed restart channel)', () => {
  it('writes a durable proof bound to the attempt nonce: safe-new after a committed cutover, safe-legacy after a clean refusal or rollback', () => {
    const w = makeCutoverWorld();
    const hash = cli(prepareArgs(w)).json.manifestHash;
    fs.writeFileSync(path.join(w.legacyDir, `${chatIdOf(2)}.json`), '{ not json');
    const refused = cli(['cutover', '--ops-dir', w.opsDir, '--confirm-manifest-hash', hash], proofEnv(w));
    assert.equal(refused.status, 1);
    assert.deepEqual([readProof(w).outcome, readProof(w).attempt, readProof(w).helperOpId], ['safe-legacy', 'attempt-nonce-1', 'helper-op']);
    fs.rmSync(path.join(w.root, 'hook-proof.json'));
    const w2 = makeCutoverWorld();
    const hash2 = cli(prepareArgs(w2)).json.manifestHash;
    const env2 = proofEnv(w2);
    assert.equal(cli(['cutover', '--ops-dir', w2.opsDir, '--confirm-manifest-hash', hash2], env2).status, 0);
    assert.equal(readProof(w2).outcome, 'safe-new');
    fs.rmSync(path.join(w2.root, 'hook-proof.json'));
    const back = cli(['rollback-precutover', '--ops-dir', w2.opsDir, '--confirm-manifest-hash', hash2], env2);
    assert.equal(back.status, 0, back.stderr);
    assert.equal(readProof(w2).outcome, 'safe-legacy');
  });

  /** Black-box preload: tampers with the synthetic world only once the marker file already exists (i.e. after the commit). */
  const writePreload = (w, mode) => {
    const file = path.join(w.root, `preload-${mode}.mjs`);
    fs.writeFileSync(file, `import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const { SYNTH_LEGACY, SYNTH_CONTROL, SYNTH_MODE } = process.env;
const markerFile = path.join(SYNTH_CONTROL, 'history-backend.json');
let fired = false;
const readdir = fs.readdirSync;
const readFile = fs.readFileSync;
let markerReads = 0;
fs.readdirSync = function patched(target, ...rest) {
  if (SYNTH_MODE === 'source' && !fired && path.resolve(String(target)) === SYNTH_LEGACY && fs.existsSync(markerFile)) {
    fired = true;
    const victim = readdir.call(fs, SYNTH_LEGACY).find((name) => name.endsWith('.json'));
    fs.appendFileSync(path.join(SYNTH_LEGACY, victim), ' ');
  }
  return readdir.call(this, target, ...rest);
};
fs.readFileSync = function patched(target, ...rest) {
  // Marker reads: 1 = pre-flight (absent), 2 = inside the coordinated commit, 3 = the post-commit readback.
  if (target === markerFile && ++markerReads === 3 && SYNTH_MODE === 'readback') return '{"tampered":true}';
  return readFile.call(this, target, ...rest);
};
syncBuiltinESMExports();
`);
    return file;
  };
  const cutoverWithPreload = (w, hash, mode) => {
    const paths = resolveCutoverPaths(w.dataRoot);
    const env = { ...proofEnv(w), SYNTH_MODE: mode, SYNTH_LEGACY: w.legacyDir, SYNTH_CONTROL: paths.controlDir, NODE_OPTIONS: `--import ${writePreload(w, mode)}` };
    return { res: cli(['cutover', '--ops-dir', w.opsDir, '--confirm-manifest-hash', hash], env), paths };
  };

  it('writes NO proof when validation fails after the marker was committed (final source hash, marker readback): fail closed, marker stays', () => {
    for (const mode of ['source', 'readback']) {
      const w = makeCutoverWorld();
      const hash = cli(prepareArgs(w)).json.manifestHash;
      const { res, paths } = cutoverWithPreload(w, hash, mode);
      assert.notEqual(res.status, 0, `${mode}: ${res.stdout.slice(-300)}${res.stderr}`);
      assert.equal(readProof(w), null, `${mode}: no restart proof`);
      const status = JSON.parse(fs.readFileSync(path.join(w.opsDir, 'cutover-status.json'), 'utf8'));
      assert.equal(status.state, 'failed-after-marker', mode);
      assert.equal(status.error.code, mode === 'source' ? 'cutover_source_changed' : 'history_backend_marker_invalid');
      assert.ok(fs.existsSync(path.join(paths.controlDir, 'history-backend.json')), `${mode}: the marker stays for the operator`);
    }
  });

  it('writes no proof (the helper stays stopped) when recover finds a committed marker or the pre-ACK rollback is refused', () => {
    const w = makeCutoverWorld();
    const hash = cli(prepareArgs(w)).json.manifestHash;
    assert.equal(cli(['cutover', '--ops-dir', w.opsDir, '--confirm-manifest-hash', hash]).status, 0);
    const env = proofEnv(w);
    const recover = cli(['recover', '--ops-dir', w.opsDir, '--confirm-manifest-hash', hash], env);
    assert.equal(recover.status, 3);
    assert.equal(recover.json.ok, false);
    assert.equal(readProof(w), null);
  });

  it('recover and rollback-precutover pin the tool like cutover and verify: a changed tool is refused before any write', () => {
    const w = makeCutoverWorld();
    const hash = cli(prepareArgs(w)).json.manifestHash;
    assert.equal(cli(['cutover', '--ops-dir', w.opsDir, '--confirm-manifest-hash', hash]).status, 0);
    const manifestFile = path.join(w.opsDir, 'cutover-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    manifest.tool.digest = 'f'.repeat(64);
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    const paths = resolveCutoverPaths(w.dataRoot);
    for (const command of ['recover', 'rollback-precutover']) {
      const res = cli([command, '--ops-dir', w.opsDir, '--confirm-manifest-hash', hash]);
      assert.equal(res.error?.code, 'cutover_tool_changed', command);
      assert.equal(readHistoryBackendMarker(paths.controlDir, { traceDirs: paths }).backend, 'sqlite', `${command}: nothing was changed`);
    }
  });

  it('tags the end state of a failed run: clean abort, abort that could not revert code, and failure after the marker', () => {
    const outcomeOf = (point, sabotage) => {
      const w = makeCutoverWorld();
      const prepared = cli(prepareArgs(w));
      const manifest = JSON.parse(read(w.opsDir, 'cutover-manifest.json'));
      let caught = null;
      try {
        runQuiescedCutover({ manifest, confirmManifestHash: prepared.json.manifestHash, faultHook: (p) => {
          if (p !== point) return;
          sabotage?.(w);
          throw Object.assign(new Error('injected'), { code: 'injected' });
        } });
      } catch (error) {
        caught = error;
      }
      return caught?.cutoverOutcome;
    };
    assert.equal(outcomeOf('after-source-plan'), 'failed-before-writes');
    assert.equal(outcomeOf('after-code-apply'), 'aborted-before-marker');
    assert.equal(outcomeOf('after-code-apply', (w) => write(w.main, 'lib/copy.js', lines('someone else edited this'))), 'abort-failed');
    assert.equal(outcomeOf('after-marker'), 'failed-after-marker');
  });
});

describe('post-check evidence under retention (receipt/watermark aware)', () => {
  const openRuntime = async (paths) => {
    const coordinator = makeCoordinator(paths.controlDir);
    coordinator.acquire();
    const runtime = await openChatHistoryRuntime({ ...paths, coordinator });
    return { runtime, close: async () => { await runtime.close(); coordinator.release(); } };
  };
  const withFullChat = async (fn) => {
    const w = makeCutoverWorld();
    const id = chatIdOf(1);
    const doc = { v: 1, chatId: id, cursorSessionId: 'sess', headSeq: 2000, updatedAt: '2026-10-05T00:00:00.000Z', events: Array.from({ length: 2000 }, (_, i) => ({ seq: i + 1, rec: userRec(`synthetic ${i}`) })) };
    fs.writeFileSync(path.join(w.legacyDir, `${id}.json`), JSON.stringify(doc));
    const prep = cli(prepareArgs(w));
    assert.equal(prep.status, 0, prep.stderr);
    assert.equal(cli(['cutover', '--ops-dir', w.opsDir, '--confirm-manifest-hash', prep.json.manifestHash]).status, 0);
    return fn(w, resolveCutoverPaths(w.dataRoot), id);
  };
  const appendAck = async (paths, id, text) => {
    const rt = await openRuntime(paths);
    try {
      const ack = await rt.runtime.adapter.appendChatHistoryEvents(id, '', [{ rec: userRec(text) }], { coalesce: false });
      assert.equal(ack.ok, true);
    } finally {
      await rt.close();
    }
  };
  const sql = (paths, statement) => {
    const db = new DatabaseSync(path.join(paths.dbDir, 'cretli-store.sqlite'));
    try { db.exec(statement); } finally { db.close(); }
  };

  it('a normal append at the 2000 cap trims the oldest imported event: the evidence stays ok (no count monotonicity)', async () => {
    await withFullChat(async (w, paths, id) => {
      const first = path.join(w.root, 'ev1.json');
      assert.equal(cli(['post-check', '--ops-dir', w.opsDir, '--out', first]).json.ok, true);
      await appendAck(paths, id, 'append one');
      const second = path.join(w.root, 'ev2.json');
      const mid = cli(['post-check', '--ops-dir', w.opsDir, '--previous', first, '--out', second]);
      assert.equal(mid.json.ok, true, JSON.stringify(mid.json.problems));
      assert.ok(mid.json.counts.importedEvents < 2004, 'the retention trim removed an imported event');
      await appendAck(paths, id, 'append two');
      const third = cli(['post-check', '--ops-dir', w.opsDir, '--previous', second]);
      assert.equal(third.json.ok, true, JSON.stringify(third.json.problems));
      assert.ok(mid.json.anchors.receipts >= 1);
    });
  });

  it('a missing earlier receipt always fails, even the oldest one and even after a later receipt', async () => {
    await withFullChat(async (w, paths, id) => {
      await appendAck(paths, id, 'ack one');
      await new Promise((resolve) => setTimeout(resolve, 15));
      await appendAck(paths, id, 'ack two');
      const evidence = path.join(w.root, 'ev.json');
      assert.equal(cli(['post-check', '--ops-dir', w.opsDir, '--out', evidence]).json.ok, true);
      const anchors = JSON.parse(fs.readFileSync(evidence, 'utf8')).anchors.receipts;
      assert.equal(anchors.length, 2);
      const [newest, oldest] = anchors;
      // The oldest receipt vanishes and a LATER receipt exists: no GC proof, so this is loss, not eviction.
      sql(paths, `DELETE FROM command_receipts WHERE command_id = '${oldest.commandId}'`);
      await new Promise((resolve) => setTimeout(resolve, 15));
      await appendAck(paths, id, 'ack three');
      const gone = cli(['post-check', '--ops-dir', w.opsDir, '--previous', evidence]);
      assert.equal(gone.status, 2);
      assert.ok(gone.json.problems.includes('earlier_receipt_missing'));
      // The newest acknowledged receipt vanishing fails too.
      sql(paths, `DELETE FROM command_receipts WHERE command_id = '${newest.commandId}'`);
      const lost = cli(['post-check', '--ops-dir', w.opsDir, '--previous', evidence]);
      assert.equal(lost.status, 2);
      assert.ok(lost.json.problems.includes('earlier_receipt_missing'));
    });
  });

  it('an actually deleted acknowledged event fails as earlier_write_missing (not receipt_changed); legal reset, delete and trim stay ok', async () => {
    await withFullChat(async (w, paths, id) => {
      await appendAck(paths, id, 'ack');
      const evidence = path.join(w.root, 'ev.json');
      const first = cli(['post-check', '--ops-dir', w.opsDir, '--out', evidence]);
      assert.equal(first.json.ok, true);
      const seq = JSON.parse(fs.readFileSync(evidence, 'utf8')).newEvents[0].seq;
      const db = () => new DatabaseSync(path.join(paths.dbDir, 'cretli-store.sqlite'));
      const keep = (() => { const d = db(); try { return d.prepare('SELECT * FROM chat_history_state WHERE chat_id = ?').get(id); } finally { d.close(); } })();
      // Legal: the chat was reset into a new epoch, so the old seq is gone.
      sql(paths, `DELETE FROM chat_history_events WHERE chat_id = '${id}' AND seq = ${seq}; UPDATE chat_history_state SET chat_epoch = 'new-epoch' WHERE chat_id = '${id}'`);
      assert.equal(cli(['post-check', '--ops-dir', w.opsDir, '--previous', evidence]).json.problems.includes('earlier_write_missing'), false, 'reset');
      // Legal: retention trim watermark covers the seq.
      sql(paths, `UPDATE chat_history_state SET chat_epoch = '${keep.chat_epoch}', trimmed_through_seq = ${seq} WHERE chat_id = '${id}'`);
      assert.equal(cli(['post-check', '--ops-dir', w.opsDir, '--previous', evidence]).json.problems.includes('earlier_write_missing'), false, 'trim');
      // Real loss: same epoch, no trim covering the seq, state and receipt intact.
      sql(paths, `UPDATE chat_history_state SET trimmed_through_seq = ${keep.trimmed_through_seq} WHERE chat_id = '${id}'`);
      const lost = cli(['post-check', '--ops-dir', w.opsDir, '--previous', evidence]);
      assert.equal(lost.status, 2);
      assert.ok(lost.json.problems.includes('earlier_write_missing'));
      assert.equal(lost.json.problems.includes('receipt_changed'), false);
      // Legal: the whole chat was deleted.
      sql(paths, `PRAGMA foreign_keys = OFF; DELETE FROM chat_history_events WHERE chat_id = '${id}'; DELETE FROM chat_history_epochs WHERE chat_id = '${id}'; DELETE FROM chat_history_state WHERE chat_id = '${id}'`);
      assert.equal(cli(['post-check', '--ops-dir', w.opsDir, '--previous', evidence]).json.problems.includes('earlier_write_missing'), false, 'delete');
    });
  });

  it('an earlier receipt pushed past the newest-200 anchor window is still found by primary key; deleting it fails', async () => {
    await withFullChat(async (w, paths) => {
      await appendAck(paths, chatIdOf(1), 'ack');
      const evidence = path.join(w.root, 'ev.json');
      assert.equal(cli(['post-check', '--ops-dir', w.opsDir, '--out', evidence]).json.ok, true);
      const old = JSON.parse(fs.readFileSync(evidence, 'utf8')).anchors.receipts[0];
      // Metadata-only: 201 newer synthetic receipt rows inserted straight into the temp DB.
      sql(paths, `INSERT INTO command_receipts (dataset_generation, command_id, request_digest, result_json, created_at)
        SELECT dataset_generation, 'synthetic-' || n, 'digest-' || n, '{}', ${Number(old.createdAt) + 1000} + n
        FROM (SELECT dataset_generation FROM command_receipts WHERE command_id = '${old.commandId}'),
        (WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 201) SELECT n FROM c)`);
      const found = cli(['post-check', '--ops-dir', w.opsDir, '--previous', evidence]);
      assert.equal(found.json.problems.includes('earlier_receipt_missing'), false, JSON.stringify(found.json.problems));
      sql(paths, `DELETE FROM command_receipts WHERE command_id = '${old.commandId}'`);
      const missing = cli(['post-check', '--ops-dir', w.opsDir, '--previous', evidence]);
      assert.ok(missing.json.problems.includes('earlier_receipt_missing'));
    });
  });

  it('a changed receipt result fails, and a lost non-trimmed acknowledged event fails', async () => {
    await withFullChat(async (w, paths, id) => {
      await appendAck(paths, id, 'ack');
      const evidence = path.join(w.root, 'ev.json');
      assert.equal(cli(['post-check', '--ops-dir', w.opsDir, '--out', evidence]).json.ok, true);
      sql(paths, "UPDATE command_receipts SET result_json = '{\"tampered\":true}'");
      assert.ok(cli(['post-check', '--ops-dir', w.opsDir, '--previous', evidence]).json.problems.includes('receipt_changed'));
    });
  });
});

