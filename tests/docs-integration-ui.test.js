import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createDocsApi } from '../app_front/core/api/docs.js';
import { linkedDocRows, loadDocChoices } from '../app_front/features/docs/docsLinkLogic.js';

test('human link/unlink client shapes preserve workspace and propagate domain errors', async () => {
  const calls = [];
  const scope = { workspaceUuid: 'workspace-a' };
  const api = createDocsApi(scope, async (url, options) => {
    calls.push({ url, ...options });
    return { ok: true, json: async () => ({ ok: true, items: [] }) };
  });
  scope.workspaceUuid = 'workspace-b';
  await api.targetLinks('todo', 'todo-id'); await api.targetLinks('initiative', 'initiative-id');
  await api.addLink('note.md', 'todo', 'todo-id'); await api.addLink('note.md', 'initiative', 'initiative-id');
  await api.removeLink('link/id');
  assert.equal(new URL(calls[0].url, 'http://localhost').searchParams.get('target'), 'todo:todo-id');
  assert.equal(new URL(calls[1].url, 'http://localhost').searchParams.get('target'), 'initiative:initiative-id');
  assert.deepEqual(JSON.parse(calls[2].body), { note: 'note.md', kind: 'todo', targetId: 'todo-id', workspaceUuid: 'workspace-a' });
  assert.equal(JSON.parse(calls[3].body).kind, 'initiative');
  assert.equal(calls[4].method, 'DELETE'); assert.match(calls[4].url, /links\/link%2Fid\?/);
  assert.ok(calls.every((call) => call.url.includes('workspaceUuid=workspace-a')));
  const denied = createDocsApi({}, async () => ({ ok: false, status: 403, json: async () => ({ error: 'human only', code: 'docs-human-required' }) }));
  await assert.rejects(denied.addLink('a.md', 'todo', 'id'), (e) => e.code === 'docs-human-required' && e.status === 403);
  await assert.rejects(denied.removeLink('id'), (e) => e.status === 403);
});

test('picker results have no bodies and external notes require agentRead for mentions', async () => {
  let read = false;
  const api = { config: async () => ({ agentRead: false }), tree: async () => { read = true; return { items: [] }; } };
  await assert.rejects(loadDocChoices(api, '', true), (e) => e.code === 'docs-agent-read-denied');
  assert.equal(read, false);
  api.config = async () => ({ agentRead: true });
  api.search = async (q) => ({ items: [{ path: 'design.md', title: q, text: 'SECRET BODY' }, { path: '../escape.md' }] });
  assert.deepEqual(await loadDocChoices(api, ' design ', true), [{ path: 'design.md', title: 'design' }]);
  await loadDocChoices(api, '', false); assert.equal(read, true);
  const rows = linkedDocRows([{ note: 'design.md', id: 'id', source: 'managed', state: 'dangling' }, { note: 'derived.md', source: 'mention' }], [{ path: 'design.md', title: 'Design' }]);
  assert.equal(rows[0].title, 'Design'); assert.equal(rows[0].dangling, true); assert.equal(rows[0].removable, true);
  assert.equal(rows[1].removable, false);
});

test('todo and initiative embed the same component; composer drives picker and send hint', () => {
  const source = (path) => fs.readFileSync(new URL(`../app_front/${path}`, import.meta.url), 'utf8');
  assert.match(source('components/ui/cr-todo-card.js'), /<cr-doc-links kind="todo"/);
  assert.match(source('features/initiatives/cr-initiatives-panel.js'), /<cr-doc-links kind="initiative"/);
  assert.match(source('features/chat/services/chatComposer.js'), /syncDocMention\(chat, target\)/);
  assert.match(source('features/chat/services/chatComposer.js'), /current.value = appendDocRef\(removed.text, item.path\)/);
  assert.match(source('features/chat/services/chatSendHandlers.js'), /payloadText = withDocReadHint\(payloadText\)/);
});
