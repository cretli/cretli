import './helpers/isolated-data-dir.js';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveChats } from '../lib/persist/chats-persist.js';
import { registerFilesRoutes } from '../lib/routes/files-routes.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'cretli-file-route-'));
const project = path.join(root, 'project');
const worktree = path.join(root, 'worktree');
for (const folder of [project, worktree]) {
  mkdirSync(path.join(folder, 'docs'), { recursive: true });
  writeFileSync(path.join(folder, 'docs/report.md'), folder === project ? 'project report' : 'worktree report');
}
saveChats([
  { id: 'project', workspaceFolder: project },
  { id: 'worktree', workspaceFolder: project, executionFolder: worktree },
]);
const app = express();
app.use((req, res, next) => {
  if (req.headers['x-test-widget']) req.widgetAccess = {};
  if (req.headers['x-test-mcp']) req.mcpIntegration = {};
  next();
});
registerFilesRoutes(app, { getCurrentCwd: () => root });
const server = await new Promise((resolve) => {
  const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
});
const url = `http://127.0.0.1:${server.address().port}/api/chats`;
try {
  for (const id of ['project', 'worktree']) {
    const response = await fetch(`${url}/${id}/files/read?path=docs/report.md`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).content, `${id} report`);
  }
  assert.equal((await fetch(`${url}/missing/files/read?path=docs/report.md`)).status, 404);
  assert.equal((await fetch(`${url}/project/files/read`)).status, 400);
  assert.equal((await fetch(`${url}/project/files/read?path=../worktree/docs/report.md`)).status, 400);
  const outside = new URLSearchParams({ path: path.join(worktree, 'docs/report.md') });
  const denied = await fetch(`${url}/project/files/read?${outside}`);
  assert.equal(denied.status, 400);
  assert.equal((await denied.json()).code, 'files.outsideWorkspace');
  outside.set('allowOutsideWorkspace', 'true');
  assert.equal((await fetch(`${url}/project/files/read?${outside}`)).status, 400);
  outside.set('allowOutsideWorkspace', '1');
  const approved = await fetch(`${url}/project/files/read?${outside}`);
  assert.equal(approved.status, 200);
  assert.equal(approved.headers.get('cache-control'), 'no-store');
  const preview = await approved.json();
  assert.equal(preview.content, 'worktree report');
  assert.equal(preview.path, path.join(worktree, 'docs/report.md').replace(/\\/g, '/'));
  assert.equal((await fetch(`${url}/project/files/read?path=../worktree/docs/report.md`)).status, 400);
  for (const header of ['x-test-widget', 'x-test-mcp']) {
    assert.equal((await fetch(`${url}/project/files/read?path=docs/report.md`, { headers: { [header]: '1' } })).status, 403);
    assert.equal((await fetch(`${url}/project/files/read?${outside}`, { headers: { [header]: '1' } })).status, 403);
  }
  console.log('chat-file-preview-route.test.js: ok');
} finally {
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
  removeIsolatedDataDir();
}
