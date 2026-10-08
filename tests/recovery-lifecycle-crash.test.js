/**
 * Crash-durability test for the launch/finish lifecycle layer (leaf R5).
 *
 * A real child process performs a durable `beginRunLaunch` (intent + approved
 * prompt) through the real lifecycle API, signals readiness and is then killed
 * with SIGKILL *before* any executor ack. Reopening the store in the parent
 * proves the leaf's core promise survives a process death: the run is `starting`
 * with NO acceptance proof, and `canAutoRelaunch` still denies an automatic
 * relaunch (`no_acceptance_proof`).
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { closeRecoveryStore, getRun, openRecoveryStore } from '../lib/recovery/recovery-store.js';
import { getQueueEntry } from '../lib/recovery/recovery-queue.js';
import { canAutoRelaunch } from '../lib/recovery/recovery-lifecycle.js';
import { spawnRecoveryCrashChild, supportsSigkill } from './helpers/recovery-crash-harness.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORE_URL = pathToFileURL(path.join(HERE, '..', 'lib', 'recovery', 'recovery-store.js')).href;
const IDS_URL = pathToFileURL(path.join(HERE, '..', 'lib', 'recovery', 'recovery-ids.js')).href;
const LIFECYCLE_URL = pathToFileURL(
  path.join(HERE, '..', 'lib', 'recovery', 'recovery-lifecycle.js')
).href;

const SKIP = supportsSigkill() ? false : 'SIGKILL is not supported on this platform';

const LAUNCH_SCRIPT = `
import fs from 'node:fs';
import path from 'node:path';
import { openRecoveryStore } from ${JSON.stringify(STORE_URL)};
import { createRecoveryIds } from ${JSON.stringify(IDS_URL)};
import { beginRunLaunch } from ${JSON.stringify(LIFECYCLE_URL)};

const dataDir = process.env.RECOVERY_CRASH_DATA_DIR;
const store = openRecoveryStore({ dataDir });
const ids = createRecoveryIds();
const launched = beginRunLaunch(
  { ...ids, family: 'chat', owner: 'chat-run-service', harness: 'opencode', prompt: 'durable prompt', mode: 'agent' },
  store
);
if (!launched.created) throw new Error('launch intent was not created');
if (launched.run.state !== 'starting') throw new Error('run is not starting after a durable launch');
fs.writeFileSync(path.join(dataDir, 'ids.json'), JSON.stringify({ ids }));
process.stdout.write('READY\\n');
setInterval(() => {}, 1000);
`;

test('a durable launch survives SIGKILL before any ack and keeps the gate denied', { skip: SKIP }, async () => {
  const child = await spawnRecoveryCrashChild({ script: LAUNCH_SCRIPT });
  try {
    assert.ok(child.pid, 'child has a pid');
    const { ids } = JSON.parse(readFileSync(path.join(child.dataDir, 'ids.json'), 'utf8'));

    const exit = await child.kill();
    assert.equal(exit.signal, 'SIGKILL', 'child was killed with SIGKILL before any ack');

    const store = openRecoveryStore({ dataDir: child.dataDir });
    try {
      const run = getRun(ids.logicalRunId, store);
      assert.ok(run, 'the launch intent survived the SIGKILL');
      assert.equal(run.state, 'starting', 'no ack ever moved the run to running');
      assert.equal(run.acceptance == null, true, 'there is no acceptance proof to honor');

      // The approved prompt is durable too, but it does not grant acceptance.
      const entry = getQueueEntry(ids.requestId, store);
      assert.equal(entry.state, 'queued');

      const gate = canAutoRelaunch({ logicalRunId: ids.logicalRunId, liveness: 'alive', harness: 'opencode' }, store);
      assert.equal(gate.allowed, false);
      assert.equal(gate.reason, 'no_acceptance_proof');
    } finally {
      closeRecoveryStore(store);
    }
  } finally {
    await child.dispose();
  }
});
