import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { proposalActions, proposalPreview, proposalStatusKey } from '../app_front/features/docs/docsProposalLogic.js';
import { createDocsApi } from '../app_front/core/api/docs.js';

const card = { id: 'p1', kind: 'doc_proposal', status: 'pending', revision: 1, subject: { docPath: 'one.md', chatId: 'chat' },
  evidence: [{ type: 'doc_diff', diff: '+ <script>alert(1)</script>', truncated: false }] };

test('approval actions require a human, pending card and idle controller; stale cards show their state', () => {
  assert.equal(proposalActions(card, true), true);
  for (const status of ['stale', 'deciding', 'decided']) assert.equal(proposalActions({ ...card, status }, true), false);
  assert.equal(proposalActions(card, false), false); assert.equal(proposalActions(card, true, true), false);
  assert.equal(proposalStatusKey({ ...card, status: 'stale' }), 'docs.proposals.stale');
  assert.equal(proposalStatusKey({ ...card, status: 'decided', optionId: 'apply' }), 'docs.proposals.applied');
  assert.equal(proposalStatusKey({ ...card, status: 'decided', optionId: 'reject' }), 'docs.proposals.rejected');
});

test('diff remains literal text and truncation is explicit for both server and view caps', () => {
  assert.equal(proposalPreview(card).text, '+ <script>alert(1)</script>');
  assert.equal(proposalPreview(card, 5).truncated, true);
  assert.equal(proposalPreview({ evidence: [{ type: 'doc_diff', diff: 'small', truncated: true }] }).truncated, true);
  const view = fs.readFileSync(new URL('../app_front/features/docs/cr-doc-proposals.js', import.meta.url), 'utf8');
  assert.match(view, /<pre>\$\{preview.text\}<\/pre>/); assert.doesNotMatch(view, /innerHTML|unsafeHTML/);
  assert.match(view, /docs.proposals.truncated/); assert.match(view, /card.proposal.text/);
});

test('approval API uses existing decision route with captured workspace, CAS revision and opened details', async () => {
  const calls = [];
  const scope = { workspaceFolder: '/example', workspaceId: 'ws' };
  const api = createDocsApi(scope, async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ ok: true, items: [] }) }; });
  scope.workspaceId = 'forged';
  await api.proposals(); await api.resolveProposal(card, 'apply'); await api.resolveProposal(card, 'reject');
  assert.match(calls[0].url, /\/api\/docs\/proposals\?/);
  for (const call of calls.slice(1)) {
    assert.match(call.url, /\/api\/decisions\/p1\?/);
    const body = JSON.parse(call.options.body);
    assert.equal(body.workspaceId, 'ws'); assert.equal(body.expectedRevision, 1); assert.equal(body.detailsOpened, true);
  }
});

// Exercise actual async component methods without mounting a browser DOM.
const source = fs.readFileSync(new URL('../app_front/features/docs/cr-doc-proposals.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
globalThis.__proposalDeps = { proposalActions, proposalPreview, proposalStatusKey };
const prelude = `const { proposalActions, proposalPreview, proposalStatusKey } = globalThis.__proposalDeps;
const LitElement = class { dispatchEvent() {} }; const CustomEvent = class {};
const html = () => ''; const css = () => ''; const nothing = ''; const t = (key) => key;
const customElements = { get: () => true };`;
const { CrDocProposals } = await import(`data:text/javascript;base64,${Buffer.from(prelude + source).toString('base64')}`);
delete globalThis.__proposalDeps;
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

test('approval controller prevents duplicate submits and refreshes stale cards after 409', async () => {
  const pending = deferred(); let calls = 0;
  const view = new CrDocProposals(); view.human = true; view.items = [card];
  view.api = { resolveProposal: async () => { calls++; await pending.promise; throw Object.assign(new Error(), { status: 409 }); },
    proposals: async () => ({ items: [{ ...card, status: 'stale' }] }) };
  const first = view.resolve(card, 'apply'); await view.resolve(card, 'apply');
  assert.equal(calls, 1); pending.resolve(); await first;
  assert.equal(view.items[0].status, 'stale'); assert.equal(view.busy, false);
  assert.equal(view.error, 'docs.proposals.stale');
});

test('workspace switch ignores late list responses and agent views never load proposals', async () => {
  const pending = deferred(); const view = new CrDocProposals(); view.human = true;
  view.api = { proposals: () => pending.promise }; const old = view.reload();
  view.api = { proposals: async () => ({ items: [{ ...card, id: 'new' }] }) }; await view.reload();
  pending.resolve({ items: [card] }); await old; assert.equal(view.items[0].id, 'new');
  view.human = false; view.api = { proposals: () => { throw new Error('must not load'); } };
  await view.reload(); assert.deepEqual(view.items, []);
});
