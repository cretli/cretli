// Synthetic stand-in for server.js used by tests/offline-snapshot.test.js.
// Opens a WAL database with autocheckpoint disabled and, on SIGTERM, exits WITHOUT
// closing it, so committed rows stay only in the -wal file (the snapshot must keep them).
// Modes (FIXTURE_MODE, comma separated): ignore-sigterm, orphan-writer, orphan-idle, spawn-helper,
// delayed-exit (exit FIXTURE_EXIT_DELAY_MS after SIGTERM), tree-kill (on SIGTERM SIGKILL every descendant
// by walking /proc parent links, like Cretli's per-PID process-tree kill), launch-on-trigger (spawn the
// argv from <markers>/launch.json as a plain child, then write launch.out).
// FIXTURE_PROFILE=1 mimics the real deployment: process.title is rewritten (argv becomes opaque) and a
// loopback HTTP listener answers GET /api/health with { ok: true } (port in the start marker).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const dataDir = process.env.FIXTURE_DATA_DIR;
const markerDir = process.env.FIXTURE_MARKER_DIR;
const modes = (process.env.FIXTURE_MODE || '').split(',');

if (process.env.FIXTURE_PROFILE) process.title = 'cretli';
let healthPort = 0;
if (process.env.FIXTURE_PROFILE) {
  const srv = require('node:http').createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(req.url === '/api/health' ? '{"ok":true}' : '{"ok":false}');
  });
  srv.listen(0, '127.0.0.1', () => { healthPort = srv.address().port; writeMarker(); });
}

const db = new DatabaseSync(path.join(dataDir, 'cretli-store.sqlite'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA foreign_keys=ON;');
db.exec('CREATE TABLE IF NOT EXISTS parent (id INTEGER PRIMARY KEY);'
  + 'CREATE TABLE IF NOT EXISTS child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id), body TEXT);');
if (db.prepare('SELECT count(*) AS c FROM parent').get().c === 0) {
  db.exec('INSERT INTO parent (id) VALUES (1)');
  for (let i = 0; i < 50; i += 1) db.prepare('INSERT INTO child (parent_id, body) VALUES (1, ?)').run(`row-${i}`);
}

if (modes.includes('orphan-writer')) {
  const w = spawn(process.execPath, ['-e',
    `require('fs').openSync(${JSON.stringify(path.join(dataDir, 'orphan.txt'))}, 'a'); setInterval(() => {}, 1000)`],
  { detached: true, stdio: 'ignore' });
  fs.writeFileSync(path.join(markerDir, 'orphan.pid'), String(w.pid));
  // A restart spawns a new orphan and overwrites orphan.pid; the list keeps
  // every one so cleanupWorlds can kill them all.
  fs.appendFileSync(path.join(markerDir, 'orphans.pids'), `${w.pid}\n`);
  w.unref();
}
if (modes.includes('spawn-helper')) {
  const out = fs.openSync(path.join(markerDir, 'helper.out'), 'w');
  spawn(process.execPath, JSON.parse(process.env.FIXTURE_HELPER_ARGV).map((a) => (a === '__PID__' ? String(process.pid) : a)), { stdio: ['ignore', out, out] });
}

if (modes.includes('orphan-idle')) {
  const w = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  fs.writeFileSync(path.join(markerDir, 'orphan.pid'), String(w.pid));
  fs.appendFileSync(path.join(markerDir, 'orphans.pids'), `${w.pid}\n`);
  w.unref();
}
if (modes.includes('launch-on-trigger')) {
  const trigger = path.join(markerDir, 'launch.json');
  const timer = setInterval(() => {
    if (!fs.existsSync(trigger)) return;
    clearInterval(timer);
    const argv = JSON.parse(fs.readFileSync(trigger, 'utf8'));
    fs.unlinkSync(trigger); // a restarted instance must not launch again
    const out = fs.openSync(path.join(markerDir, 'launch.out'), 'w');
    spawn(process.execPath, argv, { stdio: ['ignore', out, out], env: launchEnv() });
  }, 50);
}

function descendantPids(root) {
  const kids = new Map();
  for (const n of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
    try {
      const stat = fs.readFileSync(`/proc/${n}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (!kids.has(ppid)) kids.set(ppid, []);
      kids.get(ppid).push(Number(n));
    } catch { /* gone */ }
  }
  const out = [];
  const queue = [root];
  while (queue.length) for (const c of kids.get(queue.pop()) ?? []) { out.push(c); queue.push(c); }
  return out;
}

process.on('SIGTERM', () => {
  if (modes.includes('ignore-sigterm')) return;
  if (modes.includes('tree-kill')) {
    for (const pid of descendantPids(process.pid)) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
  if (modes.includes('delayed-exit')) {
    setTimeout(() => process.exit(0), Number(process.env.FIXTURE_EXIT_DELAY_MS || 1500));
    return;
  }
  process.exit(0);
});
setInterval(() => {}, 1000);

function writeMarker() {
  fs.writeFileSync(path.join(markerDir, `start-${process.pid}.json`), JSON.stringify({
    pid: process.pid,
    cwd: process.cwd(),
    secretSha256: crypto.createHash('sha256').update(process.env.FIXTURE_SECRET || '').digest('hex'),
  }));
}
if (!process.env.FIXTURE_PROFILE) writeMarker();

/** Env of the launched snapshot CLI; always tolerates unreadable foreign fds (hosted CI runners hold such processes). */
function launchEnv() {
  const env = { PATH: process.env.PATH, ...JSON.parse(process.env.FIXTURE_LAUNCH_ENV || '{}') };
  env.CRETLI_SNAPSHOT_FAULT = [env.CRETLI_SNAPSHOT_FAULT, 'tolerate-unreadable-fds'].filter(Boolean).join(',');
  return env;
}
