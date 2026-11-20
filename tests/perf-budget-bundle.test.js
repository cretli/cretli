/**
 * Performance budget: compressed first-load bundle (initial JS + CSS of the production bundle).
 * Reference: perf leaf 1c measured 779.9 KiB (brotli, docs/frontend-bundle-serving.md); the budget adds
 * a 10% margin. The production bundle is a build artifact (public/dist/app, gitignored): when it has not
 * been built the test is reported as SKIPPED with the reason, never as a pass.
 * Build with `npm run build:front:prod`; measure with `node scripts/measure-front-first-load.mjs`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'public', 'dist', 'app');
const REFERENCE_KIB = 779.9;
const MARGIN = 1.1;
const BUDGET_BYTES = Math.round(REFERENCE_KIB * 1024 * MARGIN);
const built = fs.existsSync(path.join(dist, 'index.bundle.js'));

/** Files the shell requests before the first paint (same list as scripts/measure-front-first-load.mjs). */
function initialAssets() {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const found = new Set(['index.bundle.js', 'vendor.bundle.js', 'index.css']);
  for (const m of html.matchAll(/(?:src|href)="\/dist\/app\/([^"?]+)/g)) found.add(m[1]);
  return [...found].filter((name) => fs.existsSync(path.join(dist, name)));
}

test('compressed first-load bundle stays within the leaf 1c measurement + 10%', {
  skip: built ? false : 'production bundle not built (public/dist/app); run npm run build:front:prod to enforce this budget',
}, () => {
  const files = initialAssets();
  const sizes = files.map((name) => zlib.brotliCompressSync(fs.readFileSync(path.join(dist, name)), {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: fs.statSync(path.join(dist, name)).size },
  }).length);
  const total = sizes.reduce((a, b) => a + b, 0);
  console.log(`perf-budget-bundle: ${(total / 1024).toFixed(1)} KiB brotli over ${files.length} files (budget ${(BUDGET_BYTES / 1024).toFixed(1)} KiB)`);
  assert.ok(files.length >= 3, `expected the entry, vendor and css files, found ${files.join(', ')}`);
  assert.ok(total <= BUDGET_BYTES, `first-load bundle ${total} B brotli > budget ${BUDGET_BYTES} B (1c reference ${REFERENCE_KIB} KiB + 10%)`);
});
