#!/usr/bin/env node
/**
 * Stage 7 integration check: runs the existing tests that cover the semantics of
 * docs/MULTI-INSTANCE.md plus the architecture program tests of stages 2-6 and the
 * V0 request-local chat index test. Read-only with respect to application code;
 * each file runs in its own Node process like scripts/run-unit-tests.mjs.
 *
 * Usage: node scripts/architecture-multi-instance-regression.mjs [--json out.json]
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Groups mirror the readiness matrix (docs/architecture-readiness-matrix.md). */
export const TEST_GROUPS = {
  multiInstance: [
    'tests/multi-instance-regression.test.js',
    'tests/sdk-room-registry.test.js',
    'tests/sdk-room-bus.test.js',
    'tests/sdk-sticky-session.test.js',
    'tests/sdk-remote-room-stub.test.js',
    'tests/browser-multi-instance.test.js',
    'tests/recovery-owner-lease.test.js',
  ],
  stages2to6: [
    'tests/chat-catalog-contract.test.js',
    'tests/chat-catalog-pagination.test.js',
    'tests/architecture-http-fixture.test.js',
    'tests/chat-list-sync.test.js',
    'tests/chat-list-sync-client.test.js',
    'tests/chat-list-live-sync-delta.test.js',
    'tests/sw-shell-assets.test.js',
    'tests/architecture-stall-profile.test.js',
    'tests/files-list-order.test.js',
  ],
  v0: ['tests/delegation-route-chat-index.test.js'],
};

/**
 * @param {string} relPath
 * @param {string} dataDir
 * @returns {Promise<{ file: string, exitCode: number, ms: number }>}
 */
function runOne(relPath, dataDir) {
  const filePath = path.join(projectRoot, relPath);
  const usesNodeTest = /from ['"]node:test['"]/.test(readFileSync(filePath, 'utf8'));
  const args = usesNodeTest ? ['--test', filePath] : [filePath];
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      stdio: 'inherit',
      env: { ...process.env, CRETLI_DATA_DIR: dataDir },
    });
    child.on('exit', (code) => resolve({ file: relPath, exitCode: code ?? 1, ms: Date.now() - startedAt }));
  });
}

async function main() {
  const jsonIndex = process.argv.indexOf('--json');
  const jsonOut = jsonIndex > 0 ? process.argv[jsonIndex + 1] : '';
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'cretli-multi-instance-'));
  const results = [];
  try {
    for (const [group, files] of Object.entries(TEST_GROUPS)) {
      for (const file of files) {
        process.stdout.write(`\n==> [${group}] ${file}\n`);
        results.push({ group, ...(await runOne(file, dataDir)) });
      }
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
  const failed = results.filter((r) => r.exitCode !== 0);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} files passed\n`);
  for (const r of failed) process.stdout.write(`FAILED: ${r.file} (exit ${r.exitCode})\n`);
  if (jsonOut) await writeFile(jsonOut, `${JSON.stringify({ results }, null, 2)}\n`);
  process.exit(failed.length ? 1 : 0);
}

await main();
