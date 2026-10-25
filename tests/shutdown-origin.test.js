import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildShutdownOriginSnapshot } from '../lib/shutdown-origin.js';
import { createServerDiagnostics } from '../lib/server-diagnostics.js';
import { appendDelegationEventFile } from '../lib/delegation-log.js';

const SELF_PID = 500;

function createReader(processes) {
  return { listProcesses: () => processes };
}

const inputProcesses = [
  { pid: 1, ppid: 0, name: 'init', cmdline: '/sbin/init' },
  { pid: 100, ppid: 1, name: 'bash', cmdline: 'bash restart-helper.sh' },
  { pid: 200, ppid: 100, name: 'npm', cmdline: 'npm start' },
  { pid: SELF_PID, ppid: 200, name: 'node', cmdline: 'node server.js' },
  { pid: 600, ppid: 100, name: 'pkill', cmdline: 'pkill -TERM node --token=abc123secret' },
  { pid: 700, ppid: 1, name: 'sleep', cmdline: 'sleep 60' },
];

test('snapshot records parent chain, suspects and a compact tree', () => {
  const actual = buildShutdownOriginSnapshot({
    reader: createReader(inputProcesses),
    selfPid: SELF_PID,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  });
  assert.equal(actual.ppid, 200);
  assert.equal(actual.parent.name, 'npm');
  assert.deepEqual(actual.ancestors.map((entry) => entry.pid), [200, 100, 1]);
  const suspectPids = actual.suspects.map((entry) => entry.pid);
  assert.ok(suspectPids.includes(600));
  assert.ok(suspectPids.includes(100));
  assert.equal(suspectPids.includes(SELF_PID), false);
  assert.equal(suspectPids.includes(700), false);
  assert.ok(actual.processTree.some((entry) => entry.pid === 600));
  assert.equal(actual.capturedAt, '2026-01-01T00:00:00.000Z');
});

test('snapshot never throws when the process listing fails', () => {
  const actual = buildShutdownOriginSnapshot({
    reader: { listProcesses: () => { throw new Error('procfs unavailable'); } },
    selfPid: SELF_PID,
  });
  assert.equal(actual.error, 'procfs unavailable');
});

test('snapshot survives a cyclic parent chain', () => {
  const actual = buildShutdownOriginSnapshot({
    reader: createReader([
      { pid: 10, ppid: 11, name: 'a', cmdline: 'a' },
      { pid: 11, ppid: 10, name: 'b', cmdline: 'b' },
      { pid: SELF_PID, ppid: 10, name: 'node', cmdline: 'node' },
    ]),
    selfPid: SELF_PID,
  });
  assert.deepEqual(actual.ancestors.map((entry) => entry.pid), [10, 11]);
});

test('shutdown-origin record persists the sanitized origin', (context) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cretli-shutdown-origin-'));
  const recorder = createServerDiagnostics({ dataDir, serverInstanceToken: 't', serverStartedAt: Date.now() });
  context.after(() => {
    recorder.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const origin = buildShutdownOriginSnapshot({ reader: createReader(inputProcesses), selfPid: SELF_PID });
  const entry = recorder.record('shutdown-origin', { signal: 'SIGTERM', origin });
  assert.equal(entry.details.signal, 'SIGTERM');
  assert.equal(entry.details.origin.parent.pid, 200);
  assert.equal(JSON.stringify(entry.details.origin).includes('abc123secret'), false);
});

test('delegation events are appended to a daily file', (context) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cretli-delegation-log-'));
  context.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const now = Date.parse('2026-01-02T03:04:05.000Z');
  const isWritten = appendDelegationEventFile({ dataDir, payload: { event: 'started', delegationId: 'd1' }, now });
  assert.equal(isWritten, true);
  const contents = readFileSync(path.join(dataDir, 'delegation-events-2026-01-02.jsonl'), 'utf8');
  const parsed = JSON.parse(contents.trim());
  assert.equal(parsed.event, 'started');
  assert.equal(parsed.at, '2026-01-02T03:04:05.000Z');
  assert.equal(appendDelegationEventFile({ dataDir: path.join(dataDir, 'missing'), payload: {}, now }), false);
});
