import './helpers/isolated-data-dir.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInitiativesService } from '../lib/initiatives/initiatives-service.js';
import { InitiativeError, requiresSignal } from '../lib/initiatives/constants.js';
import { INITIATIVES_STORE_FILE, initiativesDeclarationPath } from '../lib/persist/initiatives-runtime.js';
import { createOfflineBackup } from '../lib/backup/offline/offline-backup.js';
import { restoreOfflineBackup, finalizeRestore, resumeAfterRestore } from '../lib/backup/offline/offline-restore.js';
import * as todos from '../lib/persist/todos-store.js';

const roots = [];
const services = [];
after(async () => {
  await Promise.all(services.map((s) => s.close()));
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

function env() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-init-'));
  roots.push(root);
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  return { root, dataDir, controlDir: path.join(root, 'control'), destRoot: path.join(root, 'backups') };
}

/** Test resolver: `ws-a` / `ws-b` are distinct logical workspaces with their own todo homes. */
function makeService(e, extra = {}) {
  const homes = { 'uuid-a': path.join(e.root, 'home-a'), 'uuid-b': path.join(e.root, 'home-b') };
  Object.values(homes).forEach((h) => fs.mkdirSync(h, { recursive: true }));
  const svc = createInitiativesService({
    dataDir: e.dataDir, controlDir: e.controlDir, hostOptions: { noReceiptsRetention: true },
    resolveScope: async (_dir, input) => {
      const uuid = input.workspaceUuid;
      if (!homes[uuid]) throw new InitiativeError('workspace_required', 'workspace required');
      return { workspaceUuid: uuid, homeFolder: homes[uuid] };
    },
    ...extra,
  });
  services.push(svc);
  return { svc, homes };
}
const A = { workspaceUuid: 'uuid-a' };
const B = { workspaceUuid: 'uuid-b' };
const input = (title) => ({ title, desiredOutcome: `${title} outcome` });
const mk = async (svc, title, scope = A, actor = 'human') => (await svc.create(scope, input(title), { actor, idempotencyKey: `k-${title}-${Math.random()}` })).initiative;
const rejects = (p, code) => assert.rejects(p, (e) => e instanceof InitiativeError && e.code === code, code);

test('create is idempotent, validates payload match, defaults unknown values', async () => {
  const e = env();
  const { svc } = makeService(e);
  const first = await svc.create(A, input('One'), { actor: 'human', idempotencyKey: 'same' });
  assert.equal(first.created, true);
  assert.equal(first.initiative.scopeSize, 'unknown');
  assert.equal(first.initiative.status, 'draft');
  const again = await svc.create(A, input('One'), { actor: 'human', idempotencyKey: 'same' });
  assert.equal(again.created, false);
  assert.equal(again.initiative.id, first.initiative.id);
  await rejects(svc.create(A, input('Other'), { actor: 'human', idempotencyKey: 'same' }), 'idempotency_mismatch');
  await rejects(svc.create(A, { title: 'x' }, { actor: 'human', idempotencyKey: 'v' }), 'validation');
});

test('update and archive use compare-and-swap and journal every change', async () => {
  const e = env();
  const { svc } = makeService(e);
  const i = await mk(svc, 'Cas');
  const upd = await svc.update(A, i.id, { horizon: 'now', status: 'planned' }, { expectedRevision: 1, actor: 'human', reason: 'accepted' });
  assert.equal(upd.initiative.revision, 2);
  await rejects(svc.update(A, i.id, { priority: 'high' }, { expectedRevision: 1, actor: 'human' }), 'revision_conflict');
  const arch = await svc.archive(A, i.id, { expectedRevision: 2, actor: 'human' });
  assert.ok(arch.initiative.archivedAt);
  await rejects(svc.update(A, i.id, { priority: 'high' }, { expectedRevision: 3, actor: 'human' }), 'archived');
  const hist = await svc.history(A, i.id);
  assert.deepEqual(hist.items.map((h) => h.type), ['created', 'updated', 'archived']);
  assert.equal(hist.items[1].payload.reason, 'accepted');
});

test('agent can propose but not decide direction', async () => {
  const e = env();
  const { svc } = makeService(e);
  await rejects(svc.create(A, { ...input('Agent'), status: 'active' }, { actor: 'agent', idempotencyKey: 'a1' }), 'forbidden');
  const draft = (await svc.create(A, input('Agent'), { actor: 'agent', idempotencyKey: 'a2' })).initiative;
  await svc.update(A, draft.id, { rationale: 'because' }, { expectedRevision: 1, actor: 'agent' });
  await rejects(svc.update(A, draft.id, { status: 'active' }, { expectedRevision: 2, actor: 'agent' }), 'forbidden');
  const accepted = await svc.update(A, draft.id, { status: 'planned' }, { expectedRevision: 2, actor: 'human' });
  // Even a patch that keeps the status is refused for strategic fields of an accepted initiative.
  await rejects(svc.update(A, draft.id, { title: 'Renamed', status: 'planned' }, { expectedRevision: accepted.initiative.revision, actor: 'agent' }), 'forbidden');
  await rejects(svc.archive(A, draft.id, { expectedRevision: 3, actor: 'agent' }), 'forbidden');
  await rejects(svc.addRelation(A, { type: 'requires', fromId: draft.id, toId: draft.id }, { actor: 'agent' }), 'forbidden');
});

test('relations: self, duplicate and cycles are refused atomically; supports may cycle; alternative is symmetric', async () => {
  const e = env();
  const { svc } = makeService(e);
  const [a, b, c] = [await mk(svc, 'A'), await mk(svc, 'B'), await mk(svc, 'C')];
  await rejects(svc.addRelation(A, { type: 'requires', fromId: a.id, toId: a.id }, { actor: 'human' }), 'relation_self');
  await svc.addRelation(A, { type: 'requires', fromId: a.id, toId: b.id }, { actor: 'human' });
  await svc.addRelation(A, { type: 'requires', fromId: b.id, toId: c.id }, { actor: 'human' });
  await rejects(svc.addRelation(A, { type: 'requires', fromId: a.id, toId: b.id }, { actor: 'human' }), 'relation_duplicate');
  await rejects(svc.addRelation(A, { type: 'requires', fromId: c.id, toId: a.id }, { actor: 'human' }), 'relation_cycle');
  assert.equal((await svc.relations(A, c.id)).items.length, 1, 'refused cycle left nothing behind');
  await svc.addRelation(A, { type: 'contributes_to', fromId: c.id, toId: a.id }, { actor: 'human' });
  await svc.addRelation(A, { type: 'supports', fromId: a.id, toId: b.id }, { actor: 'human' });
  await svc.addRelation(A, { type: 'supports', fromId: b.id, toId: a.id }, { actor: 'human' });
  await svc.addRelation(A, { type: 'alternative_to', fromId: b.id, toId: a.id }, { actor: 'human' });
  await rejects(svc.addRelation(A, { type: 'alternative_to', fromId: a.id, toId: b.id }, { actor: 'human' }), 'relation_duplicate');
  assert.equal(await svc.requiresSignalOf(A, a.id), 'waiting');
});

test('workspaces are isolated: reads, relations and links never cross', async () => {
  const e = env();
  const { svc } = makeService(e);
  const a = await mk(svc, 'InA', A);
  const b = await mk(svc, 'InB', B);
  await rejects(svc.get(B, a.id), 'not_found');
  assert.equal((await svc.list(B)).items.length, 1);
  await rejects(svc.addRelation(A, { type: 'supports', fromId: a.id, toId: b.id }, { actor: 'human' }), 'not_found');
  await rejects(svc.update(B, a.id, { priority: 'low' }, { expectedRevision: 1, actor: 'human' }), 'not_found');
  await rejects(svc.list({ workspaceUuid: 'nope' }), 'workspace_required');
});

test('pagination is keyset-based, bounded and refuses a stale cursor', async () => {
  const e = env();
  const { svc } = makeService(e);
  for (let n = 0; n < 5; n += 1) await mk(svc, `P${n}`);
  const p1 = await svc.list(A, { limit: 2 });
  assert.equal(p1.items.length, 2);
  assert.ok(p1.hasMore && p1.nextCursor);
  const p2 = await svc.list(A, { limit: 2, cursor: p1.nextCursor });
  assert.deepEqual(p2.items.map((i) => i.title), ['P2', 'P3']);
  const p3 = await svc.list(A, { limit: 2, cursor: p2.nextCursor });
  assert.deepEqual(p3.items.map((i) => i.title), ['P4']);
  assert.equal(p3.nextCursor, null);
  assert.equal((await svc.list(A, { limit: 1000 })).items.length, 5);
  await mk(svc, 'late');
  await rejects(svc.list(A, { limit: 2, cursor: p1.nextCursor }), 'cursor_stale');
  const slice = await svc.graphSlice(A, { limit: 3 });
  assert.equal(slice.nodes.length, 3);
  assert.equal(slice.truncated, true);
});

test('research versions keep the previous entry and the observed/hypothesis split', async () => {
  const e = env();
  const { svc } = makeService(e);
  const i = await mk(svc, 'R');
  const first = await svc.addResearch(A, i.id, { kind: 'observed', claim: 'tests pass', sources: [{ type: 'test', ref: 'x' }] }, { actor: 'agent' });
  const second = await svc.addResearch(A, i.id, { kind: 'hypothesis', claim: 'maybe faster' }, { actor: 'agent', supersedesId: first.entry.id });
  assert.equal(second.entry.version, 2);
  assert.equal(second.entry.lineageId, first.entry.lineageId);
  assert.equal((await svc.research(A, i.id)).items.length, 2);
  await rejects(svc.addResearch(A, i.id, { kind: 'guess', claim: 'x' }, { actor: 'agent' }), 'validation');
  await rejects(svc.addResearch(A, i.id, { kind: 'observed', claim: 'y' }, { actor: 'agent', supersedesId: first.entry.id }), 'research_superseded');
});

test('linking an existing Todo leaves its parent and status untouched; foreign todo is unavailable', async () => {
  const e = env();
  const { svc, homes } = makeService(e, { todoApi: todos });
  const parent = (await todos.addTodo(e.dataDir, homes['uuid-a'], { title: 'parent', status: 'ready' })).item;
  const child = (await todos.addTodo(e.dataDir, homes['uuid-a'], { title: 'child', status: 'doing', parentId: parent.id })).item;
  const foreign = (await todos.addTodo(e.dataDir, homes['uuid-b'], { title: 'foreign' })).item;
  const i = await mk(svc, 'Linker');
  const { link } = await svc.addLink(A, i.id, { kind: 'todo', targetId: child.id }, { actor: 'human' });
  assert.equal(link.snapshot.name, 'child');
  const after = await todos.getTodo(e.dataDir, homes['uuid-a'], child.id);
  assert.equal(after.parentId, parent.id);
  assert.equal(after.status, 'doing');
  await rejects(svc.addLink(A, i.id, { kind: 'todo', targetId: foreign.id }, { actor: 'human' }), 'link_unavailable');
});

test('create Todo from initiative: repeats and parallel calls give one idea Todo; crash before the link is repaired', async () => {
  const e = env();
  const { svc, homes } = makeService(e, { todoApi: todos });
  const i = await mk(svc, 'Bridge');
  const [r1, r2] = await Promise.all([
    svc.createTodo(A, i.id, { operationId: 'op-1' }, { actor: 'human' }),
    svc.createTodo(A, i.id, { operationId: 'op-1' }, { actor: 'human' }),
  ]);
  assert.equal(r1.todoId, r2.todoId);
  let list = (await todos.listTodos(e.dataDir, homes['uuid-a'])).items;
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'idea');
  assert.equal((await svc.links(A, i.id)).items.filter((l) => l.kind === 'todo').length, 1);
  assert.equal((await svc.createTodo(A, i.id, { operationId: 'op-1' }, { actor: 'human' })).created, false);

  // Crash simulation: the Todo exists with its origin, but the intent never completed and no link was written.
  const j = await mk(svc, 'Crash');
  const payload = { title: 'Crash', body: 'Outcome: Crash outcome' };
  const { createHash } = await import('node:crypto');
  const { canonicalJson } = await import('../lib/storage/command-receipts.js');
  const digest = createHash('sha256').update(canonicalJson(payload)).digest('hex');
  const s = await svc.runtime().then((r) => r.store);
  await s.todoIntentBegin({ commandId: 'crash-begin-1', workspaceUuid: 'uuid-a', actor: 'human', now: new Date().toISOString(), operationId: 'op-crash', initiativeId: j.id, digest, payload });
  await todos.addTodo(e.dataDir, homes['uuid-a'], { ...payload, status: 'idea', strictStatus: true, initiativeOrigin: { workspaceUuid: 'uuid-a', operationId: 'op-crash', digest } });
  const retry = await svc.createTodo(A, j.id, { operationId: 'op-crash' }, { actor: 'human' });
  assert.equal(retry.created, false);
  list = (await todos.listTodos(e.dataDir, homes['uuid-a'])).items;
  assert.equal(list.filter((t) => t.title === 'Crash').length, 1);
  assert.equal((await svc.links(A, j.id)).items.filter((l) => l.targetId === retry.todoId).length, 1);
  assert.equal(list.find((t) => t.id === retry.todoId).status, 'idea');
  await rejects(svc.createTodo(A, j.id, { operationId: 'op-crash', title: 'Different' }, { actor: 'human' }), 'intent_mismatch');
  await rejects(svc.createTodo(A, j.id, { operationId: 'op-agent' }, { actor: 'agent' }), 'forbidden');
});

test('the origin survives todo_update and idempotency pruning because it lives on the record', async () => {
  const e = env();
  const { homes } = makeService(e);
  const origin = { workspaceUuid: 'uuid-a', operationId: 'op-x', digest: 'd1' };
  const added = (await todos.addTodo(e.dataDir, homes['uuid-a'], { title: 'o', initiativeOrigin: origin })).item;
  await todos.updateTodo(e.dataDir, homes['uuid-a'], added.id, { title: 'renamed', initiativeOrigin: { ...origin, operationId: 'forged' } });
  const row = await todos.getTodo(e.dataDir, homes['uuid-a'], added.id);
  assert.deepEqual(row.initiativeOrigin, origin);
  const replay = await todos.addTodo(e.dataDir, homes['uuid-a'], { title: 'o', initiativeOrigin: origin });
  assert.equal(replay.replayed, true);
  await assert.rejects(todos.addTodo(e.dataDir, homes['uuid-a'], { title: 'o', initiativeOrigin: { ...origin, digest: 'd2' } }), (err) => err.code === 'CONFLICT');
});

test('requires signal ordering', () => {
  assert.equal(requiresSignal([]), 'clear');
  assert.equal(requiresSignal([{ status: 'achieved', archivedAt: 'x' }]), 'clear');
  assert.equal(requiresSignal([{ status: 'active' }, { status: 'paused' }]), 'waiting_paused');
  assert.equal(requiresSignal([{ status: 'active' }]), 'waiting');
  assert.equal(requiresSignal([{ status: 'paused' }]), 'waiting_paused');
  assert.equal(requiresSignal([{ status: 'paused' }, null]), 'unknown');
  assert.equal(requiresSignal([{ status: 'dropped' }, null]), 'blocked_abandoned');
  assert.equal(requiresSignal([{ status: 'planned', archivedAt: 'x' }]), 'blocked_archived');
});

test('backup/restore round-trips initiatives, relations and history; a vanished file is refused', async () => {
  const src = env();
  const { svc } = makeService(src);
  const a = await mk(svc, 'Keep A');
  const b = await mk(svc, 'Keep B');
  await svc.addRelation(A, { type: 'requires', fromId: a.id, toId: b.id }, { actor: 'human' });
  await svc.update(A, a.id, { horizon: 'now' }, { expectedRevision: a.revision + 1, actor: 'human' });
  await svc.close();
  const { backupDir, manifest } = await createOfflineBackup(src);
  assert.ok(manifest.entries.some((x) => x.path === `initiatives/${INITIATIVES_STORE_FILE}`), 'initiatives file is a managed path');

  const dst = env();
  await restoreOfflineBackup({ ...dst, backupDir });
  finalizeRestore(dst);
  resumeAfterRestore(dst.controlDir);
  const { svc: restored } = makeService(dst);
  const list = await restored.list(A);
  assert.deepEqual(list.items.map((i) => i.title).sort(), ['Keep A', 'Keep B']);
  assert.equal((await restored.relations(A, a.id)).items.length, 1);
  assert.deepEqual((await restored.history(A, a.id)).items.map((h) => h.type), ['created', 'relation_added', 'updated']);
  await restored.close();

  // A vanished store file with a current declaration is never silently recreated.
  fs.rmSync(path.join(dst.dataDir, 'initiatives'), { recursive: true, force: true });
  const { svc: missing } = makeService(dst);
  await assert.rejects(missing.list(A), (err) => err.code === 'INITIATIVES_STORE_MISSING');
});

test('full restore of an archive that predates the domain yields a clearly empty domain', async () => {
  const old = env();
  fs.writeFileSync(path.join(old.dataDir, 'mcp.json'), '{}');
  const { backupDir } = await createOfflineBackup(old);

  const dst = env();
  const { svc } = makeService(dst);
  await mk(svc, 'Will be replaced');
  await svc.close();
  assert.ok(fs.existsSync(initiativesDeclarationPath(dst.controlDir)));
  await restoreOfflineBackup({ ...dst, backupDir });
  finalizeRestore(dst);
  resumeAfterRestore(dst.controlDir);
  assert.ok(!fs.existsSync(path.join(dst.dataDir, 'initiatives', INITIATIVES_STORE_FILE)), 'restore removed the newer file');
  const { svc: fresh } = makeService(dst);
  assert.deepEqual((await fresh.list(A)).items, []);
});
