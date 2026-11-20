import './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { saveSettings } from '../lib/persist/settings.js';
import { registerTodosRoutes } from '../lib/routes/todos-routes.js';
import { fingerprintTodoMaterial, fingerprintTodoTree } from '../lib/todo-integration-proof.js';
import { writeFixtureDocument } from './helpers/todo-repository-fixture.js';

/** Detail vs legacy-list parity for R -> P -> [L, S] where R holds valid tree-scoped integration evidence. */
const cwd = path.join(os.tmpdir(), 'cretli-todo-repo-tree-proof-ws');
mkdirSync(cwd, { recursive: true });
const dataDir = path.join(cwd, 'data');
const workspaceFile = path.join(cwd, 'proj.code-workspace');
const T = '2026-01-01T00:00:00.000Z';
const ids = { R: 'root0001-tree', P: 'mid00001-tree', L: 'leaf0001-tree', S: 'sib00001-tree', X: 'other001-tree' };

function topology(siblingBody = 'sibling material') {
  const base = { status: 'done', createdAt: T, updatedAt: T };
  const raw = [
    { ...base, id: ids.R, title: 'root', body: 'root material', siblingIndex: 0 },
    { ...base, id: ids.P, parentId: ids.R, title: 'mid', body: 'mid material', siblingIndex: 0 },
    { ...base, id: ids.L, parentId: ids.P, title: 'leaf', body: 'leaf material', siblingIndex: 0 },
    { ...base, id: ids.S, parentId: ids.P, title: 'sibling', body: siblingBody, siblingIndex: 1 },
    { ...base, id: ids.X, title: 'unrelated', body: 'unrelated', siblingIndex: 1 },
  ];
  return raw;
}

/** Evidence is computed from the ORIGINAL sibling material, so changing S later invalidates it. */
function withTreeProof(items, proofItems) {
  const root = proofItems.find((i) => i.id === ids.R);
  return items.map((item) => (item.id !== ids.R ? item : {
    ...item,
    integration: {
      state: 'integrated',
      evidence: {
        targetBranch: 'main', targetCommit: 'a'.repeat(40), sourceCommit: 'b'.repeat(40),
        materialRevision: 'material-1', cycleId: 'cycle-1', source: 'human_project', confirmedAt: T,
        changeRef: 'TODO root: verified change', branchVerified: true, changeAttested: true,
        scope: 'tree',
        todoMaterialFingerprint: fingerprintTodoMaterial(root),
        treeMaterialFingerprint: fingerprintTodoTree(proofItems, ids.R),
      },
    },
  }));
}

describe('detail parity with tree-scoped integration proof', () => {
  let server;
  let base;
  const getJson = async (p) => JSON.parse(await (await fetch(`${base}${p}`)).text());
  // computedAt is stamped on every read of a review aggregate.
  const norm = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === 'computedAt' ? undefined : x)));

  async function assertParity() {
    const legacy = (await getJson('/api/todos')).items;
    const out = {};
    for (const [name, id] of Object.entries(ids)) {
      const detail = (await getJson(`/api/todos/${id}`)).item;
      const row = legacy.find((i) => i.id === id);
      assert.deepEqual(norm(detail), norm(row), `detail of ${name} differs from the legacy list item`);
      out[name] = detail;
    }
    return out;
  }

  before(async () => {
    saveSettings({
      workspaces: [{ id: workspaceFile, kind: 'file', workspaceFile }],
      workspaceSidebarConfig: { [workspaceFile]: { folders: { [cwd]: { enabled: true } } } },
    });
    const app = express();
    registerTodosRoutes(app, {
      dataDir, getCurrentCwd: () => cwd, getCurrentWorkspaceFile: () => workspaceFile,
      agentModel: 'auto', getLocalCallbackBaseUrl: () => 'http://127.0.0.1:9999', useHttps: false,
    });
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => new Promise((resolve) => server.close(resolve)));

  it('keeps the proof for L, P and S identical in detail and legacy list', async () => {
    const proofItems = topology();
    writeFixtureDocument(dataDir, cwd, withTreeProof(proofItems, proofItems));
    const out = await assertParity();
    assert.equal(out.R.integrationSummary.state, 'integrated', 'the proof must be valid (guards a vacuous test)');
    for (const name of ['L', 'P', 'S']) {
      assert.equal(out[name].integrationSummary.state, 'integrated', name);
      assert.equal(out[name].integrationSummary.coveredByTreeId, ids.R, name);
    }
    assert.notEqual(out.X.integrationSummary.coveredByTreeId, ids.R);
  });

  it('a sibling material change invalidates the proof for L in detail and legacy alike', async () => {
    const proofItems = topology();
    writeFixtureDocument(dataDir, cwd, withTreeProof(topology('sibling material CHANGED'), proofItems));
    const out = await assertParity();
    assert.equal(out.R.integrationSummary.state, 'unconfirmed');
    assert.equal(out.L.integrationSummary.coveredByTreeId, undefined);
    assert.notEqual(out.L.integrationSummary.state, 'integrated');
  });
});
