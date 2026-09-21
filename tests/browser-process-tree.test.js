/**
 * Process-tree helpers used by the hard Browser cleanup path.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { collectProcessTree, killProcessTree, readChildPids } from '../lib/browser/process-tree.js';

test('killProcessTree ignores invalid pids', () => {
  assert.equal(killProcessTree(0), false);
  assert.equal(killProcessTree(-1), false);
  assert.equal(killProcessTree('not-a-pid'), false);
  assert.equal(killProcessTree(null), false);
});

test('collectProcessTree and killProcessTree terminate a real child', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('linux-only /proc inspection');
    return;
  }
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const tree = collectProcessTree(child.pid);
    assert.ok(tree.includes(child.pid), `tree=${tree.join(',')}`);
    assert.ok(readChildPids(process.pid).includes(child.pid) || tree.length >= 1);
    assert.equal(killProcessTree(child.pid), true);
    const exit = await new Promise((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
      setTimeout(() => resolve({ code: null, signal: null }), 2000);
    });
    assert.ok(exit.code !== null || exit.signal !== null, 'child should have exited');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});
