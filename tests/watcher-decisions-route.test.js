/**
 * GET /api/workspace-watcher/decisions returns merged idle entries with
 * count/firstAt/lastAt.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendWorkspaceWatcherDecision,
  mutateWorkspaceWatcherRow,
} from '../lib/persist/workspace-watchers-persist.js';
import { registerWorkspaceWatcherRoutes } from '../lib/routes/workspace-watcher-routes.js';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';

const cwd = mkdtempSync(path.join(os.tmpdir(), 'cr-watcher-decisions-route-'));
const dataDir = path.join(cwd, 'data');

/** @type {Map<string, Function>} */
const handlers = new Map();
registerWorkspaceWatcherRoutes({ get(p, fn) { handlers.set(`GET ${p}`, fn); }, post() {}, put() {}, patch() {}, delete() {} },
  { dataDir, getCurrentCwd: () => cwd });

mutateWorkspaceWatcherRow(cwd, () => ({ mode: 'observe' }), { dataDir });
const base = Date.UTC(2026, 0, 1);
for (let i = 0; i < 5; i += 1) {
  appendWorkspaceWatcherDecision(cwd, {
    at: new Date(base + i * 60000).toISOString(), kind: 'idle_no_work', reason: 'no_ready_work',
    readyTodoCount: 0, activeAgentCount: 0, shouldNotify: false, nextTodoId: '',
  }, { dataDir });
}

const body = await new Promise((resolve) => {
  const res = { status() { return this; }, json: resolve };
  handlers.get('GET /api/workspace-watcher/decisions')({ params: {}, query: {}, body: {} }, res);
});
assert.equal(body.ok, true);
assert.equal(body.decisions.length, 1);
assert.equal(body.decisions[0].count, 5);
assert.equal(body.decisions[0].firstAt, new Date(base).toISOString());
assert.equal(body.decisions[0].lastAt, new Date(base + 4 * 60000).toISOString());

removeIsolatedDataDir();
console.log('watcher decisions route tests passed');
