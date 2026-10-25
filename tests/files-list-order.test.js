/**
 * Entry ordering of listWorkspaceEntries (stage 6 V6 fix): the shared Intl.Collator
 * must order exactly like the former per-call `localeCompare(..., { sensitivity: 'base' })`
 * (directories first), including mixed case, accents and digit runs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listWorkspaceEntries } from '../lib/files-list.js';

const NAMES = ['b.txt', 'B2.txt', 'a.txt', 'A1.txt', 'z.txt', 'Zebra.md', 'file10.txt', 'file2.txt', 'résumé.md', 'ö.txt', '_x.txt'];
const DIRS = ['Docs', 'archive', 'Éclair', 'src'];

test('listWorkspaceEntries orders like per-call localeCompare with base sensitivity', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cretli-files-order-'));
  try {
    for (const name of NAMES) writeFileSync(path.join(root, name), 'x');
    for (const name of DIRS) mkdirSync(path.join(root, name));
    const actual = listWorkspaceEntries({ basePath: root }).entries.map((row) => row.name);
    const compare = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });
    const expected = [...[...DIRS].sort(compare), ...[...NAMES].sort(compare)];
    assert.deepEqual(actual, expected);
    assert.deepEqual(actual.slice(0, DIRS.length).sort(), [...DIRS].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listWorkspaceEntries keeps a 5000-entry directory complete and ordered', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cretli-files-order-wide-'));
  try {
    for (let i = 0; i < 5000; i += 1) writeFileSync(path.join(root, `file-${String(i).padStart(5, '0')}.txt`), 'x');
    const actual = listWorkspaceEntries({ basePath: root }).entries.map((row) => row.name);
    assert.equal(actual.length, 5000);
    assert.equal(actual[0], 'file-00000.txt');
    assert.equal(actual[4999], 'file-04999.txt');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
