import './helpers/isolated-data-dir.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { ISOLATED_DATA_DIR as dataDir } from './helpers/isolated-data-dir.js';
import { makeTempDir } from './helpers/temp-dir.js';
import {
  createDecision, changeDecision, annotateDecision, getDecision, listDecisionEvents, listDecisionHistory, closeDecisionStores,
} from '../lib/decisions/decision-store.js';
import { createWatcherHumanDecision } from '../lib/decisions/decision-request.js';

const ws = makeTempDir('cretli-storage-decisions-');
after(async () => { await closeDecisionStores(); });
const options = [
  { id: 'a', label: 'A', effect: 'do a', continuation: 'resume' },
  { id: 'b', label: 'B', effect: 'do b' },
];
const raw = (n, extra = {}) => ({
  kind: 'needs_human', workspaceFolder: ws, subject: { chatId: 'c', todoIds: [`t${n}`], updatedAt: `v${n}` },
  title: `Q${n}`, options, recommended: 'a', why: 'w', dedupeKey: `k${n}`, producer: 'c', ...extra,
});
const decideCard = async (card, at) => {
  const claimed = await changeDecision(dataDir, card.id, card.revision, 'deciding');
  return changeDecision(dataDir, card.id, claimed.revision, 'decided', { optionId: 'a', decidedAt: at, continuation: { status: 'saved', intent: 'none', todoIds: [] } }, 'deciding',
    { key: 'answered', type: 'answered', at, snapshot: { optionId: 'a' } });
};

test('create is idempotent per dedupeKey+revision and stores an immutable proposed snapshot', async () => {
  const a = await createDecision(dataDir, raw(1));
  const again = await createDecision(dataDir, raw(1, { title: 'edited later' }));
  assert.equal(again.id, a.id);
  const events = (await listDecisionEvents(dataDir, a.id)).items;
  assert.equal(events[0].type, 'proposed');
  assert.equal(events[0].snapshot.title, 'Q1');
});

test('superseding: a new revision stales a pending card; a decided needs_human card is marked superseded and keeps its answer', async () => {
  const first = await createDecision(dataDir, raw(2));
  const next = await createDecision(dataDir, raw(2, { subject: { chatId: 'c', todoIds: ['t2'], updatedAt: 'v2b' }, title: 'Q2 revised' }));
  assert.equal((await getDecision(dataDir, first.id)).status, 'stale');
  assert.deepEqual(next.relations.supersedes, [first.id]);
  const decided = await decideCard(next, '2026-11-22T10:00:00.000Z');
  const third = await createDecision(dataDir, raw(2, { subject: { chatId: 'c', todoIds: ['t2'], updatedAt: 'v2c' }, title: 'Q2 third' }));
  const old = await getDecision(dataDir, decided.id);
  assert.equal(old.status, 'decided');
  assert.equal(old.optionId, 'a');
  assert.equal(old.supersededBy, third.id);
});

test('event log keeps proposed/answered snapshots when the cap trims other events; duplicate keys stay idempotent', async () => {
  const card = await createDecision(dataDir, raw(3));
  const decided = await decideCard(card, '2026-11-22T10:01:00.000Z');
  await annotateDecision(dataDir, decided.id, { status: 'applying', applyingAt: 'x' }, { expectStatus: 'saved' });
  for (let i = 0; i < 260; i += 1) {
    await annotateDecision(dataDir, decided.id, { status: 'applying' }, { event: { key: `noise:${i}`, type: 'noise', at: 'x', snapshot: { i } } });
  }
  await annotateDecision(dataDir, decided.id, { status: 'applying' }, { event: { key: 'noise:259', type: 'noise', at: 'x', snapshot: { i: 'dup' } } });
  const all = [];
  for (let cursor = 0; ;) {
    const page = await listDecisionEvents(dataDir, decided.id, { cursor, limit: 100 });
    all.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  const types = all.map((e) => e.type);
  assert.ok(types.includes('proposed') && types.includes('answered'));
  assert.equal(all.filter((e) => e.type === 'noise').length, 200);
  assert.equal(all.find((e) => e.key === 'noise:259').snapshot.i, 259);
  assert.equal(all.find((e) => e.type === 'proposed').snapshot.title, 'Q3');
});

test('workspace history is keyset-paginated beyond the old 100-card limit', async () => {
  const ws2 = makeTempDir('cretli-storage-decisions-history-');
  for (let n = 0; n < 7; n += 1) {
    const card = await createDecision(dataDir, { ...raw(100 + n), workspaceFolder: ws2 });
    await decideCard(card, `2026-11-22T11:00:0${n}.000Z`);
  }
  const first = await listDecisionHistory(dataDir, ws2, { limit: 3 });
  assert.equal(first.items.length, 3);
  assert.ok(first.nextCursor);
  const second = await listDecisionHistory(dataDir, ws2, { limit: 3, cursor: first.nextCursor });
  const third = await listDecisionHistory(dataDir, ws2, { limit: 3, cursor: second.nextCursor });
  const ids = [...first.items, ...second.items, ...third.items].map((c) => c.id);
  assert.equal(new Set(ids).size, 7);
  assert.equal(third.nextCursor, null);
  assert.ok(first.items[0].decidedAt > third.items.at(-1).decidedAt);
});

test('multi-source relations, journey carry-over, missing sources and legacy unknown origin', async () => {
  const todoA = 'ta'; const todoB = 'tb';
  const v1 = (await createWatcherHumanDecision(dataDir, ws, { chatId: 'c', cycleId: 'cy', reportId: 'r1', todoIds: [todoA, todoB], message: 'm',
    options, recommended: 'a', why: 'w', blockerKey: 'multi', question: 'Q?', sources: [{ type: 'delegation', id: 'd1' }, { type: 'git_commit', id: 'abc' }] })).decision;
  assert.deepEqual(v1.relations.todoIds, [todoA, todoB]);
  assert.ok(v1.relations.refs.some((r) => r.type === 'delegation' && r.id === 'd1'));
  const v2 = (await createWatcherHumanDecision(dataDir, ws, { chatId: 'c', cycleId: 'cy2', reportId: 'r2', todoIds: [todoA, todoB], message: 'm',
    options, recommended: 'a', why: 'w', blockerKey: 'multi', question: 'Q changed?' })).decision;
  assert.equal(v2.relations.journeyId, v1.relations.journeyId);
  assert.ok(Array.isArray(v2.relations.refs)); // no sources: a card with missing sources still stores typed refs for its todos
  await assert.rejects(createDecision(dataDir, raw(9, { relations: { refs: [{ type: 'bogus', id: 'x' }] } })), /Invalid decision relation/);
  const legacy = await createDecision(dataDir, raw(10));
  assert.equal(legacy.origin, undefined);
  assert.equal(legacy.relations, undefined);
});

test('restart/retry: a repeated annotate with the same event key does not duplicate and a lost CAS changes nothing', async () => {
  const card = await createDecision(dataDir, raw(20));
  const decided = await decideCard(card, '2026-11-22T12:00:00.000Z');
  const ev = { key: 'continuation:waiting', type: 'continuation_waiting', at: 'x', snapshot: {} };
  await annotateDecision(dataDir, decided.id, { status: 'waiting' }, { expectStatus: 'saved', event: ev });
  assert.equal(await annotateDecision(dataDir, decided.id, { status: 'waiting' }, { expectStatus: 'saved', event: ev }), null);
  await annotateDecision(dataDir, decided.id, { status: 'waiting' }, { event: ev });
  assert.equal((await listDecisionEvents(dataDir, decided.id)).items.filter((e) => e.type === 'continuation_waiting').length, 1);
});
