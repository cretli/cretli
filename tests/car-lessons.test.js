import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLessonAggregates, buildNavCards, isLessonAggregateCard, withoutLessonCards } from '../app_front/features/car/carLessons.js';
import { carCardTitle, pickOpenTarget } from '../app_front/features/car/carCardNav.js';
import { runBulkLessonPatch, summarizeBulkResult } from '../app_front/features/settings/reviewLessonsBulk.js';

const lesson = (id, folder = '/ws/a') => ({ id, kind: 'lesson_candidate', status: 'pending', workspaceFolder: folder, workspaceFile: `${folder}.code-workspace` });
const plan = { id: 'p1', kind: 'plan_approval', status: 'pending', workspaceFolder: '/ws/a' };
const question = { id: 'q1', kind: 'question', status: 'pending', workspaceFolder: '/ws/a' };

test('lesson proposals are left out of the navigable cards', () => {
  const cards = [lesson('l1'), plan, lesson('l2'), question];
  assert.deepEqual(withoutLessonCards(cards).map((c) => c.id), ['p1', 'q1']);
  assert.deepEqual(buildNavCards(cards).map((c) => c.id), ['p1', 'q1']);
});

test('one aggregate per workspace goes last and carries the count', () => {
  const cards = [lesson('l1'), plan, lesson('l2'), lesson('l3', '/ws/b'), question];
  const nav = buildNavCards(cards, { includeAggregates: true });
  assert.deepEqual(nav.map((c) => c.id), ['p1', 'q1', 'car-lessons:/ws/a', 'car-lessons:/ws/b']);
  const [a, b] = nav.slice(2);
  assert.equal(a.count, 2);
  assert.equal(b.count, 1);
  assert.equal(a.workspaceFile, '/ws/a.code-workspace');
  assert.deepEqual(a.options, []);
  assert.ok(isLessonAggregateCard(a));
});

test('no proposals means no aggregate card', () => {
  assert.deepEqual(buildLessonAggregates([plan, question]), []);
  assert.deepEqual(buildNavCards([plan], { includeAggregates: true }).map((c) => c.id), ['p1']);
  assert.deepEqual(buildNavCards([lesson('l1')]), []);
});

test('the aggregate title shows the count and opens the lessons settings', () => {
  const [agg] = buildLessonAggregates([lesson('l1'), lesson('l2')]);
  const translate = (key, params) => `${key}:${params?.count}`;
  assert.equal(carCardTitle(agg, translate), 'car.card.lesson_aggregate:2');
  assert.deepEqual(pickOpenTarget(agg, '/ws/a'), { kind: 'lessons' });
  assert.deepEqual(pickOpenTarget(agg, '/ws/other'), { kind: 'lessons', switchTo: '/ws/a' });
});

test('bulk update continues after a conflict and counts each outcome', async () => {
  const lessons = [{ id: 'a', revision: 1 }, { id: 'b', revision: 2 }, { id: 'c', revision: 3 }, { id: 'd', revision: 4 }];
  const seen = [];
  const result = await runBulkLessonPatch(lessons, { status: 'active' }, async (item, patch) => {
    seen.push([item.id, item.revision, patch.status]);
    if (item.id === 'b') return { status: 409, json: { ok: false, code: 'CONFLICT' } };
    if (item.id === 'c') throw new Error('network');
    return { status: 200, json: { ok: true } };
  });
  assert.equal(seen.length, 4);
  assert.deepEqual(seen[1], ['b', 2, 'active']);
  assert.deepEqual(result, { done: 2, total: 4, conflicts: 1, errors: 1, failed: 2 });
  const t = (key, params) => `${key}|${JSON.stringify(params)}`;
  assert.match(summarizeBulkResult(result, t), /BulkPartial/);
  assert.match(summarizeBulkResult({ done: 2, total: 2, conflicts: 0, errors: 0, failed: 0 }, t), /BulkDone/);
});

// --- Wiring: voice must never decide a lesson or an off-screen card (R1A1-F1, F3, F6) ---
const decisions = await import('../app_front/features/car/carDecisions.js');
const { createCommandHandlers } = await import('../app_front/features/voice/commandHandlers.js');
const { localizedPickLabel } = await import('../app_front/features/car/carService.js');

const opt = (...ids) => ids.map((id) => ({ id, label: `Label ${id}` }));
const withOptions = (c) => ({ ...c, revision: 1, title: c.id, options: opt('activate', 'withdraw'), subject: { chatId: 'c' } });

function voiceHandlers(cards, cursor) {
  decisions.carCards.set(cards.map(withOptions));
  decisions.carFocusChatId.set('');
  decisions.carCursor.set(cursor);
  return createCommandHandlers({
    loadChatModule: async () => ({}),
    loadCarService: async () => ({
      refreshCarCards: async () => {},
      getCarChoiceFlow: decisions.getCarChoiceFlow,
      getCurrentCarCard: decisions.getCurrentCarCard,
      isCarOnLessonsAggregate: decisions.isCarOnLessonsAggregate,
      stepCarCard: decisions.stepCarCard,
      carCardTitle: (c) => c.title,
    }),
  });
}

test('"option one" on the aggregate card with one hidden lesson decides nothing', async () => {
  const handlers = voiceHandlers([lesson('l1')], 'car-lessons:/ws/a');
  const result = await handlers.chooseOption({ option: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'no_card');
  assert.equal(decisions.getCarChoiceFlow().getPending(), null);
});

test('"option one" on the aggregate card does not arm an off-screen question', async () => {
  const handlers = voiceHandlers([question, lesson('l1')], 'car-lessons:/ws/a');
  const result = await handlers.chooseOption({ option: 1 });
  assert.equal(result.code, 'no_card');
  assert.equal(decisions.getCarChoiceFlow().getPending(), null);
});

test('only lessons and a cursor on a normal card path: no_card, not ambiguous', async () => {
  const handlers = voiceHandlers([lesson('l1'), lesson('l2')], '');
  assert.equal((await handlers.chooseOption({ option: 1 })).code, 'no_card');
  assert.equal((await handlers.chooseOption({ option: 1, card_id: 'l1' })).code, 'stale');
});

test('a normal card is still decidable by voice next to lessons', async () => {
  const handlers = voiceHandlers([lesson('l1'), question], 'q1');
  const result = await handlers.chooseOption({ option: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.cardId, 'q1');
  decisions.getCarChoiceFlow().cancel();
});

test('voice "next card" from the aggregate wraps to the first real card, previous to the last', async () => {
  const cards = [plan, question, lesson('l1')];
  voiceHandlers(cards, 'car-lessons:/ws/a');
  assert.equal(decisions.stepCarCard(1).card.id, 'p1');
  decisions.carCursor.set('car-lessons:/ws/a');
  assert.equal(decisions.stepCarCard(-1).card.id, 'q1');
});

test('the spoken pick label is localized and shortened like the button', () => {
  decisions.carCards.set([{ id: 's1', kind: 'scout_finding', status: 'pending', options: [{ id: 'accept', label: 'Accept' }, { id: 'reject', label: 'Reject' }] }]);
  const label = localizedPickLabel('s1', 'accept', 'Accept');
  assert.ok(label.length > 0 && label.length <= 28);
});

test('the bulk guard ignores re-entry while a run is in progress', async () => {
  const { createSingleFlight } = await import('../app_front/features/settings/reviewLessonsBulk.js');
  const flight = createSingleFlight();
  let release;
  const first = flight.run(() => new Promise((resolve) => { release = () => resolve('first'); }));
  assert.equal(flight.busy, true);
  assert.equal(await flight.run(async () => 'second'), undefined);
  release();
  assert.equal(await first, 'first');
  assert.equal(flight.busy, false);
  assert.equal(await flight.run(async () => 'third'), 'third');
});

test('bulk progress is reported after each lesson', async () => {
  const seen = [];
  await runBulkLessonPatch([{ id: 'a' }, { id: 'b' }], {}, async () => ({ status: 409, json: null }), (d, t) => seen.push([d, t]));
  assert.deepEqual(seen, [[1, 2], [2, 2]]);
});
