import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { budgetMs } from './helpers/time-budget.js';
import { findPrivateMatches } from '../scripts/lib/doc-screenshot-privacy.mjs';

test('offline demo seed is isolated, complete and idempotent', { timeout: budgetMs(30000) }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-demo-test-'));
  const dataDir = path.join(dir, 'data');
  const env = { PATH: process.env.PATH, HOME: dir, CRETLI_DATA_DIR: dataDir };
  function seed() {
    const result = spawnSync(process.execPath, ['scripts/demo-instance.mjs', '--seed-only', '--dir', dir], { env, encoding: 'utf8', timeout: budgetMs(10000) });
    assert.equal(result.status, 0, result.stderr);
  }
  function read() {
    const code = `
      const { loadChats } = await import('./lib/persist/chats-persist.js');
      const { loadChatHistory } = await import('./lib/persist/chat-history-persist.js');
      const { loadDelegationsReadonly } = await import('./lib/persist/delegations-persist.js');
      const { readUsageEvents } = await import('./lib/persist/usage-persist.js');
      const fs = await import('node:fs');
      const chats = loadChats();
      console.log(JSON.stringify({ chats, histories: chats.map(c => loadChatHistory(c.id)), delegations: loadDelegationsReadonly(), usage: readUsageEvents({dataDir: process.env.CRETLI_DATA_DIR, from: '2020-01-01T00:00:00.000Z'}), watcherFiles: fs.readdirSync(process.env.CRETLI_DATA_DIR).filter(n => /watcher/.test(n)) }));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8', timeout: budgetMs(10000) });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  try {
    seed();
    const first = read();
    assert.ok(first.chats.length >= 4);
    assert.ok(first.chats.every(c => c.workspaceFolder === path.join(dir, 'projects/acme-shop')));
    for (const history of first.histories) {
      assert.ok(history.events.some(e => e.rec.kind === 'localUser'));
      assert.ok(history.events.some(e => e.rec.event?.type === 'assistant'));
    }
    assert.ok(first.histories.some(h => h.events.some(e => e.rec.event?.type === 'tool_call')));
    assert.equal(first.delegations.length, 1);
    assert.equal(first.delegations[0].status, 'completed');
    assert.ok(!first.delegations[0].leafId && !first.delegations[0].todoId);
    assert.ok(first.usage.length >= 6);
    assert.deepEqual(first.watcherFiles, []);
    assert.deepEqual(findPrivateMatches(JSON.stringify(first), { username: os.userInfo().username, hostname: os.hostname() }), []);
    seed();
    assert.deepEqual(read(), first);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
