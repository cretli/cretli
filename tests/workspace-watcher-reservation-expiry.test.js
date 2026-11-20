import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addTodo, loadTodosData } from '../lib/persist/todos-legacy-adapter.js';
import { expireWorkspaceWatcherOperatorReservations } from '../lib/workspace-watcher.js';
import { updateTodo } from '../lib/persist/todos-store.js';

test('expired operator reservations are cleared once with a single notice; live ones stay', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resv-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'resv-ws-'));
  const now = Date.now();
  const expired = addTodo(dataDir, ws, { title: 'old', status: 'idea' }).item;
  const live = addTodo(dataDir, ws, { title: 'live', status: 'idea' }).item;
  await updateTodo(dataDir, ws, expired.id, { reservedBy: { kind: 'operator', clientId: 'c1', until: new Date(now - 1000).toISOString() } });
  await updateTodo(dataDir, ws, live.id, { reservedBy: { kind: 'operator', clientId: 'c1', until: new Date(now + 3_600_000).toISOString() } });
  const pushes = [];
  const notify = (payload) => { pushes.push(payload); return true; };
  assert.deepEqual(await expireWorkspaceWatcherOperatorReservations({ dataDir, workspaceFolder: ws, now, notify }), [expired.id]);
  assert.deepEqual(await expireWorkspaceWatcherOperatorReservations({ dataDir, workspaceFolder: ws, now, notify }), []);
  assert.equal(pushes.length, 1);
  const items = loadTodosData(dataDir, ws).items;
  assert.equal(items.find((i) => i.id === expired.id).reservedBy, undefined);
  assert.ok(items.find((i) => i.id === expired.id).changelog.some((e) => /reservation expired/.test(e.text)));
  assert.ok(items.find((i) => i.id === live.id).reservedBy);
});
