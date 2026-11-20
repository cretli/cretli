import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  briefToSpeech,
  buildCardBrief,
  buildCardSummary,
  carCardTitle,
  createSnoozeStore,
  cursorIndex,
  orderCarCards,
  stepCard,
  stepCardIndex,
  summarizePlanMarkdown,
} from '../app_front/features/car/carCardNav.js';
import { pl } from '../app_front/i18n/pl.js';
import { en } from '../app_front/i18n/en.js';

const cards = [
  { id: 'a', subject: { chatId: 'x' } },
  { id: 'b', subject: { chatId: 'y' } },
  { id: 'c', subject: { chatId: 'x' } },
];

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) };
}

test('this chat first, then the rest, order kept', () => {
  assert.deepEqual(orderCarCards(cards, 'y').map((c) => c.id), ['b', 'a', 'c']);
  assert.deepEqual(orderCarCards(cards, '').map((c) => c.id), ['a', 'b', 'c']);
});

test('stepping wraps and survives a vanished cursor', () => {
  assert.equal(stepCardIndex(2, 3, 1), 0);
  assert.equal(stepCardIndex(0, 3, -1), 2);
  assert.equal(stepCardIndex(0, 0, 1), 0);
  assert.equal(stepCard(cards, 'a', 1).card.id, 'b');
  assert.equal(stepCard(cards, 'a', -1).card.id, 'c');
  assert.equal(stepCard(cards, 'gone', 1).card.id, 'b');
  assert.equal(stepCard([], 'a', 1).card, null);
  assert.equal(cursorIndex(cards, 'c'), 2);
});

test('snooze hides a card for 15 minutes locally and then lets it return', () => {
  let t = 1000;
  const store = createSnoozeStore({ storage: memoryStorage(), now: () => t });
  store.snooze('b');
  assert.deepEqual(store.visible(cards).map((c) => c.id), ['a', 'c']);
  t += 14 * 60 * 1000;
  assert.equal(store.isSnoozed('b'), true);
  t += 2 * 60 * 1000;
  assert.equal(store.isSnoozed('b'), false);
  assert.equal(store.visible(cards).length, 3);
});

test('snooze survives corrupt or missing storage', () => {
  const broken = { getItem: () => '{nope', setItem: () => { throw new Error('full'); } };
  const store = createSnoozeStore({ storage: broken });
  store.snooze('a');
  assert.equal(store.visible(cards).length, 3);
  assert.equal(createSnoozeStore({ storage: null }).visible(cards).length, 3);
});

test('titles come from i18n by kind and the todo title in summary', () => {
  const tr = (lang) => (key, params) => {
    const text = key.split('.').reduce((o, k) => o?.[k], lang.car === undefined ? lang : { car: lang.car });
    return String(text).replace(/\{(\w+)\}/g, (_, k) => params?.[k]);
  };
  const plan = { kind: 'plan_approval', title: 'Approve plan: Fix login', summary: 'Fix login' };
  assert.equal(carCardTitle(plan, tr(pl)), 'Zatwierdź plan: Fix login');
  assert.equal(carCardTitle(plan, tr(en)), 'Approve plan: Fix login');
  assert.equal(carCardTitle({ kind: 'integration', title: 'Integrate: X', summary: 'X' }, tr(pl)), 'Zintegruj: X');
  // Missing summary falls back to the server title without its English prefix.
  assert.equal(carCardTitle({ kind: 'integration', title: 'Integrate: X' }, tr(pl)), 'Zintegruj: X');
  assert.equal(carCardTitle({ kind: 'question', title: 'Which db?' }, tr(pl)), 'Which db?');
});

test('plan summary: headings first, else three sentences, never the whole plan', () => {
  const headed = '# Plan\n\n## Step one\ntext\n\n## Step two\ntext\n\n## Step three\n\n## Step four\n';
  const out = summarizePlanMarkdown(headed);
  assert.match(out, /Plan/);
  assert.match(out, /Step two/);
  assert.doesNotMatch(out, /Step four/);
  const prose = 'One is here. Two is here. Three is here. Four is here. Five is here.';
  assert.equal(summarizePlanMarkdown(prose), 'One is here. Two is here. Three is here.');
  assert.ok(summarizePlanMarkdown('word '.repeat(2000)).length <= 420);
  assert.equal(summarizePlanMarkdown(''), '');
  assert.equal(summarizePlanMarkdown('```\n# not a heading\n```'), '');
});

test('card summary: plan uses the plan text, integration the evidence', () => {
  const tr = (key, params) => `${key}:${params?.title ?? ''}`;
  const plan = { kind: 'plan_approval', summary: 'T' };
  assert.equal(buildCardSummary(plan, { planMarkdown: '## A\n## B' }, tr), 'car.card.plan_approval:T. A. B');
  assert.equal(buildCardSummary(plan, {}, tr), '');
  const integration = { kind: 'integration', summary: 'T', evidence: [{ text: 'Two files changed' }, 'Tests passed'] };
  assert.match(buildCardSummary(integration, {}, tr), /Two files changed/);
});

test('open-in-app target: the card itself, with a workspace switch only when it is elsewhere', async () => {
  const { pickOpenTarget } = await import('../app_front/features/car/carCardNav.js');
  assert.deepEqual(pickOpenTarget(null), { kind: 'panel' });
  assert.deepEqual(pickOpenTarget({ id: 'c1', workspaceFolder: '/w/a' }, '/w/a'), { kind: 'decision', cardId: 'c1' });
  assert.deepEqual(pickOpenTarget({ id: 'c1', workspaceFolder: 'C:\\W\\A\\' }, 'c:/w/a'), { kind: 'decision', cardId: 'c1' });
  assert.deepEqual(pickOpenTarget({ id: 'c1', workspaceFolder: '/w/b' }, '/w/a'), { kind: 'decision', cardId: 'c1', switchTo: '/w/b' });
  assert.deepEqual(pickOpenTarget({ id: 'c1' }, '/w/a'), { kind: 'decision', cardId: 'c1' });
});

test('workspace of a card: by workspaceFile, else by owning folder, else none', async () => {
  const { findWorkspaceForCard } = await import('../app_front/features/car/carCardNav.js');
  const spaces = [
    { workspaceFile: '/ws/a.code-workspace', workspaceDir: '/ws', folders: [{ resolvedPath: '/p/one' }] },
    { workspaceFile: '/ws/b.code-workspace', workspaceDir: '/ws2', folders: [{ resolvedPath: '/p/two', enabled: true }, { resolvedPath: '/p/off', enabled: false }] },
  ];
  assert.deepEqual(findWorkspaceForCard({ workspaceFile: '/WS/b.code-workspace', workspaceFolder: '/p/two' }, spaces),
    { workspaceFile: '/ws/b.code-workspace', folder: '/p/two' });
  assert.deepEqual(findWorkspaceForCard({ workspaceFolder: '/p/two/' }, spaces), { workspaceFile: '/ws/b.code-workspace', folder: '/p/two' });
  assert.equal(findWorkspaceForCard({ workspaceFolder: '/p/off' }, spaces), null);
  assert.equal(findWorkspaceForCard({ workspaceFolder: '/nowhere' }, spaces), null);
  assert.equal(findWorkspaceForCard(null, spaces), null);
});

/** Real translator over a dictionary, with {param} substitution. */
function dictTr(dict) {
  return (key, params = {}) => {
    const value = key.split('.').reduce((node, part) => node?.[part], dict);
    assert.equal(typeof value, 'string', `missing i18n key ${key}`);
    return value.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''));
  };
}

test('card brief: a lesson card says what a lesson is and what each option does', () => {
  const lesson = {
    kind: 'lesson_candidate',
    title: 'Activate lesson?',
    summary: 'Avoid recurring style findings.',
    workspaceFolder: '/home/me/www/my-app/',
    options: [
      { id: 'activate', label: 'Activate', effect: 'Activate this lesson' },
      { id: 'withdraw', label: 'Withdraw', effect: 'Retire this candidate' },
    ],
  };
  const tr = dictTr(pl);
  assert.equal(carCardTitle(lesson, tr), 'Włączyć lekcję z review?');
  const brief = buildCardBrief(lesson, {}, tr);
  assert.equal(brief.workspace, 'my-app');
  assert.match(brief.about, /reguła/);
  assert.equal(brief.body, 'Avoid recurring style findings.');
  assert.deepEqual(brief.options.map((option) => option.label), ['Włącz', 'Odrzuć']);
  assert.ok(brief.options.every((option) => option.effect && !/lesson|candidate/i.test(option.effect)));
  assert.equal(brief.recommendation, null);
  const speech = briefToSpeech(lesson, brief, tr);
  assert.match(speech, /^Włączyć lekcję z review\? Workspace: my-app\. /);
  assert.match(speech, /Opcja 1: Włącz — /);
  assert.match(speech, /Opcja 2: Odrzuć — /);
});

test('card brief: agent options keep their own text, the recommendation carries its reason', () => {
  const card = {
    kind: 'needs_human',
    title: 'Which database?',
    summary: 'Which database?',
    recommended: 'pg',
    why: 'It is already in use.',
    options: [
      { id: 'pg', label: 'Postgres', effect: 'Keep the current server' },
      { id: 'sqlite', label: 'SQLite', effect: 'sqlite' },
    ],
  };
  const tr = dictTr(en);
  const brief = buildCardBrief(card, {}, tr);
  assert.equal(brief.body, '', 'a summary that repeats the title is not shown twice');
  assert.deepEqual(brief.options, [
    { label: 'Postgres', effect: 'Keep the current server', recommended: true },
    { label: 'SQLite', effect: '', recommended: false },
  ]);
  assert.deepEqual(brief.recommendation, { label: 'Postgres', why: 'It is already in use.' });
  assert.match(briefToSpeech(card, brief, tr), /Recommended: Postgres, because It is already in use\.$/);
  assert.equal(buildCardBrief({ kind: 'note', title: 'x' }, {}, tr).about, '');
});
