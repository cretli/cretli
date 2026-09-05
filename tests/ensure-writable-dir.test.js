import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureWritableDir } from '../lib/ensure-writable-dir.js';

const inputWritableDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-writable-'));
const actualWritableDir = ensureWritableDir(inputWritableDir);
assert.equal(actualWritableDir, inputWritableDir);
assert.equal(fs.existsSync(path.join(inputWritableDir, '.cretli-write-probe')), false);
fs.rmSync(inputWritableDir, { recursive: true, force: true });

const processUid = typeof process.getuid === 'function' ? process.getuid() : null;
if (processUid !== 0) {
  const inputReadOnlyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-readonly-'));
  fs.chmodSync(inputReadOnlyDir, 0o500);
  try {
    assert.throws(
      () => ensureWritableDir(inputReadOnlyDir),
      (err) => String(err.message).includes('not writable'),
    );
  } finally {
    fs.chmodSync(inputReadOnlyDir, 0o700);
    fs.rmSync(inputReadOnlyDir, { recursive: true, force: true });
  }
}

console.log('ensure-writable-dir.test.js OK');
