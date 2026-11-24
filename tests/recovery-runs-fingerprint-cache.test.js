import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { openRecoveryStore, closeRecoveryStore, getRunsFingerprint } from '../lib/recovery/recovery-store.ts';
import { beginRunLaunch } from '../lib/recovery/recovery-lifecycle.ts';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';

test('fingerprint is stable without writes and moves on a run created through the same connection', () => {
  const store = openRecoveryStore();
  try {
    const first = getRunsFingerprint(store);
    assert.equal(getRunsFingerprint(store), first);
    beginRunLaunch({ family: 'chat', owner: 'chat-run-service', chatId: 'fp-a', harness: 'claude' }, store);
    const second = getRunsFingerprint(store);
    assert.notEqual(second, first);
    assert.equal(getRunsFingerprint(store), second);
  } finally {
    closeRecoveryStore(store);
  }
});

test('fingerprint sees a write committed by another connection (data_version)', () => {
  const store = openRecoveryStore();
  try {
    beginRunLaunch({ family: 'chat', owner: 'chat-run-service', chatId: 'fp-b', harness: 'claude' }, store);
    const before = getRunsFingerprint(store);
    assert.equal(getRunsFingerprint(store), before);
    const other = new DatabaseSync(path.join(ISOLATED_DATA_DIR, 'recovery.sqlite'));
    try {
      other.exec('PRAGMA busy_timeout = 5000');
      other.prepare('UPDATE recovery_runs SET revision = revision + 1').run();
    } finally {
      other.close();
    }
    assert.notEqual(getRunsFingerprint(store), before);
  } finally {
    closeRecoveryStore(store);
  }
});

test('a rolled-back write inside a transaction is never cached', () => {
  const store = openRecoveryStore();
  try {
    beginRunLaunch({ family: 'chat', owner: 'chat-run-service', chatId: 'fp-c', harness: 'claude' }, store);
    const committed = getRunsFingerprint(store);
    store.db.exec('BEGIN');
    store.db.prepare('UPDATE recovery_runs SET revision = revision + 5').run();
    const inTxn = getRunsFingerprint(store);
    assert.notEqual(inTxn, committed);
    store.db.exec('ROLLBACK');
    assert.equal(getRunsFingerprint(store), committed);
  } finally {
    closeRecoveryStore(store);
  }
});
