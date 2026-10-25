import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Real child processes, synthetic temp projects only. Nothing here touches a real
// Cretli installation, data/chat-history or native provider homes.

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SCRIPT = path.join(HERE, '..', '..', 'scripts', 'cretli-offline-snapshot.mjs');
export const FIXTURE = path.join(HERE, 'offline-snapshot-server.js');
export const SECRET = 'ENV-SECRET-4f9c1d7a';
export const CONVO = 'CONVO-CANARY-SNAPSHOT-1';
export const EXCLUDED_CANARY = 'EXCLUDED-CANARY-HOME-2';
export const IS_ROOT = process.getuid() === 0;

const worlds = [];
export const extraPids = new Set();

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return !/^[ZX]/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1] ?? 'X');
  } catch {
    return false;
  }
};
export async function waitFor(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timeout');
    await sleep(100);
  }
}

/** Build a synthetic project + data root and start the fixture server inside it. */
export async function makeWorld({ mode = '', extraEnv = {}, start = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-snap-test-'));
  const project = path.join(root, 'project');
  const data = path.join(project, 'data');
  const out = path.join(root, 'out');
  const markers = path.join(root, 'markers');
  for (const d of [project, data, out, markers, path.join(data, 'chat-history'), path.join(data, 'runtime-home'),
    path.join(data, 'sdk-agent-store'), path.join(data, 'delegation-owner.lock')]) fs.mkdirSync(d, { recursive: true });
  fs.chmodSync(out, 0o700);
  fs.copyFileSync(FIXTURE, path.join(project, 'server.js'));
  fs.writeFileSync(path.join(project, '.env'), `TOKEN=${EXCLUDED_CANARY}\n`);
  fs.writeFileSync(path.join(data, 'chat-history', 'c1.jsonl'), `{"role":"user","text":"${CONVO}"}\n{"role":"assistant","text":"ok"}\n`);
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ title: CONVO }));
  fs.writeFileSync(path.join(data, 'runtime-home', 'cred.txt'), EXCLUDED_CANARY);
  fs.writeFileSync(path.join(data, 'sdk-agent-store', 'x.json'), EXCLUDED_CANARY);
  fs.writeFileSync(path.join(data, 'auth.json'), EXCLUDED_CANARY);
  const w = { root, project, data, out, markers, pid: 0 };
  w.env = {
    PATH: process.env.PATH, FIXTURE_DATA_DIR: data, FIXTURE_MARKER_DIR: markers, FIXTURE_SECRET: SECRET,
    FIXTURE_MODE: mode, ...extraEnv,
  };
  worlds.push(w);
  if (start) await startServer(w);
  return w;
}

export async function startServer(w) {
  const log = fs.openSync(path.join(w.markers, 'server.log'), 'a');
  const child = spawn(process.execPath, ['server.js'], { cwd: w.project, env: w.env, stdio: ['ignore', log, log], detached: true });
  fs.closeSync(log);
  child.unref();
  w.pid = child.pid;
  w.child = child;
  await waitFor(() => fs.existsSync(path.join(w.markers, `start-${child.pid}.json`)));
}

/** Output of the launcher the fixture server spawned from inside its own process tree. */
export async function launchResult(w) {
  try {
    return await waitFor(() => { try { const t = fs.readFileSync(path.join(w.markers, 'launch.out'), 'utf8'); return JSON.parse(t.slice(t.indexOf('{'))); } catch { return null; } }, 15000);
  } catch {
    const raw = fs.existsSync(path.join(w.markers, 'launch.out')) ? fs.readFileSync(path.join(w.markers, 'launch.out'), 'utf8') : '<none>';
    throw new Error(`launcher produced no JSON: ${raw} ${fs.readFileSync(path.join(w.markers, 'server.log'), 'utf8')}`);
  }
}

export const startMarkers = (w) => fs.readdirSync(w.markers).filter((n) => n.startsWith('start-')).map((n) => JSON.parse(fs.readFileSync(path.join(w.markers, n), 'utf8')));

export function cli(w, extra = [], { pid = w.pid, env = {} } = {}) {
  const args = [SCRIPT, '--project-root', w.project, '--data-root', w.data, '--output-root', w.out, '--pid', String(pid), '--allow-root-service', ...extra];
  return new Promise((resolve) => {
    const c = spawn(process.execPath, args, { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    c.stdout.on('data', (d) => { stdout += d; });
    c.stderr.on('data', (d) => { stderr += d; });
    c.on('close', (code) => {
      let json = null;
      try { json = JSON.parse(stdout); } catch { /* not json */ }
      resolve({ code, stdout, stderr, json });
    });
  });
}

export async function applyArgs(w, extra = [], planFlags = []) {
  const plan = await cli(w, planFlags);
  assert.equal(plan.json.ok, true, plan.stdout);
  return ['--apply', '--confirm-stop-all-sessions', '--confirm-archive-history', '--confirm-identity', plan.json.fingerprint,
    '--restart-verify-ms', '600', '--stop-timeout-ms', '10000', '--descendant-wait-ms', '300', ...extra];
}

export function opDirOf(w) {
  const dirs = fs.readdirSync(w.out).filter((n) => n.startsWith('cretli-snapshot-'));
  return dirs.length ? path.join(w.out, dirs[0]) : null;
}
export const codes = (json) => (json.refusals ?? []).map((r) => r.code);
export const mode = (p) => fs.statSync(p).mode & 0o777;

export function assertNoLeaks(w, res) {
  const texts = [res.stdout, res.stderr];
  const op = opDirOf(w);
  if (op) {
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'work' && e.name !== 'stage' && e.name !== 'verify') walk(p); return; }
      if (!e.name.endsWith('.tar.gz')) texts.push(fs.readFileSync(p, 'utf8'));
    });
    walk(op);
  }
  for (const t of texts) {
    assert.ok(!t.includes(SECRET), 'runtime env secret leaked');
    assert.ok(!t.includes(CONVO), 'conversation text leaked');
    assert.ok(!t.includes(EXCLUDED_CANARY), 'excluded content leaked');
  }
}

export function cleanupWorlds() {
  for (const w of worlds.splice(0)) {
    for (const m of startMarkers(w)) if (alive(m.pid)) try { process.kill(m.pid, 'SIGKILL'); } catch { /* gone */ }
    if (fs.existsSync(path.join(w.markers, 'orphan.pid'))) extraPids.add(Number(fs.readFileSync(path.join(w.markers, 'orphan.pid'), 'utf8')));
    if (fs.existsSync(path.join(w.markers, 'orphans.pids'))) {
      for (const line of fs.readFileSync(path.join(w.markers, 'orphans.pids'), 'utf8').split('\n')) {
        if (/^\d+$/.test(line.trim())) extraPids.add(Number(line.trim()));
      }
    }
    fs.rmSync(w.root, { recursive: true, force: true });
  }
  for (const pid of extraPids) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  extraPids.clear();
}

/* ---------------------------------------------------------------- launch profile */

export const NODE_EXE = fs.realpathSync(process.execPath);
export const PROFILE_FLAGS = ['--launch-profile', 'cretli-npm-start-v1', '--node-exe', NODE_EXE];
const START_SCRIPT = 'CURSOR_RIPGREP_PATH=./node_modules/.bin/rg bash ./scripts/start-server-node22.sh';
const LAUNCHER = [
  '#!/usr/bin/env bash',
  '# Synthetic stand-in for the real launcher: boot loader lib/register-boot-env.js, then exec node.',
  'set -euo pipefail',
  'cd "$(dirname "${BASH_SOURCE[0]}")/.."',
  'exec node --no-warnings server.js',
  '',
].join('\n');

/** Synthetic project that mirrors the real deployment shape: launcher -> exec node, title rewritten. */
export async function makeProfileWorld({ pathPrefix = '', start = true } = {}) {
  const w = await makeWorld({ start: false, extraEnv: { FIXTURE_PROFILE: '1' } });
  w.env.PATH = `${pathPrefix}${path.dirname(NODE_EXE)}:${process.env.PATH}`;
  fs.mkdirSync(path.join(w.project, 'scripts'));
  fs.mkdirSync(path.join(w.project, 'lib'));
  fs.writeFileSync(path.join(w.project, 'scripts', 'start-server-node22.sh'), LAUNCHER, { mode: 0o755 });
  fs.writeFileSync(path.join(w.project, 'lib', 'register-boot-env.js'), '// synthetic boot loader\n');
  fs.writeFileSync(path.join(w.project, 'package.json'), JSON.stringify({ name: 'synthetic', scripts: { start: START_SCRIPT } }));
  if (start) await startProfileServer(w);
  return w;
}

export async function startProfileServer(w) {
  const log = fs.openSync(path.join(w.markers, 'server.log'), 'a');
  const child = spawn('bash', [path.join(w.project, 'scripts', 'start-server-node22.sh')], {
    cwd: w.project, env: w.env, stdio: ['ignore', log, log], detached: true,
  });
  fs.closeSync(log);
  child.unref();
  w.pid = child.pid;
  await waitFor(() => fs.existsSync(path.join(w.markers, `start-${child.pid}.json`)));
}

/** Profile plan/apply arguments (digest taken from a fresh plan). */
export async function profileApplyArgs(w, extra = []) {
  const plan = await cli(w, PROFILE_FLAGS);
  assert.equal(plan.json.ok, true, plan.stdout);
  return [...PROFILE_FLAGS, '--apply', '--confirm-stop-all-sessions', '--confirm-archive-history',
    '--confirm-identity', plan.json.fingerprint, '--confirm-profile-digest', plan.json.launchProfile.digest,
    '--restart-verify-ms', '600', '--stop-timeout-ms', '10000', '--descendant-wait-ms', '300', ...extra];
}

/* ------------------------------------------------------------ wrapped (npm/sh-like) */

/**
 * Start the server as a child of a long-lived wrapper that holds `logRel` open (like npm/sh holding the
 * inherited stdout/stderr redirect). Optional `extraRel` is an additional writable fd only the wrapper holds.
 */
export async function startWrapped(w, { logRel = 'server.log', logFlag = 'a', extraRel = null } = {}) {
  const code = `
    const fs = require('fs'); const cp = require('child_process');
    const log = fs.openSync(${JSON.stringify(path.join(w.data, logRel))}, ${JSON.stringify(logFlag)});
    ${extraRel ? `fs.openSync(${JSON.stringify(path.join(w.data, extraRel))}, 'a');` : ''}
    const c = cp.spawn(process.execPath, ['server.js'], { cwd: ${JSON.stringify(w.project)}, env: process.env, stdio: ['ignore', log, log] });
    fs.writeFileSync(${JSON.stringify(path.join(w.markers, 'wrapper.pid'))}, String(process.pid));
    fs.writeFileSync(${JSON.stringify(path.join(w.markers, 'child.pid'))}, String(c.pid));
    c.on('exit', () => process.exit(0));
    setInterval(() => {}, 1000);
  `;
  const wrapper = spawn(process.execPath, ['-e', code], { cwd: w.project, env: w.env, stdio: 'ignore', detached: true });
  wrapper.unref();
  extraPids.add(wrapper.pid);
  const childPid = Number(await waitFor(() => { try { return fs.readFileSync(path.join(w.markers, 'child.pid'), 'utf8') || null; } catch { return null; } }));
  await waitFor(() => fs.existsSync(path.join(w.markers, `start-${childPid}.json`)));
  w.pid = childPid;
  w.wrapperPid = wrapper.pid;
}
