import test from 'node:test';
import assert from 'node:assert/strict';
import { initAgentsPanel } from '../app_front/features/settings/agentsSettingsPanel.js';

test('Rules and agents loads workspace context directly from Settings', async () => {
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  const listeners = new Map();
  const elements = new Map([
    ['agents-toggle', { addEventListener: (name, fn) => listeners.set(name, fn), innerHTML: '' }],
    ['agents-rules-panel', { style: { display: 'none' } }],
    ['header-workspace-trigger', { dataset: { workspaceFolder: '/workspace' } }],
    ...['agents-rules', 'agents-shared-rules', 'agents-commands', 'agents-project-skills',
      'agents-shared-skills', 'agents-skills'].map((id) => [id, { innerHTML: '' }]),
  ]);
  const requests = [];
  globalThis.document = { getElementById: (id) => elements.get(id) || null };
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return new Response(JSON.stringify({
      ok: true,
      projectRules: [{ name: '<rule>', path: '.cursor/rules/example.mdc' }],
      projectSkills: [{ name: 'example-skill' }],
    }), { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    initAgentsPanel();
    assert.equal(typeof listeners.get('click'), 'function');
    listeners.get('click')();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(requests, ['/api/cursor-context?workspaceFolder=%2Fworkspace']);
    assert.equal(elements.get('agents-rules-panel').style.display, 'block');
    assert.match(elements.get('agents-rules').innerHTML, /&lt;rule&gt;/);
    assert.match(elements.get('agents-project-skills').innerHTML, /example-skill/);
    listeners.get('click')();
    assert.equal(elements.get('agents-rules-panel').style.display, 'none');
  } finally {
    globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
  }
});
