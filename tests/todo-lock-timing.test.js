import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  takeWatcherLockTimings,
  withWorkspaceWatchersFileLock,
} from '../lib/persist/workspace-watchers-persist.js';

function withTimingFlag(value, fn) {
  const prev = process.env.CRETLI_TODO_TIMING;
  if (value === undefined) delete process.env.CRETLI_TODO_TIMING;
  else process.env.CRETLI_TODO_TIMING = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.CRETLI_TODO_TIMING;
    else process.env.CRETLI_TODO_TIMING = prev;
  }
}

test('lock timing is off by default: work result unchanged, nothing recorded', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-lock-timing-'));
  try {
    withTimingFlag(undefined, () => {
      assert.equal(withWorkspaceWatchersFileLock(() => 42, { dataDir }), 42);
      assert.equal(takeWatcherLockTimings(), null);
    });
    withTimingFlag('1', () => {
      // Nothing from the flag-off call leaked into the totals.
      assert.equal(takeWatcherLockTimings().acquisitions, 0);
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('CRETLI_TODO_TIMING=1 records wait and hold once per outermost lock', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-lock-timing-'));
  try {
    withTimingFlag('1', () => {
      takeWatcherLockTimings();
      const result = withWorkspaceWatchersFileLock(() => (
        withWorkspaceWatchersFileLock(() => 'inner', { dataDir })
      ), { dataDir });
      assert.equal(result, 'inner');
      const t = takeWatcherLockTimings();
      assert.equal(t.acquisitions, 1);
      assert.ok(t.waitMs >= 0 && t.holdMs >= 0);
      assert.equal(takeWatcherLockTimings().acquisitions, 0);
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
