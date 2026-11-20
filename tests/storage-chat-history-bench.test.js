import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/storage-chat-history-bench.mjs', import.meta.url));

describe('storage chat-history A1 benchmark (smoke scale)', () => {
  it('reports separate A1 and end-to-end startup, honest statuses and no private paths', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-bench-test-'));
    try {
      const out = path.join(dir, 'report.json');
      const md = path.join(dir, 'report.md');
      const run = spawnSync(process.execPath, ['--no-warnings', SCRIPT], {
        env: { ...process.env, CRETLI_BENCH_SCALE: '20', CRETLI_BENCH_WORKLOADS: 'small,medium', CRETLI_BENCH_OUT: out, CRETLI_BENCH_MD: md },
        encoding: 'utf8',
        timeout: 120000,
      });
      assert.ok(fs.existsSync(out), run.stderr);
      const report = JSON.parse(fs.readFileSync(out, 'utf8'));
      assert.equal(report.scale, 20);
      for (const gate of report.gates) {
        assert.ok(['PASS', 'FAIL', 'UNVERIFIED'].includes(gate.status), gate.id);
        assert.ok(gate.method, gate.id);
        assert.ok('n' in gate && 'budget' in gate, gate.id);
        if (gate.n !== null && gate.n < gate.minN) assert.equal(gate.status, 'UNVERIFIED', gate.id);
      }
      assert.ok(report.gates.some((gate) => gate.id === 'startupReplayWalPresent') && report.gates.some((gate) => gate.id === 'startupReplayCleanClose'));
      assert.equal(report.gates.find((gate) => gate.id === 'workloadCoverage').status, 'UNVERIFIED');
      assert.notEqual(report.status, 'PASS');
      for (const entry of Object.values(report.workloads)) {
        const { startupReplay, endToEndStart } = entry.worker;
        assert.equal(startupReplay.samples.length, 5);
        assert.equal(endToEndStart.samples.length, 5);
        assert.ok(startupReplay.median.barrierMs >= 0 && startupReplay.median.openMs > 0 && startupReplay.median.integrityCheckMs >= 0);
        assert.ok(endToEndStart.walPresentReplayMedianMs > 0);
        assert.ok(endToEndStart.median.threadOverheadMs >= 0 && endToEndStart.median.startMs >= endToEndStart.median.openMs);
        assert.ok(entry.worker.fullCheckpointIdleMs.n >= 0 && 'fullCheckpointContendedMs' in entry.worker);
        assert.match(entry.worker.bytesWrittenMethod, /file-size delta/);
        assert.match(entry.worker.physicalWriteBytesMethod, /diagnostic/);
      }
      const markdown = fs.readFileSync(md, 'utf8');
      assert.ok(!markdown.includes(dir) && !markdown.includes("cretli-chat-history-bench-") && !markdown.includes(os.homedir()));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
