import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const source = readFileSync(path.join(publicDir, 'sw.js'), 'utf8');

function readShellAssets() {
  const block = /const SHELL_ASSETS = \[([\s\S]*?)\];/.exec(source);
  assert.ok(block, 'SHELL_ASSETS block present');
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test('sw cache name keeps the versioned cretli-v<N> scheme (bump on shell changes)', () => {
  assert.match(source, /const CACHE_NAME = 'cretli-v\d+';/);
});

test('every non-built SHELL_ASSET exists in public/, no duplicates', () => {
  const assets = readShellAssets();
  assert.equal(new Set(assets).size, assets.length);
  for (const asset of assets) {
    if (asset.startsWith('/dist/') || asset === '/') continue;
    assert.ok(existsSync(path.join(publicDir, asset)), `${asset} is listed in SHELL_ASSETS but missing from public/`);
  }
});

test('shell precache stays a small bounded list and keeps the app bundles', () => {
  const assets = readShellAssets();
  assert.ok(assets.length <= 40, `precache list grew to ${assets.length}`);
  for (const bundle of ['/dist/app/index.bundle.js', '/dist/app/vendor.bundle.js', '/dist/app/index.css', '/index.html']) {
    assert.ok(assets.includes(bundle), `${bundle} must stay precached for the offline shell`);
  }
});

test('versioned bundles fall back to the cached path ignoring ?v= (offline shell keeps its JavaScript)', () => {
  assert.match(source, /caches\.match\(req, \{ ignoreSearch: true \}\)/);
  assert.match(source, /ignoreSearch: true/);
});

test('shell navigation is network-first with a bounded timeout (measured gap, see frontend baseline doc)', () => {
  const timeout = /const NETWORK_TIMEOUT_MS = (\d+);/.exec(source);
  assert.ok(timeout);
  assert.equal(Number(timeout[1]), 3000, 'changing the timeout is a shell-latency decision: update docs/architecture-frontend-baseline.md');
});
