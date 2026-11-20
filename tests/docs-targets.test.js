import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ISOLATED_DATA_DIR as dataDir } from './helpers/isolated-data-dir.js';
import { createDocsService } from '../lib/docs/docs-service.js';
import { defaultTargetExists } from '../lib/docs/docs-links.js';
import { addTodo, deleteTodo, updateTodo } from '../lib/persist/todos-store.js';
import { getInitiativesService, closeInitiativesServices } from '../lib/initiatives/initiatives-service.js';
import { createDecision, closeDecisionStores } from '../lib/decisions/decision-store.js';

const home = path.join(dataDir, 'workspace');
const ws = { workspaceUuid: 'ws-real', homeFolder: home };
const scope = { workspaceUuid: ws.workspaceUuid };
fs.mkdirSync(path.join(home, 'docs'), { recursive: true });
fs.writeFileSync(path.join(home, 'docs', 'note.md'), '# Note');

test('real domain readers enforce workspace, preserve todo identity across rename and flag deletion', async (t) => {
  const svc = createDocsService({ dataDir, resolveScope: async () => ws });
  t.after(async () => { svc.close(); await closeInitiativesServices(); await closeDecisionStores(); });
  const todo = (await addTodo(dataDir, home, { title: 'Original' })).item;
  const initiatives = getInitiativesService(dataDir, { resolveScope: async () => ws, hostOptions: { noReceiptsRetention: true } });
  const initiative = (await initiatives.create(scope, { title: 'Initiative', desiredOutcome: 'Outcome' }, { actor: 'human', idempotencyKey: 'docs-real' })).initiative;
  const decision = await createDecision(dataDir, { kind: 'question', title: 'Question', workspaceFolder: home,
    subject: { chatId: 'docs', updatedAt: 'revision-1' }, dedupeKey: 'docs-question',
    options: [{ id: 'a', label: 'A', effect: 'A' }, { id: 'b', label: 'B', effect: 'B' }] });
  for (const [kind, target] of [['todo', todo], ['initiative', initiative], ['decision', decision]]) {
    assert.ok(await defaultTargetExists(dataDir, ws, kind, target.id));
    await svc.addLink(scope, { note: 'note.md', kind, targetId: target.id }, 'human');
    assert.equal((await svc.backlinks(scope, { target: `${kind}:${target.id}` }, 'agent')).items[0].state, 'ok');
  }
  assert.equal(await defaultTargetExists(dataDir, { ...ws, homeFolder: dataDir }, 'decision', decision.id), false);
  assert.equal(await defaultTargetExists(dataDir, ws, 'initiative', '99999999-abcd-4000-8000-123456789abc'), false);
  await updateTodo(dataDir, home, todo.id, { title: 'Renamed' });
  assert.equal((await svc.links(scope, { target: `todo:${todo.id}` }, 'agent')).items[0].state, 'ok');
  await deleteTodo(dataDir, home, todo.id);
  const missing = (await svc.links(scope, { target: `todo:${todo.id}` }, 'agent')).items[0];
  assert.equal(missing.targetMissing, true);
  assert.equal(missing.state, 'dangling');
  assert.equal((await svc.links(scope, { note: 'note.md' }, 'human')).items.length, 3);
});
