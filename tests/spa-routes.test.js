import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSpaLocation,
  buildSpaPath,
  isSpaShellPath,
  parseSpaPath,
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
  assert.deepEqual(parseSpaPath('/settings/workspace'), {
    panel: 'settings',
    settingsTab: 'workspace',
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

test('buildSpaPath writes allowlisted paths', () => {
  assert.equal(buildSpaPath({ panel: 'chat' }), '/chat');
  assert.equal(buildSpaPath({ panel: 'tasks' }), '/tasks');
  assert.equal(buildSpaPath({ panel: 'settings' }), '/settings');
  assert.equal(buildSpaPath({ panel: 'settings', settingsTab: 'workspace' }), '/settings/workspace');
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
