import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppToolHandlers, readActivePanelId } from '../app_front/features/voice/voiceAppTools.js';
import {
  capVoiceResult,
  resolveVoiceLanguage,
  resolveVoiceMicAction,
  resolveVoicePanel,
  resolveVoiceTheme,
} from '../app_front/features/voice/voiceAppMatch.js';
import { getVoiceAction } from '../lib/voice/action-registry.ts';

function makeDocument({ active = 'chat', hidden = [] } = {}) {
  const clicks = [];
  return {
    clicks,
    querySelector(selector) {
      if (selector === '.panel.active') return { id: `${active}-panel` };
      const match = /\.tab\[data-panel="(\w+)"\]/.exec(selector);
      if (!match) return null;
      const panel = match[1];
      if (['chat', 'git', 'files', 'tasks', 'github'].includes(panel) === false) return null;
      return { hidden: hidden.includes(panel), click: () => clicks.push(panel) };
    },
  };
}

function makeHandlers(overrides = {}) {
  const calls = { theme: [], lang: [], mic: [] };
  const doc = overrides.doc || makeDocument();
  const handlers = createAppToolHandlers({
    getDocument: () => doc,
    setTheme: (value) => calls.theme.push(value),
    getLang: () => calls.lang.at(-1) || 'en',
    setLang: (value) => { calls.lang.push(value); },
    getNotificationState: () => overrides.notifications ?? null,
    fetchScout: overrides.fetchScout || (async () => ({ status: 200, json: { findings: [], total: 0 } })),
    fetchHealth: overrides.fetchHealth || (async () => ({ harnesses: {} })),
    getConnection: () => ({ terminalStatus: 'connected', chatStatus: 'reconnecting' }),
    getActiveChat: () => overrides.chat ?? null,
    requestMicMute: (muted) => { calls.mic.push(muted); return overrides.micHandled !== false; },
  });
  return { handlers, calls, doc };
}

test('new tools are registered as safe family tools with an action enum', () => {
  for (const id of ['panel', 'app_settings', 'app_status']) {
    const action = getVoiceAction(id);
    assert.equal(action.risk, 'safe', id);
    assert.equal(action.group, 'app', id);
    assert.ok(action.required.includes('action'), id);
    assert.ok(Array.isArray(action.properties.action.enum), id);
  }
  assert.equal(getVoiceAction('panel').properties.panel.enum.length, 11);
});

test('panel names resolve from English and Polish speech with diacritics', () => {
  assert.equal(resolveVoicePanel('git'), 'git');
  assert.equal(resolveVoicePanel('panel plików'), 'files');
  assert.equal(resolveVoicePanel('Pliki'), 'files');
  assert.equal(resolveVoicePanel('przeglądarka'), 'browser');
  assert.equal(resolveVoicePanel('Przegladarke'), 'browser');
  assert.equal(resolveVoicePanel('zadania'), 'tasks');
  assert.equal(resolveVoicePanel('zadania todo'), 'todo');
  assert.equal(resolveVoicePanel('agentów'), '');
  assert.equal(resolveVoicePanel('agenci'), '');
  assert.equal(resolveVoicePanel('agent'), '');
  assert.equal(resolveVoicePanel('panel agent'), '');
  assert.equal(resolveVoicePanel('agent panel'), '');
  assert.equal(resolveVoicePanel('konsola'), 'terminal');
  assert.equal(resolveVoicePanel('dziennik'), 'logs');
  assert.equal(resolveVoicePanel('kuchnia'), '');
});

test('settings values resolve from spoken aliases', () => {
  assert.equal(resolveVoiceTheme('Ciemny'), 'dark');
  assert.equal(resolveVoiceTheme('jasny motyw'), 'light');
  assert.equal(resolveVoiceTheme('systemowy'), 'system');
  assert.equal(resolveVoiceTheme('fioletowy'), '');
  assert.equal(resolveVoiceLanguage('angielski'), 'en');
  assert.equal(resolveVoiceLanguage('po polsku'), 'pl');
  assert.equal(resolveVoiceLanguage('klingon'), '');
  assert.equal(resolveVoiceMicAction('wycisz'), 'mute');
  assert.equal(resolveVoiceMicAction('włącz'), 'unmute');
  assert.equal(resolveVoiceMicAction('unmute'), 'unmute');
});

test('mic mute verb+noun combinations resolve to the noun, not the verb', () => {
  assert.equal(resolveVoiceMicAction('włącz wyciszenie'), 'mute');
  assert.equal(resolveVoiceMicAction('wyłącz wyciszenie'), 'unmute');
  assert.equal(resolveVoiceMicAction('włącz mikrofon'), 'unmute');
  assert.equal(resolveVoiceMicAction('wyłącz mikrofon'), 'mute');
  assert.equal(resolveVoiceMicAction('wycisz mikrofon'), 'mute');
  assert.equal(resolveVoiceMicAction('odcisz'), 'unmute');
  assert.equal(resolveVoiceMicAction('odblokuj mikrofon'), 'unmute');
  assert.equal(resolveVoiceMicAction('turn on mute'), 'mute');
  assert.equal(resolveVoiceMicAction('turn off mute'), 'unmute');
  assert.equal(resolveVoiceMicAction('mute on'), 'mute');
  assert.equal(resolveVoiceMicAction('mute off'), 'unmute');
  assert.equal(resolveVoiceMicAction('kuchnia'), '');
});

test('panel open clicks the tab; unavailable and unknown panels fail', async () => {
  const { handlers, doc } = makeHandlers({ doc: makeDocument({ hidden: ['github'] }) });
  assert.deepEqual(await handlers.panel({ action: 'open', panel: 'git' }), { ok: true, panel: 'git' });
  assert.deepEqual(await handlers.panel({ action: 'open', panel: 'pliki' }), { ok: true, panel: 'files' });
  assert.deepEqual(doc.clicks, ['git', 'files']);
  assert.equal((await handlers.panel({ action: 'open', panel: 'github' })).ok, false);
  assert.equal((await handlers.panel({ action: 'open', panel: 'logs' })).ok, false);
  assert.equal((await handlers.panel({ action: 'open', panel: 'nope' })).ok, false);
  assert.equal((await handlers.panel({ action: 'open' })).ok, false);
  assert.equal((await handlers.panel({ action: 'explode' })).ok, false);
  assert.equal(doc.clicks.length, 2, 'failed opens never click');
});

test('panel status reports the active panel and its connection', async () => {
  const { handlers } = makeHandlers({ chat: { title: 'Fix login' } });
  const actual = await handlers.panel({ action: 'status' });
  assert.deepEqual(actual, { ok: true, panel: 'chat', active: true, connection: 'reconnecting', title: 'Fix login' });
  const other = await handlers.panel({ action: 'status', panel: 'terminal' });
  assert.equal(other.active, false);
  assert.equal(other.connection, 'connected');
  assert.equal(readActivePanelId(makeDocument({ active: 'git' })), 'git');
  assert.equal(readActivePanelId(null), 'none');
});

test('settings: theme, language and mic', async () => {
  const { handlers, calls } = makeHandlers();
  assert.deepEqual(await handlers.app_settings({ action: 'theme', value: 'jasny' }), { ok: true, theme: 'light' });
  assert.deepEqual(await handlers.app_settings({ action: 'language', value: 'angielski' }), { ok: true, language: 'en' });
  assert.deepEqual(await handlers.app_settings({ action: 'mic', value: 'wycisz' }), { ok: true, micMuted: true });
  assert.deepEqual(calls, { theme: ['light'], lang: ['en'], mic: [true] });
  assert.equal((await handlers.app_settings({ action: 'theme', value: 'neon' })).ok, false);
  assert.equal((await handlers.app_settings({ action: 'language', value: 'de' })).ok, false);
  assert.equal((await handlers.app_settings({ action: 'volume', value: '1' })).ok, false);
  const noSession = makeHandlers({ micHandled: false });
  assert.equal((await noSession.handlers.app_settings({ action: 'mic', value: 'mute' })).ok, false);
});

test('notifications: unread first, capped to 8 items, strings clipped', async () => {
  const items = Array.from({ length: 12 }, (_, i) => ({
    title: i === 0 ? 'Read one' : `Notification ${i} ${'x'.repeat(300)}`,
    readAt: i === 0 ? '2026-01-01' : '',
  }));
  const { handlers } = makeHandlers({ notifications: { items, unreadCount: 11, initialized: true } });
  const actual = await handlers.app_status({ action: 'notifications' });
  assert.equal(actual.ok, true);
  assert.equal(actual.unread, 11);
  assert.equal(actual.items.length <= 8, true);
  assert.match(actual.items[0], /^\(unread\) Notification 1/);
  assert.equal(actual.truncated, true);
  assert.ok(JSON.stringify(actual).length <= 1200);
  const missing = makeHandlers({ notifications: null });
  assert.equal((await missing.handlers.app_status({ action: 'notifications' })).ok, false);
});

test('scout: pending count plus capped titles, polish diacritics preserved', async () => {
  const findings = Array.from({ length: 11 }, (_, i) => ({ title: i === 0 ? 'Zażółć gęślą jaźń' : `Finding ${i}` }));
  const { handlers } = makeHandlers({ fetchScout: async () => ({ status: 200, json: { findings, total: 11 } }) });
  const actual = await handlers.app_status({ action: 'scout' });
  assert.equal(actual.pending, 11);
  assert.equal(actual.titles.length, 8);
  assert.equal(actual.titles[0], 'Zażółć gęślą jaźń');
  assert.equal(actual.truncated, true);
  const failing = makeHandlers({ fetchScout: async () => ({ status: 500, json: null }) });
  assert.equal((await failing.handlers.app_status({ action: 'scout' })).ok, false);
});

test('health: connection plus harness problems only', async () => {
  const { handlers } = makeHandlers({
    fetchHealth: async () => ({
      harnesses: {
        sdk: { runs: 10, errorRuns: 0 },
        codex: { runs: 5, errorRuns: 1, activeLimit: { resetAt: 'x' } },
        qwen: { runs: 4, errorRuns: 3 },
        idle: { runs: 0 },
      },
    }),
  });
  const actual = await handlers.app_status({ action: 'health' });
  assert.deepEqual(actual.connection, { terminal: 'connected', chat: 'reconnecting' });
  assert.equal(actual.healthyHarnesses, 1);
  assert.deepEqual(actual.problems, ['codex: usage limit reached', 'qwen: 3 failed runs in 7 days']);
  const down = makeHandlers({ fetchHealth: async () => { throw new Error('boom'); } });
  assert.match((await down.handlers.app_status({ action: 'health' })).note, /not available/);
});

test('context: usage of the active chat, empty and missing chat', async () => {
  const chat = { title: 'Big', model: 'gpt-x', _contextUsageSnapshot: { fillPercent: 61.4, pressureLevel: 'warn' }, _contextUsageTotalTokens: 123456 };
  const { handlers } = makeHandlers({ chat });
  assert.deepEqual(await handlers.app_status({ action: 'context' }), {
    ok: true, title: 'Big', model: 'gpt-x', fillPercent: 61, level: 'warn', totalTokens: 123456,
  });
  const empty = makeHandlers({ chat: { title: 'New' } });
  assert.equal((await empty.handlers.app_status({ action: 'context' })).note, 'No usage data yet');
  const none = makeHandlers();
  assert.equal((await none.handlers.app_status({ action: 'context' })).ok, false);
  assert.equal((await none.handlers.app_status({ action: 'weather' })).ok, false);
});

test('capVoiceResult enforces item, string and byte limits', () => {
  const actual = capVoiceResult({ ok: true, items: Array.from({ length: 30 }, () => 'y'.repeat(120)), long: 'z'.repeat(500) });
  assert.ok(JSON.stringify(actual).length <= 1200);
  assert.equal(actual.truncated, true);
  assert.ok(actual.long.length <= 120);
  assert.equal(capVoiceResult({ ok: true, items: ['a'] }).truncated, undefined);
});
