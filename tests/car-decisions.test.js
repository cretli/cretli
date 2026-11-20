import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchCardsAcrossWorkspaces } from '../app_front/features/car/carDecisions.js';
import { buildAgentList } from '../app_front/features/car/orchestratorModel.js';

const workspaces = [
  { name: 'Shop', workspaceFile: '/w/shop.code-workspace', workspaceDir: '/w/shop' },
  { name: 'Blog', workspaceFile: '/w/blog.code-workspace', workspaceDir: '/w/blog' },
];
const card = (id, folder, chatId) => ({ id, status: 'pending', revision: 1, workspaceFolder: folder, subject: { chatId }, title: id });

function makeFetch(byFolder, failing = new Set()) {
  const queries = [];
  const fetchJson = async (query) => {
    queries.push(query);
    const folder = decodeURIComponent((query.match(/workspaceFolder=([^&]+)/) || [])[1] || '/w/shop');
    if (failing.has(folder)) throw new Error('HTTP 500');
    return { items: byFolder[folder] || [] };
  };
  return { fetchJson, queries };
}

test('CAR5: cards of every workspace are fetched, and an idle agent elsewhere shows needs_decision first', async () => {
  const { fetchJson, queries } = makeFetch({ '/w/shop': [], '/w/blog': [card('k1', '/w/blog', 'b')] });
  const { cards, ok } = await fetchCardsAcrossWorkspaces({
    fetchJson, currentQuery: '?workspaceFolder=%2Fw%2Fshop', currentFolder: '/w/shop', workspaces,
  });
  assert.equal(ok, true);
  assert.equal(queries.length, 2, 'the current workspace is not fetched twice');
  assert.deepEqual(cards.map((c) => c.id), ['k1']);
  const chats = [
    { id: 'a', title: 'Shop agent', workspaceFile: '/w/shop.code-workspace' },
    { id: 'b', title: 'Blog agent', workspaceFile: '/w/blog.code-workspace' },
  ];
  const rows = buildAgentList({ chats, workspaces, states: { a: { state: 'busy' } }, cards });
  assert.equal(rows[0].chatId, 'b');
  assert.equal(rows[0].status, 'needs_decision');
});

test('CAR11: one failing workspace keeps the other cards and reports the data as not fresh', async () => {
  const { fetchJson } = makeFetch({ '/w/shop': [card('k1', '/w/shop', 'a')] }, new Set(['/w/blog']));
  const partial = await fetchCardsAcrossWorkspaces({
    fetchJson, currentQuery: '?workspaceFolder=%2Fw%2Fshop', currentFolder: '/w/shop', workspaces,
  });
  assert.equal(partial.ok, false);
  assert.deepEqual(partial.cards.map((c) => c.id), ['k1']);
  const allFailing = makeFetch({}, new Set(['/w/shop', '/w/blog']));
  const none = await fetchCardsAcrossWorkspaces({
    fetchJson: allFailing.fetchJson, currentQuery: '?workspaceFolder=%2Fw%2Fshop', currentFolder: '/w/shop', workspaces,
  });
  assert.equal(none.ok, false);
  assert.deepEqual(none.cards, []);
});

test('duplicate cards and decided cards are dropped', async () => {
  const dup = card('k1', '/w/shop', 'a');
  const { fetchJson } = makeFetch({ '/w/shop': [dup, { ...dup, status: 'decided', id: 'k2' }], '/w/blog': [dup] });
  const { cards } = await fetchCardsAcrossWorkspaces({
    fetchJson, currentQuery: '?workspaceFolder=%2Fw%2Fshop', currentFolder: '/w/shop', workspaces,
  });
  assert.deepEqual(cards.map((c) => c.id), ['k1']);
});

test('CAR5: fetches the last decision workspace beyond twelve with bounded concurrency', async () => {
  const list = Array.from({ length: 15 }, (_, i) => ({ workspaceDir: `/w/${i}` }));
  let active = 0;
  let peak = 0;
  const { cards, ok } = await fetchCardsAcrossWorkspaces({
    currentQuery: '?workspaceFolder=%2Fw%2Fcurrent', currentFolder: '/w/current', workspaces: list,
    fetchJson: async (query) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return { items: decodeURIComponent(query).includes('/w/14') ? [card('last-only', '/w/14', 'z')] : [] };
    },
  });
  assert.equal(ok, true);
  assert.ok(peak <= 4);
  assert.deepEqual(cards.map((item) => item.id), ['last-only']);
});

test('Docs proposals are touch-only even when a producer omits the humanOnly flag', async () => {
  const { buildCarChoice, createCarChoiceFlow, HUMAN_ONLY_KINDS } = await import('../app_front/features/car/carChoice.js');
  assert.ok(HUMAN_ONLY_KINDS.has('doc_proposal'));
  const proposal = { ...card('docs', '/w/shop', 'a'), kind: 'doc_proposal', options: [{ id: 'apply', label: 'Apply' }, { id: 'reject', label: 'Reject' }] };
  assert.equal(buildCarChoice(proposal, { source: 'voice' }).code, 'human_only');
  const flow = createCarChoiceFlow({ getCards: () => [proposal], submit: async () => ({ ok: true }) });
  assert.equal(flow.choose({ option: 'apply', source: 'touch' }).ok, true);
  assert.equal((await flow.confirm({ source: 'voice' })).code, 'human_only');
  assert.equal((await flow.confirm({ source: 'touch' })).ok, true);
});
