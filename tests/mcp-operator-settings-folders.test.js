import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { folderOptions } from '../app_front/features/settings/mcpOperatorFolders.js';

const workspaces = [
  {
    workspaceFile: '/home/me/www/acme.code-workspace',
    workspaceDir: '/home/me/www',
    folders: [
      { name: 'acme', resolvedPath: '/home/me/www/acme' },
      { name: 'docs', resolvedPath: '/home/me/www/acme-docs/' },
      { name: 'off', resolvedPath: '/home/me/www/off', enabled: false },
    ],
  },
  { workspaceFile: '/home/me/www/other', workspaceDir: '/home/me/www/other', folders: [{ name: 'other', resolvedPath: '/home/me/www/other' }] },
];

test('offers only the enabled folders of the current workspace', () => {
  const rows = folderOptions(workspaces, '/home/me/www/acme.code-workspace', '/home/me/www/acme');
  assert.deepEqual(rows.map((row) => row.value), ['/home/me/www/acme', '/home/me/www/acme-docs']);
});

test('keeps the current folder when the workspace is not in the list', () => {
  const rows = folderOptions(workspaces, '/missing.code-workspace', '/home/me/www/acme/');
  assert.deepEqual(rows.map((row) => row.value), ['/home/me/www/acme']);
});

test('nested page recipes in Settings do not trap touch scrolling', () => {
  const scss = readFileSync(new URL('../app_front/css/base/_global.scss', import.meta.url), 'utf8');
  assert.match(scss, /#settings-panel \.settings-sections \.cr-page,\s*#settings-panel \.settings-sections \.cr-page-body \{\s*overflow: visible;\s*overscroll-behavior: auto;/);
});

test('MCP operator sub-tabs are settings routes and share one page', async () => {
  const { SPA_SETTINGS_TABS, isMcpOperatorSettingsTab, isMcpSettingsTab } = await import('../lib/spa-routes.js');
  for (const tab of ['mcp-operator', 'mcp-operator-playbook', 'mcp-operator-proposals', 'mcp-operator-activity']) {
    assert.ok(SPA_SETTINGS_TABS.includes(tab), tab);
    assert.equal(isMcpOperatorSettingsTab(tab), true);
    assert.equal(isMcpSettingsTab(tab), true);
  }
  assert.equal(isMcpOperatorSettingsTab('mcp-clients'), false);
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="settings-mcp-operator-tabs"[^>]*hidden/);
  const sw = readFileSync(new URL('../public/sw-routes.js', import.meta.url), 'utf8');
  assert.ok(sw.includes("'mcp-operator-activity'"));
});
