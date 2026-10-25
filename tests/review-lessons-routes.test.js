import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import { saveChats } from '../lib/persist/chats-persist.js';
import { registerReviewLessonsRoutes } from '../lib/routes/review-lessons-routes.js';

const routes = new Map();
registerReviewLessonsRoutes({ get: (p, fn) => routes.set(`GET ${p}`, fn), post: (p, fn) => routes.set(`POST ${p}`, fn), patch: (p, fn) => routes.set(`PATCH ${p}`, fn), delete: (p, fn) => routes.set(`DELETE ${p}`, fn) }, { getCurrentWorkspace: () => ISOLATED_DATA_DIR });
async function invoke(method, route, req) { let status = 200; let body; const res = { status(code) { status = code; return this; }, json(data) { body = data; return this; } }; await routes.get(`${method} ${route}`)(req, res); return { status, body }; }
saveChats([
  { id: 'chat-here', title: 'here', workspaceFolder: ISOLATED_DATA_DIR },
  { id: 'chat-there', title: 'there', workspaceFolder: `${ISOLATED_DATA_DIR}-foreign` },
]);
const base = { query: {}, params: {}, body: { workspaceFolder: ISOLATED_DATA_DIR, audience: 'implementer', kind: 'do', text: 'Add regression coverage for behavior changes.', category: 'missing-test' } };

const invalid = await invoke('POST', '/api/review-lessons', { ...base, body: { ...base.body, text: 'x'.repeat(301) } });
assert.equal(invalid.status, 400);
const outOfScope = await invoke('POST', '/api/review-lessons', { ...base, body: { ...base.body, workspaceFolder: `${ISOLATED_DATA_DIR}-foreign` } });
assert.equal(outOfScope.status, 403);
const forbiddenSuppress = await invoke('POST', '/api/review-lessons', { ...base, body: { ...base.body, kind: 'suppress', category: 'security', evidence: [] } });
assert.equal(forbiddenSuppress.status, 400);
const noEvidence = await invoke('POST', '/api/review-lessons', { ...base, body: { ...base.body, kind: 'suppress', category: 'other', evidence: [] } });
assert.equal(noEvidence.status, 400);
// Scope follows the calling chat (real isChatInWorkspace semantics), not the UI-selected workspace.
const wrongChat = await invoke('POST', '/api/review-lessons', { ...base, body: { ...base.body, chatId: 'chat-there' } });
assert.equal(wrongChat.status, 403);
assert.equal(wrongChat.body.code, 'OUT_OF_SCOPE');
const foreignFolderViaChat = await invoke('GET', '/api/review-lessons', { query: { workspaceFolder: `${ISOLATED_DATA_DIR}-foreign`, chatId: 'chat-here' }, body: {} });
assert.equal(foreignFolderViaChat.status, 403);
assert.equal((await invoke('GET', '/api/review-lessons', { query: { workspaceFolder: ISOLATED_DATA_DIR, chatId: 'nope' }, body: {} })).status, 404);
assert.equal((await invoke('GET', '/api/review-lessons', { query: { workspaceFolder: ISOLATED_DATA_DIR, chatId: 'chat-here' }, body: {} })).status, 200);
const created = await invoke('POST', '/api/review-lessons', base);
assert.equal(created.status, 200);
const patch = { ...base, params: { id: created.body.lesson.id }, body: { workspaceFolder: base.body.workspaceFolder, patch: { status: 'active' }, expectedRevision: 999 } };
const conflict = await invoke('PATCH', '/api/review-lessons/:id', patch);
assert.equal(conflict.status, 409);
assert.equal(conflict.body.code, 'CONFLICT');
const activeViaFlag = await invoke('POST', '/api/review-lessons', { ...base, body: { ...base.body, chatId: 'chat-here', text: 'Another rule via flag.', activate: true } });
assert.equal(activeViaFlag.body.lesson.status, 'active');
assert.equal('chatId' in activeViaFlag.body.lesson, false);
assert.equal('workspaceFolder' in activeViaFlag.body.lesson, false);
console.log('review-lessons-routes tests passed');
