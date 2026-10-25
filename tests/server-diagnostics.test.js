import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createServerDiagnostics } from '../lib/server-diagnostics.js';

function createTempDirectory() {
  return mkdtempSync(path.join(os.tmpdir(), 'cretli-server-diagnostics-'));
}

function createRecorder(dataDir, options = {}) {
  return createServerDiagnostics({
    dataDir,
    serverInstanceToken: 'test-instance',
    serverStartedAt: Date.now(),
    ...options,
  });
}

test('returns newest records first and respects the requested limit', (context) => {
  const dataDir = createTempDirectory();
  const recorder = createRecorder(dataDir);
  context.after(() => {
    recorder.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
  recorder.record('first-event');
  recorder.record('second-event');
  assert.deepEqual(recorder.readRecent(1).map((entry) => entry.event), ['second-event']);
  assert.deepEqual(recorder.readRecent(2).map((entry) => entry.event), ['first-event', 'second-event']);
});

test('redacts error messages, suppresses bursts, and preserves the fatal error', (context) => {
  const dataDir = createTempDirectory();
  const recorder = createRecorder(dataDir);
  context.after(() => {
    recorder.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const entry = recorder.record('unhandled-rejection', {
    errorName: 'Error',
    message: `token=private-value ${'x'.repeat(1000)}`,
  });
  assert.ok(entry);
  assert.ok(entry.details.message.length <= 300);
  assert.equal(entry.details.message.includes('private-value'), false);
  assert.equal(recorder.record('unhandled-rejection', { message: 'burst' }), null);
  const fatalEntry = recorder.record('uncaught-exception', { message: 'fatal cause' }, { fatal: true });
  assert.equal(fatalEntry.details.message, 'fatal cause');
  assert.equal(fatalEntry.details.suppressedCount, 1);
  assert.equal(recorder.readRecent(10).filter((record) => record.event === 'unhandled-rejection').length, 1);
  assert.equal(statSync(path.join(dataDir, `server-diagnostics-${new Date().toISOString().slice(0, 10)}.jsonl`)).mode & 0o777, 0o600);
});

test('flushes suppressed errors without hiding a new error for another minute', async (context) => {
  const dataDir = createTempDirectory();
  const recorder = createRecorder(dataDir, { sampleIntervalMs: 2 });
  const originalNow = Date.now;
  let currentTime = 1_800_000_000_000;
  Date.now = () => currentTime;
  context.after(() => {
    Date.now = originalNow;
    recorder.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
  recorder.record('server-error', { message: 'first' });
  recorder.record('server-error', { message: 'suppressed' });
  currentTime += 61_000;
  recorder.start();
  await new Promise((resolve) => setTimeout(resolve, 15));
  const summary = recorder.readRecent(20).find((entry) => entry.event === 'error-events-suppressed');
  assert.equal(summary.details.suppressedCount, 1);
  const nextError = recorder.record('server-error', { message: 'new error' });
  assert.equal(nextError.details.message, 'new error');
});

test('continues without persistent diagnostics when the data path is not a directory', (context) => {
  const rootDir = createTempDirectory();
  const dataPath = path.join(rootDir, 'data-file');
  writeFileSync(dataPath, 'occupied');
  const originalError = console.error;
  console.error = () => {};
  let recorder;
  try {
    recorder = createRecorder(dataPath);
  } finally {
    console.error = originalError;
  }
  context.after(() => {
    recorder.stop();
    rmSync(rootDir, { recursive: true, force: true });
  });
  assert.doesNotThrow(() => recorder.snapshot('current'));
  assert.equal(recorder.record('sample'), null);
  assert.deepEqual(recorder.readRecent(), []);
});

test('rate-limits write failures and carries failed error counts into the next record', (context) => {
  const rootDir = createTempDirectory();
  const dataDir = path.join(rootDir, 'diagnostics');
  const recorder = createRecorder(dataDir);
  const originalError = console.error;
  const originalNow = Date.now;
  let currentTime = 1_800_000_000_000;
  let errorCount = 0;
  console.error = () => { errorCount += 1; };
  Date.now = () => currentTime;
  context.after(() => {
    console.error = originalError;
    Date.now = originalNow;
    recorder.stop();
    rmSync(rootDir, { recursive: true, force: true });
  });
  rmSync(dataDir, { recursive: true });
  assert.equal(recorder.record('server-error', { message: 'first failure' }), null);
  assert.equal(recorder.record('server-error', { message: 'suppressed failure' }), null);
  assert.equal(errorCount, 1);
  mkdirSync(dataDir);
  currentTime += 61_000;
  const recoveredEntry = recorder.record('server-error', { message: 'recovered' });
  assert.equal(recoveredEntry.details.suppressedCount, 2);
});

test('counts non-fatal error records rejected by the daily size cap', (context) => {
  const dataDir = createTempDirectory();
  const recorder = createRecorder(dataDir);
  const originalNow = Date.now;
  let currentTime = 1_800_000_000_000;
  Date.now = () => currentTime;
  context.after(() => {
    Date.now = originalNow;
    recorder.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
  assert.ok(recorder.record('server-error', { message: 'recorded' }));
  assert.equal(recorder.record('server-error', { message: 'burst' }), null);
  const date = new Date(currentTime).toISOString().slice(0, 10);
  const filePath = path.join(dataDir, `server-diagnostics-${date}.jsonl`);
  writeFileSync(filePath, Buffer.alloc(4 * 1024 * 1024));
  currentTime += 61_000;
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(recorder.record('server-error', { message: 'size capped' }), null);
    writeFileSync(filePath, '{}\n');
  } finally {
    console.error = originalError;
  }
  currentTime += 61_000;
  const recoveredEntry = recorder.record('server-error', { message: 'recovered' });
  assert.equal(recoveredEntry.details.suppressedCount, 2);
});

test('removes expired daily files on startup', (context) => {
  const dataDir = createTempDirectory();
  const oldFile = path.join(dataDir, 'server-diagnostics-2000-01-01.jsonl');
  writeFileSync(oldFile, '{}\n');
  const recorder = createRecorder(dataDir, { retentionDays: 2 });
  context.after(() => {
    recorder.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
  recorder.start();
  assert.throws(() => statSync(oldFile), { code: 'ENOENT' });
});

test('keeps daily files inside the retention window while pruning only expired ones', (context) => {
  const dataDir = createTempDirectory();
  const keptFile = path.join(dataDir, `server-diagnostics-${new Date().toISOString().slice(0, 10)}.jsonl`);
  const expiredFile = path.join(dataDir, 'server-diagnostics-2000-01-01.jsonl');
  const unrelatedFile = path.join(dataDir, 'server-diagnostics-not-a-date.jsonl');
  writeFileSync(keptFile, '{}\n');
  writeFileSync(expiredFile, '{}\n');
  writeFileSync(unrelatedFile, '{}\n');
  const recorder = createRecorder(dataDir, { retentionDays: 2 });
  context.after(() => {
    recorder.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
  recorder.start();
  assert.throws(() => statSync(expiredFile), { code: 'ENOENT' });
  // The kept file also receives the startup record, so only its existence and
  // non-empty content are asserted.
  assert.ok(statSync(keptFile).size > 0);
  // A filename that does not parse as a date is never treated as expired.
  assert.equal(statSync(unrelatedFile).size, 3);
});

test('does not append beyond the per-day size cap', (context) => {
  const dataDir = createTempDirectory();
  const date = new Date().toISOString().slice(0, 10);
  const filePath = path.join(dataDir, `server-diagnostics-${date}.jsonl`);
  const maxBytes = 4 * 1024 * 1024;
  writeFileSync(filePath, Buffer.alloc(maxBytes));
  const recorder = createRecorder(dataDir);
  context.after(() => {
    recorder.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const originalError = console.error;
  let warningCount = 0;
  console.error = () => { warningCount += 1; };
  try {
    assert.equal(recorder.record('sample'), null);
    assert.equal(recorder.record('sample'), null);
  } finally {
    console.error = originalError;
  }
  assert.equal(warningCount, 1);
  assert.equal(statSync(filePath).size, maxBytes);
});

test('preserves fatal records beyond the daily cap and attaches pending counts to shutdown', (context) => {
  const dataDir = createTempDirectory();
  const date = new Date().toISOString().slice(0, 10);
  const filePath = path.join(dataDir, `server-diagnostics-${date}.jsonl`);
  const maxBytes = 4 * 1024 * 1024;
  writeFileSync(filePath, `${' '.repeat(maxBytes - 1)}\n`);
  const recorder = createRecorder(dataDir);
  context.after(() => {
    recorder.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
  assert.ok(recorder.record('server-error', { message: 'first error' }, { fatal: true }));
  assert.ok(statSync(filePath).size > maxBytes);
  assert.equal(recorder.readRecent(1)[0].details.message, 'first error');
  writeFileSync(filePath, '{}\n');
  recorder.record('server-error', { message: 'first throttled error' });
  recorder.record('server-error', { message: 'throttled error' });
  const shutdownEntry = recorder.record('shutdown-signal', { signal: 'SIGTERM' });
  assert.equal(shutdownEntry.details.suppressedCount, 2);
  const previousExitHandlers = new Set(process.listeners('exit'));
  recorder.start();
  const exitHandler = process.listeners('exit').find((handler) => !previousExitHandlers.has(handler));
  assert.equal(typeof exitHandler, 'function');
  exitHandler(0);
  const processExitEntry = recorder.readRecent(1)[0];
  assert.equal(Object.hasOwn(processExitEntry.details, 'suppressedCount'), false);
});

test('separates server RSS from child process RSS in the snapshot', async (context) => {
  const dataDir = createTempDirectory();
  const recorder = createRecorder(dataDir);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
  context.after(() => {
    child.kill('SIGKILL');
    recorder.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
  await new Promise((resolve) => child.once('spawn', resolve));
  let entry = recorder.snapshot('current');
  const startedAt = Date.now();
  while (entry.processTree.childCount === 0 && Date.now() - startedAt < 2000) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    entry = recorder.snapshot('current');
  }
  assert.equal(entry.processTree.serverRssBytes, entry.processMemory.rssBytes);
  assert.ok(entry.processTree.childCount >= 1);
  assert.ok(entry.processTree.children.length <= 10);
  assert.ok(entry.processTree.childrenRssBytes > 0);
  assert.equal(
    entry.processTree.combinedRssBytes,
    entry.processTree.serverRssBytes + entry.processTree.childrenRssBytes,
  );
  assert.ok(entry.processTree.children.some((row) => row.pid === child.pid));
});

test('reports serializable V8 memory metrics and stops the recorder cleanly', async (context) => {
  const dataDir = createTempDirectory();
  const recorder = createRecorder(dataDir, { sampleIntervalMs: 5 });
  const exitListenersBeforeStart = process.listenerCount('exit');
  context.after(() => {
    recorder.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const entry = recorder.record('v8-metrics');
  assert.deepEqual(Object.keys(entry.v8).sort(), [
    'externalMemory',
    'mallocedMemory',
    'peakMallocedMemory',
    'totalPhysicalSize',
  ]);
  for (const value of Object.values(entry.v8)) assert.ok(Number.isFinite(value));
  assert.doesNotThrow(() => JSON.stringify(entry));

  recorder.start();
  assert.equal(process.listenerCount('exit'), exitListenersBeforeStart + 1);
  recorder.stop();
  recorder.stop();
  assert.equal(process.listenerCount('exit'), exitListenersBeforeStart);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(recorder.readRecent(10).map((record) => record.event), ['v8-metrics', 'server-start']);
});

test('write-stats records a bounded, validated top list', (context) => {
  const dataDir = createTempDirectory();
  const recorder = createRecorder(dataDir);
  context.after(() => {
    recorder.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const rows = Array.from({ length: 40 }, (_, i) => ({
    key: `file-${i}-${'x'.repeat(300)}`,
    writes: i,
    bytes: 10,
    stringifyMs: i,
    ioMs: 1,
    maxMs: 2,
    writesPerMin: Number.NaN,
  }));
  recorder.record('write-stats', { writeStats: rows, ignored: 'nope' });
  const entry = recorder.readRecent(1)[0];
  assert.equal(entry.event, 'write-stats');
  assert.ok(entry.details.writeStats.length <= 20);
  assert.ok(entry.details.writeStats.every((row) => row.key.length <= 120 && row.writesPerMin === 0));
  assert.equal(entry.details.ignored, undefined);
});
