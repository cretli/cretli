import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRunHistory } from '../lib/devices/run-history.js';

test('durable history, paired count/byte eviction, per-metric comparisons and workspace scope', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'runs.json');
  const h = createRunHistory({ file, maxRecords: 2, maxBytes: 10 });
  const record = (deviceId, score, bytes) => {
    const id = crypto.randomUUID();
    const screenshots = h.writeScreenshots(id, [Buffer.alloc(bytes).toString('base64')]);
    const run = { id, deviceId, workspace: '/workspace', scriptPath: 'measure.mjs', metrics: { score }, screenshots };
    h.put(run); return run;
  };
  const a = record('a', 10, 3), b = record('a', 15, 3);
  assert.equal(h.compare(a.id, b.id, '/workspace').deltas.score.delta, 5);
  const c = record('b', 20, 3);
  assert.equal(h.compare(b.id, c.id, '/workspace').deltas.score.delta, 5);
  assert.equal(fs.existsSync(path.join(h.directory, a.screenshots[0])), false, 'count evicts file');
  assert.equal(h.get(a.id, '/workspace'), null);
  const d = record('c', 30, 8);
  assert.deepEqual(h.list({ workspace: '/workspace' }).map((r) => r.id), [d.id], 'byte cap evicts oldest records');
  for (const r of [b, c]) assert.equal(fs.existsSync(path.join(h.directory, r.screenshots[0])), false);
  assert.equal(new Set(JSON.parse(fs.readFileSync(file, 'utf8')).runs.map((r) => r.id)).size, 1);
  assert.deepEqual(createRunHistory({ file }).get(d.id, '/workspace'), d);
  assert.equal(h.screenshot(d.id, d.screenshots[0], '/elsewhere'), null);
  assert.equal(h.screenshot(d.id, '../secret', '/workspace'), null);
  assert.equal(h.compare(d.id, d.id, '/elsewhere').error, 'run-not-found');
  assert.deepEqual(h.list({ workspace: '/elsewhere' }), []);
});
