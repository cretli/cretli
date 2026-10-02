import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSpaLocation,
  buildSpaPath,
  isHarnessSettingsTab,
  isHarnessSubtabOf,
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
    settingsTab: 'harness-sdk-keys',
  });
  assert.deepEqual(parseSpaPath('/settings/harness-openrouter'), {
    panel: 'settings',
    settingsTab: 'harness-openrouter-keys',
  });
  assert.deepEqual(parseSpaPath('/settings/harness-opencode'), {
    panel: 'settings',
    settingsTab: 'harness-opencode-keys',
  });
  assert.deepEqual(parseSpaPath('/settings/harness-codebuddy'), {
    panel: 'settings',
    settingsTab: 'harness-codebuddy-keys',
  });
  assert.deepEqual(parseSpaPath('/settings/harness-deepseek'), {
    panel: 'settings',
    settingsTab: 'harness-deepseek-keys',
  });
  assert.deepEqual(parseSpaPath('/settings/harness-codex'), {
    panel: 'settings',
    settingsTab: 'harness-codex-keys',
  });
  assert.deepEqual(parseSpaPath('/settings/harness-qwen'), {
    panel: 'settings',
    settingsTab: 'harness-qwen-keys',
  });
  assert.deepEqual(parseSpaPath('/settings/harness-claude'), {
    panel: 'settings',
    settingsTab: 'harness-claude-keys',
  });
  assert.equal(parseSpaPath('/settings/harness/sdk'), null);
});

test('parseSpaPath accepts third-level harness sub-tabs', () => {
  assert.deepEqual(parseSpaPath('/settings/harness-sdk-keys'), {
    panel: 'settings',
    settingsTab: 'harness-sdk-keys',
  });
  assert.deepEqual(parseSpaPath('/settings/harness-sdk-models'), {
    panel: 'settings',
    settingsTab: 'harness-sdk-models',
  });
  assert.deepEqual(parseSpaPath('/settings/harness-openrouter-models'), {
    panel: 'settings',
    settingsTab: 'harness-openrouter-models',
  });
  assert.deepEqual(parseSpaPath('/settings/harness-opencode-keys'), {
    panel: 'settings',
    settingsTab: 'harness-opencode-keys',
  });
  assert.deepEqual(parseSpaPath('/settings/harness-opencode-models'), {
    panel: 'settings',
    settingsTab: 'harness-opencode-models',
  });
  assert.deepEqual(parseSpaPath('/settings/harness-opencode-approvals'), {
    panel: 'settings',
    settingsTab: 'harness-opencode-approvals',
  });
  assert.deepEqual(parseSpaPath('/settings/harness-codebuddy-models'), {
    panel: 'settings',
    settingsTab: 'harness-codebuddy-models',
  });
  assert.deepEqual(parseSpaPath('/settings/harness-deepseek-models'), {
    panel: 'settings',
    settingsTab: 'harness-deepseek-models',
  });
  assert.deepEqual(parseSpaPath('/settings/harness-qwen-models'), {
    panel: 'settings',
    settingsTab: 'harness-qwen-models',
  });
  assert.deepEqual(parseSpaPath('/settings/harness-claude-models'), {
    panel: 'settings',
    settingsTab: 'harness-claude-models',
  });
  assert.deepEqual(parseSpaPath('/settings/harness-codex-models'), {
    panel: 'settings',
    settingsTab: 'harness-codex-models',
  });
  assert.equal(parseSpaPath('/settings/harness-opencode-unknown'), null);
});

test('remapSettingsTab maps legacy harness tabs to the Keys sub-tab', () => {
  for (const harnessId of [
    'sdk',
    'openrouter',
    'opencode',
    'codebuddy',
    'deepseek',
    'qwen',
    'claude',
    'codex',
  ]) {
    assert.equal(remapSettingsTab(`harness-${harnessId}`), `harness-${harnessId}-keys`);
  }
  assert.equal(remapSettingsTab('harness-opencode-models'), 'harness-opencode-models');
  assert.equal(remapSettingsTab('harness-opencode-approvals'), 'harness-opencode-approvals');
  assert.equal(remapSettingsTab('harness'), 'harness');
});

test('isHarnessSubtabOf matches the base id and third-level sub-tabs', () => {
  assert.equal(isHarnessSubtabOf('harness-sdk', 'sdk'), true);
  assert.equal(isHarnessSubtabOf('harness-sdk-keys', 'sdk'), true);
  assert.equal(isHarnessSubtabOf('harness-sdk-models', 'sdk'), true);
  assert.equal(isHarnessSubtabOf('harness-opencode-approvals', 'opencode'), true);
  assert.equal(isHarnessSubtabOf('harness-opencode-models', 'opencode'), true);
  assert.equal(isHarnessSubtabOf('harness-codex-models', 'codebuddy'), false);
  assert.equal(isHarnessSubtabOf('harness-codex-models', 'codex'), true);
  assert.equal(isHarnessSubtabOf('harness', 'sdk'), false);
  assert.equal(isHarnessSubtabOf('workspace', 'sdk'), false);
  assert.equal(isHarnessSubtabOf('harness-sdk-models', ''), false);
});

test('isHarnessSettingsTab covers overview and backend tabs', () => {
  assert.equal(isHarnessSettingsTab('harness'), true);
  assert.equal(isHarnessSettingsTab('harness-sdk'), true);
  assert.equal(isHarnessSettingsTab('harness-codebuddy'), true);
  assert.equal(isHarnessSettingsTab('harness-deepseek'), true);
  assert.equal(isHarnessSettingsTab('harness-codex'), true);
  assert.equal(isHarnessSettingsTab('harness-qwen'), true);
  assert.equal(isHarnessSettingsTab('harness-sdk-keys'), true);
  assert.equal(isHarnessSettingsTab('harness-sdk-models'), true);
  assert.equal(isHarnessSettingsTab('harness-openrouter-keys'), true);
  assert.equal(isHarnessSettingsTab('harness-opencode-models'), true);
  assert.equal(isHarnessSettingsTab('harness-opencode-approvals'), true);
  assert.equal(isHarnessSettingsTab('harness-claude-models'), true);
  assert.equal(isHarnessSettingsTab('workspace'), false);
  assert.equal(isHarnessSettingsTab(''), false);
});

test('parseSpaPath accepts the delegations settings tab', () => {
  assert.deepEqual(parseSpaPath('/settings/delegations'), {
    panel: 'settings',
    settingsTab: 'delegations',
  });
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
  assert.equal(buildSpaPath({ panel: 'settings', settingsTab: 'harness-sdk' }), '/settings/harness-sdk-keys');
  assert.equal(buildSpaPath({ panel: 'settings', settingsTab: 'harness-sdk-models' }), '/settings/harness-sdk-models');
  assert.equal(buildSpaPath({ panel: 'settings', settingsTab: 'harness-opencode-approvals' }), '/settings/harness-opencode-approvals');
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


test('each harness statistics tab has a round-trip direct link', () => {
  for (const harness of ['sdk', 'openrouter', 'opencode', 'codebuddy', 'deepseek', 'qwen', 'claude', 'codex']) {
    const settingsTab = `harness-${harness}-stats`;
    const url = buildSpaPath({ panel: 'settings', settingsTab });
    assert.equal(url, `/settings/${settingsTab}`);
    assert.deepEqual(parseSpaPath(url), { panel: 'settings', settingsTab });
    assert.equal(isHarnessSubtabOf(settingsTab, harness), true);
  }
});
