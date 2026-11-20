import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCarChoice,
  createCarChoiceFlow,
  isHumanOnlyCard,
  parseOptionNumber,
  shortCarLabel,
} from '../app_front/features/car/carChoice.js';

const opts = (...ids) => ids.map((id) => ({ id, label: `Label ${id}` }));
const card = (extra = {}) => ({
  id: 'c1', revision: 3, status: 'pending', kind: 'question', title: 'Which db?', options: opts('a', 'b'),
  recommended: 'a', workspaceFolder: '/w', subject: { chatId: 'chat-1' }, ...extra,
});

function makeFlow(cards, { submit, now } = {}) {
  const sent = [];
  const state = { cards };
  const flow = createCarChoiceFlow({
    getCards: () => state.cards,
    submit: submit || (async (pick) => { sent.push(pick); return { ok: true }; }),
    now,
  });
  return { flow, sent, state };
}

test('2 to 4 options become numbered big buttons with short labels', () => {
  for (const n of [2, 3, 4]) {
    const choice = buildCarChoice(card({ options: opts(...['a', 'b', 'c', 'd'].slice(0, n)) }));
    assert.equal(choice.ok, true);
    assert.deepEqual(choice.options.map((o) => o.index), Array.from({ length: n }, (_, i) => i + 1));
    assert.equal(choice.options[0].recommended, true);
    assert.equal(choice.chatId, 'chat-1');
  }
  for (const bad of [[], opts('a'), opts('a', 'b', 'c', 'd', 'e'), opts('a', 'a'), [{ id: 'a' }, { label: 'x' }]]) {
    assert.deepEqual(buildCarChoice(card({ options: bad })), { ok: false, code: 'bad_options' });
  }
  assert.ok(shortCarLabel('x'.repeat(80)).length <= 28);
});

test('human-only cards are selectable by touch only, never by voice or the agent', async () => {
  for (const extra of [{ humanOnly: true }, { kind: 'plan_approval' }, { kind: 'integration' }, { kind: 'policy_upgrade' }]) {
    const touch = buildCarChoice(card(extra), { source: 'touch' });
    assert.equal(touch.ok, true);
    assert.equal(touch.humanOnly, true);
    // A `source` smuggled into a voice call is irrelevant: voice never sets it, anything but 'touch' is refused.
    assert.deepEqual(buildCarChoice(card(extra), { source: 'voice' }), { ok: false, code: 'human_only' });
    const { flow, sent } = makeFlow([card(extra)]);
    assert.deepEqual(flow.choose({ option: 1 }), { ok: false, code: 'human_only' });
    assert.equal(flow.choose({ option: 1, source: 'touch' }).ok, true);
    // A spoken "yes" cannot send the touch pick, and keeps it for the touch confirm.
    assert.deepEqual(await flow.confirm(), { ok: false, code: 'human_only' });
    assert.equal(sent.length, 0);
    assert.notEqual(flow.getPending(), null);
    assert.equal((await flow.confirm({ source: 'touch' })).ok, true);
    assert.equal(sent.length, 1);
  }
  assert.equal(buildCarChoice(card({ kind: 'permission' })).humanOnly, false);
});

test('human-only cards are never selectable without touch', () => {
  for (const extra of [{ humanOnly: true }, { kind: 'plan_approval' }, { kind: 'integration' }, { kind: 'policy_upgrade' }]) {
    assert.equal(isHumanOnlyCard(card(extra)), true);
    assert.deepEqual(buildCarChoice(card(extra)), { ok: false, code: 'human_only' });
    const { flow } = makeFlow([card(extra)]);
    assert.deepEqual(flow.choose({ option: 1 }), { ok: false, code: 'human_only' });
  }
  assert.equal(isHumanOnlyCard(card({ kind: 'permission' })), false);
});

test('a pick is two steps: nothing is sent until confirm', async () => {
  const { flow, sent } = makeFlow([card()]);
  const picked = flow.choose({ option: 2 });
  assert.equal(picked.ok, true);
  assert.equal(picked.needsConfirm, true);
  assert.equal(picked.optionId, 'b');
  assert.equal(sent.length, 0);
  const done = await flow.confirm();
  assert.deepEqual(done, { ok: true, cardId: 'c1', optionId: 'b' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].optionId, 'b');
  assert.equal(sent[0].card.revision, 3);
  assert.equal((await flow.confirm()).code, 'nothing_to_confirm');
});

test('confirm twice sends once; cancel drops the pick', async () => {
  const { flow, sent } = makeFlow([card()]);
  flow.choose({ option: 1 });
  const [first, second] = await Promise.all([flow.confirm(), flow.confirm()]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(sent.length, 1);
  flow.choose({ option: 1 });
  assert.equal(flow.cancel().ok, true);
  assert.equal((await flow.confirm()).code, 'nothing_to_confirm');
});

test('a card that changed after the pick selects nothing', async () => {
  for (const mutate of [
    (state) => { state.cards = [card({ revision: 4 })]; },
    (state) => { state.cards = [card({ status: 'decided' })]; },
    (state) => { state.cards = []; },
    (state) => { state.cards = [card({ options: opts('x', 'y') })]; },
    (state) => { state.cards = [card({ humanOnly: true })]; },
  ]) {
    const { flow, sent, state } = makeFlow([card()]);
    flow.choose({ option: 1 });
    mutate(state);
    const result = await flow.confirm();
    assert.equal(result.ok, false);
    assert.equal(sent.length, 0);
  }
});

test('an unknown or stale card id selects nothing', () => {
  const { flow } = makeFlow([card()]);
  assert.deepEqual(flow.choose({ cardId: 'missing', option: 1 }), { ok: false, code: 'stale' });
  const stale = makeFlow([card({ status: 'decided' })]).flow;
  assert.equal(stale.choose({ option: 1 }).code, 'no_card');
});

test('several open cards without an id are ambiguous; an id resolves it', () => {
  const { flow } = makeFlow([card(), card({ id: 'c2' })]);
  assert.deepEqual(flow.choose({ option: 1 }), { ok: false, code: 'ambiguous_card' });
  assert.equal(flow.choose({ cardId: 'c2', option: 1 }).cardId, 'c2');
});

test('option numbers and words; out-of-range picks nothing', () => {
  assert.equal(parseOptionNumber('2'), 2);
  assert.equal(parseOptionNumber('trzecia'), 3);
  assert.equal(parseOptionNumber('Two'), 2);
  assert.equal(parseOptionNumber(5), 0);
  assert.equal(parseOptionNumber('banana'), 0);
  const { flow } = makeFlow([card()]);
  assert.equal(flow.choose({ option: 3 }).code, 'bad_option');
  assert.equal(flow.choose({ option: 'b' }).optionId, 'b', 'a raw option id works too');
});

test('a pick expires', async () => {
  let at = 1000;
  const { flow } = makeFlow([card()], { now: () => at });
  flow.choose({ option: 1 });
  at += 31000;
  assert.equal(flow.getPending(), null);
  assert.equal((await flow.confirm()).code, 'nothing_to_confirm');
});

test('a failed send reports and stays retryable', async () => {
  let calls = 0;
  const { flow } = makeFlow([card()], { submit: async () => { calls += 1; return { ok: false, stale: calls === 1 }; } });
  flow.choose({ option: 1 });
  assert.equal((await flow.confirm()).code, 'stale');
  flow.choose({ option: 1 });
  assert.equal((await flow.confirm()).code, 'send_failed');
  assert.equal(calls, 2);
});

test('voice handlers drive the same flow: choose reads back, confirm sends once', async () => {
  const { createCommandHandlers } = await import('../app_front/features/voice/commandHandlers.js');
  const { flow, sent } = makeFlow([card()]);
  const refreshed = [];
  const opened = [];
  const handlers = createCommandHandlers({
    loadChatModule: async () => ({}),
    loadCarService: async () => ({
      refreshCarCards: async () => { refreshed.push(1); },
      getCarChoiceFlow: () => flow,
      openCarView: async () => { opened.push('open'); return { ok: true }; },
      closeCarView: () => { opened.push('close'); return { ok: true }; },
    }),
  });
  const picked = await handlers.chooseOption({ option: 2 });
  assert.equal(picked.ok, true);
  assert.equal(picked.label, 'Label b');
  assert.match(picked.message, /Label b/);
  assert.equal(refreshed.length, 1, 'cards are refreshed before a voice pick');
  assert.equal(sent.length, 0);
  const done = await handlers.confirmChoice({});
  assert.equal(done.ok, true);
  assert.equal(sent.length, 1);
  assert.equal((await handlers.confirmChoice({})).ok, false, 'a second confirm sends nothing');
  assert.equal(sent.length, 1);

  const refused = await handlers.chooseOption({ option: 9 });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'bad_option');
  await handlers.chooseOption({ option: 1 });
  assert.equal((await handlers.confirmChoice({ confirm: false })).cancelled, true);
  assert.equal(flow.getPending(), null);

  await handlers.setCarMode(true);
  await handlers.setCarMode(false);
  assert.deepEqual(opened, ['open', 'close']);
});

test('voice and the agent cannot decide a human-only card, even with a smuggled source', async () => {
  const { createCommandHandlers } = await import('../app_front/features/voice/commandHandlers.js');
  const plan = card({ id: 'p1', kind: 'plan_approval', options: opts('approve', 'reject') });
  const { flow, sent } = makeFlow([plan]);
  const handlers = createCommandHandlers({
    loadChatModule: async () => ({}),
    loadCarService: async () => ({
      refreshCarCards: async () => {},
      getCarChoiceFlow: () => flow,
      getCurrentCarCard: () => plan,
      stepCarCard: (direction) => ({ card: plan, index: 0, total: 1, direction }),
      carCardTitle: () => 'Zatwierdź plan: X',
    }),
  });
  const refused = await handlers.chooseOption({ option: 1, source: 'touch', card_id: 'p1' });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'human_only');
  assert.equal(flow.getPending(), null);
  assert.equal(sent.length, 0);

  const stepped = await handlers.cycleCard(1);
  assert.equal(stepped.ok, true);
  assert.equal(stepped.total, 1);
  assert.match(stepped.message, /X/);
});
