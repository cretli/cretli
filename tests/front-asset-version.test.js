import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveFrontAssetVersion } from '../lib/front-asset-version.js';

test('uses server start time when dist files are missing', () => {
  const inputProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-front-ver-'));
  const actual = resolveFrontAssetVersion({
    projectRoot: inputProjectRoot,
    serverStartedAt: 1_700_000_000_000,
  });
  assert.equal(actual, '1700000000000');
  fs.rmSync(inputProjectRoot, { recursive: true, force: true });
});

test('follows the newest built bundle mtime', () => {
  const inputProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-front-ver-'));
  const distDir = path.join(inputProjectRoot, 'public', 'dist', 'app');
  fs.mkdirSync(distDir, { recursive: true });
  const olderPath = path.join(distDir, 'vendor.bundle.js');
  const newerPath = path.join(distDir, 'index.bundle.js');
  fs.writeFileSync(olderPath, 'vendor');
  fs.writeFileSync(newerPath, 'index');
  const olderAt = new Date('2026-01-01T00:00:00.000Z');
  const newerAt = new Date('2026-02-01T00:00:00.000Z');
  fs.utimesSync(olderPath, olderAt, olderAt);
  fs.utimesSync(newerPath, newerAt, newerAt);
  const expected = String(Math.trunc(fs.statSync(newerPath).mtimeMs));
  const actual = resolveFrontAssetVersion({
    projectRoot: inputProjectRoot,
    serverStartedAt: 1,
  });
  assert.equal(actual, expected);
  fs.rmSync(inputProjectRoot, { recursive: true, force: true });
});
