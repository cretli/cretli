import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import { collectSdkLocalStoreStats } from '../lib/sdk/sdk-context-stats.js';

const storeDir = path.join(ISOLATED_DATA_DIR, 'sdk-agent-store', 'sess');
const checkpointPath = path.join(storeDir, 'checkpoints.ndjson');
const originalRead = fs.readFileSync;
let checkpointReads = 0;
fs.readFileSync = function readFileSyncCounting(target, ...args) {
  if (String(target) === checkpointPath) checkpointReads += 1;
  return originalRead.call(this, target, ...args);
};

try {
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(checkpointPath, 'x'.repeat(300 * 1024));
  fs.writeFileSync(path.join(storeDir, 'note.txt'), 'one\ntwo\n');
  fs.writeFileSync(
    path.join(storeDir, 'agents.ndjson'),
    `${JSON.stringify({ agentId: 'agent-1', status: 'running' })}\n`,
  );
  checkpointReads = 0;
  const stats = collectSdkLocalStoreStats('sess');
  assert.equal(checkpointReads, 0);
  assert.equal(stats?.files?.['checkpoints.ndjson']?.lines, null);
  assert.ok(stats.files['checkpoints.ndjson'].bytes > 256 * 1024);
  assert.equal(stats.files['note.txt'].lines, 2);
  assert.equal(stats.agents.length, 1);
  assert.equal(stats.agents[0].agentId, 'agent-1');
  assert.ok(stats.totalBytes > stats.files['checkpoints.ndjson'].bytes);
  console.log('sdk-local-store-stats.test.js ok');
} finally {
  fs.readFileSync = originalRead;
}
