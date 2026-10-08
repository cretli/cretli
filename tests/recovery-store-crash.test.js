/**
 * Crash-durability tests for the recovery store (leaf R2).
 *
 * A real child process writes through the real store API into its own temp data
 * dir, signals readiness and is then killed with SIGKILL. Reopening the store in
 * the parent proves the intent survived a process death, and that an
 * uncommitted transaction never leaves a partial row behind.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  closeRecoveryStore,
  getRun,
  listAttempts,
  listOpenRuns,
  listRuns,
  openRecoveryStore,
  writeRunIntent,
} from '../lib/recovery/recovery-store.js';
import { createRecoveryIds } from '../lib/recovery/recovery-ids.js';
import {
  createCrashDataDir,
  spawnRecoveryBarrier,
  spawnRecoveryCrashChild,
  supportsSigkill,
} from './helpers/recovery-crash-harness.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORE_URL = pathToFileURL(path.join(HERE, '..', 'lib', 'recovery', 'recovery-store.js')).href;
const IDS_URL = pathToFileURL(path.join(HERE, '..', 'lib', 'recovery', 'recovery-ids.js')).href;

const SKIP = supportsSigkill() ? false : 'SIGKILL is not supported on this platform';

const INTENT_SCRIPT = `
import fs from 'node:fs';
import path from 'node:path';
import { openRecoveryStore, writeRunIntent } from ${JSON.stringify(STORE_URL)};
import { createRecoveryIds } from ${JSON.stringify(IDS_URL)};

const dataDir = process.env.RECOVERY_CRASH_DATA_DIR;
const store = openRecoveryStore({ dataDir });
const ids = createRecoveryIds();
const result = writeRunIntent({
  logicalRunId: ids.logicalRunId,
  attemptId: ids.attemptId,
  requestId: ids.requestId,
  family: 'chat',
  owner: 'chat-run-service',
  workspaceFolder: '/crash/ws',
  now: '2026-03-01T00:00:00.000Z',
}, store);
if (!result.created) throw new Error('intent was not created');
fs.writeFileSync(path.join(dataDir, 'ids.json'), JSON.stringify(ids));
process.stdout.write('READY\\n');
setInterval(() => {}, 1000);
`;

const PARTIAL_TX_SCRIPT = `
import { openRecoveryStore, getRecoveryStoreDatabase } from ${JSON.stringify(STORE_URL)};
import { createRecoveryIds } from ${JSON.stringify(IDS_URL)};

const dataDir = process.env.RECOVERY_CRASH_DATA_DIR;
const store = openRecoveryStore({ dataDir });
const db = getRecoveryStoreDatabase(store);
const ids = createRecoveryIds();
const at = '2026-03-02T00:00:00.000Z';
db.exec('BEGIN IMMEDIATE');
db.prepare(
  'INSERT INTO recovery_runs(logical_run_id, family, owner, state, workspace_folder, chat_id, generation, revision, request_id, created_at, updated_at, json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'
).run(ids.logicalRunId, 'chat', 'chat-run-service', 'starting', '', '', 0, 1, '', at, at, JSON.stringify({ partial: true }));
process.stdout.write('READY ' + ids.logicalRunId + '\\n');
setInterval(() => {}, 1000);
`;

/**
 * Two children open the same store and hold at the harness barrier (`READY`
 * twice, then the parent creates `go`). Only then do both call `transitionRun`
 * on the same run with the same `expectedRevision`, which makes the CAS race
 * genuinely concurrent across OS processes.
 */
const CAS_RACE_SCRIPT = `
import fs from 'node:fs';
import {
  closeRecoveryStore,
  openRecoveryStore,
  transitionRun,
} from ${JSON.stringify(STORE_URL)};

const dataDir = process.env.RECOVERY_CRASH_DATA_DIR;
const logicalRunId = process.env.RECOVERY_CAS_RUN;
const to = process.env.RECOVERY_CAS_TO;
const go = process.env.RECOVERY_CRASH_BARRIER;

const store = openRecoveryStore({ dataDir });
process.stdout.write('READY\\n');
while (!fs.existsSync(go)) {
  await new Promise((resolve) => setTimeout(resolve, 5));
}
const result = transitionRun({ logicalRunId, expectedRevision: 1, to }, store);
process.stdout.write(
  'RESULT ' +
    JSON.stringify({
      ok: result.ok,
      reason: result.reason,
      revision: result.run ? result.run.revision : null,
      state: result.run ? result.run.state : null,
    }) +
    '\\n'
);
closeRecoveryStore(store);
`;

test('a committed run intent survives SIGKILL and is readable after reopen', { skip: SKIP }, async () => {
  const child = await spawnRecoveryCrashChild({ script: INTENT_SCRIPT });
  try {
    assert.ok(child.pid, 'child has a pid');
    const ids = JSON.parse(readFileSync(path.join(child.dataDir, 'ids.json'), 'utf8'));

    const exit = await child.kill();
    assert.equal(exit.signal, 'SIGKILL', 'child was killed with SIGKILL');

    const store = openRecoveryStore({ dataDir: child.dataDir });
    try {
      const run = getRun(ids.logicalRunId, store);
      assert.ok(run, 'the run intent survived the SIGKILL');
      assert.equal(run.state, 'starting');
      assert.equal(run.attemptId, ids.attemptId);
      assert.equal(run.workspaceFolder, '/crash/ws');

      const attempts = listAttempts(ids.logicalRunId, store);
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].attemptId, ids.attemptId);
      assert.equal(listOpenRuns({}, store).length, 1);

      // The request ledger also survived: replaying the same intent after the
      // crash returns the existing record instead of duplicating it.
      const replay = writeRunIntent(
        {
          logicalRunId: ids.logicalRunId,
          attemptId: ids.attemptId,
          requestId: ids.requestId,
          family: 'chat',
          owner: 'chat-run-service',
        },
        store
      );
      assert.equal(replay.created, false);
      assert.equal(listRuns({}, store).length, 1);
    } finally {
      closeRecoveryStore(store);
    }
  } finally {
    await child.dispose();
  }
});

test('an uncommitted transaction leaves no partial row after SIGKILL', { skip: SKIP }, async () => {
  const child = await spawnRecoveryCrashChild({ script: PARTIAL_TX_SCRIPT });
  try {
    assert.ok(child.pid, 'child has a pid');
    const exit = await child.kill();
    assert.equal(exit.signal, 'SIGKILL', 'child was killed with SIGKILL');

    const store = openRecoveryStore({ dataDir: child.dataDir });
    try {
      const integrity = store.db.prepare('PRAGMA integrity_check').get();
      assert.equal(String(Object.values(integrity)[0]).toLowerCase(), 'ok');
      assert.deepEqual(listRuns({}, store), [], 'no partially written run row');
      assert.deepEqual(listOpenRuns({}, store), []);

      // The store is still writable and consistent after the torn transaction.
      const freshIds = createRecoveryIds();
      const fresh = writeRunIntent(
        {
          logicalRunId: freshIds.logicalRunId,
          attemptId: freshIds.attemptId,
          requestId: freshIds.requestId,
          family: 'chat',
          owner: 'chat-run-service',
        },
        store
      );
      assert.equal(fresh.created, true);
      assert.equal(listRuns({}, store).length, 1);
    } finally {
      closeRecoveryStore(store);
    }
  } finally {
    await child.dispose();
  }
});

test('two concurrent processes resolve the same CAS to exactly one winner', async () => {
  const dir = createCrashDataDir();
  try {
    const ids = createRecoveryIds();
    const seed = openRecoveryStore({ dataDir: dir });
    try {
      const created = writeRunIntent(
        {
          logicalRunId: ids.logicalRunId,
          attemptId: ids.attemptId,
          requestId: ids.requestId,
          family: 'chat',
          owner: 'chat-run-service',
        },
        seed
      );
      assert.equal(created.created, true);
    } finally {
      closeRecoveryStore(seed);
    }

    const barrier = await spawnRecoveryBarrier({
      dataDir: dir,
      script: CAS_RACE_SCRIPT,
      env: { RECOVERY_CAS_RUN: ids.logicalRunId },
      envForIndex: (index) => ({ RECOVERY_CAS_TO: index === 0 ? 'running' : 'waiting' }),
    });
    try {
      // Both children have opened the store and are blocked on the barrier.
      assert.equal(barrier.handles.length, 2);
      barrier.release();
      await barrier.waitForExit(20000);

      const results = barrier.handles.map((handle) => {
        const match = handle.stdout().match(/RESULT (\{.*\})/);
        assert.ok(
          match,
          `child printed a RESULT line\n--- stdout ---\n${handle.stdout()}\n--- stderr ---\n${handle.stderr()}`
        );
        return JSON.parse(match[1]);
      });

      const winners = results.filter((result) => result.ok);
      const conflicts = results.filter(
        (result) => !result.ok && result.reason === 'revision_conflict'
      );
      assert.equal(winners.length, 1, `exactly one winner: ${JSON.stringify(results)}`);
      assert.equal(conflicts.length, 1, `exactly one revision_conflict: ${JSON.stringify(results)}`);

      const finalStore = openRecoveryStore({ dataDir: dir });
      try {
        const run = getRun(ids.logicalRunId, finalStore);
        assert.equal(run.revision, 2, 'revision advanced exactly once');
        assert.equal(run.state, winners[0].state, 'final state is the winner state');
        assert.ok(['running', 'waiting'].includes(run.state));
      } finally {
        closeRecoveryStore(finalStore);
      }
    } finally {
      await barrier.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
