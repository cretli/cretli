/**
 * Dynamic review-verify catalog: audited dirs are scanned into a generated
 * manifest, a test added during the flow is a valid id without a restart, and
 * the manifest is written under the OS temp dir — never the project data/.
 */
import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  describeReviewVerifyCatalog,
  parseReviewVerifyNodeArgs,
  resolveReviewVerifyCatalog,
  runReviewVerify,
} from '../lib/sdk/sdk-review-verify.js';

function makeProjectRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-review-catalog-'));
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  return root;
}

function writeAuditedTest(root, id, body) {
  const file = path.join(root, 'tests', `${id}.test.js`);
  fs.writeFileSync(file, body, 'utf8');
  // Force a distinct directory mtime so the mtime-based cache notices the add
  // even on a filesystem with coarse timestamps.
  const next = new Date(Date.now() + 1000);
  fs.utimesSync(path.join(root, 'tests'), next, next);
  return file;
}

const markerBody = (id) => [
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  'const dir = process.env.CRETLI_DATA_DIR || process.env.CRETLI_TEST_DATA_DIR || \'\';',
  'if (dir) {',
  "  fs.mkdirSync(dir, { recursive: true });",
  `  fs.writeFileSync(path.join(dir, '${id}.marker'), 'ok');`,
  '}',
  `console.log('${id} OK');`,
].join('\n');

test('a test added to an audited dir is verifiable without a restart', async () => {
  const root = makeProjectRoot();
  try {
    writeAuditedTest(root, 'demo-audited', markerBody('demo-audited'));
    const catalog = resolveReviewVerifyCatalog(root);
    assert.equal(catalog['demo-audited'], 'tests/demo-audited.test.js');

    const run = await runReviewVerify({ ids: ['demo-audited'], projectRoot: root });
    assert.equal(run.ok, true, run.error);
    assert.match(run.output, /demo-audited OK/);
    // Isolation: the test writes only into the isolated data dir, not the root.
    assert.equal(fs.existsSync(path.join(run.dataDir, 'demo-audited.marker')), true);
    assert.equal(fs.existsSync(path.join(root, 'data', 'demo-audited.marker')), false);
    fs.rmSync(run.dataDir, { recursive: true, force: true });

    // A second file added after the first resolution must be picked up by the
    // mtime-keyed cache with no process restart.
    writeAuditedTest(root, 'demo-later', markerBody('demo-later'));
    const refreshed = resolveReviewVerifyCatalog(root);
    assert.equal(refreshed['demo-later'], 'tests/demo-later.test.js');
    const laterRun = await runReviewVerify({ ids: ['demo-later'], projectRoot: root });
    assert.equal(laterRun.ok, true, laterRun.error);
    assert.match(laterRun.output, /demo-later OK/);
    fs.rmSync(laterRun.dataDir, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('generated manifest lives under tmp, never the project data/ tree', () => {
  const root = makeProjectRoot();
  try {
    writeAuditedTest(root, 'demo-manifest', markerBody('demo-manifest'));
    resolveReviewVerifyCatalog(root);
    const meta = describeReviewVerifyCatalog(root);
    assert.ok(meta && meta.manifestPath, 'manifest path recorded');
    assert.ok(meta.manifestPath.startsWith(os.tmpdir()), 'manifest is under the OS temp dir');
    assert.equal(meta.manifestPath.startsWith(path.join(root, 'data')), false, 'never writes project data/');
    assert.equal(fs.existsSync(meta.manifestPath), true);
    assert.equal(meta.generatedCount >= 1, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('curated catalog wins an id collision and the runner accepts a dynamic id', () => {
  const root = makeProjectRoot();
  try {
    // A new file named like a curated id must not shadow the audited entry.
    writeAuditedTest(root, 'delegation-contract', 'console.log("shadow");');
    const catalog = resolveReviewVerifyCatalog(root);
    assert.equal(catalog['delegation-contract'], 'tests/delegation-contract.test.js');
    // The runner validates explicit ids against the dynamic catalog.
    const parsed = parseReviewVerifyNodeArgs(
      ['scripts/review-verify.js', 'delegation-contract'],
      { projectRoot: root },
    );
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.ids, ['delegation-contract']);
    const unknown = parseReviewVerifyNodeArgs(
      ['scripts/review-verify.js', 'definitely-not-audited'],
      { projectRoot: root },
    );
    assert.equal(unknown.ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a no-id invocation still defaults to the curated catalog', () => {
  const root = makeProjectRoot();
  try {
    writeAuditedTest(root, 'demo-default', markerBody('demo-default'));
    const parsed = parseReviewVerifyNodeArgs(['scripts/review-verify.js'], { projectRoot: root });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.ids.includes('demo-default'), false, 'generated ids are opt-in by id');
    assert.equal(parsed.ids.includes('delegation-contract'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
