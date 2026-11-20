import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initChatRestartRecoverySettings } from '../app_front/features/settings/chatRestartRecoverySettings.js';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';

function fakeElement() {
  const listeners = new Map();
  return {
    value: '', options: [], hidden: false, textContent: '', dataset: {}, children: [],
    classList: { toggle() {} },
    addEventListener: (name, fn) => listeners.set(name, fn),
    appendChild(child) { this.children.push(child); },
    fire: (name) => listeners.get(name)?.(),
  };
}

test('restart recovery switch loads state and saves global and per-workspace modes', async () => {
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  const elements = Object.fromEntries(
    ['chat-recovery-mode', 'chat-recovery-workspace-field', 'chat-recovery-workspace-mode', 'chat-recovery-status', 'chat-recovery-adapters']
      .map((id) => [id, fakeElement()]),
  );
  const patches = [];
  globalThis.document = {
    getElementById: (id) => elements[id] || null,
    createElement: () => fakeElement(),
  };
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === 'PATCH') {
      patches.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      ok: true,
      workspaceFolder: '/w/a',
      chatRestartRecovery: { mode: 'automatic', workspaces: { '/w/a': 'off' } },
      chatRestartRecoveryAdapters: [
        { harness: 'claude', sdkVersion: '1.0.0', validated: true },
        { harness: 'codex', sdkVersion: '2.0.0', validated: false },
      ],
    }), { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    initChatRestartRecoverySettings();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(elements['chat-recovery-mode'].value, 'automatic');
    assert.equal(elements['chat-recovery-workspace-mode'].value, 'off');
    assert.equal(elements['chat-recovery-workspace-field'].hidden, false);
    assert.deepEqual(elements['chat-recovery-adapters'].children.map((li) => li.dataset.validated), ['true', 'false']);

    elements['chat-recovery-mode'].value = 'manual';
    elements['chat-recovery-mode'].fire('change');
    await new Promise((resolve) => setTimeout(resolve, 20));
    elements['chat-recovery-workspace-mode'].value = '';
    elements['chat-recovery-workspace-mode'].fire('change');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(patches, [
      { chatRestartRecoveryMode: 'manual' },
      { chatRestartRecoveryWorkspace: { workspaceFolder: '/w/a', mode: '' } },
    ]);
  } finally {
    globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
  }
});

test('restart recovery strings exist in en and pl and the tab is wired in the markup', () => {
  for (const dict of [en, pl]) {
    for (const key of ['tabsChatRecovery', 'restartRecoveryTitle', 'restartRecoveryModeOff', 'restartRecoveryModeManual', 'restartRecoveryModeAutomatic', 'restartRecoveryAdaptersHint']) {
      assert.ok(dict.settings[key], key);
    }
  }
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /data-settings-tab="chat-recovery" role="tab"/);
  assert.match(html, /<cr-bar-select id="chat-recovery-mode"/);
  assert.match(readFileSync(new URL('../lib/spa-routes.js', import.meta.url), 'utf8'), /'chat-recovery'/);
});
