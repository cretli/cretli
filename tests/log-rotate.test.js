/**
 * Size-capped rotation semantics: archive shifting, no-throw failure handling,
 * copy-truncate with a live O_APPEND writer, and the sustained-output bound.
 */

import assert from 'node:assert/strict';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  createLogRotator,
  copyTruncateLog,
  resolvePositiveIntEnv,
  rotateLogIfNeeded,
  startLogCapTimer,
} from '../lib/log-rotate.js';

function createTempDirectory() {
  return mkdtempSync(path.join(os.tmpdir(), 'cretli-log-rotate-'));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('rotateLogIfNeeded keeps the newest archives and drops the oldest', (context) => {
  const dir = createTempDirectory();
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'server.log');
  const rotate = () => rotateLogIfNeeded(filePath, { maxBytes: 1, keep: 2 });

  writeFileSync(filePath, 'AAAA');
  assert.equal(rotate(), true);
  writeFileSync(filePath, 'BBBB');
  rotate();
  writeFileSync(filePath, 'CCCC');
  rotate();

  assert.equal(readFileSync(`${filePath}.1`, 'utf8'), 'CCCC');
  assert.equal(readFileSync(`${filePath}.2`, 'utf8'), 'BBBB');
  assert.equal(existsSync(`${filePath}.3`), false);
});

test('rotateLogIfNeeded drops a pre-existing oversized oldest archive', (context) => {
  const dir = createTempDirectory();
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'server.log');

  writeFileSync(`${filePath}.2`, 'OLD-OVERSIZED-ARCHIVE');
  writeFileSync(filePath, 'NEW');
  rotateLogIfNeeded(filePath, { maxBytes: 1, keep: 2 });

  assert.equal(readFileSync(`${filePath}.1`, 'utf8'), 'NEW');
  assert.equal(existsSync(`${filePath}.2`), false);
});

test('rotateLogIfNeeded is a no-op for a missing or small file', (context) => {
  const dir = createTempDirectory();
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'server.log');

  assert.equal(rotateLogIfNeeded(filePath, { maxBytes: 100 }), false);
  writeFileSync(filePath, 'small');
  assert.equal(rotateLogIfNeeded(filePath, { maxBytes: 100 }), false);
  assert.equal(readFileSync(filePath, 'utf8'), 'small');
});

test('a rename failure warns once and does not throw', (context) => {
  const dir = createTempDirectory();
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'server.log');
  writeFileSync(filePath, 'a'.repeat(64));

  const rotator = createLogRotator({
    renameSync: () => {
      throw new Error('EXDEV: cross-device link');
    },
  });
  const originalWarn = console.warn;
  let warnings = 0;
  console.warn = () => { warnings += 1; };
  let result;
  try {
    result = rotator.rotateLogIfNeeded(filePath, { maxBytes: 8, keep: 2 });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(result, false);
  assert.equal(warnings, 1);
  assert.equal(existsSync(filePath), true);
});

test('copyTruncateLog preserves O_APPEND writes after truncation', (context) => {
  const dir = createTempDirectory();
  const filePath = path.join(dir, 'live.log');
  const fd = openSync(filePath, 'a');
  context.after(() => {
    closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  });

  writeSync(fd, 'x'.repeat(64));
  assert.equal(copyTruncateLog(filePath, { maxBytes: 16, keep: 2 }), true);
  assert.equal(statSync(filePath).size, 0);
  assert.equal(readFileSync(`${filePath}.1`, 'utf8'), 'x'.repeat(64));

  writeSync(fd, 'after-truncate\n');
  assert.equal(readFileSync(filePath, 'utf8'), 'after-truncate\n');
});

test('startLogCapTimer without a file path schedules nothing', () => {
  let scheduled = 0;
  const timer = startLogCapTimer(undefined, {
    setIntervalFn: () => {
      scheduled += 1;
      return { unref() {} };
    },
  });

  assert.equal(timer, null);
  assert.equal(scheduled, 0);
});

test('startLogCapTimer unrefs the interval timer', () => {
  let unrefCalls = 0;
  const fakeTimer = { unref: () => { unrefCalls += 1; } };
  const timer = startLogCapTimer('/tmp/cretli-cap-timer.log', {
    setIntervalFn: () => fakeTimer,
  });

  assert.equal(timer, fakeTimer);
  assert.equal(unrefCalls, 1);
});

test('startLogCapTimer passes interval, maxBytes and keep to copyTruncateLog', (context) => {
  const dir = createTempDirectory();
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'capped.log');
  writeFileSync(filePath, 'x'.repeat(64));

  let capturedCallback = null;
  let capturedIntervalMs = null;
  startLogCapTimer(filePath, {
    intervalMs: 1234,
    maxBytes: 8,
    keep: 2,
    setIntervalFn: (callback, intervalMs) => {
      capturedCallback = callback;
      capturedIntervalMs = intervalMs;
      return { unref() {} };
    },
  });

  assert.equal(capturedIntervalMs, 1234);
  assert.equal(typeof capturedCallback, 'function');

  // keep=2 must drop a pre-existing `.2` archive; with the default keep=3 it
  // would have been shifted to `.3` instead.
  writeFileSync(`${filePath}.2`, 'OLDEST');
  capturedCallback();

  assert.equal(statSync(filePath).size, 0);
  assert.equal(readFileSync(`${filePath}.1`, 'utf8'), 'x'.repeat(64));
  assert.equal(existsSync(`${filePath}.2`), false);
});

test('resolvePositiveIntEnv falls back for missing, non-numeric and non-positive values', () => {
  assert.equal(resolvePositiveIntEnv({}, 'CRETLI_LOG_CAP_CHECK_MS', 60_000), 60_000);
  assert.equal(resolvePositiveIntEnv({ CRETLI_LOG_CAP_CHECK_MS: 'nope' }, 'CRETLI_LOG_CAP_CHECK_MS', 60_000), 60_000);
  assert.equal(resolvePositiveIntEnv({ CRETLI_LOG_CAP_CHECK_MS: '0' }, 'CRETLI_LOG_CAP_CHECK_MS', 60_000), 60_000);
  assert.equal(resolvePositiveIntEnv({ CRETLI_LOG_CAP_CHECK_MS: '-5' }, 'CRETLI_LOG_CAP_CHECK_MS', 60_000), 60_000);
});

test('resolvePositiveIntEnv returns the env-driven interval and byte cap', () => {
  assert.equal(
    resolvePositiveIntEnv({ CRETLI_LOG_CAP_CHECK_MS: '2500' }, 'CRETLI_LOG_CAP_CHECK_MS', 60_000),
    2500,
  );
  assert.equal(
    resolvePositiveIntEnv({ CRETLI_SERVER_LOG_MAX_BYTES: '1048576' }, 'CRETLI_SERVER_LOG_MAX_BYTES', 10 * 1024 * 1024),
    1048576,
  );
});

test('sustained output stays within the runtime bound with a delayed cap timer', async (context) => {
  const dir = createTempDirectory();
  const filePath = path.join(dir, 'sustained.log');
  const cap = 64 * 1024;
  const chunk = 'a'.repeat(32 * 1024);
  const fd = openSync(filePath, 'a');
  const timer = startLogCapTimer(filePath, { intervalMs: 5, maxBytes: cap, keep: 3 });
  context.after(() => {
    if (timer) clearInterval(timer);
    closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  });

  // 18 intervals x 3 chunks = ~1.8 MiB, well over 5x the cap, while the cap
  // timer fires between (delayed) intervals.
  for (let tick = 0; tick < 18; tick += 1) {
    writeSync(fd, chunk);
    writeSync(fd, chunk);
    writeSync(fd, chunk);
    await sleep(6);
  }
  clearInterval(timer);
  copyTruncateLog(filePath, { maxBytes: cap, keep: 3 });

  assert.ok(statSync(filePath).size <= cap, `live file ${statSync(filePath).size} exceeds cap`);
  const archiveNames = readdirSync(dir).filter((name) => name.startsWith('sustained.log.'));
  assert.ok(archiveNames.length <= 3, `archives ${archiveNames.join(', ')} exceed keep`);

  const perFileBound = cap + 3 * chunk.length + 8 * 1024;
  for (const name of archiveNames) {
    assert.ok(statSync(path.join(dir, name)).size <= perFileBound, `${name} exceeds the runtime bound`);
  }
  const totalBytes = statSync(filePath).size
    + archiveNames.reduce((sum, name) => sum + statSync(path.join(dir, name)).size, 0);
  assert.ok(totalBytes <= (3 + 1) * perFileBound, `total ${totalBytes} exceeds (keep + 1) * per-file bound`);
});
