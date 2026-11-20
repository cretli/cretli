/**
 * Restart-time rotation decision: the Node helper and the shell launcher both
 * rename the old log aside only after the previous writer is verified gone.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveRestartLogRotation } from '../lib/log-rotate.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guardPath = path.join(projectRoot, 'scripts', 'lib', 'restart-log-guard.sh');

/**
 * Runs the shared shell guard with a listener PID list and the lsof exit status.
 * @param {string} listenerPids
 * @param {number} [lsofStatus]
 * @returns {number} exit status
 */
function shellDecision(listenerPids, lsofStatus = 1) {
  return spawnSync('bash', [
    '-c',
    'source "$1"; restart_log_rotation_allowed "$2" "$3"',
    'bash',
    guardPath,
    listenerPids,
    String(lsofStatus),
  ]).status;
}

test('rotates only when the old process is gone and the port is free', () => {
  assert.deepEqual(
    resolveRestartLogRotation({ processGone: true, portFree: true }),
    { rotate: true, reason: '' },
  );
});

test('skips rotation when the old PID survives SIGKILL', () => {
  const decision = resolveRestartLogRotation({ processGone: false, portFree: true });
  assert.equal(decision.rotate, false);
  assert.match(decision.reason, /old process still alive/);
});

test('skips rotation when the port listener remains', () => {
  const decision = resolveRestartLogRotation({ processGone: true, portFree: false });
  assert.equal(decision.rotate, false);
  assert.match(decision.reason, /port 3011/);
});

test('the shell launcher decision allows rotation only when lsof ran and found nobody', () => {
  assert.equal(shellDecision('', 1), 0);
  assert.notEqual(shellDecision('1234 5678', 0), 0);
});

test('the shell launcher treats an inconclusive lsof probe as rotation not allowed', () => {
  assert.notEqual(shellDecision('', 2), 0);
  assert.notEqual(shellDecision('', 127), 0);
});
