/**
 * Recovery registry tests (leaf R2): schema migration, intent-before-launch
 * durability, idempotency, CAS conflicts and the cross-connection CAS race.
 *
 * Every test uses its own temporary data dir and cleans up afterwards, so the
 * suite never touches the real `data/` store.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  RECOVERY_STORE_SCHEMA_VERSION,
  RecoveryStoreError,
  closeRecoveryStore,
  getAttempt,
  getRecoveryStoreDatabase,
  getRun,
  getRunByRequestId,
  isRecoveryStoreError,
  listAttempts,
  listOpenRuns,
  listRuns,
  migrateRecoveryStore,
  openRecoveryStore,
  registerAttempt,
  resolveRecoveryStorePath,
  resolveRunRefByRequest,
  transitionRun,
  writeRunIntent,
} from '../lib/recovery/recovery-store.js';
import {
  RECOVERY_ID_KINDS,
  createRecoveryIds,
  isRecoveryId,
  newRecoveryId,
  parseRecoveryId,
} from '../lib/recovery/recovery-ids.js';

/**
 * @returns {string}
 */
function tempDir() {
  return mkdtempSync(path.join(tmpdir(), 'recovery-store-'));
}

/**
 * @param {object} [extra]
 * @returns {{ logicalRunId: string, attemptId: string, requestId: string, family: string, owner: string }}
 */
function baseIntent(extra = {}) {
  const ids = createRecoveryIds();
  return {
    logicalRunId: ids.logicalRunId,
    attemptId: ids.attemptId,
    requestId: ids.requestId,
    family: 'chat',
    owner: 'chat-run-service',
    ...extra,
  };
}

/**
 * @param {string} dir
 * @param {() => void} fn
 */
function withStore(dir, fn) {
  const store = openRecoveryStore({ dataDir: dir });
  try {
    fn(store);
  } finally {
    closeRecoveryStore(store);
  }
}

test('resolveRecoveryStorePath returns recovery.sqlite inside the data dir', () => {
  assert.equal(resolveRecoveryStorePath({ dataDir: '/tmp/x' }), path.join('/tmp/x', 'recovery.sqlite'));
});

test('a fresh store migrates to the current schema and reopen is idempotent', () => {
  const dir = tempDir();
  try {
    const store = openRecoveryStore({ dataDir: dir });
    assert.equal(store.schemaVersion, RECOVERY_STORE_SCHEMA_VERSION);
    const userVersion = Number(store.db.prepare('PRAGMA user_version').get().user_version);
    assert.equal(userVersion, RECOVERY_STORE_SCHEMA_VERSION);
    const meta = store.db
      .prepare('SELECT value FROM recovery_meta WHERE key = ?')
      .get('schemaVersion');
    assert.equal(Number(meta.value), RECOVERY_STORE_SCHEMA_VERSION);

    // Re-running the migration on the open store is a no-op.
    assert.equal(migrateRecoveryStore(store), RECOVERY_STORE_SCHEMA_VERSION);
    const again = store.db
      .prepare('SELECT COUNT(*) AS n FROM recovery_meta WHERE key = ?')
      .get('schemaVersion');
    assert.equal(Number(again.n), 1);
    closeRecoveryStore(store);

    // Reopening the same file stays at the current version.
    const reopened = openRecoveryStore({ dataDir: dir });
    assert.equal(reopened.schemaVersion, RECOVERY_STORE_SCHEMA_VERSION);
    closeRecoveryStore(reopened);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a store file from a newer build fails closed with schema_too_new', () => {
  const dir = tempDir();
  const filePath = path.join(dir, 'recovery.sqlite');
  try {
    const raw = new DatabaseSync(filePath);
    raw.exec('PRAGMA user_version = 99');
    raw.close();

    assert.throws(
      () => openRecoveryStore({ filePath }),
      (err) => {
        assert.ok(err instanceof RecoveryStoreError);
        assert.ok(isRecoveryStoreError(err));
        assert.equal(err.code, 'schema_too_new');
        assert.equal(err.details.version, 99);
        assert.equal(err.details.supported, RECOVERY_STORE_SCHEMA_VERSION);
        return true;
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeRunIntent persists a starting run and its first attempt', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const intent = baseIntent({
        workspaceFolder: '/tmp/ws',
        chatId: 'chat-1',
        sessionId: 'session-1',
        harness: 'sdk',
        model: 'model-x',
        now: '2026-01-02T03:04:05.000Z',
      });
      const result = writeRunIntent(intent, store);

      assert.equal(result.created, true);
      assert.equal(result.run.state, 'starting');
      assert.equal(result.run.revision, 1);
      assert.equal(result.run.logicalRunId, intent.logicalRunId);
      assert.equal(result.run.family, 'chat');
      assert.equal(result.run.owner, 'chat-run-service');
      assert.equal(result.run.createdAt, '2026-01-02T03:04:05.000Z');
      assert.equal(result.attempt.attemptId, intent.attemptId);
      assert.equal(result.attempt.logicalRunId, intent.logicalRunId);
      assert.equal(result.attempt.state, 'starting');
      assert.equal(result.attempt.cause, 'initial');

      assert.deepEqual(getRun(intent.logicalRunId, store), result.run);
      assert.deepEqual(getAttempt(intent.attemptId, store), result.attempt);

      const attempts = listAttempts(intent.logicalRunId, store);
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].attemptId, intent.attemptId);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeRunIntent is idempotent by requestId and creates no duplicate', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const intent = baseIntent();
      const first = writeRunIntent(intent, store);
      const second = writeRunIntent(intent, store);

      assert.equal(second.created, false);
      assert.equal(second.run.logicalRunId, first.run.logicalRunId);
      assert.equal(second.attempt.attemptId, first.attempt.attemptId);
      assert.equal(listRuns({}, store).length, 1);
      assert.equal(listAttempts(first.run.logicalRunId, store).length, 1);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeRunIntent rejects malformed payloads with invalid_intent', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const intent = baseIntent();
      const cases = [
        { ...intent, logicalRunId: 'not-an-id' },
        { ...intent, attemptId: 'att_not-a-uuid' },
        { ...intent, requestId: '' },
        { ...intent, requestId: 'req_after_crash' },
        { ...intent, requestId: 'req_not-a-uuid' },
        { ...intent, requestId: newRecoveryId('attempt') },
        { ...intent, family: 'nope' },
        { ...intent, owner: 'someone-else' },
      ];
      for (const bad of cases) {
        assert.throws(
          () => writeRunIntent(bad, store),
          (err) => {
            assert.ok(isRecoveryStoreError(err));
            assert.equal(err.code, 'invalid_intent');
            return true;
          }
        );
      }
      assert.equal(listRuns({}, store).length, 0);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed intent write throws intent_write_failed and blocks the launch', () => {
  const dir = tempDir();
  try {
    const store = openRecoveryStore({ dataDir: dir });
    const intent = baseIntent();
    writeRunIntent(intent, store);

    // Closed handle: the crash/close window must surface as a hard blocker.
    closeRecoveryStore(store);
    assert.throws(
      () => writeRunIntent(baseIntent(), store),
      (err) => {
        assert.ok(isRecoveryStoreError(err));
        assert.equal(err.code, 'intent_write_failed');
        return true;
      }
    );

    // No store open at all is the same blocker for the process default.
    assert.throws(() => writeRunIntent(baseIntent()), (err) => err.code === 'intent_write_failed');

    // A raw database close is also reported as a write failure, never a silent
    // success.
    const second = openRecoveryStore({ dataDir: dir });
    getRecoveryStoreDatabase(second).close();
    assert.throws(
      () => writeRunIntent(baseIntent(), second),
      (err) => isRecoveryStoreError(err) && err.code === 'intent_write_failed'
    );
    second.closed = true;

    // A writable connection flipped to read-only is an injected broken store:
    // the write must fail loudly instead of pretending the intent was saved.
    const third = openRecoveryStore({ dataDir: dir });
    third.db.exec('PRAGMA query_only = ON;');
    assert.throws(
      () => writeRunIntent(baseIntent(), third),
      (err) => isRecoveryStoreError(err) && err.code === 'intent_write_failed'
    );
    third.db.exec('PRAGMA query_only = OFF;');
    closeRecoveryStore(third);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openRecoveryStore fails closed with store_open_failed on an unusable path', () => {
  const dir = tempDir();
  try {
    // A regular file in the way makes `mkdir -p` of the parent impossible.
    const blocker = path.join(dir, 'blocker');
    writeFileSync(blocker, 'not a directory');
    assert.throws(
      () => openRecoveryStore({ filePath: path.join(blocker, 'recovery.sqlite') }),
      (err) => {
        assert.ok(isRecoveryStoreError(err));
        assert.equal(err.code, 'store_open_failed');
        return true;
      }
    );

    // An unknown synchronous mode is rejected before any file is touched.
    assert.throws(
      () => openRecoveryStore({ dataDir: dir, synchronous: 'TURBO' }),
      (err) => isRecoveryStoreError(err) && err.code === 'store_open_failed'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('transitionRun applies a valid CAS and rejects reasons without throwing', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const intent = baseIntent();
      writeRunIntent(intent, store);

      const wrongRevision = transitionRun(
        { logicalRunId: intent.logicalRunId, expectedRevision: 2, to: 'running' },
        store
      );
      assert.equal(wrongRevision.ok, false);
      assert.equal(wrongRevision.applied, false);
      assert.equal(wrongRevision.conflict, true);
      assert.equal(wrongRevision.reason, 'revision_conflict');
      assert.equal(getRun(intent.logicalRunId, store).state, 'starting');
      assert.equal(getRun(intent.logicalRunId, store).revision, 1);

      const applied = transitionRun(
        { logicalRunId: intent.logicalRunId, expectedRevision: 1, to: 'running' },
        store
      );
      assert.equal(applied.ok, true);
      assert.equal(applied.applied, true);
      assert.equal(applied.conflict, false);
      assert.equal(applied.run.state, 'running');
      assert.equal(applied.run.revision, 2);
      assert.equal(getRun(intent.logicalRunId, store).revision, 2);

      const ownerMismatch = transitionRun(
        {
          logicalRunId: intent.logicalRunId,
          expectedRevision: 2,
          to: 'waiting',
          expectedOwner: 'delegation-service',
        },
        store
      );
      assert.equal(ownerMismatch.reason, 'owner_mismatch');

      const generationMismatch = transitionRun(
        {
          logicalRunId: intent.logicalRunId,
          expectedRevision: 2,
          to: 'waiting',
          expectedGeneration: 7,
        },
        store
      );
      assert.equal(generationMismatch.reason, 'generation_mismatch');

      const stateMismatch = transitionRun(
        {
          logicalRunId: intent.logicalRunId,
          expectedRevision: 2,
          to: 'waiting',
          expectedState: 'completed',
        },
        store
      );
      assert.equal(stateMismatch.reason, 'state_mismatch');

      const notFound = transitionRun(
        { logicalRunId: newRecoveryId('logical_run'), expectedRevision: 1, to: 'running' },
        store
      );
      assert.equal(notFound.reason, 'not_found');
      assert.equal(notFound.run, null);

      // Nothing above changed the run.
      assert.equal(getRun(intent.logicalRunId, store).state, 'running');
      assert.equal(getRun(intent.logicalRunId, store).revision, 2);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an illegal contract transition is refused and leaves the run untouched', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const intent = baseIntent();
      writeRunIntent(intent, store);

      const completed = transitionRun(
        { logicalRunId: intent.logicalRunId, expectedRevision: 1, to: 'completed' },
        store
      );
      assert.equal(completed.ok, true);
      assert.equal(completed.run.state, 'completed');

      const illegal = transitionRun(
        { logicalRunId: intent.logicalRunId, expectedRevision: 2, to: 'running' },
        store
      );
      assert.equal(illegal.ok, false);
      assert.equal(illegal.reason, 'illegal_transition');

      const unknownTarget = transitionRun(
        { logicalRunId: intent.logicalRunId, expectedRevision: 2, to: 'bogus' },
        store
      );
      assert.equal(unknownTarget.reason, 'illegal_transition');

      const run = getRun(intent.logicalRunId, store);
      assert.equal(run.state, 'completed');
      assert.equal(run.revision, 2);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('registerAttempt adds an attempt to the same logical run and is idempotent', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const intent = baseIntent();
      writeRunIntent(intent, store);

      const next = createRecoveryIds();
      const registered = registerAttempt(
        {
          logicalRunId: intent.logicalRunId,
          attemptId: next.attemptId,
          requestId: next.requestId,
          cause: 'new_attempt',
          now: '2026-02-03T00:00:00.000Z',
        },
        store
      );
      assert.equal(registered.created, true);
      assert.equal(registered.attempt.logicalRunId, intent.logicalRunId);
      assert.equal(registered.attempt.cause, 'new_attempt');
      assert.equal(registered.attempt.state, 'starting');

      const attempts = listAttempts(intent.logicalRunId, store);
      assert.equal(attempts.length, 2);
      assert.deepEqual(
        attempts.map((a) => a.attemptId).sort(),
        [intent.attemptId, next.attemptId].sort()
      );

      const replay = registerAttempt(
        { logicalRunId: intent.logicalRunId, attemptId: next.attemptId, requestId: next.requestId },
        store
      );
      assert.equal(replay.created, false);
      assert.equal(replay.attempt.attemptId, next.attemptId);
      assert.equal(listAttempts(intent.logicalRunId, store).length, 2);

      // A duplicate attempt id without a request id is a hard write failure.
      assert.throws(
        () => registerAttempt({ logicalRunId: intent.logicalRunId, attemptId: next.attemptId }, store),
        (err) => isRecoveryStoreError(err) && err.code === 'attempt_write_failed'
      );

      // An unknown logical run is also a write failure, not a created attempt.
      assert.throws(
        () =>
          registerAttempt(
            { logicalRunId: newRecoveryId('logical_run'), attemptId: newRecoveryId('attempt') },
            store
          ),
        (err) => isRecoveryStoreError(err) && err.code === 'attempt_write_failed'
      );

      // A malformed requestId is rejected before anything is written.
      assert.throws(
        () =>
          registerAttempt(
            {
              logicalRunId: intent.logicalRunId,
              attemptId: newRecoveryId('attempt'),
              requestId: 'req_after_crash',
            },
            store
          ),
        (err) => isRecoveryStoreError(err) && err.code === 'attempt_write_failed'
      );
      assert.throws(
        () =>
          registerAttempt(
            {
              logicalRunId: intent.logicalRunId,
              attemptId: newRecoveryId('attempt'),
              requestId: newRecoveryId('logical_run'),
            },
            store
          ),
        (err) => isRecoveryStoreError(err) && err.code === 'attempt_write_failed'
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeRunIntent rejects a reused requestId for a different run identity', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const intent = baseIntent();
      writeRunIntent(intent, store);
      const other = createRecoveryIds();

      // Same requestId, different logicalRunId and attemptId.
      assert.throws(
        () =>
          writeRunIntent(
            { ...intent, logicalRunId: other.logicalRunId, attemptId: other.attemptId },
            store
          ),
        (err) => {
          assert.ok(isRecoveryStoreError(err));
          assert.equal(err.code, 'request_conflict');
          assert.equal(err.details.requestId, intent.requestId);
          return true;
        }
      );

      // Same logicalRunId but a different attemptId is still a conflict.
      assert.throws(
        () => writeRunIntent({ ...intent, attemptId: other.attemptId }, store),
        (err) => isRecoveryStoreError(err) && err.code === 'request_conflict'
      );

      // The original intent is untouched and still idempotent.
      assert.equal(listRuns({}, store).length, 1);
      assert.equal(listAttempts(intent.logicalRunId, store).length, 1);
      const replay = writeRunIntent(intent, store);
      assert.equal(replay.created, false);
      assert.equal(replay.run.logicalRunId, intent.logicalRunId);
      assert.equal(replay.attempt.attemptId, intent.attemptId);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('registerAttempt rejects a reused requestId for a different attempt identity', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const intent = baseIntent();
      writeRunIntent(intent, store);
      const next = createRecoveryIds();
      registerAttempt(
        {
          logicalRunId: intent.logicalRunId,
          attemptId: next.attemptId,
          requestId: next.requestId,
        },
        store
      );

      // Same requestId, different attemptId.
      const other = createRecoveryIds();
      assert.throws(
        () =>
          registerAttempt(
            {
              logicalRunId: intent.logicalRunId,
              attemptId: other.attemptId,
              requestId: next.requestId,
            },
            store
          ),
        (err) => {
          assert.ok(isRecoveryStoreError(err));
          assert.equal(err.code, 'request_conflict');
          assert.equal(err.details.requestId, next.requestId);
          return true;
        }
      );

      // Same requestId, existing but different logical run.
      const second = baseIntent();
      writeRunIntent(second, store);
      assert.throws(
        () =>
          registerAttempt(
            {
              logicalRunId: second.logicalRunId,
              attemptId: next.attemptId,
              requestId: next.requestId,
            },
            store
          ),
        (err) => isRecoveryStoreError(err) && err.code === 'request_conflict'
      );

      // Exact replay stays idempotent.
      const replay = registerAttempt(
        {
          logicalRunId: intent.logicalRunId,
          attemptId: next.attemptId,
          requestId: next.requestId,
        },
        store
      );
      assert.equal(replay.created, false);
      assert.equal(replay.attempt.attemptId, next.attemptId);
      assert.equal(listAttempts(intent.logicalRunId, store).length, 2);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('transitionRun patch cannot rewrite protected identity/lifecycle fields', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const intent = baseIntent();
      writeRunIntent(intent, store);
      const before = getRun(intent.logicalRunId, store);
      const other = createRecoveryIds();

      const result = transitionRun(
        {
          logicalRunId: intent.logicalRunId,
          expectedRevision: 1,
          to: 'running',
          patch: {
            schemaVersion: 99,
            logicalRunId: other.logicalRunId,
            attemptId: other.attemptId,
            requestId: other.requestId,
            family: 'delegation',
            owner: 'delegation-service',
            state: 'completed',
            revision: 42,
            generation: 7,
            createdAt: '1999-01-01T00:00:00.000Z',
            updatedAt: '1999-01-01T00:00:00.000Z',
            sessionId: 'session-patched',
            harness: 'patched-harness',
          },
        },
        store
      );

      assert.equal(result.ok, true);
      assert.equal(result.run.schemaVersion, before.schemaVersion);
      assert.equal(result.run.logicalRunId, before.logicalRunId);
      assert.equal(result.run.attemptId, before.attemptId);
      assert.equal(result.run.requestId, before.requestId);
      assert.equal(result.run.family, before.family);
      assert.equal(result.run.owner, before.owner);
      assert.equal(result.run.generation, before.generation);
      assert.equal(result.run.state, 'running');
      assert.equal(result.run.revision, 2);
      assert.equal(result.run.createdAt, before.createdAt);
      assert.notEqual(result.run.updatedAt, '1999-01-01T00:00:00.000Z');
      // The non-protected metadata from `patch` is allowed through.
      assert.equal(result.run.sessionId, 'session-patched');
      assert.equal(result.run.harness, 'patched-harness');

      const persisted = getRun(intent.logicalRunId, store);
      assert.equal(persisted.requestId, before.requestId);
      assert.equal(persisted.attemptId, before.attemptId);
      assert.equal(persisted.generation, before.generation);
      assert.equal(persisted.state, 'running');
      assert.equal(persisted.revision, 2);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openRecoveryStore enables WAL, synchronous=FULL and foreign_keys', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const journal = store.db.prepare('PRAGMA journal_mode').get();
      assert.equal(String(Object.values(journal)[0]).toLowerCase(), 'wal');

      const synchronous = store.db.prepare('PRAGMA synchronous').get();
      assert.equal(Number(Object.values(synchronous)[0]), 2);

      const foreignKeys = store.db.prepare('PRAGMA foreign_keys').get();
      assert.equal(Number(Object.values(foreignKeys)[0]), 1);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt non-empty store file fails closed and is left byte-identical', () => {
  const dir = tempDir();
  const filePath = path.join(dir, 'recovery.sqlite');
  try {
    const garbage = Buffer.from('this is definitely not a sqlite database file at all');
    writeFileSync(filePath, garbage);

    assert.throws(
      () => openRecoveryStore({ filePath }),
      (err) => {
        assert.ok(isRecoveryStoreError(err));
        assert.equal(err.code, 'store_open_failed');
        return true;
      }
    );

    assert.deepEqual(readFileSync(filePath), garbage);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('foreign keys link attempts and requests to recovery_runs', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);

      const at = '2026-04-01T00:00:00.000Z';
      const missingRunId = newRecoveryId('logical_run');

      // An attempt for a run that does not exist violates the FK.
      assert.throws(
        () =>
          store.db
            .prepare(
              `INSERT INTO recovery_attempts(
                attempt_id, logical_run_id, request_id, state, revision, created_at, updated_at, json
              ) VALUES(?, ?, '', 'starting', 1, ?, ?, '{}')`
            )
            .run(newRecoveryId('attempt'), missingRunId, at, at),
        /FOREIGN KEY/i
      );

      // Same for the idempotency ledger.
      assert.throws(
        () =>
          store.db
            .prepare(
              `INSERT INTO recovery_requests(
                request_id, kind, logical_run_id, attempt_id, created_at, json
              ) VALUES(?, 'run_intent', ?, '', ?, '{}')`
            )
            .run(newRecoveryId('request'), missingRunId, at),
        /FOREIGN KEY/i
      );

      // With a real run the rows insert and the check stays clean.
      const intent = baseIntent();
      writeRunIntent(intent, store);
      assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listRuns and listOpenRuns filter by family, state and workspace', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const chatA = baseIntent({ workspaceFolder: '/ws/a' });
      writeRunIntent(chatA, store);
      const chatB = baseIntent({ workspaceFolder: '/ws/b' });
      writeRunIntent(chatB, store);

      assert.equal(listRuns({}, store).length, 2);
      assert.equal(listRuns({ family: 'chat' }, store).length, 2);
      assert.equal(listRuns({ family: 'delegation' }, store).length, 0);
      assert.equal(listRuns({ workspaceFolder: '/ws/a' }, store).length, 1);
      assert.equal(listRuns({ state: 'starting' }, store).length, 2);
      assert.equal(listRuns({ state: 'completed' }, store).length, 0);
      assert.equal(listOpenRuns({}, store).length, 2);
      assert.equal(listOpenRuns({ limit: 1 }, store).length, 1);

      transitionRun(
        { logicalRunId: chatB.logicalRunId, expectedRevision: 1, to: 'completed' },
        store
      );
      assert.equal(listOpenRuns({}, store).length, 1);
      assert.equal(listRuns({ state: 'completed' }, store).length, 1);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two independent connections resolve the same CAS to exactly one winner', () => {
  const dir = tempDir();
  const storeA = openRecoveryStore({ dataDir: dir });
  const storeB = openRecoveryStore({ dataDir: dir });
  try {
    const intent = baseIntent();
    writeRunIntent(intent, storeA);

    const first = transitionRun(
      { logicalRunId: intent.logicalRunId, expectedRevision: 1, to: 'running' },
      storeA
    );
    const second = transitionRun(
      { logicalRunId: intent.logicalRunId, expectedRevision: 1, to: 'waiting' },
      storeB
    );
    const results = [first, second];
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal(
      results.filter((r) => !r.ok && r.reason === 'revision_conflict').length,
      1
    );

    const run = getRun(intent.logicalRunId, storeA);
    assert.equal(run.revision, 2);
    // Only the winner's target state is persisted.
    assert.ok(['running', 'waiting'].includes(run.state));
    assert.equal(getRun(intent.logicalRunId, storeB).state, run.state);
  } finally {
    closeRecoveryStore(storeA);
    closeRecoveryStore(storeB);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recovery ids have a canonical format, parse back and reject garbage', () => {
  assert.deepEqual([...RECOVERY_ID_KINDS], ['logical_run', 'attempt', 'request', 'cycle']);

  const ids = createRecoveryIds();
  assert.ok(ids.logicalRunId.startsWith('lrun_'));
  assert.ok(ids.attemptId.startsWith('att_'));
  assert.ok(ids.requestId.startsWith('req_'));
  assert.ok(ids.cycleId.startsWith('cyc_'));

  assert.deepEqual(parseRecoveryId(ids.attemptId), {
    kind: 'attempt',
    uuid: ids.attemptId.slice('att_'.length),
  });
  assert.equal(isRecoveryId(ids.attemptId), true);
  assert.equal(isRecoveryId(ids.attemptId, 'attempt'), true);
  assert.equal(isRecoveryId(ids.attemptId, 'cycle'), false);
  assert.equal(parseRecoveryId('nope_123'), null);
  assert.equal(parseRecoveryId('att_not-a-uuid'), null);
  assert.equal(parseRecoveryId(''), null);
  assert.equal(isRecoveryId(42), false);

  const unique = new Set(
    Array.from({ length: 50 }, () => createRecoveryIds().logicalRunId)
  );
  assert.equal(unique.size, 50);

  const uuid = '11111111-2222-4333-8444-555555555555';
  assert.equal(newRecoveryId('attempt', { uuid }), `att_${uuid}`);
  // Case-insensitive validation, canonical lowercase output.
  assert.equal(newRecoveryId('attempt', { uuid: uuid.toUpperCase() }), `att_${uuid}`);
  assert.equal(parseRecoveryId(`att_${uuid.toUpperCase()}`).uuid, uuid);

  assert.throws(() => newRecoveryId('bogus', { uuid }), TypeError);
  assert.throws(() => newRecoveryId('attempt', { uuid: 'not-a-uuid' }), TypeError);
  assert.throws(() => newRecoveryId('attempt', { uuid: '' }), TypeError);

  // Telemetry compatibility: one trimmed token, within `shortCode`'s 64 chars.
  for (const id of Object.values(ids)) {
    assert.equal(id, id.trim());
    assert.equal(/\s/.test(id), false);
    assert.ok(id.length <= 64);
  }
});

test('a run written by intent is found again by requestId across a fresh store read', () => {
  const dir = tempDir();
  try {
    const intent = baseIntent({
      workspaceFolder: '/tmp/workspace-lookup',
      chatId: 'chat-lookup',
      harness: 'codex',
      requestId: newRecoveryId('request', { uuid: 'aaaaaaaa-bbbb-4bbb-8ccc-dddddddddddd' }),
    });
    withStore(dir, (store) => {
      const written = writeRunIntent(intent, store);
      assert.equal(written.created, true);
      const found = getRunByRequestId(intent.requestId, store);
      assert.equal(found.logicalRunId, intent.logicalRunId);
      assert.equal(found.requestId, intent.requestId);
      assert.equal(found.state, 'starting');
      // The requestId column is what a restarted process has; the run id is not.
      assert.deepEqual(resolveRunRefByRequest('run_intent', intent.requestId, store), {
        logicalRunId: intent.logicalRunId,
        attemptId: intent.attemptId,
      });
    });

    // Reopen the same file: the lookup survives the process boundary.
    withStore(dir, (store) => {
      const found = getRunByRequestId(intent.requestId, store);
      assert.equal(found?.logicalRunId, intent.logicalRunId);
      assert.equal(getRun(found.logicalRunId, store).requestId, intent.requestId);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getRunByRequestId and resolveRunRefByRequest answer blank or unknown ids as null', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const intent = baseIntent();
      writeRunIntent(intent, store);

      assert.equal(getRunByRequestId('', store), null);
      assert.equal(getRunByRequestId('   ', store), null);
      assert.equal(getRunByRequestId(newRecoveryId('request', { uuid: 'ffffffff-1111-4111-8222-333333333333' }), store), null);

      assert.equal(resolveRunRefByRequest('run_intent', '', store), null);
      assert.equal(resolveRunRefByRequest('', intent.requestId, store), null);
      // The ledger is keyed by kind: an attempt row does not answer run_intent.
      assert.equal(resolveRunRefByRequest('attempt', intent.requestId, store), null);
      assert.deepEqual(resolveRunRefByRequest('run_intent', intent.requestId, store), {
        logicalRunId: intent.logicalRunId,
        attemptId: intent.attemptId,
      });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
