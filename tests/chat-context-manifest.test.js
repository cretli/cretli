import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import { loadChats, saveChats } from '../lib/persist/chats-persist.js';
import {
  buildContextSnapshot,
  previewNextSend,
  recordContextSend,
} from '../lib/context/context-send-manifest.ts';
import {
  appendContextSendManifest,
  deleteContextSendManifests,
  listContextSendManifests,
  MAX_MANIFESTS_PER_CHAT,
} from '../lib/persist/context-send-manifests-persist.js';
import { registerChatContextRoutes } from '../lib/routes/chat-context-routes.js';
import {
  compareSendWithPreview,
  groupContextEntries,
} from '../app_front/features/chat/chatContextPanelModel.js';

test.after(() => removeIsolatedDataDir());

const SECRET_BODY = 'TOP-SECRET-RULE-BODY-9f3a';

/** @returns {{ project: string, home: string, bundled: string }} */
function makeProject() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-manifest-proj-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-manifest-home-'));
  const bundled = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-manifest-bundled-'));
  fs.mkdirSync(path.join(project, '.cursor', 'rules'), { recursive: true });
  fs.writeFileSync(
    path.join(project, '.cursor', 'rules', 'always.mdc'),
    `---\nalwaysApply: true\n---\n${SECRET_BODY}\n`,
  );
  fs.mkdirSync(path.join(project, '.cursor', 'skills', 'demo'), { recursive: true });
  fs.writeFileSync(
    path.join(project, '.cursor', 'skills', 'demo', 'SKILL.md'),
    '---\nname: demo\ndescription: Demo skill\n---\nBody\n',
  );
  return { project, home, bundled };
}

/** @param {ReturnType<typeof makeProject>} dirs */
function ctx(dirs, extra = {}) {
  return {
    cwd: dirs.project,
    projectRoot: dirs.project,
    homeDir: dirs.home,
    bundledRoot: dirs.bundled,
    additionalDirs: [],
    prompt: 'hello',
    mode: 'agent',
    transport: 'sdk',
    ...extra,
  };
}

test('preview and real send go through one builder and share the revision', () => {
  const dirs = makeProject();
  const preview = previewNextSend(ctx(dirs), 'sdk', { chatId: 'chat-m1' });
  const sent = recordContextSend({ chatId: 'chat-m1', sendId: 's1', context: ctx(dirs), adapterId: 'sdk' });
  assert.equal(sent.revision, preview.revision);
  assert.equal(sent.preview.changedSincePreview, false);
  assert.equal(buildContextSnapshot(ctx(dirs), 'sdk').revision, preview.revision);
});

test('a file change between preview and send is flagged', () => {
  const dirs = makeProject();
  const preview = previewNextSend(ctx(dirs), 'sdk', { chatId: 'chat-m2' });
  fs.writeFileSync(
    path.join(dirs.project, '.cursor', 'rules', 'always.mdc'),
    `---\nalwaysApply: true\n---\nchanged ${SECRET_BODY}\n`,
  );
  const sent = recordContextSend({ chatId: 'chat-m2', sendId: 's2', context: ctx(dirs), adapterId: 'sdk' });
  assert.notEqual(sent.revision, preview.revision);
  assert.equal(sent.preview.changedSincePreview, true);
});

test('snapshot is content-free and holds no absolute or home paths', () => {
  const dirs = makeProject();
  const sent = recordContextSend({
    chatId: 'chat-m3', sendId: 's3', context: ctx(dirs), adapterId: 'sdk', sentPayload: `prefix ${SECRET_BODY}`,
  });
  const text = JSON.stringify(sent);
  assert.equal(text.includes(SECRET_BODY), false);
  for (const root of [dirs.project, dirs.home, dirs.bundled]) assert.equal(text.includes(root), false);
  assert.equal(sent.entries.every((row) => row.read === false && row.readEvidence === 'none'), true);
  assert.equal(sent.delivery.matchesAssembler, false);
});

test('entries are grouped into the panel categories', () => {
  const dirs = makeProject();
  const snapshot = buildContextSnapshot(ctx(dirs), 'harness');
  const groups = groupContextEntries(snapshot);
  assert.deepEqual(groups.map((g) => g.id), [
    'selected', 'delivered', 'available', 'unknown_native', 'error', 'overridden', 'disabled',
  ]);
  assert.equal(groups.find((g) => g.id === 'delivered').entries.some((row) => row.callName === 'demo'), true);
  assert.equal(compareSendWithPreview(null, snapshot), 'no_send');
  assert.equal(compareSendWithPreview(snapshot, snapshot), 'same');
  assert.equal(compareSendWithPreview({ revision: 'x' }, snapshot), 'changed');
});

test('retention: idempotent by sendId, capped per chat, aged rows dropped, deleted with the chat', () => {
  const now = Date.now();
  assert.equal(appendContextSendManifest('chat-r', { sendId: 'a' }, { now: () => now }), true);
  assert.equal(appendContextSendManifest('chat-r', { sendId: 'a' }, { now: () => now }), false);
  for (let i = 0; i < MAX_MANIFESTS_PER_CHAT + 5; i += 1) {
    appendContextSendManifest('chat-r', { sendId: `n${i}` }, { now: () => now });
  }
  assert.equal(listContextSendManifests('chat-r', { now: () => now }).length, MAX_MANIFESTS_PER_CHAT);
  assert.equal(listContextSendManifests('chat-r', { now: () => now + 31 * 24 * 3600 * 1000 }).length, 0);
  deleteContextSendManifests('chat-r');
  assert.equal(listContextSendManifests('chat-r', { now: () => now }).length, 0);
});

/**
 * @param {string} urlPath
 * @param {object} req
 * @returns {Promise<{ status: number, body: any }>}
 */
function invoke(urlPath, req) {
  const handlers = {};
  registerChatContextRoutes({ get: (p, fn) => { handlers[p] = fn; } }, { getCurrentCwd: () => process.cwd() });
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); },
    };
    handlers[urlPath](req, res);
  });
}

test('routes: chatId required, foreign workspaceFolder rejected, own chat served', async () => {
  const dirs = makeProject();
  const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-manifest-foreign-'));
  saveChats([...loadChats(), { id: 'chat-route-1', title: 't', workspaceFolder: dirs.project, agentTransport: 'sdk' }]);
  assert.equal((await invoke('/api/chat-context/snapshot', { query: {} })).status, 400);
  const denied = await invoke('/api/chat-context/preview', { query: { chatId: 'chat-route-1', workspaceFolder: foreign } });
  assert.equal(denied.status, 403);
  assert.equal(JSON.stringify(denied.body).includes(foreign), false);
  const unknown = await invoke('/api/chat-context/snapshot', { query: { chatId: 'nope' } });
  assert.equal(unknown.status, 404);
  const preview = await invoke('/api/chat-context/preview', { query: { chatId: 'chat-route-1' } });
  assert.equal(preview.status, 200);
  assert.equal(JSON.stringify(preview.body).includes(dirs.project), false);
  const snap = await invoke('/api/chat-context/snapshot', { query: { chatId: 'chat-route-1' } });
  assert.equal(snap.body.persistenceScope, 'local');
  assert.equal(snap.body.latest, null);
});
