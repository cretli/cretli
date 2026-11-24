import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-sweep-nocopy-'));
process.env.CRETLI_DATA_DIR = dir;
const chats = await import('../lib/persist/chats-legacy-store.js');
const { sweepClosedWorkspaceWatcherCycles } = await import('../lib/workspace-watcher-archive-sweep.js');

test('sweep reads candidate chats without copying the whole chat list', async () => {
  const at = new Date().toISOString();
  const rows = [];
  for (let i = 0; i < 200; i += 1) {
    rows.push({ id: `bulk-${i}`, title: `Bulk ${i}`, cursorSessionId: `s-${i}`, workspaceFolder: dir, createdAt: at, updatedAt: at });
  }
  rows.push({ id: 'orch-1', title: 'Orch', cursorSessionId: 's-orch', workspaceFolder: dir, createdAt: at, updatedAt: at });
  chats.saveChats(rows);
  const row = {
    workspaceFolder: dir,
    cycleChats: [{ id: 'orch-1', cycleId: 'c1', at, outcome: 'success' }],
    activeCycles: [],
  };
  const before = chats.getChatsReadStats().listCopies;
  // Within the idle grace the gate refuses, so no archive write (and no full load) happens.
  const out = await sweepClosedWorkspaceWatcherCycles({
    now: Date.now(),
    rows: [row],
    deps: { isChatRunConfirmedIdle: () => true, listDelegationsForController: () => [] },
  });
  assert.equal(out.considered, 1);
  assert.deepEqual(out.archived, []);
  assert.equal(chats.getChatsReadStats().listCopies - before, 0, 'sweep must not copy the chat list');
});
