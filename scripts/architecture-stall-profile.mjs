#!/usr/bin/env node
/**
 * V6/V8 stall profile (docs/architecture-stall-profile.md). Exercises the blocking
 * sites inventoried in docs/architecture-sync-io-inventory.json that are reachable
 * WITHOUT external services and records, per site, the main-thread stall:
 *
 * - per-call wall time of the synchronous call (n, P50, P95, P99, max), which IS the
 *   stall the call imposes on the event loop,
 * - event-loop delay of the whole site window sampled at 1 ms with
 *   perf_hooks.monitorEventLoopDelay (the resolution required by docs/storage-gates.md).
 *
 * P99 is labelled `stable` only from n >= 1000 samples; otherwise `exploratory`.
 * Sites that cannot be driven in isolation are listed as `not measured` with a reason.
 *
 * Isolation: everything runs in a child process whose CRETLI_DATA_DIR points at a
 * fresh directory under os.tmpdir() (persistence paths bind to the env at first
 * import). The repository `data/` directory is never read or written.
 *
 * Usage:
 *   node scripts/architecture-stall-profile.mjs [--profile full|smoke] [--seed 20261017]
 *     [--out docs/architecture-stall-profile.json]
 * Reproduction of the committed profile:
 *   node scripts/architecture-stall-profile.mjs --profile full --out docs/architecture-stall-profile.json
 * Smoke profile (used by tests): --profile smoke
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);

export const THRESHOLDS = Object.freeze({
  source: 'docs/storage-gates.md (Event loop)',
  resolutionMs: 1,
  eventLoopP99Ms: 25,
  eventLoopMaxMs: 100,
});
const STABLE_P99_SAMPLES = 1000;

/**
 * One-off pre-fix measurement of the only stage-6-owned site that exceeded the
 * thresholds, recorded before `lib/files-list.js` switched to a shared Intl.Collator
 * (same script, profile `full`, 20 000 entries in one directory, n = 200 exploratory).
 * It cannot be regenerated without reverting that change; it is kept as evidence.
 */
export const PRE_FIX_REFERENCE = Object.freeze({
  'V8-files-list-20000-entries': {
    change: 'lib/files-list.js: per-call String#localeCompare(..., { sensitivity: "base" }) replaced by one shared Intl.Collator',
    callMs: { n: 200, p50: 83.953, p95: 87.422, p99: 90.175, p99Label: 'exploratory', max: 96.069 },
    eventLoopMs: { p50: 85.787, p99: 95.355, max: 101.777 },
  },
});

/** Coarse platform label; no kernel string or exact CPU count in committed output. */
function describePlatform() {
  const isWsl = process.platform === 'linux' && /microsoft|wsl/i.test(os.release());
  return isWsl ? 'linux (WSL2)' : process.platform;
}

/** Sample counts per profile. `heavy` = process-spawning or contention sites. */
const PROFILES = Object.freeze({
  full: { fs: 1000, git: 200, heavy: 20, fixtureChats: 5000, fixtureProfile: 'full', gitFiles: 3000, tree: 20000, ptyMessages: 5000, browserOps: 300 },
  smoke: { fs: 30, git: 10, heavy: 3, fixtureChats: 200, fixtureProfile: 'smoke', gitFiles: 100, tree: 500, ptyMessages: 200, browserOps: 20 },
});

/** @param {number[]} samples */
export function stats(samples) {
  if (!samples.length) return { n: 0, p50: null, p95: null, p99: null, p99Label: 'n/a', max: null };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
  const round = (v) => Math.round(v * 1000) / 1000;
  const n = sorted.length;
  return {
    n,
    p50: round(at(50)),
    p95: round(at(95)),
    p99: round(at(99)),
    p99Label: n >= STABLE_P99_SAMPLES ? 'stable' : 'exploratory',
    max: round(sorted[n - 1]),
  };
}

/**
 * Verdict of one site against the thresholds. A call that blocks longer than the
 * event-loop P99 budget, or the event-loop max over the window above its max
 * budget, `exceeds`. With fewer than 1000 samples the verdict is `exploratory`.
 *
 * @param {{ callMs: ReturnType<typeof stats>, eventLoopMs: { p99: number, max: number } | null }} row
 */
export function classify(row) {
  const call = row.callMs;
  if (!call || !call.n) return 'not-measured';
  const over = call.p99 > THRESHOLDS.eventLoopP99Ms
    || call.max > THRESHOLDS.eventLoopMaxMs
    || (row.eventLoopMs && row.eventLoopMs.max > THRESHOLDS.eventLoopMaxMs);
  if (call.p99Label !== 'stable') return over ? 'exceeds (exploratory)' : 'within (exploratory)';
  return over ? 'exceeds' : 'within';
}

// ---------------------------------------------------------------------------
// Parent: spawn the isolated child, merge, write JSON + Markdown
// ---------------------------------------------------------------------------

function runParent() {
  const profile = option('--profile', 'full');
  const seed = Number(option('--seed', '20261017'));
  const out = option('--out', '');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-stall-profile-'));
  const dataDir = path.join(dir, 'data');
  try {
    const env = { ...process.env, CRETLI_DATA_DIR: dataDir, CURSOR_REMOTE_DATA_DIR: dataDir, HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null' };
    const stdout = execFileSync(process.execPath, [SELF, '--child', '--profile', profile, '--seed', String(seed), '--work', dir], {
      env,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const report = JSON.parse(stdout.trim().split('\n').pop());
    report.environment = {
      node: process.version,
      platform: describePlatform(),
      profile,
      seed,
      eventLoopResolutionMs: THRESHOLDS.resolutionMs,
    };
    try { report.environment.commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { /* not a checkout */ }
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (out) fs.writeFileSync(path.resolve(ROOT, out), json);
    else process.stdout.write(json);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Child: measurement helpers
// ---------------------------------------------------------------------------

const tick = () => new Promise((resolve) => setImmediate(resolve));
const histogram = monitorEventLoopDelay({ resolution: THRESHOLDS.resolutionMs });
const ns = (v) => Math.round((v / 1e6) * 1000) / 1000;

/**
 * Run `fn` `count` times (sync or async), timing each call and sampling the event
 * loop for the whole window. Yields to the loop between calls so the 1 ms sampler
 * can observe the stall each call causes.
 *
 * @param {() => unknown} fn
 * @param {number} count
 * @param {number} [warmup]
 */
async function sample(fn, count, warmup = 3) {
  for (let i = 0; i < warmup; i += 1) { await fn(); await tick(); }
  const calls = [];
  histogram.reset();
  histogram.enable();
  for (let i = 0; i < count; i += 1) {
    const t0 = performance.now();
    await fn();
    calls.push(performance.now() - t0);
    await tick();
  }
  histogram.disable();
  return {
    callMs: stats(calls),
    eventLoopMs: { p50: ns(histogram.percentile(50)), p99: ns(histogram.percentile(99)), max: ns(histogram.max) },
  };
}

/** @type {object[]} */
const rows = [];

/**
 * @param {object} meta
 * @param {string} meta.id
 * @param {string} meta.group
 * @param {string} meta.site
 * @param {string} meta.owner  A2 | A4 | R3 | A3b | stage-6 | other
 * @param {string} meta.requestPath  yes | no | contention-only | startup
 * @param {string} [meta.note]
 * @param {() => unknown} fn
 * @param {number} count
 */
async function profileSite(meta, fn, count) {
  let result;
  try {
    result = await sample(fn, count);
  } catch (error) {
    rows.push({ ...meta, status: 'error', error: String(error?.message || error).slice(0, 300) });
    return;
  }
  const row = { ...meta, status: 'measured', ...result };
  row.verdict = classify(row);
  rows.push(row);
}

/** @param {object} meta */
function notMeasured(meta) {
  rows.push({ ...meta, status: 'not measured' });
}

/**
 * A second process that holds a directory lock (or any resource) for `holdMs`,
 * announces readiness on stdout and exits. Used to induce cross-process contention,
 * the only way the Atomics.wait lock backoffs can run.
 *
 * @param {string} code  source of the holder script
 * @returns {Promise<import('node:child_process').ChildProcess>}
 */
function startHolder(code, argv = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code, ...argv], { stdio: ['ignore', 'pipe', 'inherit'] });
    child.once('error', reject);
    child.stdout.once('data', () => resolve(child));
  });
}

async function runChild() {
  const profileName = option('--profile', 'full');
  const P = PROFILES[profileName];
  const seed = Number(option('--seed', '20261017'));
  const work = option('--work', '');
  const dataDir = process.env.CRETLI_DATA_DIR;
  if (!P || !work || !dataDir || path.resolve(dataDir).startsWith(path.join(ROOT, 'data'))) {
    throw new Error('child requires an isolated CRETLI_DATA_DIR and --work dir');
  }
  const started = Date.now();

  // Idle floor: what 1 ms sampling reports when nothing blocks.
  histogram.reset(); histogram.enable();
  await new Promise((resolve) => setTimeout(resolve, 500));
  histogram.disable();
  const idleFloor = { p50: ns(histogram.percentile(50)), p99: ns(histogram.percentile(99)), max: ns(histogram.max) };

  // ---- fixture (isolated, deterministic) ----
  const { populateFixture } = await import(pathToFileURL(path.join(ROOT, 'scripts/architecture-http-fixture.mjs')).href);
  const fixtureDir = path.join(work, 'data');
  const fixture = await populateFixture({ dir: fixtureDir, size: P.fixtureChats, profile: P.fixtureProfile, seed });

  // ---- A. Atomics.wait sites ----
  const opencodeReg = await import('../harnesses/opencode/opencode-port-registry.js');
  const childReg = await import('../lib/child-process-registry.js');
  const ownerLock = await import('../lib/delegation-owner-lock.js');
  const usage = await import('../lib/persist/usage-persist.js');
  const { createUsageEvent } = await import('../lib/usage/usage-event.js');

  const holderLockScript = `
    const fs = require('fs'); const [lock, holdMs] = process.argv.slice(1);
    fs.mkdirSync(require('path').dirname(lock), { recursive: true });
    fs.mkdirSync(lock);
    process.stdout.write('ready\\n');
    setTimeout(() => { try { fs.rmdirSync(lock); } catch {} process.exit(0); }, Number(holdMs));`;

  // Helper processes are killed in finally so a failing site cannot leak them.
  let liveReturns = 0;
  const helperProcs = [];
  const trackHelper = (proc) => { helperProcs.push(proc); return proc; };
  try {
    // child-process-registry: uncontended (every spawn of a PTY/agent/terminal registers here).
    const sleepers = Array.from({ length: 8 }, () => trackHelper(spawn('sleep', ['300'], { stdio: 'ignore' })));
    let sleeperIndex = 0;
    await profileSite({
      id: 'AW-child-process-registry-uncontended',
      group: 'atomics-wait',
      site: 'lib/child-process-registry.js:130 (registry lock, uncontended register+unregister)',
      owner: 'stage-6',
      requestPath: 'yes',
      note: 'registerChildProcess/unregisterChildProcess run on every terminal/agent PTY spawn and exit; uncontended path never reaches Atomics.wait.',
    }, () => {
      const pid = sleepers[sleeperIndex++ % sleepers.length].pid;
      childReg.registerChildProcess({ pid, type: 'profile', label: 'stall-profile' });
      childReg.unregisterChildProcess(pid);
    }, P.fs);

    // contended variants: holder keeps the lock for 40 ms -> poll backoff (25 ms steps) blocks the loop.
    const contended = async (id, site, owner, lockPath, fn, note) => {
      const calls = [];
      histogram.reset(); histogram.enable();
      for (let i = 0; i < P.heavy; i += 1) {
        const holder = await startHolder(holderLockScript, [lockPath, '40']);
        const t0 = performance.now();
        try { fn(i); } catch { /* lock timeout is a valid outcome */ }
        calls.push(performance.now() - t0);
        await new Promise((resolve) => holder.once('exit', resolve));
        await tick();
      }
      histogram.disable();
      const row = {
        id, group: 'atomics-wait', site, owner, requestPath: 'contention-only', note, status: 'measured',
        callMs: stats(calls),
        eventLoopMs: { p50: ns(histogram.percentile(50)), p99: ns(histogram.percentile(99)), max: ns(histogram.max) },
      };
      row.verdict = classify(row);
      rows.push(row);
    };
    let contendedPid = 0;
    const spawnedForContention = trackHelper(spawn('sleep', ['300'], { stdio: 'ignore' }));
    await contended(
      'AW-child-process-registry-contended',
      'lib/child-process-registry.js:130 (registry lock held by another process for 40 ms)',
      'stage-6',
      `${childReg.getChildProcessRegistryPath()}.lock`,
      () => { contendedPid += 1; childReg.unregisterChildProcess(spawnedForContention.pid); childReg.registerChildProcess({ pid: spawnedForContention.pid, type: 'profile', label: `c${contendedPid}` }); },
      'Stall is the holder critical-section time rounded up to the 25 ms poll step. Requires a second process touching the same registry (second server instance, CLI).',
    );

    await profileSite({
      id: 'AW-opencode-port-registry-uncontended',
      group: 'atomics-wait',
      site: 'harnesses/opencode/opencode-port-registry.js:83 (port registry lock, uncontended write+remove)',
      owner: 'stage-6',
      requestPath: 'no',
      note: 'Runs when an OpenCode serve process is started/stopped, not per request.',
    }, () => {
      const entry = opencodeReg.createOpenCodePortOwnerEntry({ pid: process.pid + 1, port: 4999, instanceKey: 'profile', cmdline: 'opencode serve --port 4999' });
      if (entry) opencodeReg.writeOpenCodePortOwner(4999, entry);
      opencodeReg.removeOpenCodePortOwner(4999, 'profile');
    }, P.fs);
    await contended(
      'AW-opencode-port-registry-contended',
      'harnesses/opencode/opencode-port-registry.js:83 (port registry lock held by another process for 40 ms)',
      'stage-6',
      `${opencodeReg.getOpenCodePortRegistryPath()}.lock`,
      () => { const e = opencodeReg.createOpenCodePortOwnerEntry({ pid: process.pid + 1, port: 4998, instanceKey: 'profile', cmdline: 'opencode serve --port 4998' }); if (e) opencodeReg.writeOpenCodePortOwner(4998, e); opencodeReg.removeOpenCodePortOwner(4998, 'profile'); },
      'Cross-process only; same poll-step arithmetic as the child-process registry.',
    );

    // usage ledger: uncontended commit is the hot path (each finished harness run).
    let usageSeq = 0;
    const usageCtx = { dataDir: path.join(dataDir, 'usage-profile') };
    await profileSite({
      id: 'AW-usage-ledger-uncontended',
      group: 'atomics-wait',
      site: 'lib/persist/usage-persist.js:1389 (ledger lock; commitUsageEvent uncontended, includes journal append + index persist)',
      owner: 'stage-6',
      requestPath: 'yes',
      note: 'commitUsageEvent runs at every harness run start/finish. Uncontended path never reaches Atomics.wait; the stall measured here is the synchronous journal+index fs work.',
    }, () => {
      usageSeq += 1;
      return usage.commitUsageEvent(createUsageEvent({
        harness: 'sdk', provider: 'cursor', runId: `run-${usageSeq}`, sourceSessionId: `sess-${usageSeq}`,
        requestId: `req-${usageSeq}`, tokens: { textInput: 100, textOutput: 10 }, at: new Date(1_790_000_000_000 + usageSeq * 1000).toISOString(),
      }), usageCtx);
    }, P.fs);

    // owner lock socket probe (R3): Atomics.wait blocks while the connect callback can never run.
    const sockPath = path.join(work, 'probe.sock');
    trackHelper(await startHolder(`
      const net = require('net'); const s = net.createServer(() => {}); s.listen(process.argv[1], () => process.stdout.write('ready\\n')); setInterval(() => {}, 1e6);`, [sockPath]));
    liveReturns = 0;
    await profileSite({
      id: 'AW-owner-lock-socket-probe',
      group: 'atomics-wait',
      site: 'lib/delegation-owner-lock.js:159 (isLockSocketLive, 80 ms Atomics.wait)',
      owner: 'R3',
      requestPath: 'startup',
      note: 'READ-ONLY (recovery R3). Probed against a socket that IS listening in another process.',
    }, () => { if (ownerLock.isLockSocketLive(sockPath)) liveReturns += 1; }, P.heavy);
  } finally {
    for (const proc of helperProcs) { try { proc.kill(); } catch { /* already exited */ } }
  }
  const probeRow = rows[rows.length - 1];
  if (probeRow.status === 'measured') {
    probeRow.observed = { listeningSocketCalls: probeRow.callMs.n + 3, reportedLive: liveReturns };
  }

  notMeasured({
    id: 'AW-delegation-sqlite-busy-retry',
    group: 'atomics-wait',
    site: 'lib/persist/delegation-sqlite.js:118 (busy retry, 50 ms Atomics.wait)',
    owner: 'A2',
    requestPath: 'contention-only',
    reason: 'Storage-owned (A2 4fb174ca removes it with the sqlite-worker). Runs only when another process holds the SQLite database busy during open/migrate; by construction one 50 ms block per retry. Not driven here to avoid touching a storage-owned file path.',
  });
  notMeasured({
    id: 'AW-workspace-watchers-lock-backoff',
    group: 'atomics-wait',
    site: 'lib/persist/workspace-watchers-persist.js:2916 (lock backoff, caller ms)',
    owner: 'A4',
    requestPath: 'contention-only',
    reason: 'Storage-owned (A4 6e483edd). Private sleep helper reached only under cross-process lock contention; not exported, not driven.',
  });
  notMeasured({
    id: 'AW-model-pick-decisions-lock-backoff',
    group: 'atomics-wait',
    site: 'lib/persist/model-pick-decisions-persist.js:51 (lock backoff, caller ms)',
    owner: 'A4',
    requestPath: 'contention-only',
    reason: 'Storage-owned (A4/A5). Private sleep helper reached only under cross-process lock contention; not exported, not driven.',
  });

  // ---- B. Sync child processes (git helpers) ----
  const repo = path.join(work, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'profile@example.com');
  git('config', 'user.name', 'profile');
  for (let i = 0; i < P.gitFiles; i += 1) {
    const sub = path.join(repo, `d${i % 50}`);
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, `f${i}.txt`), `fixture ${i}\n`);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  for (let i = 0; i < 20; i += 1) fs.appendFileSync(path.join(repo, `d${i % 50}`, `f${i}.txt`), 'dirty\n');
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'u\n');

  const gitWorktree = await import('../lib/worktree/git-worktree.ts');
  const metricsGit = await import('../lib/delegation-metrics-git.js');
  const materialRev = await import('../lib/delegation-material-revision.js');
  const gitCli = await import('../lib/git-cli.js');
  const gitRepoNote = `${P.gitFiles} tracked files, 20 dirty, 1 untracked, tmp repo`;
  const gitSites = [
    ['SC-git-cli-status', 'lib/git-cli.js:30 runGitCommand(status --porcelain) via spawnSync', 'yes', 'lib/routes/git-routes.js calls it on /api/git/* requests (3-4 spawnSync per request).', () => gitCli.runGitCommand(['status', '--porcelain=v1', '-b'], repo)],
    ['SC-git-cli-is-repo', 'lib/git-cli.js:30 isGitRepo(rev-parse) via spawnSync', 'yes', 'Called before every git route handler.', () => gitCli.isGitRepo(repo)],
    ['SC-worktree-run-git-status', 'lib/worktree/git-worktree.ts:55 runGit(status) via execFileSync', 'yes', 'Worktree status/list routes and delegation integration.', () => gitWorktree.listWorktreeStatusEntries(repo)],
    ['SC-worktree-dirty-paths', 'lib/worktree/git-worktree.ts:55 listDirtyWorktreePaths', 'no', 'Leaf-checkpoint path (delegation cycle).', () => gitWorktree.listDirtyWorktreePaths(repo)],
    ['SC-material-revision', 'lib/delegation-material-revision.js:17,22 readDelegationMaterialRevision (2 execFileSync)', 'yes', 'Called from delegation-service review/verify gates and the delegation HTTP/MCP paths.', () => materialRev.readDelegationMaterialRevision(repo)],
    ['SC-metrics-git-snapshot', 'lib/delegation-metrics-git.js:17 captureGitSnapshot (3 execFileSync)', 'yes', 'Run start and run finish in delegation-run-bridge (delegation start/stop path).', () => metricsGit.captureGitSnapshot(repo)],
  ];
  for (const [id, site, requestPath, note, fn] of gitSites) {
    await profileSite({ id, group: 'sync-child', site, owner: 'stage-6', requestPath, note: `${note} Fixture: ${gitRepoNote}.` }, fn, P.git);
  }
  for (const [id, site, owner, reason] of [
    ['SC-tool-executor', 'lib/agent-harness/tool-executor.ts:320,333 spawnSync fallback', 'stage-6', 'Runs the model-requested shell command; duration is the external operation itself, not Cretli overhead.'],
    ['SC-chats-routes-agent-cli', 'lib/routes/chats-routes.js:1274 spawnSync(agent CLI create-chat)', 'stage-6', 'Requires the external agent CLI; time is dominated by the external binary.'],
    ['SC-fork-title', 'lib/fork-title.js:127,174 spawnSync(agent CLI)', 'stage-6', 'Requires the external agent CLI.'],
    ['SC-codex-logout', 'lib/codex/codex-device-login.ts:182 spawnSync(codex logout)', 'other', 'Requires the external codex CLI; manual user action.'],
    ['SC-zai-probe', 'harnesses/zai/zai-sdk-runtime.js:26 spawnSync(python -c import zai)', 'other', 'Requires python + zai package; cached capability probe.'],
    ['SC-sdk-history-isolation-probe', 'lib/sdk/sdk-history-isolation-probe.ts:492 spawnSync(node fork CLI)', 'other', 'Requires the cursor SDK fork CLI; probe, not a request path.'],
    ['SC-self-update', 'lib/self-update.js:269 spawnSync(git)', 'other', 'Manual self-update action against the real checkout; not driven against the repository.'],
    ['SC-shutdown-origin', 'lib/shutdown-origin.js:47 execFileSync(ps)', 'stage-6', 'Runs once during shutdown (bounded by PS_TIMEOUT_MS); not a steady-state path.'],
    ['SC-secret-scan', 'lib/secret-scan.js:74 execFileSync(git)', 'other', 'Run on explicit commit/scan actions.'],
    ['SC-todo-integration-proof', 'lib/todo-integration-proof.js:63,116 execFileSync(git)', 'stage-6', 'Integration-proof confirm action only; two git calls per explicit user/orchestrator action.'],
    ['SC-patch-scope', 'lib/worktree/patch-scope.ts:127 execFileSync(git apply --numstat)', 'stage-6', 'Smart-merge patch analysis; per integration action.'],
    ['SC-workspace-scout-git', 'lib/workspace-scout-git.js:34 / lib/workspace-watcher-scout.js:315 execFileSync', 'stage-6', 'Scout scans run on the Watcher schedule, not per request.'],
    ['SC-worktree-snapshot-commit', 'lib/worktree/git-worktree.ts:184-239 createDirtyTreeSnapshot / createWorktreeLeafCheckpoint (execFileSync commit-tree)', 'stage-6', 'Mutating (writes git objects); per todo start / leaf PASS, off the request path of normal reads. Not driven to avoid mutation helpers in the profile.'],
  ]) {
    notMeasured({ id, group: 'sync-child', site, owner, requestPath: 'no', reason });
  }

  // ---- C. Hot sync fs on request paths (fixture with chats/todos/usage) ----
  const chatsPersist = await import('../lib/persist/chats-persist.js');
  const { writeJsonAtomic } = await import('../lib/persist/atomic-write.js');
  const todosStore = await import('../lib/persist/todos-store.js');
  const delegations = await import('../lib/persist/delegations-persist.js');
  const chatList = chatsPersist.loadChats();
  const hotFolder = chatList[0].workspaceFolder;
  await profileSite({
    id: 'FS-chats-load-copy',
    group: 'sync-fs',
    site: `lib/persist/chats-persist.js loadChats() full copy (${chatList.length} chats)`,
    owner: 'A3b',
    requestPath: 'yes',
    note: 'Cached read; every call returns a full copy. Stage-1/3 request-local index addresses the per-request multiplier.',
  }, () => chatsPersist.loadChats(), P.fs);
  let chatToggle = 0;
  await profileSite({
    id: 'FS-chats-update-one',
    group: 'sync-fs',
    site: `lib/persist/chats-persist.js updateChat() (read copy + sync write of the whole chats.json, ${chatList.length} chats)`,
    owner: 'A3b',
    requestPath: 'yes',
    note: 'Writer is owned by storage A3b (metadata migration); measured only to attribute the stall.',
  }, () => { chatToggle += 1; chatsPersist.updateChat(chatList[1].id, { title: `Fixture chat renamed ${chatToggle % 7}` }); }, Math.min(P.fs, 300));
  const bigDoc = { chats: chatList };
  await profileSite({
    id: 'FS-write-json-atomic-large',
    group: 'sync-fs',
    site: `lib/persist/atomic-write.js writeJsonAtomic (pretty-printed, ${chatList.length} chat objects)`,
    owner: 'other',
    requestPath: 'yes',
    note: 'Shared helper (JSON.stringify indent 2 + writeFileSync + renameSync, no fsync).',
  }, () => writeJsonAtomic(path.join(work, 'atomic-large.json'), bigDoc), Math.min(P.fs, 200));
  let todoSeq = 0;
  await profileSite({
    id: 'FS-todos-add',
    group: 'sync-fs',
    site: 'lib/persist/todos-store.js addTodo() (async facade; legacy backend: load + normalize + sync write of the workspace todo document)',
    owner: 'A4',
    requestPath: 'yes',
    note: 'Todos document writer belongs to storage A4/A5; measured to attribute the stall. Document grows during the run (TODOS_MAX_ITEMS=2000).',
  }, async () => { todoSeq += 1; try { await todosStore.addTodo(dataDir, hotFolder, { title: `Profile todo ${todoSeq}`, body: 'b', status: 'ready' }); } catch { /* cap reached */ } }, Math.min(P.fs, 300));
  await profileSite({
    id: 'FS-todos-load',
    group: 'sync-fs',
    site: 'lib/persist/todos-store.js listTodos() (async facade; legacy backend: read + normalize)',
    owner: 'A4',
    requestPath: 'yes',
    note: 'Todo list/show routes.',
  }, () => todosStore.listTodos(dataDir, hotFolder), Math.min(P.fs, 300));
  await profileSite({
    id: 'FS-delegation-create-sqlite',
    group: 'sync-fs',
    site: 'lib/persist/delegations-persist.js createDelegationRecord() (main-thread DatabaseSync write)',
    owner: 'A2',
    requestPath: 'yes',
    note: 'Main-thread SQLite writer; A2 replaces it with the sqlite-worker. Measured to attribute the stall only.',
  }, () => delegations.createDelegationRecord({
    parentChatId: chatList[0].id, workspaceFolder: hotFolder, assignment: 'implement', status: 'completed',
    executor: { transport: 'opencode', model: 'opencode/test' },
  }), Math.min(P.fs, 300));

  // ---- C2. V5 runtime tick: what one 5 s tick reads (R15 scheduler itself is NOT touched) ----
  const mailbox = await import('../lib/persist/delegation-mailbox-persist.js');
  const worker = await import('../lib/delegation-runtime-worker.js');
  const mailboxRows = P.fixtureProfile === 'full' ? 3000 : 100;
  for (let i = 0; i < mailboxRows; i += 1) {
    mailbox.createMailboxMessage({
      fromChatId: chatList[(i + 1) % 50].id, toChatId: chatList[0].id, kind: 'reply', replyKind: 'progress',
      body: `Fixture mailbox row ${i}`, status: 'delivered', idempotencyKey: `profile-mailbox-${i}`,
    });
  }
  await profileSite({
    id: 'V5-tick-load-mailbox',
    group: 'v5-runtime-tick',
    site: `lib/delegation-runtime-worker.js tick reader listMailboxByStatus(['queued','dispatching']) (${mailboxRows} delivered rows, JSON backend default)`,
    owner: 'A4',
    requestPath: 'no',
    note: 'The tick reads only queued/dispatching rows (status-filtered before copying). The former whole-mailbox reader loadMailboxMessages() is measured as V5-tick-load-mailbox-baseline.',
  }, () => mailbox.listMailboxByStatus(['queued', 'dispatching']), Math.min(P.fs, 300));
  await profileSite({
    id: 'V5-tick-load-mailbox-baseline',
    group: 'v5-runtime-tick',
    site: `lib/persist/delegation-mailbox-persist.js loadMailboxMessages() (${mailboxRows} delivered rows; historical pre-fix tick reader)`,
    owner: 'A4',
    requestPath: 'no',
    note: 'Historical baseline: the whole-mailbox reader the tick used before listMailboxByStatus.',
  }, () => mailbox.loadMailboxMessages(), Math.min(P.fs, 300));
  await profileSite({
    id: 'V5-tick-full',
    group: 'v5-runtime-tick',
    site: `lib/delegation-runtime-worker.js tickDelegationRuntime({ drainMailbox: false }) (${fixture.delegations} delegations, ${mailboxRows} mailbox rows, ${chatList.length} chats)`,
    owner: 'R15',
    requestPath: 'no',
    note: 'Whole tick incl. the workspace watcher heartbeat in observe-off state. The scheduler/resume policy (R15) is read-only for this program; this only attributes the stall.',
  }, () => worker.tickDelegationRuntime({ drainMailbox: false }), Math.min(P.heavy * 5, 100));

  // ---- D. V8: Files / Terminal / Browser Cretli overhead ----
  const v8 = await measureV8(P, work);
  rows.push(...v8);

  const out = {
    schema: 1,
    purpose: 'V6 per-site main-thread stall profile and V8 Files/Terminal/Browser overhead (stage 6)',
    thresholds: THRESHOLDS,
    idleFloorMs: idleFloor,
    fixture,
    referenceMeasurements: PRE_FIX_REFERENCE,
    sites: rows,
    wallSeconds: Math.round((Date.now() - started) / 100) / 10,
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

// ---------------------------------------------------------------------------
// V8: Files / Terminal / Browser
// ---------------------------------------------------------------------------

async function measureV8(P, work) {
  const out = [];
  const push = async (meta, fn, count) => {
    const before = rows.length;
    await profileSite(meta, fn, count);
    out.push(rows.pop());
    rows.length = before;
  };

  // Files: list a wide directory and read a 1 MiB file through the real route handlers.
  const tree = path.join(work, 'files-tree');
  fs.mkdirSync(tree, { recursive: true });
  const widths = [...new Set([Math.min(1000, P.tree), Math.min(5000, P.tree), P.tree])];
  for (const width of widths) {
    const wide = path.join(tree, `wide-${width}`);
    fs.mkdirSync(wide, { recursive: true });
    for (let i = 0; i < width; i += 1) fs.writeFileSync(path.join(wide, `file-${String(i).padStart(6, '0')}.txt`), 'x');
  }
  fs.writeFileSync(path.join(tree, 'big.txt'), 'y'.repeat(1024 * 1024 - 16));
  const { registerFilesRoutes } = await import('../lib/routes/files-routes.js');
  const handlers = new Map();
  registerFilesRoutes({ get: (route, handler) => handlers.set(route, handler) }, { getCurrentCwd: () => tree });
  const call = (route, query) => {
    let payload;
    const res = { status: () => res, json: (body) => { payload = body; return res; } };
    handlers.get(route)({ query, headers: {} }, res);
    return payload;
  };
  for (const width of widths) {
    await push({
      id: `V8-files-list-${width}-entries`,
      group: 'v8-files',
      site: `lib/routes/files-routes.js GET /api/files/entries (one directory with ${width} entries; readdirSync + statSync per entry + sort, route handler)`,
      owner: 'stage-6',
      requestPath: 'yes',
      note: 'Cretli-side overhead only; the handler is fully synchronous and has no entry cap.',
    }, () => call('/api/files/entries', { dir: `wide-${width}` }), Math.min(P.fs, 200));
  }
  await push({
    id: 'V8-files-read-1mib',
    group: 'v8-files',
    site: 'lib/routes/files-routes.js GET /api/files/read (1 MiB file, the route cap)',
    owner: 'stage-6',
    requestPath: 'yes',
    note: 'statSync x2 + readFileSync(1 MiB, utf8). Fully synchronous.',
  }, () => call('/api/files/read', { path: 'big.txt' }), Math.min(P.fs, 500));

  // Terminal: ws message handling + output broadcast with a stub pty (node-pty spawn patched).
  try {
    const nodePty = (await import('node-pty')).default;
    const ptyModule = await import('../lib/ws/pty-ws-handler.ts');
    const { queuePtyOutput, PTY_BUFFER_MAX } = await import('../lib/pty-broadcast.js');
    const handlersByEvent = {};
    const stubPty = { pid: 0, write: () => {}, resize: () => {}, kill: () => {}, onData: (cb) => { handlersByEvent.data = cb; }, onExit: () => {} };
    nodePty.spawn = () => stubPty;
    const sent = [];
    const makeWs = () => {
      const listeners = {};
      return { readyState: 1, OPEN: 1, bufferedAmount: 0, send: (m) => sent.push(m.length), close: () => {}, on: (e, cb) => { listeners[e] = cb; }, listeners };
    };
    const ws = makeWs();
    const ctx = {
      agentCmd: 'agent', agentModel: 'auto', agentSessions: new Map(), terminalSessions: new Map(),
      workspaceDirForAgent: () => work, getCurrentCwd: () => work, buildInteractivePtyEnv: (e) => ({ ...e }),
      randomSessionId: () => 'stall-profile-session', setLastTerminalSessionId: () => {}, getLastTerminalSessionId: () => null,
    };
    ptyModule.handlePtyConnection(ws, false, null, null, work, null, null, false, ctx, true);
    const inputFrame = Buffer.from(JSON.stringify({ type: 'input', data: 'ls -la\r' }));
    await push({
      id: 'V8-pty-ws-input-message',
      group: 'v8-terminal',
      site: 'lib/ws/pty-ws-handler.ts ws.on(message) type=input (JSON.parse + ptyProcess.write, stub pty)',
      owner: 'stage-6',
      requestPath: 'yes',
      note: 'Stub pty: measures only Cretli frame handling, not the shell.',
    }, () => ws.listeners.message(inputFrame), Math.max(P.ptyMessages, 1000));
    const chunk = 'x'.repeat(4096);
    const session = ctx.terminalSessions.get('stall-profile-session') || { buffer: '' };
    const clients = new Set([ws, makeWs(), makeWs()]);
    await push({
      id: 'V8-pty-output-broadcast',
      group: 'v8-terminal',
      site: 'lib/pty-broadcast.js queuePtyOutput (4 KiB chunk -> 64 KiB ring buffer + 3 ws clients, JSON.stringify once)',
      owner: 'stage-6',
      requestPath: 'yes',
      note: `Stub pty output path. Ring buffer bounded at PTY_BUFFER_MAX=${PTY_BUFFER_MAX} bytes; per-client skip on backpressure (WS_BACKPRESSURE_THRESHOLD_BYTES).`,
    }, () => queuePtyOutput(clients, session, chunk), Math.max(P.ptyMessages, 1000));
    ws.listeners.close?.();
  } catch (error) {
    out.push({ id: 'V8-terminal', group: 'v8-terminal', site: 'lib/ws/pty-ws-handler.ts', status: 'not measured', reason: `node-pty or handler import failed: ${String(error?.message || error).slice(0, 200)}` });
  }

  // Browser: session-manager bookkeeping with a minimal fake driver (no Chromium).
  try {
    const { BrowserSessionManager, describePageElementsBatch } = await import('../lib/browser/session-manager.js');
    const makePage = (ctxRef) => {
      const handlers = new Map();
      return {
        _url: 'about:blank', on: (e, cb) => { handlers.set(e, cb); }, url() { return this._url; }, context: () => ctxRef,
        async title() { return 'fake'; }, viewportSize: () => ({ width: 390, height: 844 }), async setViewportSize() {},
        async goto(url) { this._url = url; }, async close() { handlers.get('close')?.(); },
        async screenshot() { return Buffer.from('fake'); },
        locator: () => ({ evaluateAll: async () => [], count: async () => 0 }),
        mouse: {}, keyboard: {}, touchscreen: {},
      };
    };
    const driver = {
      name: 'fake',
      async launch() {
        return {
          isConnected: () => true, async close() {},
          async newContext() {
            const ctxRef = { routes: [], pages: [], on() {}, async route(_p, h) { ctxRef.routes.push(h); }, async routeWebSocket() {}, async addInitScript() {}, async newCDPSession() { return { send: async () => ({}), detach: async () => {} }; }, async close() {} };
            ctxRef.newPage = async () => { const p = makePage(ctxRef); ctxRef.pages.push(p); return p; };
            return ctxRef;
          },
        };
      },
    };
    const manager = new BrowserSessionManager({
      driver, driverStatus: { status: 'available' }, dataDir: path.join(work, 'browser'),
      resolvePolicy: () => ({ allowedOrigins: ['https://example.com'], blockedPorts: [], unblockedPorts: [] }),
      lookup: async () => [{ address: '93.184.216.34' }],
      setIntervalFn: () => 0, clearIntervalFn: () => {}, setTimeoutFn: () => 0, clearTimeoutFn: () => {},
      pidStore: { read: () => [], write: () => {}, add: () => {}, remove: () => {}, list: () => [], clear: () => {} },
      multiInstanceGuard: null,
    });
    const scope = { workspaceFile: '/ws/stall-profile' };
    let ownerN = 0;
    await push({
      id: 'V8-browser-session-lifecycle',
      group: 'v8-browser',
      site: 'lib/browser/session-manager.js createSession + listTabs + closeSession (fake driver, no Chromium)',
      owner: 'stage-6',
      requestPath: 'yes',
      note: 'Cretli bookkeeping only (limits, policy, tab registry, cleanup). Chromium launch/navigation time is external and NOT measured.',
    }, async () => {
      ownerN += 1;
      const owner = `owner-${ownerN}`;
      const session = await manager.createSession({ ownerSessionId: owner, ...scope });
      manager.listTabs(session.browserSessionId, owner, scope);
      await manager.closeSession(session.browserSessionId, owner, { scope });
    }, P.browserOps);
    const nodes = Array.from({ length: 200 }, (_, i) => ({
      tagName: 'BUTTON', textContent: `Button ${i}`, getAttribute: () => null, hasAttribute: () => false,
      getBoundingClientRect: () => ({ x: 0, y: i, width: 10, height: 10 }), isConnected: true,
    }));
    await push({
      id: 'V8-browser-describe-elements-200',
      group: 'v8-browser',
      site: 'lib/browser/session-manager.js describePageElementsBatch (200 nodes; the page-side scan body, run in Node here)',
      owner: 'stage-6',
      requestPath: 'yes',
      note: 'The real scan runs inside the page; this measures the same function body on the Node side with synthetic nodes, so it is an upper-bound proxy for the descriptor-building cost only.',
    }, () => describePageElementsBatch(nodes, { limit: 200 }), P.browserOps);
  } catch (error) {
    out.push({ id: 'V8-browser', group: 'v8-browser', site: 'lib/browser/session-manager.js', status: 'not measured', reason: `harness failed: ${String(error?.message || error).slice(0, 200)}` });
  }
  for (const item of [
    ['V8-browser-chromium-launch-navigate', 'Chromium launch / navigation / screenshot capture', 'External operation (browser process); by definition excluded from Cretli overhead.'],
    ['V8-terminal-real-shell', 'Real PTY spawn + shell output latency', 'node-pty spawn of a real shell is an external process; excluded. PTY spawn registration cost is covered by AW-child-process-registry-uncontended.'],
  ]) {
    out.push({ id: item[0], group: item[0].startsWith('V8-browser') ? 'v8-browser' : 'v8-terminal', site: item[1], owner: 'stage-6', requestPath: 'yes', status: 'not measured', reason: item[2] });
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  if (args.includes('--child')) {
    runChild().catch((error) => { console.error(error); process.exit(1); });
  } else {
    runParent();
  }
}
