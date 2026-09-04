#!/usr/bin/env node
/**
 * Run every tests/*.test.js in an isolated Node process.
 * Files that import node:test use --test; standalone assert scripts run as-is.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

// Tests that use node:test fail with a bare "bad option: --test" on old runtimes,
// so fail early with the version that package.json engines requires.
const MIN_NODE = [22, 13];
const currentNode = process.versions.node.split('.').map(Number);
if (currentNode[0] < MIN_NODE[0] || (currentNode[0] === MIN_NODE[0] && currentNode[1] < MIN_NODE[1])) {
  console.error(
    `Cretli tests require Node >= ${MIN_NODE.join('.')} (running v${process.versions.node}).\n` +
      'Use nvm/fnm, or run: npx -y node@22 scripts/run-unit-tests.mjs'
  );
  process.exit(1);
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsDir = path.join(projectRoot, 'tests');
// Persistence tests write real chats/settings/history. Point them at a scratch
// directory so running the suite never touches a contributor's own data/.
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'cretli-test-data-'));
const files = (await readdir(testsDir))
  .filter((name) => name.endsWith('.test.js'))
  .sort();

if (files.length === 0) {
  console.error('No tests/*.test.js files found');
  process.exit(1);
}

let failed = 0;
for (const name of files) {
  const filePath = path.join(testsDir, name);
  const source = readFileSync(filePath, 'utf8');
  const usesNodeTest = /from ['"]node:test['"]/.test(source);
  const args = usesNodeTest ? ['--test', filePath] : [filePath];
  process.stdout.write(`\n==> ${name}\n`);
  const exitCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      stdio: 'inherit',
      env: { ...process.env, CRETLI_DATA_DIR: dataDir },
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) {
    failed += 1;
    console.error(`FAILED ${name} (exit ${exitCode})`);
  }
}

await rm(dataDir, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n${failed}/${files.length} test file(s) failed`);
  process.exit(1);
}
console.log(`\n${files.length} test file(s) passed`);
