import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PROFILES, buildChats } from '../scripts/architecture-http-fixture.mjs';

test('fixture shape is deterministic and meets the stage-3 requirements', () => {
  const a = buildChats({ size: 5000, seed: 1, profile: 'full', root: '/fx' });
  const b = buildChats({ size: 5000, seed: 1, profile: 'full', root: '/fx' });
  assert.deepEqual(a, b);
  assert.ok(new Set(a.map((c) => c.workspaceFolder)).size >= 20, '>= 20 workspaces');
  const hot = a.filter((c) => c.workspaceFolder === a[0].workspaceFolder && !c.archivedAt);
  assert.ok(hot.length >= 2000, 'thousands of live rows in one group');
  assert.ok(a.filter((c) => c.archivedAt).length > 800, 'large archive');
  const byId = new Map(a.map((c) => [c.id, c]));
  let depth = 0;
  for (let cur = a[Math.min(PROFILES.full.hotLiveRows, 2500) + PROFILES.full.deepChain - 1]; cur?.forkParentChatId; cur = byId.get(cur.forkParentChatId)) depth += 1;
  assert.ok(depth >= PROFILES.full.deepChain - 2, 'deep subtree');
});

test('smoke harness boots real routes on an isolated data dir and reports P99 as exploratory', () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-http-smoke-')), 'r.json');
  try {
    execFileSync(process.execPath, ['--no-warnings', 'scripts/architecture-http-bench.mjs',
      '--sizes', '120', '--profile', 'smoke', '--samples', '5', '--out', out], { stdio: 'pipe' });
    const report = JSON.parse(fs.readFileSync(out, 'utf8'));
    const eps = report.sizes['120'].endpoints;
    for (const name of ['listLive', 'pageFirst', 'pageScopedHotGroup', 'titleHistory', 'seenNoop']) {
      assert.equal(eps[name].status, 200, name);
      assert.equal(eps[name].p99Label, 'exploratory');
    }
    assert.ok(eps.pageFirst.responseBytes < eps.listFullIndex.responseBytes);
  } finally {
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
  }
});
