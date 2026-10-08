import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { execScoutGit, describeScoutGitError } from '../lib/workspace-scout-git.js';
import { buildScoutPreview, collectScoutSignalsForProfile, runWorkspaceWatcherScoutPass, WORKSPACE_SCOUT_MAX_CHANGED_FILES } from '../lib/workspace-watcher-scout.js';
import { runWorkspaceWatcherScoutNow } from '../lib/workspace-watcher-control.js';
import { getWorkspaceWatcher, upsertWorkspaceWatcher, upsertWorkspaceScoutProfile } from '../lib/persist/workspace-watchers-persist.js';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import { renderScoutPreviewHtml } from '../app_front/features/watcher/scoutProfileEditorView.js';
import { renderScoutScanRow } from '../app_front/features/watcher/scoutHistoryView.js';
import { scoutRunResultText } from '../app_front/features/watcher/scoutProfilesView.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-git-scope-'));
let sequence = 0;
after(() => { fs.rmSync(root, { recursive: true, force: true }); removeIsolatedDataDir(); });

function createRepo(branch = 'master') {
  const cwd = path.join(root, `repo-${sequence++}`);
  fs.mkdirSync(cwd);
  execFileSync('git', ['init', '-q', '-b', branch, cwd]);
  fs.mkdirSync(path.join(cwd, 'lib'));
  fs.writeFileSync(path.join(cwd, 'lib', 'a.js'), 'initial\n');
  git(cwd, ['add', '.']);
  git(cwd, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial']);
  return cwd;
}

function git(cwd, args) {
  return execFileSync('git', ['-c', `safe.directory=${cwd}`, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function profile(base = 'auto', scope = {}) {
  return { id: 'scope-test', name: 'Scope test', categories: ['bug'], enabled: true, objective: 'Review changed files', sources: ['diff', 'todoMarkers'],
    scope: { mode: 'changes', base, include: [], exclude: [], ...scope },
    executor: { auto: true, allowedHarnesses: ['codex'] }, schedule: { mode: 'interval', intervalHours: 6 } };
}

function signals(cwd, base = 'auto', scope = {}, deps = {}) {
  return collectScoutSignalsForProfile(profile(base, scope), { workspaceFolder: cwd }, deps);
}

test('main missing with master present is an explicit error, never an empty scope or silent fallback', () => {
  const cwd = createRepo();
  fs.writeFileSync(path.join(cwd, 'lib', 'a.js'), 'changed\n');
  const preview = buildScoutPreview(profile('main'), { workspaceFolder: cwd });
  assert.equal(preview.signals.scopeStatus, 'error');
  assert.equal(preview.signals.scopeError.code, 'git_base_missing');
  assert.match(preview.signals.scopeError.message, /master/);
  assert.equal(preview.prompt, '');
  assert.ok(!preview.blockers.some((blocker) => blocker.code === 'no_files_in_scope'));
  const html = renderScoutPreviewHtml({ preview });
  assert.match(html, /git_base_missing/);
  assert.match(html, /master/);
  assert.ok(!html.includes('data-scout-preview-no-files'));
});

test('arbitrary explicit missing base does not fall back even with changed files', () => {
  const cwd = createRepo('main');
  fs.writeFileSync(path.join(cwd, 'new.js'), 'new\n');
  const result = signals(cwd, 'typo-branch');
  assert.equal(result.scopeStatus, 'error');
  assert.equal(result.resolvedBase, '');
  assert.equal(result.scopeError.code, 'git_base_missing');
});

test('auto chooses main, then master, and only then HEAD with visible diagnostics', () => {
  for (const branch of ['main', 'master', 'feature']) {
    const cwd = createRepo(branch);
    fs.writeFileSync(path.join(cwd, 'new.js'), 'new\n');
    const result = signals(cwd);
    assert.equal(result.resolvedBase, branch === 'feature' ? 'HEAD' : branch);
    assert.equal(result.baseCommit, git(cwd, ['rev-parse', 'HEAD']).trim());
    assert.equal(result.diagnostics[0].code, 'git_base_auto');
    assert.deepEqual(result.matchedFiles, ['new.js']);
  }
});

test('successful empty diff never tries a second base', () => {
  const cwd = createRepo('main');
  git(cwd, ['branch', 'master']);
  const calls = [];
  const result = signals(cwd, 'main', {}, { execGit: (args, directory) => { calls.push(args); return execScoutGit(args, directory); } });
  assert.equal(result.scopeStatus, 'empty');
  assert.equal(result.hasFiles, false);
  assert.equal(result.resolvedBase, 'main');
  assert.equal(calls.filter((args) => args[0] === 'rev-parse').length, 1);
  assert.equal(calls.filter((args) => args[0] === 'diff').length, 1);
});

test('untracked files, ignored files, include/exclude, dedupe and file limits', () => {
  const cwd = createRepo();
  fs.writeFileSync(path.join(cwd, '.gitignore'), '*.ignored\n');
  fs.writeFileSync(path.join(cwd, 'lib', 'new.js'), '// TODO: new work\n');
  fs.writeFileSync(path.join(cwd, 'lib', 'skip.js'), 'excluded\n');
  fs.writeFileSync(path.join(cwd, 'lib', 'hidden.ignored'), 'ignored\n');
  fs.writeFileSync(path.join(cwd, 'outside.js'), 'outside\n');
  fs.writeFileSync(path.join(cwd, 'lib', 'a.js'), 'modified\n');
  const result = signals(cwd, 'auto', { include: ['lib/**'], exclude: ['**/skip.js'] });
  assert.deepEqual(result.matchedFiles, ['lib/a.js', 'lib/new.js']);
  assert.deepEqual(result.untrackedFiles, ['lib/new.js']);
  assert.ok(result.markers.some((marker) => marker.startsWith('lib/new.js:')));
  for (let index = 0; index < WORKSPACE_SCOUT_MAX_CHANGED_FILES + 2; index += 1) fs.writeFileSync(path.join(cwd, `extra-${index}.js`), 'new\n');
  assert.equal(signals(cwd).matchedFiles.length, WORKSPACE_SCOUT_MAX_CHANGED_FILES);
});

test('file list and diff use one pinned commit even when the branch moves; diff includes only matched files', () => {
  const cwd = createRepo('main');
  const commit = git(cwd, ['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(path.join(cwd, 'lib', 'a.js'), 'modified\n');
  fs.writeFileSync(path.join(cwd, 'excluded.js'), 'outside\n');
  git(cwd, ['add', 'excluded.js']);
  const calls = [];
  const result = signals(cwd, 'main', { include: ['lib/**'] }, {
    execGit: (args, directory) => {
      calls.push(args);
      const output = execScoutGit(args, directory);
      if (args[0] === 'rev-parse') git(cwd, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qam', 'moving branch']);
      return output;
    },
  });
  assert.equal(result.baseCommit, commit);
  assert.deepEqual(result.matchedFiles, ['lib/a.js']);
  assert.match(result.diff, /modified/);
  assert.ok(!result.diff.includes('excluded.js'));
  for (const args of calls.filter((args) => args[0] === 'diff')) assert.ok(args.includes(commit));
});

test('Git errors distinguish ownership, repository, timeout, executable and failed commands', () => {
  const cases = [
    [{ stderr: 'fatal: detected dubious ownership', status: 128 }, 'git_ownership'],
    [{ stderr: 'fatal: not a git repository', status: 128 }, 'git_not_repository'],
    [{ code: 'ETIMEDOUT' }, 'git_timeout'],
    [{ code: 'ENOENT' }, 'git_unavailable'],
    [{ stderr: 'unknown error', status: 128 }, 'git_failed'],
  ];
  for (const [failure, code] of cases) {
    assert.equal(describeScoutGitError(failure).code, code);
    const result = signals(root, 'auto', {}, { execGit: () => { throw failure; } });
    assert.equal(result.scopeStatus, 'error');
    assert.equal(result.scopeError.code, code);
  }
  assert.throws(() => execScoutGit(['status'], root, { program: 'cretli-missing-git-executable' }), { code: 'git_unavailable' });
  assert.equal(signals(root).scopeError.code, 'git_not_repository');
});

test('diff failure cannot masquerade as an empty scan, and cannot trigger base fallback', () => {
  const cwd = createRepo('main');
  fs.writeFileSync(path.join(cwd, 'lib', 'a.js'), 'changed\n');
  const calls = [];
  const result = signals(cwd, 'main', {}, { execGit: (args, directory) => {
    calls.push(args);
    if (args[0] === 'diff' && !args.includes('--name-only')) throw Object.assign(new Error('diff timeout'), { code: 'git_timeout' });
    return execScoutGit(args, directory);
  } });
  assert.equal(result.scopeStatus, 'error');
  assert.equal(result.scopeError.code, 'git_timeout');
  assert.equal(result.resolvedBase, 'main');
  assert.ok(result.baseCommit);
  assert.equal(calls.filter((args) => args[0] === 'rev-parse').length, 1);
});

test('actual child timeout retains a diagnostic; auto on an unborn repository does not pretend it is empty', () => {
  const program = path.join(root, 'slow-git');
  fs.writeFileSync(program, '#!/bin/sh\nexec sleep 2\n', { mode: 0o700 });
  assert.throws(() => execScoutGit(['status'], root, { program, timeout: 20 }), { code: 'git_timeout' });
  const cwd = path.join(root, `unborn-${sequence++}`);
  execFileSync('git', ['init', '-q', '-b', 'main', cwd]);
  assert.equal(signals(cwd).scopeStatus, 'error');
  assert.equal(signals(cwd).scopeError.code, 'git_base_missing');
});

test('selected subdirectory keeps tracked and untracked paths relative and outside changes excluded', () => {
  const cwd = createRepo();
  fs.writeFileSync(path.join(cwd, 'lib', 'a.js'), 'modified\n');
  fs.writeFileSync(path.join(cwd, 'lib', 'new.js'), 'new\n');
  fs.writeFileSync(path.join(cwd, 'outside.js'), 'outside\n');
  const result = signals(path.join(cwd, 'lib'), 'master');
  assert.deepEqual(result.matchedFiles, ['a.js', 'new.js']);
  assert.ok(!result.diff.includes('outside.js'));
  assert.match(result.diff, /modified/);
});

test('scope reads never execute repository-configured filesystem monitor or diff helpers', () => {
  const cwd = createRepo('main');
  const helper = path.join(cwd, 'helper');
  fs.writeFileSync(helper, '#!/bin/sh\n: > "$0.ran"\n', { mode: 0o700 });
  fs.writeFileSync(path.join(cwd, '.gitattributes'), '*.js diff=unsafe\n');
  git(cwd, ['config', 'core.fsmonitor', helper]);
  git(cwd, ['config', 'diff.external', helper]);
  git(cwd, ['config', 'diff.unsafe.textconv', helper]);
  fs.writeFileSync(path.join(cwd, 'lib', 'a.js'), 'modified\n');
  const result = signals(cwd, 'main', { include: ['lib/**'] });
  assert.equal(result.scopeStatus, 'ready');
  assert.match(result.diff, /modified/);
  assert.equal(fs.existsSync(`${helper}.ran`), false);
});

test('inherited Git routing cannot redirect scope reads to a different repository', () => {
  const cwd = createRepo('main');
  const other = createRepo('master');
  fs.writeFileSync(path.join(cwd, 'new.js'), 'new\n');
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(other, '.git');
  try {
    const result = signals(cwd, 'main');
    assert.equal(result.scopeStatus, 'ready');
    assert.equal(result.resolvedBase, 'main');
    assert.deepEqual(result.matchedFiles, ['new.js']);
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
  }
});

test('status and history show diagnostic details and resolved bases without treating empty scopes as scans', () => {
  assert.equal(scoutRunResultText({ reason: 'scope_error', error: { code: 'git_base_missing', message: 'Select master instead of missing main.' } }), 'Select master instead of missing main.');
  assert.ok(!scoutRunResultText({ reason: 'no_files_in_scope' }).includes('no_files_in_scope'));
  const html = renderScoutScanRow({ status: 'failed', error: 'Scope collection failed', scopeResolution: {
    resolvedBase: 'master', baseCommit: 'b'.repeat(40), diagnostics: [{ code: 'git_timeout', message: '<diff timeout>' }],
  } });
  assert.match(html, /master/);
  assert.match(html, /git_timeout/);
  assert.match(html, /&lt;diff timeout&gt;/);
  assert.ok(!html.includes('<diff timeout>'));
});

test('foreign-owned repository reads use per-command trust without writing config or index', { skip: process.getuid?.() !== 0 }, () => {
  const cwd = createRepo();
  fs.writeFileSync(path.join(cwd, 'lib', 'a.js'), 'changed\n');
  fs.writeFileSync(path.join(cwd, 'new.js'), 'new\n');
  const config = fs.readFileSync(path.join(cwd, '.git', 'config'));
  const index = fs.readFileSync(path.join(cwd, '.git', 'index'));
  const globalTrust = spawnSync('git', ['config', '--global', '--get-all', 'safe.directory'], { encoding: 'utf8' }).stdout;
  fs.chownSync(cwd, 65534, 65534);
  fs.chownSync(path.join(cwd, '.git'), 65534, 65534);
  assert.throws(() => execFileSync('git', ['-c', 'safe.directory=', 'rev-parse', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }), (error) => /dubious ownership/.test(String(error.stderr)));
  const result = signals(cwd, 'master');
  assert.equal(result.scopeStatus, 'ready');
  assert.deepEqual(result.matchedFiles, ['lib/a.js', 'new.js']);
  assert.deepEqual(fs.readFileSync(path.join(cwd, '.git', 'config')), config);
  assert.deepEqual(fs.readFileSync(path.join(cwd, '.git', 'index')), index);
  assert.equal(spawnSync('git', ['config', '--global', '--get-all', 'safe.directory'], { encoding: 'utf8' }).stdout, globalTrust);
});

test('manual trigger and scheduler never start a model for errors or empty scope and refund both budgets', async () => {
  for (const scenario of ['empty', 'bad-base', 'ownership', 'legacy-empty', 'legacy-error']) {
    const cwd = createRepo('main');
    const dataDir = path.join(root, `data-${sequence++}`);
    upsertWorkspaceWatcher(cwd, { mode: 'observe', policy: { scoutEnabled: true } }, { dataDir });
    if (!scenario.startsWith('legacy')) assert.equal(upsertWorkspaceScoutProfile(cwd, profile(scenario === 'bad-base' ? 'typo' : 'main'), { dataDir }).ok, true);
    let starts = 0;
    const deps = { runScout: async () => { starts += 1; return { started: true }; } };
    if (scenario === 'ownership' || scenario === 'legacy-error') deps.execGit = () => { throw { stderr: 'fatal: detected dubious ownership', status: 128 }; };
    const scoutId = scenario.startsWith('legacy') ? undefined : 'scope-test';
    const manual = await runWorkspaceWatcherScoutNow({ workspaceFolder: cwd, dataDir, scoutId, deps });
    const hasError = !scenario.endsWith('empty');
    assert.equal(manual.reason, hasError ? 'scope_error' : 'no_files_in_scope');
    assert.equal(manual.scanned, false);
    const pass = await runWorkspaceWatcherScoutPass({ workspaceFolders: [cwd], dataDir, deps });
    assert.equal(pass.started, 0);
    assert.equal(pass.errors.length, hasError ? 1 : 0);
    assert.equal(starts, 0);
    const row = getWorkspaceWatcher(cwd, { dataDir });
    assert.equal(row.scoutScans.count, 0);
    assert.equal(row.lastScoutAt, '');
    assert.equal(row.scoutSchedules[scoutId || 'scout-general']?.count || 0, 0);
    assert.equal(row.activeScoutScans.length, 0);
    assert.equal(row.scoutScanHistory.length, 2);
    for (const entry of row.scoutScanHistory) {
      assert.equal(entry.status, hasError ? 'failed' : 'skipped');
      assert.equal(entry.scopeResolution.status, hasError ? 'error' : 'empty');
    }
  }
});
