import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runner = path.join(projectRoot, 'scripts', 'run-unit-tests.mjs');
const fixtureDir = path.join(projectRoot, 'tests', 'fixtures', 'runner');

function run(args, env = {}) {
  return spawnSync(process.execPath, [runner, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, CRETLI_TEST_DIR: fixtureDir, CRETLI_TEST_JOBS: '', ...env },
  });
}

// Invalid --jobs values fail with a clear message.
for (const bad of ['0', '-2', '1.5', 'abc']) {
  const res = run(['--jobs', bad, 'a.test.js']);
  assert.equal(res.status, 1, `--jobs ${bad}`);
  assert.match(res.stderr, /--jobs must be a positive integer/);
}
assert.match(run(['--jobs']).stderr, /--jobs requires a value/);
assert.equal(run(['--jobs=0', 'a.test.js']).status, 1);
assert.match(run(['a.test.js'], { CRETLI_TEST_JOBS: 'x' }).stderr, /--jobs must be a positive integer/);

// Sequential: --jobs 1 and no flag give the same pass summary.
const seq = run(['--jobs', '1', 'a.test.js', 'b.test.js']);
assert.equal(seq.status, 0);
assert.match(seq.stdout, /2 test file\(s\) passed/);

// Parallel: --jobs=2 (and the env var) keep each file's output contiguous, one data dir each, exit code kept.
for (const res of [run(['--jobs=2', 'a.test.js', 'b.test.js', 'c.test.js']), run(['a.test.js', 'b.test.js', 'c.test.js'], { CRETLI_TEST_JOBS: '2' })]) {
  assert.equal(res.status, 1);
  assert.match(res.stderr, /FAILED c\.test\.js \(exit 3\)/);
  assert.match(res.stderr, /1\/3 test file\(s\) failed/);
  const lines = res.stdout.split('\n');
  const dirs = [];
  for (const id of ['a', 'b', 'c']) {
    const header = lines.indexOf(`==> ${id}.test.js`);
    assert.ok(header >= 0, `header for ${id}`);
    for (let i = 0; i < 5; i += 1) assert.equal(lines[header + 1 + i], `fixture-${id} line ${i}`);
    const dataLine = lines[header + 6];
    assert.match(dataLine, new RegExp(`^fixture-${id} data-dir \\S+ files=owner\\.txt$`));
    dirs.push(dataLine.split(' ')[2]);
  }
  assert.equal(new Set(dirs).size, 3, 'each file gets its own data dir');
}

// Parallel path: concurrency limit, timeout handling and per-file data-dir cleanup.
const parallelDir = path.join(projectRoot, 'tests', 'fixtures', 'runner-parallel');
const dataDirsOf = (stdout) => [...stdout.matchAll(/^DATA_DIR=(.+)$/gm)].map((m) => m[1]);

// Concurrency: 4 holding files with --jobs 2 never exceed 2 at once, and do reach 2.
const markDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-runner-marks-'));
try {
  const res = run(['--jobs', '2', 'hold1.test.js', 'hold2.test.js', 'hold3.test.js', 'hold4.test.js'], {
    CRETLI_TEST_DIR: parallelDir,
    RUNNER_FIXTURE_MARK_DIR: markDir,
  });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /4 test file\(s\) passed/);
  const seen = fs.readFileSync(path.join(markDir, 'concurrency.log'), 'utf8').trim().split('\n').map(Number);
  assert.equal(seen.length, 4);
  assert.ok(Math.max(...seen) <= 2, `concurrency exceeded the limit: ${seen}`);
  assert.equal(Math.max(...seen), 2, `expected two files to overlap: ${seen}`);
  // Data dirs are private per file and gone after the run.
  const dirs = dataDirsOf(res.stdout);
  assert.equal(new Set(dirs).size, 4);
  for (const dir of dirs) assert.equal(fs.existsSync(dir), false, `data dir not cleaned: ${dir}`);
} finally {
  fs.rmSync(markDir, { recursive: true, force: true });
}

// Timeout: a hanging file is killed and reported, siblings still pass, and its data dir is removed too.
{
  const started = Date.now();
  const timeoutMarkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-runner-marks-'));
  const res = run(['--jobs', '2', 'hang.test.js', 'hold1.test.js', 'hold2.test.js'], {
    CRETLI_TEST_DIR: parallelDir,
    CRETLI_TEST_FILE_TIMEOUT_MS: '1500',
    RUNNER_FIXTURE_MARK_DIR: timeoutMarkDir,
  });
  fs.rmSync(timeoutMarkDir, { recursive: true, force: true });
  assert.ok(Date.now() - started < 30000, 'runner must not hang');
  assert.equal(res.status, 1);
  assert.match(res.stderr, /FAILED hang\.test\.js \(timeout after \d+s\)/);
  assert.doesNotMatch(res.stderr, /FAILED hold/);
  assert.match(res.stderr, /1\/3 test file\(s\) failed/);
  const dirs = dataDirsOf(res.stdout);
  assert.equal(dirs.length, 3);
  for (const dir of dirs) assert.equal(fs.existsSync(dir), false, `data dir not cleaned: ${dir}`);
}

// Selection: --core-only runs tests/ only, --plugins-only runs harnesses/<id>/tests only, both flags conflict.
const pluginFixtures = path.join(projectRoot, 'tests', 'fixtures', 'runner-plugins');
const core = run(['--core-only', 'a.test.js', 'b.test.js']);
assert.equal(core.status, 0);
assert.match(core.stdout, /2 test file\(s\) passed/);
const coreAll = run(['--core-only'], { CRETLI_TEST_PLUGINS_DIR: pluginFixtures, CRETLI_TEST_JOBS: '2' });
assert.doesNotMatch(coreAll.stdout, /fixture-plugin-alpha/, 'core mode never scans plugin tests');
const plugins = run(['--plugins-only'], { CRETLI_TEST_PLUGINS_DIR: pluginFixtures });
assert.equal(plugins.status, 0);
assert.match(plugins.stdout, /fixture-plugin-alpha/);
assert.match(plugins.stdout, /1 test file\(s\) passed/);
const both = run(['a.test.js', 'p.test.js'], { CRETLI_TEST_PLUGINS_DIR: pluginFixtures });
assert.equal(both.status, 0, 'no flag runs both sets');
assert.match(both.stdout, /2 test file\(s\) passed/);
const conflict = run(['--core-only', '--plugins-only']);
assert.equal(conflict.status, 1);
assert.match(conflict.stderr, /cannot be combined/);
// A requested file that belongs to the other set is unknown in that mode.
assert.match(run(['--core-only', 'p.test.js'], { CRETLI_TEST_PLUGINS_DIR: pluginFixtures }).stderr, /Unknown test file/);
console.log('run-unit-tests-runner.test.js: ok');

// Port-collision guard: a test file that defaults a DOM server port to a fixed number must be
// listed as serial-only in the runner (or allocate a free port), otherwise --jobs > 1 collides.
{
  const runnerSource = fs.readFileSync(runner, 'utf8');
  const serialBlock = runnerSource.slice(runnerSource.indexOf('SERIAL_ONLY_TEST_FILES = new Set(['));
  for (const name of fs.readdirSync(path.join(projectRoot, 'tests'))) {
    if (!name.endsWith('.test.js') || name === 'run-unit-tests-runner.test.js') continue;
    const source = fs.readFileSync(path.join(projectRoot, 'tests', name), 'utf8');
    const fixedPort = /process\.env\.\w*DOM_PORT\s*\|\|\s*'\d+'/.test(source);
    if (!fixedPort) continue;
    assert.ok(serialBlock.includes(`'${name}'`), `${name} uses a fixed DOM port but is not serial-only`);
  }
}

// The sidebar DOM tests allocate a free port per run, so they must never fall back to a fixed one.
for (const name of ['sidebar-chat-row.test.js', 'sidebar-transient-patch.test.js']) {
  const source = fs.readFileSync(path.join(projectRoot, 'tests', name), 'utf8');
  assert.match(source, /await getFreePort\(\)/, `${name} must allocate its DOM server port dynamically`);
  assert.doesNotMatch(source, /DOM_PORT\s*\|\|/, `${name} must not default to a fixed DOM port`);
}

// Behavioural: two files that each bind a dynamically allocated port at the same time under
// --jobs 2 both pass and receive different ports (no EADDRINUSE-style collision).
{
  const res = spawnSync(process.execPath, [runner, '--jobs', '2', 'port1.test.js', 'port2.test.js'], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, CRETLI_TEST_DIR: path.join(projectRoot, 'tests', 'fixtures', 'runner-ports'), CRETLI_TEST_JOBS: '' },
  });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /2 test file\(s\) passed/);
  const ports = [...res.stdout.matchAll(/^PORT=(\d+)$/gm)].map((m) => m[1]);
  assert.equal(ports.length, 2, 'both fixtures report a port');
  assert.equal(new Set(ports).size, 2, 'parallel files get distinct ports');
}
