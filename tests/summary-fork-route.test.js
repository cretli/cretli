import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { appendChatHistoryEvents } from '../lib/persist/chat-history-persist.js';
import { loadChats, saveChats } from '../lib/persist/chats-persist.js';
import { SUMMARY_SECTIONS } from '../lib/context/history-summary.ts';
import { SUMMARY_FALLBACK } from '../lib/context/summary-fork.js';
import { registerChatsRoutes } from '../lib/routes/chats-routes.js';

function seedParent() {
  const id = randomUUID();
  saveChats([...loadChats(), {
    id, title: 'Big chat', cursorSessionId: `sess-${id}`, agentTransport: 'claude', model: 'm',
    workspaceFolder: '/tmp/ws', createdAt: new Date().toISOString(),
  }]);
  const parent = loadChats().find((row) => row.id === id);
  const events = [];
  for (let i = 1; i <= 4; i += 1) {
    events.push({ rec: { kind: 'localUser', text: `question ${i}` } });
    events.push({ rec: { kind: 'sdk', event: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `answer ${i}` }] } } } });
  }
  appendChatHistoryEvents(id, parent.cursorSessionId, events);
  return parent;
}

function validSummary(chatId) {
  const ref = `cretli-ref chat=${chatId} seq=1`;
  return [
    `## ${SUMMARY_SECTIONS.GOAL}`, `Ship the feature. ${ref}`, '',
    `## ${SUMMARY_SECTIONS.DECISIONS}`, `- Use the cheap provider. ${ref}`, '',
    `## ${SUMMARY_SECTIONS.FILE_STATE_CHANGES}`, `- none. ${ref}`, '',
    `## ${SUMMARY_SECTIONS.OPEN_ITEMS}`, `- Tests. ${ref}`, '',
    `## ${SUMMARY_SECTIONS.EXACT_IDENTIFIERS}`, `- lib/x.js. ${ref}`,
  ].join('\n');
}

function post(summaryForkDeps, id) {
  const routes = new Map();
  registerChatsRoutes({ get() {}, post: (r, h) => routes.set(`POST ${r}`, h), patch() {}, put() {}, delete() {} }, { summaryForkDeps });
  const res = { statusCode: 200, body: null, status(c) { res.statusCode = c; return res; }, json(v) { res.body = v; return res; } };
  return routes.get('POST /api/chats/:id/fork-with-summary')({ params: { id }, body: {}, headers: {}, query: {} }, res).then(() => res);
}

const allow = () => ({ allowed: true });

test('success: reference chat whose first prompt is the rendered seed with cretli-ref pointers', async () => {
  const parent = seedParent();
  let calls = 0;
  const res = await post({
    checkGate: allow,
    getContextEpoch: () => 2,
    summarize: async () => { calls += 1; return validSummary(parent.id); },
  }, parent.id);
  assert.equal(res.statusCode, 200);
  assert.equal(calls, 1);
  assert.equal(res.body.summarized, true);
  assert.equal(res.body.summaryFallback, null);
  assert.equal(res.body.chat.forkKind, 'reference');
  assert.match(res.body.initialPrompt, /^# Resumed session \(compressed history\)/);
  assert.match(res.body.initialPrompt, new RegExp(`cretli-ref chat=${parent.id} seq=1`));
  assert.match(res.body.initialPrompt, new RegExp(`chat_history\\(\\{ chat: "${parent.id}" \\}\\)`));
});

test('provider failure falls back to a plain reference chat and reports the error', async () => {
  const parent = seedParent();
  const res = await post({
    checkGate: allow,
    getContextEpoch: () => 1,
    summarize: async () => { throw new Error('provider down'); },
  }, parent.id);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.summarized, false);
  assert.equal(res.body.summaryFallback.code, SUMMARY_FALLBACK.PROVIDER_ERROR);
  assert.match(res.body.summaryFallback.error, /provider down/);
  assert.equal(res.body.chat.forkKind, 'reference');
  assert.doesNotMatch(res.body.initialPrompt, /Resumed session \(compressed history\)/);
  assert.match(res.body.initialPrompt, new RegExp(`chat_history\\(\\{ chat: "${parent.id}" \\}\\)`));
});

test('an invalid summary answer also falls back without a summary', async () => {
  const parent = seedParent();
  const res = await post({ checkGate: allow, getContextEpoch: () => 1, summarize: async () => 'not structured' }, parent.id);
  assert.equal(res.body.summaryFallback.code, SUMMARY_FALLBACK.INVALID_SUMMARY);
  assert.equal(res.body.summarized, false);
});

test('contextEpoch changing during generation never seeds the stale summary', async () => {
  const parent = seedParent();
  let epoch = 1;
  const res = await post({
    checkGate: allow,
    getContextEpoch: () => epoch,
    summarize: async () => { epoch = 2; return validSummary(parent.id); },
  }, parent.id);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.summarized, false);
  assert.equal(res.body.summaryFallback.code, SUMMARY_FALLBACK.EPOCH_CHANGED);
  assert.doesNotMatch(res.body.initialPrompt, /Resumed session \(compressed history\)/);
  assert.doesNotMatch(res.body.initialPrompt, /Ship the feature/);
});

test('a closed gate makes no model call', async () => {
  const parent = seedParent();
  let calls = 0;
  const res = await post({
    checkGate: () => ({ allowed: false, reason: 'cache_warm' }),
    summarize: async () => { calls += 1; return ''; },
  }, parent.id);
  assert.equal(calls, 0);
  assert.equal(res.body.summaryFallback.code, SUMMARY_FALLBACK.GATE_BLOCKED);
});

test('unknown chat is 404', async () => {
  assert.equal((await post({}, randomUUID())).statusCode, 404);
});
