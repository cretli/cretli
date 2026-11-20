import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/storage-startup-profile.mjs', import.meta.url));
const CHILD = fileURLToPath(new URL('../scripts/storage-startup-profile-child.mjs', import.meta.url));
const run = (script, args) => spawnSync(process.execPath, ['--no-warnings', script, ...args], { encoding: 'utf8', timeout: 120000 });

describe('storage startup profiler', () => {
  it('labels scenario/mmap/variant and emits finite results with provenance', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-prof-test-'));
    try {
      const out = path.join(dir, 'nested', 'out.json');
      const r = run(SCRIPT, ['small', '1', out]);
      assert.equal(r.status, 0, r.stderr);
      const res = JSON.parse(fs.readFileSync(out, 'utf8'));
      assert.equal(res.provenance.shape, 'small');
      assert.equal(res.provenance.effectiveMmapSize.componentsUnmapped, 0);
      assert.ok(res.provenance.effectiveMmapSize.componentsMapped > 0);
      assert.ok(res.provenance.sqliteVersion && res.provenance.node);
      assert.deepEqual(Object.keys(res.variants).sort(), ['clean', 'walPrecheckpointed']);
      for (const v of Object.values(res.variants)) {
        assert.ok(v.stats['componentsMapped.integrityMs'] && v.stats['componentsUnmapped.integrityMs'] && v.stats['full.fullTotalMs']);
        for (const s of Object.values(v.stats)) assert.ok(Number.isFinite(s.median));
      }
      const w = res.variants.walPrecheckpointed.walSetup[0];
      assert.ok(w.walFramesLog > 0 && w.walFramesLog === w.walFramesCheckpointed);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects bad CLI arguments and surfaces child failure', () => {
    assert.equal(run(SCRIPT, ['huge']).status, 2);
    assert.equal(run(SCRIPT, ['small', '0']).status, 2);
    const missing = path.join(os.tmpdir(), 'cretli-prof-missing-dir');
    const r = run(CHILD, [missing, 'components', '0']);
    assert.notEqual(r.status, 0);
  });
});
