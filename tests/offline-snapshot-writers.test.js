import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  extraPids, alive, makeWorld, startWrapped, startMarkers, cli, applyArgs, codes, assertNoLeaks, cleanupWorlds, opDirOf,
} from './fixtures/offline-snapshot-helpers.js';

// Synthetic processes only. A wrapper (npm/sh stand-in) is the server's parent and holds the same
// append-only log fd the server writes to; everything else it holds below the data root is refused.

afterEach(cleanupWorlds);

const writerClasses = (json) => (json.refusals.find((r) => r.code === 'UNKNOWN_WRITER')?.detail.writers ?? []).map((x) => x.class);

describe('offline snapshot inherited descriptors of ancestor wrappers', () => {
  it('accepts an ancestor holding exactly the server\'s own append-only log fd, and reports it', async () => {
    const w = await makeWorld({ start: false });
    await startWrapped(w);
    const res = await cli(w);
    assert.equal(res.code, 0, res.stdout);
    assert.ok(res.json.inheritedLogFds >= 1);
    assert.ok(!codes(res.json).includes('UNKNOWN_WRITER'));
    assert.ok(alive(w.wrapperPid));
  });

  it('an ancestor holding canonical JSON, SQLite or a different log is an unknown writer (class only, no path)', async () => {
    const cases = [
      ['settings.json', 'ancestor-canonical-data'],
      ['other-store.sqlite', 'ancestor-sqlite'],
      ['other.log', 'ancestor-foreign-log'],
    ];
    for (const [extraRel, cls] of cases) {
      const w = await makeWorld({ start: false });
      await startWrapped(w, { extraRel });
      const res = await cli(w);
      assert.ok(codes(res.json).includes('UNKNOWN_WRITER'), `${extraRel}: ${res.stdout}`);
      assert.deepEqual(writerClasses(res.json), [cls], extraRel);
      assert.ok(!res.stdout.includes(extraRel), 'no data path in the report');
      cleanupWorlds();
    }
  });

  it('a non-append log descriptor held by the wrapper is refused', async () => {
    const w = await makeWorld({ start: false });
    await startWrapped(w, { logFlag: 'w' });
    const res = await cli(w);
    assert.deepEqual(writerClasses(res.json), ['ancestor-not-append']);
  });

  it('an unrelated process with the same log open is still an unknown writer', async () => {
    const w = await makeWorld({ start: false });
    await startWrapped(w);
    const stranger = spawn(process.execPath, ['-e', `require('fs').openSync(${JSON.stringify(path.join(w.data, 'server.log'))}, 'a'); setInterval(()=>{},1000)`], { stdio: 'ignore' });
    extraPids.add(stranger.pid);
    await new Promise((r) => setTimeout(r, 300));
    const res = await cli(w);
    assert.deepEqual(writerClasses(res.json), ['unrelated']);
  });

  it('apply with the wrapper: stops only the server, publishes, then restarts', async () => {
    const w = await makeWorld({ start: false });
    await startWrapped(w);
    const oldPid = w.pid;
    const res = await cli(w, await applyArgs(w));
    assert.equal(res.json.state, 'published', res.stdout);
    assert.ok(!alive(oldPid));
    assert.equal(res.json.restart.outcome, 'running-verified');
    assert.equal(startMarkers(w).length, 2);
    assert.ok(fs.existsSync(opDirOf(w)));
    assertNoLeaks(w, res);
  });
});
