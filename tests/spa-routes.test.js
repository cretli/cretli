import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSpaLocation,
  buildSpaPath,
  isHarnessSettingsTab,
  isInterfaceSettingsTab,
  isSpaShellPath,
  parseSpaPath,
  remapSettingsTab,
} from '../lib/spa-routes.js';

test('parseSpaPath treats / and /index.html as implicit (no explicit view)', () => {
  assert.equal(parseSpaPath('/'), null);
  assert.equal(parseSpaPath('/index.html'), null);
  assert.equal(parseSpaPath(''), null);
});

test('parseSpaPath reads panel and settings tab', () => {
  assert.deepEqual(parseSpaPath('/chat'), { panel: 'chat', settingsTab: '' });
  assert.deepEqual(parseSpaPath('/tasks'), { panel: 'tasks', settingsTab: '' });
  assert.deepEqual(parseSpaPath('/settings'), { panel: 'settings', settingsTab: '' });
  assert.deepEqual(parseSpaPath('/settings/mcp'), {
    panel: 'settings',
    settingsTab: 'mcp',
  });
  assert.deepEqual(parseSpaPath('/settings/workspace/'), {
    panel: 'settings',
    settingsTab: 'workspace',
  });
});

test('parseSpaPath aliases /widget to settings widgets', () => {
  assert.deepEqual(parseSpaPath('/widget'), { panel: 'settings', settingsTab: 'widgets' });
  assert.deepEqual(parseSpaPath('/widget/'), { panel: 'settings', settingsTab: 'widgets' });
  assert.equal(isSpaShellPath('/widget'), true);
  assert.equal(buildSpaPath({ panel: 'widget' }), '/chat');
  assert.equal(
    buildSpaPath({ panel: 'settings', settingsTab: 'widgets' }),
    '/settings/widgets',
  );
});

test('parseSpaPath rejects login, embed, api and unknown tabs', () => {
  assert.equal(parseSpaPath('/login'), null);
  assert.equal(parseSpaPath('/embed/abc'), null);
  assert.equal(parseSpaPath('/api/settings'), null);
  assert.equal(parseSpaPath('/dist/app/index.bundle.js'), null);
  assert.equal(parseSpaPath('/settings/unknown'), null);
  assert.equal(parseSpaPath('/terminal/extra'), null);
  assert.equal(parseSpaPath('//evil.example.com'), null);
});

test('parseSpaPath accepts harness backend tabs', () => {
  assert.deepEqual(parseSpaPath('/settings/harness'), {
    panel: 'settings',
    settingsTab: 'harness',
  });
  assert.deepEqual(parseSpaPath('/settings/harness-sdk'), {
    panel: 'settings',
    settingsTab: 'harness-sdk',
  });
  assert.deepEqual(parseSpaPath('/settings/harness-openrouter'), {
    panel: 'settings',
    settingsTab: 'harness-openrouter',
  });
  assert.deepEqual(parseSpaPath('/settings/harness-opencode'), {
    panel: 'settings',
    settingsTab: 'harness-opencode',
  });
  assert.deepEqual(parseSpaPath('/settings/harness-codebuddy'), {
    panel: 'settings',
    settingsTab: 'harness-codebuddy',
  });
  assert.deepEqual(parseSpaPath('/settings/harness-deepseek'), {
    panel: 'settings',
    settingsTab: 'harness-deepseek',
  });
  assert.deepEqual(parseSpaPath('/settings/harness-codex'), {
    panel: 'settings',
    settingsTab: 'harness-codex',
  });
  assert.deepEqual(parseSpaPath('/settings/harness-qwen'), {
    panel: 'settings',
    settingsTab: 'harness-qwen',
  });
  assert.equal(parseSpaPath('/settings/harness/sdk'), null);
});

test('isHarnessSettingsTab covers overview and backend tabs', () => {
  assert.equal(isHarnessSettingsTab('harness'), true);
  assert.equal(isHarnessSettingsTab('harness-sdk'), true);
  assert.equal(isHarnessSettingsTab('harness-codebuddy'), true);
  assert.equal(isHarnessSettingsTab('harness-deepseek'), true);
  assert.equal(isHarnessSettingsTab('harness-codex'), true);
  assert.equal(isHarnessSettingsTab('harness-qwen'), true);
  assert.equal(isHarnessSettingsTab('workspace'), false);
  assert.equal(isHarnessSettingsTab(''), false);
});

test('parseSpaPath accepts interface sub-tabs', () => {
  assert.deepEqual(parseSpaPath('/settings/interface'), {
    panel: 'settings',
    settingsTab: 'interface',
  });
  assert.deepEqual(parseSpaPath('/settings/interface-terminal'), {
    panel: 'settings',
    settingsTab: 'interface-terminal',
  });
  assert.deepEqual(parseSpaPath('/settings/interface-voice'), {
    panel: 'settings',
    settingsTab: 'interface-voice',
  });
  assert.deepEqual(parseSpaPath('/settings/interface-browser'), {
    panel: 'settings',
    settingsTab: 'interface-browser',
  });
  assert.equal(parseSpaPath('/settings/interface/voice'), null);
});

test('parseSpaPath aliases /settings/browser to interface-browser', () => {
  assert.deepEqual(parseSpaPath('/settings/browser'), {
    panel: 'settings',
    settingsTab: 'interface-browser',
  });
  assert.equal(remapSettingsTab('browser'), 'interface-browser');
  assert.equal(remapSettingsTab('interface-voice'), 'interface-voice');
  assert.equal(
    buildSpaPath({ panel: 'settings', settingsTab: 'browser' }),
    '/settings/interface-browser',
  );
  assert.equal(isSpaShellPath('/settings/browser'), true);
});

test('isInterfaceSettingsTab covers appearance, terminal, voice and storage tabs', () => {
  assert.equal(isInterfaceSettingsTab('interface'), true);
  assert.equal(isInterfaceSettingsTab('interface-terminal'), true);
  assert.equal(isInterfaceSettingsTab('interface-voice'), true);
  assert.equal(isInterfaceSettingsTab('interface-browser'), true);
  assert.equal(isInterfaceSettingsTab('harness'), false);
  assert.equal(isInterfaceSettingsTab('workspace'), false);
  assert.equal(isInterfaceSettingsTab(''), false);
});

test('buildSpaPath writes allowlisted paths', () => {
  assert.equal(buildSpaPath({ panel: 'chat' }), '/chat');
  assert.equal(buildSpaPath({ panel: 'tasks' }), '/tasks');
  assert.equal(buildSpaPath({ panel: 'settings' }), '/settings');
  assert.equal(buildSpaPath({ panel: 'settings', settingsTab: 'workspace' }), '/settings/workspace');
  assert.equal(buildSpaPath({ panel: 'settings', settingsTab: 'harness-sdk' }), '/settings/harness-sdk');
  assert.equal(buildSpaPath({ panel: 'settings', settingsTab: 'interface-voice' }), '/settings/interface-voice');
  assert.equal(buildSpaPath({ panel: 'nope' }), '/chat');
  assert.equal(buildSpaPath({ panel: 'settings', settingsTab: 'nope' }), '/settings');
});

test('isSpaShellPath covers the HTML shell and view paths only', () => {
  assert.equal(isSpaShellPath('/'), true);
  assert.equal(isSpaShellPath('/index.html'), true);
  assert.equal(isSpaShellPath('/settings/workspace'), true);
  assert.equal(isSpaShellPath('/login'), false);
  assert.equal(isSpaShellPath('/embed/abc'), false);
  assert.equal(isSpaShellPath('/widget-authorize/x'), false);
});

test('buildSpaLocation drops panel/tab aliases and keeps other query params', () => {
  assert.equal(
    buildSpaLocation({
      panel: 'settings',
      settingsTab: 'workspace',
      search: '?source=pwa&panel=chat&tab=harness&chat=abc',
    }),
    '/settings/workspace?source=pwa&chat=abc'
  );
  assert.equal(buildSpaLocation({ panel: 'chat', search: '' }), '/chat');
});
