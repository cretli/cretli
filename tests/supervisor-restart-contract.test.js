import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { isSupervised, canRestartServer } from '../lib/server-restart-policy.js';
import { scheduleServerRestart } from '../lib/routes/dev-actions-routes.js';
import { createFatalProcessEventHandler } from '../lib/process-fatal.js';

for (const marker of [undefined, '', '0', '42x', ' 42', '042', '43']) {
  assert.equal(isSupervised({ CRETLI_SUPERVISOR_PID: marker }, 42), false);
}
assert.equal(isSupervised({ CRETLI_SUPERVISOR_PID: '42' }, 42), true);
assert.equal(isSupervised({ CRETLI_SUPERVISOR_PID: '42' }, 43), false);
assert.equal(canRestartServer({ NODE_ENV: 'production', CRETLI_SUPERVISOR_PID: String(process.ppid) }), true);
assert.equal(canRestartServer({ NODE_ENV: 'production' }), false);

let scheduled = true;
let spawnCalls = 0;
const signals = [];
const ctx = { projectRoot: '/example/cretli', setServerRestartScheduled: (v) => { scheduled = v; } };
const child = new EventEmitter();
let unrefCalls = 0;
child.unref = () => { unrefCalls++; };
const deps = {
  env: { CRETLI_SUPERVISOR_PID: '42' }, ppid: 42,
  kill: (pid, signal) => { assert.equal(scheduled, true); signals.push([pid, signal]); return true; },
  spawn: (executable, args, options) => {
    spawnCalls++;
    assert.equal(executable, process.execPath);
    assert.deepEqual(args, ['/example/cretli/scripts/restart-server-helper.js']);
    assert.equal(options.env.RESTART_REQUEST_ID, 'request');
    assert.equal(options.detached, true);
    return child;
  },
};
scheduleServerRestart(ctx, 'request', deps);
assert.deepEqual(signals, [[42, 'SIGUSR2']]);
assert.equal(spawnCalls, 0);
const originalError = console.error;
const errors = [];
try {
  console.error = (...args) => errors.push(args);
  scheduleServerRestart(ctx, 'request', { ...deps, kill: () => { throw new Error('denied'); } });
  assert.equal(scheduled, false);
  assert.match(errors[0][0], /Failed to signal/);
  scheduleServerRestart(ctx, 'request', { ...deps, env: {} });
  assert.equal(spawnCalls, 1);
  assert.equal(unrefCalls, 1);
  scheduled = true;
  child.emit('error', new Error('spawn failed'));
  assert.equal(scheduled, false);
} finally { console.error = originalError; }

// Evaluate the actual server configuration without booting the server.
const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const terminalFlag = server.match(/const FATAL_TERMINATES = .*;/)[0];
const fatalConfig = server.match(/const handleFatalProcessEvent = createFatalProcessEventHandler\(([\s\S]*?)\n\}\);/)[1] + '\n})';
for (const production of [false, true]) {
  for (const supervised of [false, true]) {
    const kinds = [];
    const recorded = [];
    const handler = vm.runInNewContext(terminalFlag + '\ncreateFatalProcessEventHandler(' + fatalConfig, {
      createFatalProcessEventHandler, IS_PROD: production, isSupervised: () => supervised,
      serverDiagnostics: { record: (kind, _details, options) => recorded.push([kind, options.fatal]) }, fatalProcessShutdown: (kind) => kinds.push(kind),
    });
    for (const kind of ['uncaught-exception', 'unhandled-rejection']) {
      assert.equal(handler({ kind, error: new Error('fatal') }).terminate, production || supervised);
      assert.deepEqual(recorded.at(-1), [kind, production || supervised]);
    }
    assert.equal(kinds.length, production || supervised ? 2 : 0);
  }
}
const shutdownHook = server.match(/fatalProcessShutdown = \(kind\) => \{[\s\S]*?\n\};/)[0];
const shutdownCalls = [];
let fallback;
vm.runInNewContext(shutdownHook + '\nfatalProcessShutdown("unhandled-rejection")', {
  process: { exit: (code) => shutdownCalls.push(['exit', code]) },
  setTimeout: (fn, ms) => { assert.equal(ms, 15000); fallback = fn; return { unref() {} }; },
  shutdownDelegationAndExit: (kind, options) => shutdownCalls.push([kind, options.exitCode]),
});
assert.deepEqual(shutdownCalls, [['unhandled-rejection', 1]]);
fallback();
assert.deepEqual(shutdownCalls[1], ['exit', 1]);

// Update success must set the planned flag before calling the shared restart.
const update = readFileSync(new URL('../lib/routes/update-routes.js', import.meta.url), 'utf8');
const updateFunction = update.match(/function scheduleRestartAfterUpdate\(ctx\) \{[\s\S]*?\n\}/)[0];
const updateCalls = [];
vm.runInNewContext(updateFunction + '\nscheduleRestartAfterUpdate(ctx)', {
  canRestartServer: () => true, randomUUID: () => 'update-request',
  ctx: { getServerRestartScheduled: () => false, setServerRestartScheduled: (v) => updateCalls.push(v), scheduleServerRestart: (id) => updateCalls.push(id) },
});
assert.deepEqual(updateCalls, [true, 'update-request']);

// Only a temporary scripts tree runs. The fake nohup records fallback and
// never executes the launcher, so no listener probe can reach a real port.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'cretli-restart-contract-'));
try {
  const scripts = path.join(tmp, 'scripts');
  const bin = path.join(tmp, 'bin');
  mkdirSync(scripts); mkdirSync(bin);
  cpSync(new URL('../scripts/task-restart-server.sh', import.meta.url), path.join(scripts, 'task-restart-server.sh'));
  mkdirSync(path.join(scripts, 'lib'));
  writeFileSync(path.join(scripts, 'lib/restart-log-guard.sh'), 'restart_server_listener_pids() { echo probe >> "$TRACE"; }\n');
  writeFileSync(path.join(bin, 'nohup'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  const command = path.join(scripts, 'cretli-supervisor.mjs');
  const trace = path.join(tmp, 'trace');
  for (const cwd of [tmp, os.tmpdir()]) {
    for (const code of [0, 3, null, 4, 1]) {
      rmSync(trace, { force: true });
      rmSync(command, { force: true });
      if (code !== null) writeFileSync(command, `import fs from 'node:fs'; fs.appendFileSync(process.env.TRACE, process.argv[2] + '\\n'); process.exit(${code});`);
      const result = spawnSync('bash', [path.join(scripts, 'task-restart-server.sh')], {
        cwd, encoding: 'utf8', env: { ...process.env, PATH: bin + ':' + process.env.PATH, TRACE: trace }, timeout: 5000,
      });
      assert.equal(result.status, code === 4 || code === 1 ? 1 : 0, result.stderr);
      const calls = existsSync(trace) ? readFileSync(trace, 'utf8') : '';
      assert.equal(calls.includes('request-restart'), code !== null);
      assert.equal(calls.includes('probe'), code === 3 || code === null);
      // The background stub may finish just after its parent; the launcher
      // announcement proves the unchanged fallback was selected.
      assert.equal(result.stdout.includes('Launcher PID:'), code === 3 || code === null);
      if (code === 4 || code === 1) {
        assert.match(result.stderr, /refusing manual restart/);
        assert.match(readFileSync(path.join(tmp, 'data/task-restart-server.log'), 'utf8'), /refusing manual restart/);
      }
    }
  }
} finally { rmSync(tmp, { recursive: true, force: true }); }
console.log('supervisor-restart-contract.test.js: ok');
