import './helpers/isolated-data-dir.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Runs the converted tests of the routes / lifecycle / titles groups a second time on an isolated SQLite chats runtime
 * (`CHATS_TEST_BACKEND=sqlite`, see tests/helpers/chats-backends.js). The default `node --test` run of each file is the
 * legacy pass. The production backend is untouched: the runtime is injected per process.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Files that still pass on legacy only, because the scenario crosses into a group that has not been converted yet
 * (it calls the synchronous chats API, which throws `chats_sync_api_unavailable` on a non-legacy runtime).
 * Each entry names the unconverted module; the list shrinks as B4/B5 land.
 */
const SQLITE_BLOCKED = Object.freeze({
  'tests/chat-title-routes.test.js': 'lib/chat-catalog.js (readChatCatalog, B5)',
});

/** @param {string} dir @returns {string[]} */
function testFiles(dir) {
  const abs = path.join(ROOT, dir);
  return fs.readdirSync(abs).filter((f) => f.endsWith('.test.js')).map((f) => path.join(dir, f));
}

const converted = [
  ...testFiles('tests'),
  ...fs.readdirSync(path.join(ROOT, 'harnesses')).flatMap((d) => (fs.existsSync(path.join(ROOT, 'harnesses', d, 'tests')) ? testFiles(path.join('harnesses', d, 'tests')) : [])),
].filter((file) => file !== 'tests/chats-b2-backend-matrix.test.js'
  && fs.readFileSync(path.join(ROOT, file), 'utf8').includes('registerChatsBackendTeardown()'));

/** @param {string} file @returns {Promise<{ code: number | null, out: string }>} */
function runOnSqlite(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', file], { cwd: ROOT, env: { ...process.env, CHATS_TEST_BACKEND: 'sqlite' } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

describe('B2 backend matrix (sqlite pass of the converted tests)', () => {
  it('lists the converted files and only real blocked entries', () => {
    assert.ok(converted.length >= 30, `found ${converted.length}`);
    for (const file of Object.keys(SQLITE_BLOCKED)) assert.ok(converted.includes(file), `${file} is not a converted test`);
  });

  it('every non-blocked converted test passes on the sqlite runtime', { timeout: 600000 }, async () => {
    const queue = converted.filter((file) => !SQLITE_BLOCKED[file]);
    const failures = [];
    const worker = async () => {
      for (let file = queue.shift(); file; file = queue.shift()) {
        const { code, out } = await runOnSqlite(file);
        if (code !== 0) failures.push(`${file}\n${out.split('\n').filter((l) => /^(not ok|# fail|\s+error:)/.test(l)).slice(0, 6).join('\n')}`);
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    assert.deepEqual(failures, []);
  });
});
