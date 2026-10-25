/**
 * Oversized top-level data files: the scan threshold, the startup warning and
 * the `largeDataFiles` field in `GET /api/diagnostics/server`.
 */

import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  listLargeDataFiles,
  resolveDataWarnBytes,
  warnLargeDataFiles,
} from '../lib/data-dir-size-warning.js';
import { registerHealthRoutes } from '../lib/routes/health-routes.js';

function createTempDirectory() {
  return mkdtempSync(path.join(os.tmpdir(), 'cretli-data-size-'));
}

test('lists only top-level files over the threshold, largest first', (context) => {
  const dir = createTempDirectory();
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'at-threshold.log'), Buffer.alloc(1024));
  writeFileSync(path.join(dir, 'over.log'), Buffer.alloc(1025));
  writeFileSync(path.join(dir, 'bigger.log'), Buffer.alloc(4096));
  mkdirSync(path.join(dir, 'subdir'));
  writeFileSync(path.join(dir, 'subdir', 'nested.log'), Buffer.alloc(8192));

  const rows = listLargeDataFiles(dir, { thresholdBytes: 1024 });
  assert.deepEqual(rows.map((row) => row.name), ['bigger.log', 'over.log']);
  assert.equal(rows[0].bytes, 4096);
});

test('a symlink to a large file counts while a directory does not', (context) => {
  const dir = createTempDirectory();
  const outside = createTempDirectory();
  context.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  writeFileSync(path.join(outside, 'target.log'), Buffer.alloc(2048));
  symlinkSync(path.join(outside, 'target.log'), path.join(dir, 'link.log'));
  mkdirSync(path.join(dir, 'subdir'));
  writeFileSync(path.join(dir, 'subdir', 'nested.log'), Buffer.alloc(4096));

  const rows = listLargeDataFiles(dir, { thresholdBytes: 1024 });
  assert.deepEqual(rows, [{ name: 'link.log', bytes: 2048 }]);
});

test('a missing directory scans as empty and the default threshold is 20 MiB', () => {
  assert.deepEqual(listLargeDataFiles(path.join(os.tmpdir(), 'cretli-does-not-exist-xyz'), {}), []);
  assert.equal(resolveDataWarnBytes({ CRETLI_DATA_WARN_BYTES: '1024' }), 1024);
  assert.equal(resolveDataWarnBytes({ CRETLI_DATA_WARN_BYTES: 'nope' }), 20 * 1024 * 1024);
  assert.equal(resolveDataWarnBytes({}), 20 * 1024 * 1024);
});

test('warns once per oversized file', (context) => {
  const dir = createTempDirectory();
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'a.log'), Buffer.alloc(100));
  writeFileSync(path.join(dir, 'b.log'), Buffer.alloc(50));

  const warnings = [];
  const rows = warnLargeDataFiles(dir, {
    thresholdBytes: 60,
    logger: { warn: (message) => warnings.push(message) },
  });
  assert.equal(rows.length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /a\.log/);
});

test('GET /api/diagnostics/server includes largeDataFiles', () => {
  const routes = new Map();
  const app = {
    get(routePath, handler) {
      routes.set(routePath, handler);
    },
  };
  registerHealthRoutes(app, {
    serverInstanceToken: 'test-instance',
    serverStartedAt: 1,
    serverDiagnostics: { snapshot: () => ({}), readRecent: () => [] },
    listLargeDataFiles: () => [{ name: 'delegations.json', bytes: 68_000_000 }],
  });
  const response = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  routes.get('/api/diagnostics/server')({ query: {} }, response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.largeDataFiles, [{ name: 'delegations.json', bytes: 68_000_000 }]);
});
