import assert from 'node:assert/strict';
import http from 'node:http';
import { CretliApiClient, CretliApiError, findChatByRef } from '../lib/remote-api-client.js';

const CHATS = [
  { id: 'aaaaaaaa-1111-2222-3333-444444444444', title: 'Fix widget', workspaceFolder: '/tmp/w1' },
  { id: 'bbbbbbbb-1111-2222-3333-444444444444', title: 'Widget harnes', workspaceFolder: '/tmp/w2' },
  { id: 'cccccccc-1111-2222-3333-444444444444', title: 'Unrelated', workspaceFolder: '/tmp/w3', archivedAt: '2026-09-01T00:00:00Z' },
];

const server = http.createServer((req, res) => {
  assert.equal(req.headers['x-cretli-agent'], '1', 'HTTP tooling identifies its restricted agent channel, including login');
  const cookie = req.headers.cookie || '';
  const url = new URL(req.url, 'http://localhost');
  const reply = (status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'POST' && url.pathname === '/api/login') {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      if (body.password !== 'good') return reply(401, { ok: false, error: 'Invalid password' });
      reply(200, { ok: true, csrfToken: 'csrf456' }, {
        'Set-Cookie': 'cr_session=tok123; Path=/; HttpOnly',
      });
    });
    return;
  }
  // Simulate an expired session: any request with the stale cookie gets 401
  // once, then the client is expected to re-login and retry.
  if (cookie === 'cr_session=expired') return reply(401, { ok: false, error: 'Unauthorized' });
  if (cookie !== 'cr_session=tok123') return reply(401, { ok: false, error: 'Unauthorized' });
  if (req.method === 'POST' && url.pathname === '/api/todos/session-todo/plan-reviewer-session') {
    if (req.headers['x-cretli-csrf'] !== 'csrf456') return reply(403, { ok: false, error: 'CSRF' });
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => reply(200, { ok: true, session: { id: 'revision-session' }, saved: JSON.parse(raw) }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/chats/meta-chat/delegations') {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => reply(200, { ok: true, saved: JSON.parse(raw) }));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/chats') {
    const includeArchived = url.searchParams.get('includeArchived') === '1';
    return reply(200, {
      ok: true,
      chats: CHATS.filter((chat) => includeArchived || !chat.archivedAt),
    });
  }
  if (req.method === 'GET' && url.pathname.endsWith('/history')) {
    return reply(200, { ok: true, headSeq: 10, events: [{ seq: 10, rec: { kind: 'localUser', text: 'hi' } }] });
  }
  if (req.method === 'GET' && url.pathname === '/api/workspace-watcher') {
    return reply(200, { ok: true, watcher: { mode: 'off' }, snapshot: {}, guardrails: {} });
  }
  if (req.method === 'POST' && url.pathname === '/api/workspace-watcher/scout') {
    if (req.headers['x-cretli-csrf'] !== 'csrf456') return reply(403, { ok: false, error: 'CSRF' });
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      reply(200, { ok: true, saved: body, action: body.action });
    });
    return;
  }
  if (req.method === 'POST' && ['/api/workspace-watcher/save-plan', '/api/workspace-watcher/claim-next', '/api/workspace-watcher/report'].includes(url.pathname)) {
    if (req.headers['x-cretli-csrf'] !== 'csrf456') return reply(403, { ok: false, error: 'CSRF' });
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      if (url.pathname === '/api/workspace-watcher/report') {
        if (body.outcome === 'denied') {
          return reply(403, { ok: false, reason: 'not_orchestrator', cwd: body.workspaceFolder });
        }
        if (body.cycleId === 'missing-cycle') {
          return reply(404, { ok: false, reason: 'no_cycle', cwd: body.workspaceFolder });
        }
        if (body.cycleId === 'mismatch-cycle') {
          return reply(403, { ok: false, reason: 'cycle_mismatch', cwd: body.workspaceFolder });
        }
      }
      if (url.pathname === '/api/workspace-watcher/claim-next') {
        const sourceChatId = String(body.sourceChatId || '').trim();
        const claimedByChatId = String(body.claimedByChatId || '').trim();
        if (sourceChatId && claimedByChatId && sourceChatId !== claimedByChatId) {
          return reply(403, { ok: false, reason: 'claim_owner_forbidden', cwd: body.workspaceFolder });
        }
      }
      reply(200, { ok: true, saved: body });
    });
    return;
  }
  if (req.method === 'PATCH') {
    if (req.headers['x-cretli-csrf'] !== 'csrf456') return reply(403, { ok: false, error: 'CSRF' });
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const id = url.pathname.split('/').pop();
      const item = { id, ...JSON.parse(raw || '{}') };
      reply(200, { ok: true, chat: item, item });
    });
    return;
  }
  if (req.method === 'DELETE') {
    if (req.headers['x-cretli-csrf'] !== 'csrf456') return reply(403, { ok: false, error: 'CSRF' });
    return reply(200, { ok: true });
  }
  reply(404, { ok: false, error: 'Not found' });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;

try {
  const client = new CretliApiClient({ baseUrl, password: 'good' });

  // Login on demand, then authorized requests carry cookie + CSRF.
  const chats = await client.listChats();
  assert.equal(chats.length, 2);
  const draftInput = {
    action: 'save_plan', workspaceFolder: '/tmp/w1', todoId: 'todo-1',
    expectedUpdatedAt: 'revision-1', planMarkdown: '# Remote draft', sourceChatId: 'chat-1',
  };
  const draft = await client.workspaceWatcherUpdate(draftInput);
  const { action: _action, ...draftBody } = draftInput;
  assert.deepEqual(draft.saved, draftBody);
  const claimRequest = await client.workspaceWatcherUpdate({ action: 'claim_next', workspaceFolder: '/tmp/w1', claimedByChatId: 'claim-owner', ttlMs: 1000 });
  assert.deepEqual(claimRequest.saved, { workspaceFolder: '/tmp/w1', claimedByChatId: 'claim-owner', ttlMs: 1000 });
  const foreignClaim = await client.workspaceWatcherUpdate({
    action: 'claim_next',
    workspaceFolder: '/tmp/w1',
    sourceChatId: 'chat-owner',
    claimedByChatId: 'chat-foreign',
    ttlMs: 1000,
  });
  assert.equal(foreignClaim.ok, false);
  assert.equal(foreignClaim.reason, 'claim_owner_forbidden');
  assert.equal(foreignClaim.cwd, '/tmp/w1');
  const reportRequest = await client.workspaceWatcherUpdate({
    action: 'report', workspaceFolder: '/tmp/w1', sourceChatId: 'chat-1', outcome: 'success',
    cycleId: 'cycle-1', reportId: 'report-1', todoIds: ['todo-1'], message: 'done',
  });
  assert.deepEqual(reportRequest.saved, {
    workspaceFolder: '/tmp/w1', sourceChatId: 'chat-1', outcome: 'success',
    cycleId: 'cycle-1', reportId: 'report-1', todoIds: ['todo-1'], message: 'done',
  });
  const foreignReport = await client.workspaceWatcherUpdate({
    action: 'report',
    workspaceFolder: '/tmp/w1',
    sourceChatId: 'chat-foreign',
    outcome: 'denied',
    cycleId: 'cycle-1',
  });
  assert.equal(foreignReport.ok, false);
  assert.equal(foreignReport.reason, 'not_orchestrator');
  assert.ok(foreignReport.view?.watcher, 'soft denial still loads the watcher view');
  const noCycleReport = await client.workspaceWatcherUpdate({
    action: 'report',
    workspaceFolder: '/tmp/w1',
    sourceChatId: 'chat-1',
    outcome: 'success',
    cycleId: 'missing-cycle',
  });
  assert.equal(noCycleReport.ok, false);
  assert.equal(noCycleReport.reason, 'no_cycle');
  const mismatchReport = await client.workspaceWatcherUpdate({
    action: 'report',
    workspaceFolder: '/tmp/w1',
    sourceChatId: 'chat-1',
    outcome: 'success',
    cycleId: 'mismatch-cycle',
  });
  assert.equal(mismatchReport.ok, false);
  assert.equal(mismatchReport.reason, 'cycle_mismatch');
  const plan = { markdown: '# Todo draft', sourceChatId: 'chat-1' };
  const updatedTodo = await client.updateTodo({
    workspaceFolder: '/tmp/w1', todoId: 'todo-1', expectedUpdatedAt: 'revision-1', plan,
  });
  assert.deepEqual(updatedTodo.plan, plan);
  assert.equal(updatedTodo.expectedUpdatedAt, 'revision-1');
  assert.equal(client.sessionCookie, 'cr_session=tok123');
  assert.equal(client.csrfToken, 'csrf456');

  // includeArchived query reaches the server.
  const all = await client.listChats({ includeArchived: true });
  assert.equal(all.length, 3);

  // PATCH archives and sends the CSRF header.
  const archived = await client.archiveChat(CHATS[0].id, true);
  assert.equal(archived.archived, true);

  // DELETE works with the same session.
  const deleted = await client.deleteChat(CHATS[1].id);
  assert.equal(deleted.ok, true);

  // History tail passes the tail param through.
  const history = await client.getChatHistory(CHATS[0].id, { tail: 5 });
  assert.equal(history.headSeq, 10);

  // Expired session triggers a single re-login + retry.
  client.sessionCookie = 'cr_session=expired';
  const recovered = await client.listChats();
  assert.equal(recovered.length, 2);

  // Server errors surface as CretliApiError with the server message.
  const bad = new CretliApiClient({ baseUrl, password: 'wrong' });
  await assert.rejects(() => bad.listChats(), (err) => {
    assert.ok(err instanceof CretliApiError);
    assert.equal(err.status, 401);
    assert.equal(err.message, 'Invalid password');
    return true;
  });

  // findChatByRef: id prefix, title substring, ambiguity, no match.
  assert.equal(findChatByRef(CHATS, 'bbbb').chat.id, CHATS[1].id);
  assert.equal(findChatByRef(CHATS, 'unrelat').chat.id, CHATS[2].id);
  assert.equal(findChatByRef(CHATS, 'widget').matches.length, 2);
  assert.equal(findChatByRef(CHATS, 'nope').matches.length, 0);

  const scoutSubmit = await client.workspaceWatcherScout({
    workspaceFolder: '/tmp/w1',
    action: 'submit',
    sourceChatId: 'scout-chat-1',
    scanId: 'scan-remote-1',
    scoutSubmitToken: 'submit-tok-1',
    findings: [{ title: 'Remote scout finding', category: 'bug' }],
  });
  assert.equal(scoutSubmit.action, 'submit');
  assert.deepEqual(scoutSubmit.saved, {
    workspaceFolder: '/tmp/w1',
    action: 'submit',
    sourceChatId: 'scout-chat-1',
    scanId: 'scan-remote-1',
    scoutSubmitToken: 'submit-tok-1',
    findings: [{ title: 'Remote scout finding', category: 'bug' }],
  });

  for (const [phase, slot] of [['independent', 0], ['exchange', 2]]) {
    const snake = await client.startDelegation({
      chatId: 'meta-chat', workspaceFolder: '/tmp/w1', harness: 'h', model: 'm',
      plan_reviewer_session_id: 's1', plan_reviewer_phase: phase, plan_reviewer_slot: slot,
    });
    assert.equal(snake.saved.planReviewerSessionId, 's1');
    assert.equal(snake.saved.planReviewerPhase, phase);
    assert.equal(snake.saved.planReviewerSlot, slot);
  }
  for (const key of ['exchange_of_delegation_id', 'exchangeOfDelegationId', 'origin_delegation_id', 'originDelegationId']) {
    const ex = await client.startDelegation({
      chatId: 'meta-chat', workspaceFolder: '/tmp/w1', harness: 'h', model: 'm',
      planReviewerSessionId: 's1', planReviewerPhase: 'exchange', [key]: 'orig-1',
    });
    assert.equal(ex.saved.exchangeOfDelegationId, 'orig-1', key);
  }
  const camel = await client.startDelegation({
    chatId: 'meta-chat', workspaceFolder: '/tmp/w1', harness: 'h', model: 'm',
    planReviewerSessionId: 's2', planReviewerSlot: 0,
  });
  assert.equal(camel.saved.planReviewerSessionId, 's2');
  assert.equal(camel.saved.planReviewerSlot, 0);

  const preparedSession = await client.ensurePlanReviewerSession({
    todoId: 'session-todo', workspaceFolder: '/tmp/w1', coordinatorChatId: CHATS[0].id,
    cooperationMode: 'exchange',
  });
  assert.equal(preparedSession.session.id, 'revision-session');
  assert.deepEqual(preparedSession.saved, {
    workspaceFolder: '/tmp/w1', coordinatorChatId: CHATS[0].id,
    cooperationMode: 'exchange', reuseCurrentRevision: true,
  });
  console.log('remote-api-client.test.js OK');
} finally {
  server.close();
}

// Per-call budget: the first request and the 401 retry of a builtin
// delegation_verify call use the larger timeout; other tools keep 30 s.
{
  const { BRIDGE_VERIFY_TIMEOUT_MS } = await import('../lib/remote-api-client.js');
  const seen = [];
  const original = http.ClientRequest.prototype.setTimeout;
  http.ClientRequest.prototype.setTimeout = function patched(ms, ...rest) {
    seen.push({ path: this.path, ms });
    return original.call(this, ms, ...rest);
  };
  let calls = 0;
  const bridge = http.createServer((req, res) => {
    const reply = (status, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    req.resume();
    if (req.url === '/api/login') return reply(200, { ok: true, csrfToken: 'c' }, { 'Set-Cookie': 'cr_session=t; Path=/' });
    calls += 1;
    if (calls === 1) return reply(401, { ok: false, error: 'Unauthorized' });
    return reply(200, { ok: true });
  });
  await new Promise((resolve) => bridge.listen(0, '127.0.0.1', resolve));
  const client = new CretliApiClient({ baseUrl: `http://127.0.0.1:${bridge.address().port}`, password: 'good' });
  try {
    await client.callMcpBridgeTool('mcp__cretli_builtincretl__delegation_verify', {});
    const bridgeCalls = seen.filter((s) => s.path === '/api/mcp/bridge/call');
    assert.ok(bridgeCalls.length >= 2, 'first request and 401 retry both observed');
    assert.ok(bridgeCalls.every((s) => s.ms === BRIDGE_VERIFY_TIMEOUT_MS));
    assert.ok(seen.filter((s) => s.path === '/api/login').every((s) => s.ms === 30000));
    seen.length = 0;
    calls = 1;
    await client.callMcpBridgeTool('mcp__cretli_builtincretl__delegation_show', {});
    assert.ok(seen.filter((s) => s.path === '/api/mcp/bridge/call').every((s) => s.ms === 30000));
  } finally {
    http.ClientRequest.prototype.setTimeout = original;
    await new Promise((resolve) => bridge.close(resolve));
  }
}
