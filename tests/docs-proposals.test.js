import './helpers/isolated-data-dir.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { ISOLATED_DATA_DIR as dataDir } from './helpers/isolated-data-dir.js';
import { setPassword, createSession, getCsrfTokenForSessionToken, AUTH_CSRF_HEADER, requireAuth } from '../lib/auth.js';
import { mintMcpIntegrationToken } from '../lib/mcp/mcp-integration-token.js';
import { getDocsService } from '../lib/docs/docs-service.js';
import { DocsError, loadDocsState } from '../lib/docs/docs-state-store.js';
import { classifyDecision, getDecision, listDecisions, closeDecisionStores } from '../lib/decisions/decision-store.js';
import { MAX_CARD_BYTES, MAX_PENDING_WORKSPACE_BYTES } from '../lib/docs/docs-proposals.js';
import { requestDecision } from '../lib/decisions/decision-request.js';
import { installWidgetApiGate } from '../lib/widget/widget-http.ts';
import { registerDocsRoutes } from '../lib/routes/docs-routes.js';
import { registerDecisionsRoutes } from '../lib/routes/decisions-routes.js';
import { DOC_PROPOSAL_MCP_TOOLS } from '../lib/mcp/builtin/doc-tools.js';
import { BUILTIN_TOOLS } from '../lib/mcp/builtin/catalog.js';
import { DOC_OPS } from '../lib/docs/doc-ops.js';

const home = path.join(dataDir, 'workspace');
const root = path.join(home, 'docs');
const external = path.join(dataDir, 'external');
fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(external);
fs.writeFileSync(path.join(root, 'one.md'), '# Before\n');
fs.writeFileSync(path.join(external, 'one.md'), '# External');
const target = '12345678-abcd-4000-8000-123456789abc';
const svc = getDocsService(dataDir, { resolveScope: async (_dir, input) => {
  if (input.workspaceUuid !== 'ws' && input.workspaceId !== 'ws') throw new DocsError('workspace_required', 'Unknown workspace', 409);
  return { workspaceUuid: 'ws', homeFolder: home };
}, targetExists: async (_dir, _ws, _kind, id) => id === target });
setPassword('proposal-test');
function session(options) {
  const token = createSession(options);
  return { cookie: `cr_session=${token}`, [AUTH_CSRF_HEADER]: getCsrfTokenForSessionToken(token) };
}
const human = session(); const agent = session({ agentSession: true });
const bearer = { authorization: `Bearer ${mintMcpIntegrationToken({ sessionId: 'docs-proposal', chatId: 'source-chat', workspaceId: 'ws', workspaceFolder: home, harness: 'test', incarnation: 'docs-proposal' })}` };
const app = express(); app.use(express.json({ limit: '1mb' })); app.use(requireAuth);
installWidgetApiGate(app);
registerDocsRoutes(app, { dataDir }); registerDecisionsRoutes(app, { dataDir, getCurrentCwd: () => home });
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => { svc.close(); await closeDecisionStores(); await new Promise((r) => server.close(r)); });
const scope = { workspaceUuid: 'ws' };
async function call(url, body, headers = human, method = 'POST') {
  const res = await fetch(base + url, { method, headers: { ...headers, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: await res.json() };
}
const propose = async (kind, args, headers = bearer) => call(`/api/docs/proposals/${kind}?workspaceId=forged`, { ...args, workspaceId: 'forged', chatId: 'forged' }, headers);
const resolve = (card, optionId, headers = human, extra = {}) => call(`/api/decisions/${card.id}`, { workspaceFolder: home, expectedRevision: card.revision, optionId, detailsOpened: true, ...extra }, headers);
const bytes = () => fs.readFileSync(path.join(root, 'one.md'), 'utf8');

test('registry and generic decision_request cannot forge proposal cards', async () => {
  assert.deepEqual(classifyDecision('doc_proposal'), { risk: 'medium', reversible: false, humanOnly: true });
  assert.throws(() => classifyDecision('made_up'), /Unknown decision kind/);
  await assert.rejects(requestDecision(dataDir, { kind: 'doc_proposal' }), (e) => e.code === 'OUT_OF_SCOPE');
});

test('proposal tools are registered, mutating, scoped, and never write files or links', async () => {
  assert.deepEqual(DOC_PROPOSAL_MCP_TOOLS.map((t) => t.name), ['doc_propose_write', 'doc_propose_append', 'doc_propose_link']);
  for (const tool of DOC_PROPOSAL_MCP_TOOLS) {
    assert.equal(tool.readOnly, false); assert.ok(BUILTIN_TOOLS.includes(tool));
    let input;
    const prior = { bytes: bytes(), state: loadDocsState(dataDir) };
    await tool.handler({ path: 'one.md', text: 'x', target: `todo:${target}`, workspaceId: 'forged' }, {
      session: { workspaceId: 'ws', workspaceFolder: home, chatId: 'tool-chat' },
      client: { docRequest: async (request) => {
        input = request;
        return DOC_OPS[request.op].run(svc, request.scope, request.args, request.chatId);
      } },
    });
    assert.equal(input.scope.workspaceId, 'ws'); assert.equal(input.chatId, 'tool-chat');
    assert.equal(bytes(), prior.bytes); assert.deepEqual(loadDocsState(dataDir), prior.state);
    const http = DOC_OPS[input.op].http(input.args);
    assert.equal(http.method, 'POST'); assert.equal(http.body.workspaceId, undefined);
  }
});

test('agent-only endpoint binds workspace/chat claims and rejects cookie callers', async () => {
  for (const headers of [human, agent]) assert.equal((await propose('write', { path: 'one.md', text: 'x' }, headers)).status, 403);
  const unbound = { authorization: `Bearer ${mintMcpIntegrationToken({ sessionId: 'unbound-docs', chatId: 'source', harness: 'test', incarnation: 'unbound-docs' })}` };
  assert.equal((await propose('write', { path: 'one.md', text: 'x' }, unbound)).status, 403);
  const result = await propose('write', { path: 'one.md', text: '# After\n' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const card = result.body.decision;
  assert.equal(card.proposal.workspaceUuid, 'ws'); assert.equal(card.subject.chatId, 'source-chat');
  assert.equal(card.recommended, 'reject'); assert.equal(card.onTimeout, 'nothing'); assert.equal(card.otherOption, null);
  assert.match(card.evidence[0].diff, /-# Before/); assert.match(card.evidence[0].diff, /\+# After/);
  assert.equal(bytes(), '# Before\n');
  for (const headers of [agent, bearer]) assert.equal((await resolve(card, 'apply', headers)).status, 403);
  assert.equal((await resolve(card, 'apply', human, { gesture: true })).status, 403);
  assert.equal((await resolve(card, 'apply')).status, 200);
  assert.equal(bytes(), '# After\n');
  assert.equal((await resolve(card, 'apply')).status, 409); assert.equal(bytes(), '# After\n');
  const saved = await getDecision(dataDir, card.id);
  assert.equal(saved.decidedBy.kind, 'human-session'); assert.ok(saved.decidedAt);
  assert.equal(saved.response.proposingChatId, 'source-chat');
  assert.match(fs.readFileSync(path.join(dataDir, 'approvals', 'decisions-audit.jsonl'), 'utf8'), /doc_proposal/);
});

test('append approval applies exact text; rejection touches neither file nor state', async () => {
  const before = bytes(); const state = loadDocsState(dataDir);
  const rejected = (await propose('append', { path: 'one.md', text: 'Rejected' })).body.decision;
  assert.equal((await resolve(rejected, 'reject')).status, 200);
  assert.equal(bytes(), before); assert.deepEqual(loadDocsState(dataDir), state);
  const card = (await propose('append', { path: 'one.md', text: '\nExact suffix\n' })).body.decision;
  assert.equal((await resolve(card, 'apply')).status, 200);
  assert.equal(bytes(), before + '\nExact suffix\n');
  assert.equal((await resolve(card, 'apply')).status, 409); assert.equal(bytes(), before + '\nExact suffix\n');
});

test('external edit, deleted note and root change make cards stale without writing', async () => {
  const card = (await propose('write', { path: 'one.md', text: 'Overwrite' })).body.decision;
  fs.writeFileSync(path.join(root, 'one.md'), 'External edit');
  assert.equal((await resolve(card, 'apply')).status, 409);
  assert.equal((await getDecision(dataDir, card.id)).status, 'stale'); assert.equal(bytes(), 'External edit');
  const deleted = (await propose('append', { path: 'one.md', text: 'No' })).body.decision;
  fs.unlinkSync(path.join(root, 'one.md'));
  assert.equal((await resolve(deleted, 'apply')).status, 409); assert.equal(fs.existsSync(path.join(root, 'one.md')), false);
  fs.writeFileSync(path.join(root, 'one.md'), 'Restored');
  const moved = (await propose('write', { path: 'one.md', text: 'No' })).body.decision;
  await svc.setConfig(scope, { root: external }, 'human'); await svc.consent(scope, { agentRead: true }, 'human');
  assert.equal((await resolve(moved, 'apply')).status, 409);
  assert.equal(fs.readFileSync(path.join(external, 'one.md'), 'utf8'), '# External');
  await svc.setConfig(scope, { root: 'docs' }, 'human');
});

test('link proposals preserve state until approval and enforce store revision', async () => {
  const before = loadDocsState(dataDir); const text = bytes();
  const rejected = (await propose('link', { path: 'one.md', target: `todo:${target}` })).body.decision;
  assert.deepEqual(loadDocsState(dataDir), before);
  assert.equal((await resolve(rejected, 'reject')).status, 200); assert.deepEqual(loadDocsState(dataDir), before);
  const card = (await propose('link', { path: 'one.md', target: `todo:${target}` })).body.decision;
  assert.deepEqual(loadDocsState(dataDir), before);
  await svc.addLink(scope, { note: 'one.md', kind: 'todo', targetId: target }, 'human');
  const revision = loadDocsState(dataDir).workspaces.ws.revision;
  assert.equal((await resolve(card, 'apply')).status, 409);
  assert.equal(loadDocsState(dataDir).workspaces.ws.revision, revision);
  const link = (await svc.links(scope, { note: 'one.md' }, 'human')).items[0];
  await svc.changeLink(scope, { id: link.id }, 'human');
  const approved = (await propose('link', { path: 'one.md', target: `todo:${target}` })).body.decision;
  assert.equal((await resolve(approved, 'apply')).status, 200);
  const saved = loadDocsState(dataDir).workspaces.ws;
  assert.equal(saved.links.length, 1); assert.equal(saved.links[0].proposingChatId, 'source-chat');
  assert.equal(saved.links[0].decisionId, approved.id);
  assert.equal((await resolve(approved, 'apply')).status, 409); assert.deepEqual(loadDocsState(dataDir).workspaces.ws, saved);
  assert.equal(bytes(), text);
});

test('consent, agentRead, path validation and proposal size are enforced', async () => {
  assert.equal((await propose('write', { path: '../escape.md', text: 'x' })).status, 400);
  assert.equal((await propose('write', { path: 'one.md', text: 'x'.repeat(128 * 1024 + 1) })).status, 413);
  assert.equal((await propose('append', { path: 'one.md', text: 'x'.repeat(128 * 1024) })).status, 413);
  await svc.setConfig(scope, { root: external }, 'human');
  assert.equal((await propose('write', { path: 'one.md', text: 'x' })).body.code, 'docs-consent-required');
  await svc.consent(scope, { agentRead: false }, 'human');
  assert.equal((await propose('write', { path: 'one.md', text: 'x' })).body.code, 'docs-agent-read-denied');
  await svc.consent(scope, { agentRead: true }, 'human');
  const card = (await propose('write', { path: 'one.md', text: 'x' })).body.decision;
  await svc.consent(scope, {}, 'human', true);
  assert.equal((await resolve(card, 'apply')).status, 409);
  await svc.setConfig(scope, { root: 'docs' }, 'human');
});

test('create proposals use exclusive creation; human listing exposes stale and audit history only', async () => {
  const card = (await propose('write', { path: 'new.md', text: '# New' })).body.decision;
  assert.equal(fs.existsSync(path.join(root, 'new.md')), false);
  assert.equal((await resolve(card, 'apply')).status, 200);
  assert.equal(fs.readFileSync(path.join(root, 'new.md'), 'utf8'), '# New');
  const stale = (await propose('append', { path: 'one.md', text: 'x' })).body.decision;
  fs.writeFileSync(path.join(root, 'one.md'), 'Changed again');
  const list = await call('/api/docs/proposals?workspaceUuid=ws', undefined, human, 'GET');
  assert.equal(list.status, 200); assert.ok(list.body.items.some((c) => c.id === stale.id && c.status === 'stale'));
  assert.ok(list.body.items.some((c) => c.id === card.id && c.decidedBy.kind === 'human-session'));
  assert.equal((await call('/api/docs/proposals', undefined, bearer, 'GET')).status, 403);
});

test('missing payload is refused and a concurrent resolution applies once', async () => {
  const { executeDecision } = await import('../lib/decisions/decision-adapters.js');
  assert.deepEqual(await svc.resolveProposal({ producer: 'docs-service' }, 'apply', 'human'), { ok: false, reason: 'invalid_proposal' });
  const result = await executeDecision({ kind: 'doc_proposal' }, 'apply', dataDir);
  assert.equal(result.ok, false); assert.equal(result.reason, 'human_required');
  const before = bytes();
  const card = (await propose('append', { path: 'one.md', text: 'once' })).body.decision;
  const results = await Promise.all([resolve(card, 'apply'), resolve(card, 'apply')]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(bytes(), before + 'once');
});

test('real in-process and stdio clients expose proposal POST operations with immutable session scope', async () => {
  const { CretliApiClient } = await import('../lib/remote-api-client.js');
  const { createInProcessMcpClient } = await import('../lib/mcp/mcp-inprocess-client.js');
  const remote = new CretliApiClient({ baseUrl: base, bearerToken: bearer.authorization.slice(7) });
  const local = createInProcessMcpClient({ dataDir: () => dataDir });
  const before = bytes(); const state = loadDocsState(dataDir);
  for (const op of ['propose_write', 'propose_append', 'propose_link']) {
    const args = { path: 'one.md', text: '# Client proposal', target: `todo:${target}`, workspaceId: 'forged' };
    const result = await remote.docRequest({ op, scope: { workspaceId: 'forged' }, args });
    assert.equal(result.decision.proposal.workspaceUuid, 'ws'); assert.equal(result.decision.subject.chatId, 'source-chat');
    const direct = await local.docRequest({ op, scope: { workspaceId: 'ws' }, chatId: 'local-source', args });
    assert.equal(direct.decision.subject.chatId, 'local-source');
    assert.equal(bytes(), before); assert.deepEqual(loadDocsState(dataDir), state);
  }
});

test('N4: concurrent duplicates create one card; full changes, kinds and base hashes distinguish proposals', async () => {
  const submit = (args) => svc.propose(scope, args, 'agent', 'dedupe-chat');
  const args = { kind: 'write', path: 'one.md', text: 'deduped' };
  const results = await Promise.allSettled([submit(args), submit(args)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'docs-proposal-duplicate');
  await assert.rejects(submit(args), (e) => e.code === 'docs-proposal-duplicate' && !e.message.includes('one.md'));
  // Changes beyond the displayed diff must still produce distinct hashes.
  for (const suffix of ['A', 'B']) await submit({ ...args, text: 'x'.repeat(30 * 1024) + suffix });
  const append = await submit({ kind: 'append', path: 'one.md', text: '' });
  await submit({ ...args, text: bytes() });
  await submit({ kind: 'link', path: 'one.md', target: `todo:${target}` });
  await assert.rejects(submit({ kind: 'link', path: 'one.md', target: `todo:${target}` }), (e) => e.code === 'docs-proposal-duplicate');
  const before = bytes();
  fs.writeFileSync(path.join(root, 'one.md'), before + 'new base');
  try {
    const changed = await submit(args);
    assert.notEqual(changed.decision.proposal.baseSha256, append.decision.proposal.baseSha256);
  } finally { fs.writeFileSync(path.join(root, 'one.md'), before); }
});

test('N4: concurrent calls respect 20 per workspace/chat; human rejection frees capacity', async () => {
  const submit = (i, chat = 'capacity-chat', ws = scope) => svc.propose(ws, { kind: 'write', path: 'one.md', text: `capacity-${i}` }, 'agent', chat);
  const results = await Promise.allSettled(Array.from({ length: 22 }, (_, i) => submit(i)));
  const cards = results.filter((r) => r.status === 'fulfilled').map((r) => r.value.decision);
  assert.equal(cards.length, 20);
  for (const result of results.filter((r) => r.status === 'rejected')) {
    assert.equal(result.reason.code, 'docs-proposal-limit'); assert.doesNotMatch(result.reason.message, /one\.md|workspace\//);
  }
  await submit(100, 'other-capacity-chat');
  assert.equal((await resolve(cards[0], 'reject')).status, 200);
  await submit(101);
  const { createDocsProposals } = await import('../lib/docs/docs-proposals.js');
  // A second workspace can share a physical root without sharing its chat quota.
  const other = createDocsProposals({ dataDir, scope: async () => ({ workspaceUuid: 'other-ws', homeFolder: home }),
    access: () => ({ root: { realpath: root }, state: {} }), stateFor: () => ({}), targetExists: async () => true, invalidate: () => {} });
  await other.propose({}, { kind: 'write', path: 'one.md', text: 'other workspace' }, 'agent', 'capacity-chat');
});

test('N5/R1A1-R1: note, metadata and card byte limits have distinct errors', async () => {
  const text = '\n"\\'.repeat(5 * 1024);
  const card = (await svc.propose(scope, { kind: 'write', path: 'escaped.md', text }, 'agent', 'size-chat')).decision;
  const stored = await getDecision(dataDir, card.id);
  assert.ok(Buffer.byteLength(JSON.stringify(stored)) <= MAX_CARD_BYTES);
  await assert.rejects(svc.propose(scope, { kind: 'write', path: 'escaped.md', text }, 'agent', 'size-chat'), (e) => e.code === 'docs-proposal-duplicate');
  assert.equal((await resolve(card, 'apply')).status, 200);
  assert.equal(fs.readFileSync(path.join(root, 'escaped.md'), 'utf8'), text);
  for (const largeText of ['\n"\\'.repeat(34 * 1024), '\u0001'.repeat(128 * 1024), 'é'.repeat(64 * 1024)]) {
    assert.ok(Buffer.byteLength(largeText) <= 128 * 1024);
    await assert.rejects(svc.propose(scope, { kind: 'write', path: 'large.md', text: largeText }, 'agent', 'size-chat'),
      (e) => e.code === 'docs-proposal-card-too-large' && e.status === 413 && /48 KiB/.test(e.message) && !e.message.includes('large.md'));
  }
  await assert.rejects(svc.propose(scope, { kind: 'write', path: 'too-large.md', text: 'é'.repeat(64 * 1024) + 'x' }, 'agent', 'size-chat'),
    (e) => e.status === 413 && /Note exceeds 128 KiB/.test(e.message));
  await assert.rejects(svc.propose(scope, { kind: 'write', path: 'one.md', text: '' }, 'agent', 'm'.repeat(5 * 1024)),
    (e) => e.code === 'docs-proposal-metadata-too-large' && /metadata exceeds 4 KiB/.test(e.message));
});

test('N5: generated diff respects the byte bound for multibyte text', async () => {
  const { proposalDiff } = await import('../lib/docs/docs-proposals.js');
  const evidence = proposalDiff('one.md', '界'.repeat(43 * 1024), '');
  assert.ok(Buffer.byteLength(evidence.diff) <= 128 * 1024);
  assert.equal(evidence.truncated, true);
});

test('R1A1-R1: concurrent chats share the workspace byte budget; listing and human rejection remain usable', async () => {
  const submit = (i) => svc.propose(scope, { kind: 'write', path: `budget-${i}.md`, text: 'x'.repeat(40 * 1024) }, 'agent', `budget-chat-${i}`);
  const results = await Promise.allSettled(Array.from({ length: 32 }, (_, i) => submit(i)));
  const cards = results.filter((r) => r.status === 'fulfilled').map((r) => r.value.decision);
  assert.ok(cards.length >= 20 && cards.length < 32);
  for (const { reason } of results.filter((r) => r.status === 'rejected')) {
    assert.equal(reason.code, 'docs-proposal-workspace-limit'); assert.equal(reason.status, 429);
    assert.match(reason.message, /1 MiB workspace budget/); assert.doesNotMatch(reason.message, /budget-\d+\.md/);
  }
  for (const card of cards) {
    const stored = await getDecision(dataDir, card.id);
    const size = Buffer.byteLength(JSON.stringify(stored));
    assert.ok(size > 40 * 1024 && size <= MAX_CARD_BYTES);
    assert.equal(stored.evidence[0].truncated, true);
    assert.equal(stored.proposal.text.length, 40 * 1024, 'full proposed text is retained');
  }
  const pendingBytes = (await listDecisions(dataDir, home)).filter((c) => c.kind === 'doc_proposal'
    && c.proposal.workspaceUuid === 'ws' && ['pending', 'deciding'].includes(c.status))
    .reduce((sum, c) => sum + Buffer.byteLength(JSON.stringify(c)), 0);
  assert.ok(pendingBytes <= MAX_PENDING_WORKSPACE_BYTES && pendingBytes < 1.5 * 1024 * 1024);
  const listed = await call('/api/docs/proposals?workspaceUuid=ws', undefined, human, 'GET');
  assert.equal(listed.status, 200); assert.ok(listed.body.items.some((c) => c.id === cards[0].id));
  assert.equal((await resolve(cards[0], 'reject')).status, 200);
  const decided = await getDecision(dataDir, cards[0].id);
  assert.equal(decided.status, 'decided'); assert.ok(Buffer.byteLength(JSON.stringify(decided)) <= MAX_CARD_BYTES);
  await submit(100);
  assert.equal((await call('/api/docs/proposals?workspaceUuid=ws', undefined, human, 'GET')).status, 200);
});
