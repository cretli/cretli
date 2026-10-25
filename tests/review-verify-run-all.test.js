import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { runReviewVerify, spawnReviewVerifyFile } from '../lib/sdk/sdk-review-verify.ts';

after(removeIsolatedDataDir);

/**
 * @param {Record<string, string>} files tests/<name> -> source
 * @returns {{ root: string, catalog: Record<string, string> }}
 */
function makeProject(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-run-all-'));
  fs.mkdirSync(path.join(root, 'tests'));
  const catalog = {};
  for (const [name, source] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, 'tests', name), source);
    catalog[name.replace(/\.js$/, '')] = `tests/${name}`;
  }
  return { root, catalog };
}

test('a failing id in the middle does not stop the remaining ids', async () => {
  const { root, catalog } = makeProject({
    'a.js': 'console.log("a ok")',
    'b.js': 'console.error("b broke"); process.exit(1)',
    'c.js': 'console.log("c ok")',
  });
  const result = await runReviewVerify({ ids: ['a', 'b', 'c'], projectRoot: root, catalog });
  assert.equal(result.ok, false);
  assert.match(result.error, /exited with code 1/);
  assert.deepEqual(result.results.map((r) => [r.id, r.ok]), [['a', true], ['b', false], ['c', true]]);
  assert.match(result.output, /==> c/);
  assert.match(result.results[1].outputTail, /b broke/);
  assert.ok(result.results.every((r) => Number.isFinite(r.durationMs)));
  fs.rmSync(result.dataDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('all passing keeps the legacy shape and adds results', async () => {
  const { root, catalog } = makeProject({ 'a.js': 'console.log("a ok")' });
  const result = await runReviewVerify({ ids: ['a'], projectRoot: root, catalog });
  assert.equal(result.ok, true);
  assert.equal(result.error, undefined);
  assert.equal(result.results.length, 1);
  fs.rmSync(result.dataDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('a child ignoring SIGTERM is killed after the grace and the run settles', async () => {
  const { root } = makeProject({ 'stubborn.js': 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);' });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-run-all-data-'));
  const startedAt = Date.now();
  const result = await spawnReviewVerifyFile({
    filePath: path.join(root, 'tests', 'stubborn.js'), workDir: root, dataDir, timeoutMs: 300, graceMs: 300,
  });
  assert.equal(result.ok, false);
  assert.ok(Date.now() - startedAt < 4000);
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('a grandchild holding the stdio pipes does not keep the run open', async () => {
  const { root } = makeProject({
    'holder.js': 'import { spawn } from "node:child_process"; spawn(process.execPath, ["-e", "setTimeout(() => {}, 4000)"], { stdio: "inherit" }).unref(); process.exit(0);',
  });
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-run-all-data-'));
  const startedAt = Date.now();
  const result = await spawnReviewVerifyFile({
    filePath: path.join(root, 'tests', 'holder.js'), workDir: root, dataDir, timeoutMs: 20000, drainMs: 300,
  });
  assert.equal(result.ok, true);
  assert.ok(Date.now() - startedAt < 3500, 'settled on exit + drain, not on pipe close');
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});
