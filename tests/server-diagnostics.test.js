import assert from 'node:assert/strict';
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
