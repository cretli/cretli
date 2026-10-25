#!/usr/bin/env node
// Scout pass fixture: 8 watcher rows (6 inactive, 2 active), ~1500 chats and
// ~2000 todos in a throw-away data dir (never the real data/). Measures
// runWorkspaceWatcherScoutPass per phase over N passes and prints the medians.
// Usage: node scripts/scout-pass-fixture.mjs [--passes 20] [--json]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-scout-fixture-'));
process.env.CRETLI_DATA_DIR = tmp;
process.env.CURSOR_REMOTE_DATA_DIR = tmp;

const args = process.argv.slice(2);
const passArg = args.indexOf('--passes');
const PASSES = passArg >= 0 ? Math.max(1, Number(args[passArg + 1]) || 20) : 20;

const { upsertWorkspaceWatcher } = await import('../lib/persist/workspace-watchers-persist.js');
const { saveChats } = await import('../lib/persist/chats-persist.js');
const { saveTodosData } = await import('../lib/persist/todos-persist.js');
const scout = await import('../lib/workspace-watcher-scout.js');

const folders = [];
for (let i = 0; i < 8; i += 1) {
  const cwd = path.join(tmp, `ws-${i}`);
  fs.mkdirSync(cwd, { recursive: true });
  folders.push(cwd);
  const active = i >= 6;
  upsertWorkspaceWatcher(cwd, {
    mode: active ? 'observe' : 'off',
    policy: { scoutEnabled: active, scoutMaxPerDay: 10 },
  }, { dataDir: tmp });
}
const now = new Date().toISOString();
// The fixture records carry only the fields the scout pass reads.
saveChats(/** @type {any} */ (Array.from({ length: 1500 }, (_, i) => ({
  id: `chat-${i}`,
  title: `Chat ${i}`,
  workspaceFolder: folders[i % folders.length],
  createdAt: now,
  updatedAt: now,
}))));
folders.forEach((cwd, w) => {
  saveTodosData(tmp, cwd, {
    version: 1,
    updatedAt: now,
    items: Array.from({ length: 250 }, (_, i) => ({
      id: `todo-${w}-${i}`, title: `Todo ${i}`, body: '', status: 'idea', createdAt: now, updatedAt: now,
    })),
  });
});

const perPass = [];
const totals = [];
for (let n = 0; n < PASSES; n += 1) {
  scout.resetScoutPassPhaseStats();
  const t0 = process.hrtime.bigint();
  await scout.runWorkspaceWatcherScoutPass({ dataDir: tmp, now: Date.now(), deps: { listDelegationsForController: () => [] } });
  totals.push(Number(process.hrtime.bigint() - t0) / 1e6);
  const byPhase = {};
  for (const row of scout.getScoutPassPhaseStats().rows) byPhase[row.phase] = (byPhase[row.phase] || 0) + row.totalMs;
  perPass.push(byPhase);
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const phases = [...new Set(perPass.flatMap((p) => Object.keys(p)))];
const report = {
  passes: PASSES,
  medianPassMs: median(totals),
  phases: Object.fromEntries(phases.map((p) => [p, median(perPass.map((x) => x[p] || 0))])),
};
console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : report);
fs.rmSync(tmp, { recursive: true, force: true });
