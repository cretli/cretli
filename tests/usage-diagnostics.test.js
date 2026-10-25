/**
 * readUsageDiagnostics: retention gap and corrupt-file counters.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readUsageDiagnostics } from '../lib/persist/usage-persist.js';

/**
 * @param {string[]} days
 * @param {Record<string, string>} [content]
 * @returns {string}
 */
function ledger(days, content = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'cretli-usage-diag-'));
  const dir = path.join(root, 'usage');
  mkdirSync(dir, { recursive: true });
  for (const day of days) writeFileSync(path.join(dir, `${day}.jsonl`), content[day] || '');
  return root;
}

test('no files: nothing retained out', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cretli-usage-diag-'));
  const out = readUsageDiagnostics({ dataDir: root, from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(out, { corrupt: 0, retainedOut: 0 });
  rmSync(root, { recursive: true, force: true });
});

test('older files outside the window do not flag retention', () => {
  const root = ledger(['2026-08-01', '2026-09-10']);
  const out = readUsageDiagnostics({ dataDir: root, from: '2026-09-01', to: '2026-09-30' });
  assert.equal(out.retainedOut, 0);
  rmSync(root, { recursive: true, force: true });
});

test('window starting before the oldest retained day flags retention', () => {
  const root = ledger(['2026-10-01', '2026-10-05']);
  const out = readUsageDiagnostics({ dataDir: root, from: '2026-09-01', to: '2026-10-10' });
  assert.equal(out.retainedOut, 1);
  rmSync(root, { recursive: true, force: true });
});

test('corrupt lines inside the window are counted, outside are not', () => {
  const root = ledger(['2026-09-05', '2026-08-01'], {
    '2026-09-05': 'not json\n{"v":1,"seq":1}\n',
    '2026-08-01': 'garbage\n',
  });
  const out = readUsageDiagnostics({ dataDir: root, from: '2026-09-01', to: '2026-09-30' });
  assert.equal(out.corrupt, 2);
  rmSync(root, { recursive: true, force: true });
});
