import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';
import {
  OPERATOR_STATES, findOperatorChat, handleOperatorOwnerSend, isOperatorChat, operatorChatActions, operatorChipModel,
  onOperatorStatusChange, refreshOperatorStatus, renderOperatorSectionHtml, resetOperatorStatusForTests, getOperatorStatus,
} from '../app_front/features/chat/operatorChat.js';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const tr = (dict) => (key, params = {}) => String(key.split('.').reduce((node, part) => node?.[part], dict) ?? `MISSING:${key}`).replace(/\{(\w+)\}/g, (_m, name) => String(params[name]));

test('i18n: pl and en carry the same operatorChat keys and every chip state', () => {
  const keys = (dict) => Object.keys(dict.operatorChat).sort();
  assert.deepEqual(keys(pl), keys(en));
  assert.deepEqual(Object.keys(pl.operatorChat.state).sort(), Object.keys(en.operatorChat.state).sort());
  for (const state of OPERATOR_STATES) {
    for (const dict of [en, pl]) assert.ok(dict.operatorChat.state[state], `state ${state}`);
  }
  assert.match(pl.operatorChat.state.queued, /\{count\}/);
  assert.match(en.operatorChat.state.queued, /\{count\}/);
});

test('the owner thread is recognised only by the server flag and has no archive action', () => {
  assert.equal(isOperatorChat({ operatorChat: true }), true);
  assert.equal(isOperatorChat({ operatorChat: 'true' }), false);
  assert.equal(isOperatorChat({ title: 'Operator' }), false);
  assert.deepEqual(operatorChatActions({ operatorChat: true }), { archive: false, remove: false });
  assert.deepEqual(operatorChatActions({ id: 'x' }), { archive: true, remove: true });
  assert.equal(findOperatorChat([{ id: 'a' }, { id: 'b', operatorChat: true }]).id, 'b');
  assert.equal(findOperatorChat([{ id: 'b', operatorChat: true, archivedAt: '2026-01-01' }]), null);
});

test('state chip: every state and the queue counter, in both languages', () => {
  const labels = (dict) => OPERATOR_STATES.map((state) => operatorChipModel({ state, queued: 3 }, tr(dict)).label);
  assert.deepEqual(labels(en), ['running', 'queued 3', 'idle', 'paused', 'budget', 'off']);
  assert.deepEqual(labels(pl), ['w toku', 'w kolejce 3', 'bezczynny', 'wstrzymany', 'budżet', 'wyłączony']);
  assert.equal(operatorChipModel(null, tr(en)).state, 'idle');
  assert.equal(operatorChipModel({ state: 'bogus' }, tr(en)).state, 'idle');
});

test('pinned section: badge, chip, active row, no archive/delete control, escaped', () => {
  const html = renderOperatorSectionHtml({ chat: { id: 'c"1' }, status: { state: 'paused' }, activeChatId: 'c"1', escapeHtml: esc, translate: tr(en) });
  assert.match(html, /sidebar-operator-section/);
  assert.match(html, /sidebar-operator-badge">Operator</);
  assert.match(html, /data-operator-state="paused">paused</);
  assert.match(html, /data-pinned-chat-id="c&quot;1"/);
  assert.match(html, /is-active/);
  assert.doesNotMatch(html, /<button|sidebar-chat-archive-btn|sidebar-chat-delete-btn|trash/);
  assert.equal(renderOperatorSectionHtml({ chat: null, escapeHtml: esc }), '');
});

test('owner message goes to the human route; a refusal is shown in the thread', async () => {
  const calls = [];
  const notices = [];
  const chat = { id: 'c1', operatorChat: true, _sdkRichView: { appendMetaNotice: (text) => notices.push(text) } };
  const ok = await handleOperatorOwnerSend(chat, '  hello  ', { translate: tr(en), fetchJson: async (url, init) => { calls.push([url, init]); return { ok: true }; } });
  assert.equal(ok, true);
  assert.equal(calls[0][0], '/api/operator/internal/message');
  assert.equal(calls[0][1].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0][1].body), { text: 'hello', source: 'ui' });
  assert.equal(await handleOperatorOwnerSend(chat, '   ', { fetchJson: async () => ({ ok: true }) }), false);
  assert.equal(await handleOperatorOwnerSend(chat, 'x', { translate: tr(en), fetchJson: async () => ({ ok: false, error: 'operator_disabled' }) }), false);
  assert.equal(await handleOperatorOwnerSend(chat, 'x', { translate: tr(pl), fetchJson: async () => { throw new Error('net'); } }), false);
  assert.deepEqual(notices, [en.operatorChat.disabled, pl.operatorChat.sendFailed]);
});

test('status store: refreshed when stale, notifies on change only, keeps the last value on failure', async () => {
  resetOperatorStatusForTests();
  let changes = 0;
  onOperatorStatusChange(() => { changes += 1; });
  let reads = 0;
  const fetchJson = async () => { reads += 1; return { ok: true, state: 'idle' }; };
  await refreshOperatorStatus({ now: 1_000_000, fetchJson });
  await refreshOperatorStatus({ now: 1_005_000, fetchJson });
  assert.equal(reads, 1);
  await refreshOperatorStatus({ now: 1_030_000, fetchJson });
  assert.equal(reads, 2);
  assert.equal(changes, 1);
  await refreshOperatorStatus({ now: 1_100_000, fetchJson: async () => { throw new Error('403'); } });
  assert.equal(getOperatorStatus().state, 'idle');
  resetOperatorStatusForTests();
});

test('wiring: the sidebar hides the thread from regular lists and the send/archive paths know it', () => {
  const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  assert.match(read('app_front/features/sidebar/services/sidebarSearchService.js'), /operatorChat !== true/);
  assert.match(read('app_front/features/chat/services/chatSendHandlers.js'), /isOperatorChat\(chat\)/);
  assert.match(read('app_front/features/chat/services/chatDeleteArchive.js'), /operatorChatActions/);
  assert.match(read('app_front/features/sidebar/views/sidebarRender.js'), /applyOperatorSection/);
  assert.match(read('app_front/features/chat/chatListServerReconcile.js'), /operatorChat/);
});
