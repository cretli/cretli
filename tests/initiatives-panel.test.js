import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  classifyError, clearDraft, conflictingFields, draftFromInitiative, draftKey, draftPatch, groupByHorizon, linkRows, linkableTodos, loadDraft,
  mergePages, parseSources, partitionResearch, saveDraft, scopeQuery,
} from '../app_front/features/initiatives/initiativeLogic.js';
import { SPA_PANELS, SPA_ROUTE_QUERY_KEYS } from '../lib/spa-routes.js';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
}

test('horizon grouping keeps achieved and Todo-done initiatives and orders by priority', () => {
  const groups = groupByHorizon([
    { id: 'a', horizon: 'now', status: 'achieved', priority: 'low', updatedAt: '2026-01-01' },
    { id: 'b', horizon: 'now', status: 'active', priority: 'urgent', updatedAt: '2025-01-01' },
    { id: 'c', horizon: 'next', status: 'dropped', priority: 'unknown' },
    { id: 'd', horizon: 'later', archivedAt: '2026-02-01' },
    { id: 'e', horizon: 'bogus' },
  ]);
  assert.deepEqual(groups.now.map((i) => i.id), ['b', 'a']);
  assert.deepEqual(groups.next.map((i) => i.id), ['c']);
  assert.deepEqual(groups.later.map((i) => i.id), ['e']);
  assert.deepEqual(groupByHorizon([{ id: 'd', horizon: 'later', archivedAt: 'x' }], { includeArchived: true }).later.map((i) => i.id), ['d']);
});

test('research is split into evidence, hypotheses and unknowns with the newest version per lineage', () => {
  const parts = partitionResearch([
    { id: '1', lineageId: 'L', version: 1, kind: 'hypothesis', claim: 'old' },
    { id: '2', lineageId: 'L', version: 2, kind: 'observed', claim: 'measured' },
    { id: '3', lineageId: 'M', version: 1, kind: 'hypothesis', claim: 'guess' },
    { id: '4', lineageId: 'N', version: 1, kind: 'unknown', claim: '?' },
  ]);
  assert.deepEqual(parts.observed.map((e) => [e.id, e.revisions]), [['2', 2]]);
  assert.deepEqual(parts.hypothesis.map((e) => e.id), ['3']);
  assert.deepEqual(parts.unknown.map((e) => e.id), ['4']);
  assert.deepEqual(parseSources('https://x.test/a\nnotes\n\n'), [
    { type: 'url', ref: 'https://x.test/a', accessedAt: '' }, { type: 'note', ref: 'notes', accessedAt: '' }]);
});

test('errors are classified: lost connection keeps the draft, CAS and cursor refusals are distinct', () => {
  assert.equal(classifyError(new TypeError('Failed to fetch')).kind, 'offline');
  assert.equal(classifyError({ status: 409, code: 'revision_conflict' }).kind, 'conflict');
  assert.equal(classifyError({ status: 409, code: 'archived' }).kind, 'conflict');
  assert.equal(classifyError({ status: 409, code: 'cursor_stale' }).kind, 'stale_cursor');
  assert.equal(classifyError({ status: 409, code: 'workspace_required' }).kind, 'workspace');
  assert.equal(classifyError({ status: 403, code: 'forbidden' }).kind, 'forbidden');
  assert.equal(classifyError({ status: 503, code: 'internal' }).kind, 'unavailable');
  assert.equal(classifyError({ status: 500 }).kind, 'error');
});

test('the canonical workspaceUuid wins over the per-tab view-context query', () => {
  assert.equal(scopeQuery('u-1', '?workspaceFolder=%2Fx'), 'workspaceUuid=u-1');
  assert.equal(scopeQuery('', '?workspaceFolder=%2Fx&workspaceFile=y'), 'workspaceFolder=%2Fx&workspaceFile=y');
  assert.equal(scopeQuery('', ''), '');
  assert.notEqual(draftKey('ws-a', 'i1'), draftKey('ws-b', 'i1'));
});

test('a draft survives a reload, is rebased by revision and only changed fields form the patch', () => {
  const base = { id: 'i', revision: 3, title: 'T', desiredOutcome: 'O', horizon: 'next', status: 'planned', priority: 'high', successCriteria: ['a'] };
  const storage = memoryStorage();
  const draft = { ...draftFromInitiative(base), title: 'T2', successCriteria: ['a', 'b'] };
  saveDraft(storage, draftKey('s', 'i'), draft, 3);
  const loaded = loadDraft(storage, draftKey('s', 'i'));
  assert.equal(loaded.baseRevision, 3);
  assert.deepEqual(Object.keys(draftPatch(loaded.draft, base)).sort(), ['successCriteria', 'title']);
  assert.deepEqual(draftPatch(draftFromInitiative(base), base), {});
  const remote = { ...base, revision: 4, title: 'T3', priority: 'urgent' };
  assert.deepEqual(conflictingFields(draft, base, remote), ['title']);
  clearDraft(storage, draftKey('s', 'i'));
  assert.equal(loadDraft(storage, draftKey('s', 'i')), null);
  assert.equal(loadDraft({ getItem: () => 'not json' }, 'k'), null);
});

test('linked Todos show their live status without affecting the initiative', () => {
  const links = [{ id: 'l1', kind: 'todo', targetId: 't1', snapshot: { name: 'Snap' } }, { id: 'l2', kind: 'todo', targetId: 'gone' }, { id: 'l3', kind: 'git', targetId: 'abc' }];
  const rows = linkRows(links, [{ id: 't1', status: 'done', title: 'Real' }]);
  assert.equal(rows[0].todoStatus, 'done');
  assert.equal(rows[1].todoMissing, true);
  assert.equal(rows[2].todoMissing, false);
  const todos = [{ id: 't1', title: 'One' }, { id: 't2', title: 'Two' }, { id: 't3', title: 'Three' }];
  assert.deepEqual(linkableTodos(todos, links, '').map((t) => t.id), ['t2', 't3']);
  assert.deepEqual(linkableTodos(todos, links, 'thr').map((t) => t.id), ['t3']);
  assert.deepEqual(mergePages([[{ id: 'a', v: 1 }], [{ id: 'a', v: 2 }, { id: 'b' }]]).map((i) => i.v ?? i.id), [2, 'b']);
});

test('the plans panel is a registered SPA route and is wired into the shell', () => {
  assert.ok(SPA_PANELS.includes('plans'));
  assert.deepEqual(SPA_ROUTE_QUERY_KEYS.plans, []);
  assert.match(read('public/sw-routes.js'), /'plans'/);
  assert.match(read('public/index.html'), /data-panel="plans"/);
  assert.match(read('public/index.html'), /<div id="plans-panel" class="panel"><cr-initiatives-panel>/);
  assert.match(read('app_front/app/appShell/panelRegistry.js'), /'plans'/);
  assert.match(read('app_front/app/appShell/panelRouter.js'), /initiativesPanel\.js/);
  assert.match(read('app_front/features/chat/transport/socketMessages.js'), /initiativeChanged[\s\S]*cr-initiatives-changed/);
});

test('the panel never starts work: Todo creation goes through the idea-only endpoint with an operation id', () => {
  const api = read('app_front/features/initiatives/initiativesApi.js');
  const panel = read('app_front/features/initiatives/cr-initiatives-panel.js');
  assert.match(api, /\/todos`/);
  assert.match(panel, /operationId/);
  assert.doesNotMatch(panel + api, /todo_start|\/start|planApproved|approvedAt/);
  assert.doesNotMatch(panel, /#[0-9a-fA-F]{3,8}\b(?![^`]*\))/m, 'colours must come from --cr-* tokens');
});

test('en and pl define the same plans keys and every t() key used by the panel exists', () => {
  const flat = (obj, prefix = '') => Object.entries(obj).flatMap(([k, v]) => (typeof v === 'object' ? flat(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
  assert.deepEqual(flat(en.plans).sort(), flat(pl.plans).sort());
  const keys = new Set(flat(en.plans).map((k) => `plans.${k}`));
  const source = read('app_front/features/initiatives/cr-initiatives-panel.js');
  for (const match of source.matchAll(/\bt\('(plans\.[\w.]+)'/g)) assert.ok(keys.has(match[1]), `missing ${match[1]}`);
  for (const group of ['status', 'horizon', 'priority']) for (const value of Object.keys(en.plans[group])) assert.ok(pl.plans[group][value]);
  assert.ok(en.tabs.plans && pl.tabs.plans);
});

// ---- map view ------------------------------------------------------------------------------------------------------

const mapItems = [
  { id: 'a', title: 'Alpha', horizon: 'now', status: 'active', priority: 'high', scopeSize: 'L' },
  { id: 'b', title: 'Beta', horizon: 'next', status: 'achieved', priority: 'low', scopeSize: 'S' },
  { id: 'c', title: 'Gamma', horizon: 'later', status: 'dropped', priority: 'normal' },
];

test('map model uses horizon columns, size heights and keeps relations with both ends drawn', async () => {
  const { buildMapModel, filterForMap } = await import('../app_front/features/initiatives/initiativeLogic.js');
  const rels = [
    { id: 'r1', type: 'requires', fromId: 'a', toId: 'b' },
    { id: 'r2', type: 'supports', fromId: 'b', toId: 'a' },
    { id: 'r3', type: 'supports', fromId: 'a', toId: 'a' },
    { id: 'r4', type: 'requires', fromId: 'a', toId: 'zzz' },
  ];
  const model = buildMapModel(filterForMap(mapItems, {}), rels);
  assert.deepEqual(model.nodes.map((n) => n.col), [0, 1, 2]);
  assert.ok(model.nodes[0].height > model.nodes[1].height);
  assert.equal(model.edges.length, 3, 'a supports cycle and a self relation are allowed');
  assert.equal(model.edges.find((e) => e.id === 'r3').loop, true);
  assert.equal(model.hiddenEdges, 1);
  assert.equal(model.hiddenNodes, 0);
});

test('a large set is limited explicitly, never truncated silently', async () => {
  const { buildMapModel, filterForMap, MAP_MAX_NODES } = await import('../app_front/features/initiatives/initiativeLogic.js');
  const many = Array.from({ length: MAP_MAX_NODES + 15 }, (_, i) => ({ id: `n${i}`, title: `T${i}`, horizon: 'now', status: 'active', priority: 'normal' }));
  const model = buildMapModel(many, []);
  assert.equal(model.nodes.length, MAP_MAX_NODES);
  assert.equal(model.hiddenNodes, 15);
  assert.equal(buildMapModel(filterForMap(many, { query: 'T1' }), []).hiddenNodes, 0);
  assert.deepEqual(filterForMap(mapItems, { hideClosed: true }).map((i) => i.id), ['a']);
  assert.deepEqual(filterForMap(mapItems, { horizon: 'next', query: 'bet' }).map((i) => i.id), ['b']);
  assert.ok(en.plans.map.limited.includes('{hidden}') && pl.plans.map.limited.includes('{hidden}'));
});

test('requires cycles are detected, supports cycles are allowed, and the server code maps to a cycle error', async () => {
  const { wouldCloseCycle, classifyError: classify } = await import('../app_front/features/initiatives/initiativeLogic.js');
  const rels = [{ type: 'requires', fromId: 'a', toId: 'b' }, { type: 'requires', fromId: 'b', toId: 'c' }, { type: 'supports', fromId: 'a', toId: 'b' }];
  assert.equal(wouldCloseCycle(rels, 'requires', 'c', 'a'), true);
  assert.equal(wouldCloseCycle(rels, 'requires', 'a', 'c'), false);
  assert.equal(wouldCloseCycle(rels, 'supports', 'b', 'a'), false);
  assert.equal(wouldCloseCycle(rels, 'requires', 'a', 'a'), true);
  assert.equal(classify({ status: 409, code: 'initiative_relation_cycle' }).kind, 'cycle');
});

test('keyboard navigation, relation outline and zoom clamping', async () => {
  const { buildMapModel, neighborNode, relationsOf, zoomView, panView, MAP_ZOOM_MAX, MAP_ZOOM_MIN } = await import('../app_front/features/initiatives/initiativeLogic.js');
  const model = buildMapModel(mapItems, []);
  assert.equal(neighborNode(model.nodes, 'a', 'ArrowRight'), 'b');
  assert.equal(neighborNode(model.nodes, 'a', 'ArrowLeft'), 'a');
  const out = relationsOf('a', [{ id: 'r', type: 'supports', fromId: 'b', toId: 'a' }], (id) => id);
  assert.deepEqual(out.map((r) => [r.direction, r.otherId]), [['in', 'b']]);
  assert.equal(zoomView({ zoom: 1, x: 0, y: 0 }, 100).zoom, MAP_ZOOM_MAX);
  assert.equal(zoomView({ zoom: 1, x: 0, y: 0 }, 0.001).zoom, MAP_ZOOM_MIN);
  assert.equal(panView({ zoom: 1, x: 1, y: 2 }, 3, 4).y, 6);
});

test('map component uses only defined i18n keys and no hardcoded colours', () => {
  const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' ? flat(v, `${p}${k}.`) : [`${p}${k}`]));
  assert.deepEqual(flat(en.plans.map), flat(pl.plans.map));
  const keys = new Set(flat(en.plans).map((k) => `plans.${k}`));
  for (const file of ['cr-initiatives-map.js', 'cr-initiatives-panel.js']) {
    const source = read(`app_front/features/initiatives/${file}`);
    for (const m of source.matchAll(/\bt\('(plans\.[\w.]+)'/g)) assert.ok(keys.has(m[1]), `missing ${m[1]}`);
    assert.doesNotMatch(source, /#[0-9a-fA-F]{3,6}\b/, `${file} must use var(--cr-*) tokens`);
  }
  assert.ok(en.plans.errors.cycle && pl.plans.errors.cycle);
});

test('relations of the visible subset are complete even when the pair sits on different graph-slice pages', async () => {
  const { collectRelations, buildMapModel, filterForMap } = await import('../app_front/features/initiatives/initiativeLogic.js');
  const all = Array.from({ length: 150 }, (_, i) => ({ id: `n${i}`, title: `Item ${i}`, horizon: 'now', status: 'active', priority: 'normal' }));
  // n3 is on slice page 1, n140 on page 2: a graph-slice read never returns this edge.
  const rels = [{ id: 'r1', type: 'requires', fromId: 'n140', toId: 'n3' }, { id: 'r2', type: 'supports', fromId: 'n3', toId: 'n7' }];
  const fetchOne = async (id) => ({ items: rels.filter((r) => r.fromId === id || r.toId === id) });
  const matched = all.filter((i) => ['n3', 'n140'].includes(i.id));
  assert.equal(filterForMap(all, { query: 'Item 140' }).length, 1);
  const { relations, complete } = await collectRelations(matched.map((i) => i.id), fetchOne);
  assert.equal(complete, true);
  assert.deepEqual(relations.map((r) => r.id).sort(), ['r1', 'r2']);
  const model = buildMapModel(matched, relations);
  assert.deepEqual(model.edges.map((e) => e.id), ['r1']);
  assert.equal(model.hiddenEdges, 1);
  const partial = await collectRelations(['n3', 'n140'], async (id) => { if (id === 'n3') throw Object.assign(new Error('x'), { status: 503 }); return fetchOne(id); });
  assert.equal(partial.complete, false);
  await assert.rejects(collectRelations(['n3'], async () => { throw new TypeError('offline'); }));
});

test('out-of-order relation responses: an older partial result never overwrites a newer complete one', async () => {
  // The panel pulls in .scss modules through the UI barrel; stub them so the real element loads under Node.
  await import('./helpers/stub-style-imports.js');
  const { CrInitiativesPanel } = await import('../app_front/features/initiatives/cr-initiatives-panel.js');
  const panel = new CrInitiativesPanel();
  const gates = [];
  // Deferred responses, settled by the test in a chosen order.
  Object.defineProperty(panel, 'api', { value: { relationsOfAll: () => new Promise((resolve) => gates.push(resolve)) } });
  // Same node set requested twice (refresh): the first (older) request answers last.
  const older = panel.loadRelations(['a']);
  const newer = panel.loadRelations(['a']);
  gates[1]({ relations: [{ id: 'r-new', type: 'requires', fromId: 'a', toId: 'b' }], complete: true });
  await newer;
  gates[0]({ relations: [], complete: false });
  await older;
  assert.deepEqual(panel.relations.map((r) => r.id), ['r-new']);
  assert.equal(panel.edgesPartial, false);
  // A stale failure must not flag the newer complete result as partial either.
  const staleFail = panel.loadRelations(['a']);
  const fresh = panel.loadRelations(['a']);
  gates[3]({ relations: [{ id: 'r-new', type: 'requires', fromId: 'a', toId: 'b' }], complete: true });
  await fresh;
  gates[2]({ relations: [], complete: false });
  await staleFail;
  assert.equal(panel.edgesPartial, false);
});
