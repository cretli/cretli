import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SPA_PANELS,
  SPA_PANEL_SUBVIEWS,
  SPA_ROUTE_CONTRACT_VERSION,
  SPA_SETTINGS_TABS,
  buildSpaLocation,
  buildSpaPath,
  buildSpaRoute,
  canonicalSpaLocation,
  isHarnessSettingsTab,
  isHarnessSubtabOf,
  isInterfaceSettingsTab,
  isOpaqueRouteId,
  isRelativeRoutePath,
  isSpaLoginNextPath,
  isWatcherSettingsTab,
  isSpaShellPath,
  parseSpaPath,
  parseSpaRoute,
  remapSettingsTab,
  spaRouteQueryKeys,
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
    'mistral',
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

test('isWatcherSettingsTab covers the watcher sub-tabs', () => {
  assert.equal(isWatcherSettingsTab('watcher'), true);
  assert.equal(isWatcherSettingsTab('watcher-monitor'), true);
  assert.equal(isWatcherSettingsTab('watcher-settings'), true);
  assert.equal(isWatcherSettingsTab('watcher-scout'), true);
  assert.equal(isWatcherSettingsTab('watcher-actions'), true);
  assert.equal(isWatcherSettingsTab('workspace'), false);
  assert.equal(isWatcherSettingsTab(''), false);
  assert.deepEqual(parseSpaPath('/settings/watcher-scout'), {
    panel: 'settings',
    settingsTab: 'watcher-scout',
  });
  assert.equal(buildSpaPath({ panel: 'settings', settingsTab: 'watcher-monitor' }), '/settings/watcher-monitor');
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
  for (const harness of ['sdk', 'openrouter', 'mistral', 'opencode', 'codebuddy', 'deepseek', 'qwen', 'claude', 'codex']) {
    const settingsTab = `harness-${harness}-stats`;
    const url = buildSpaPath({ panel: 'settings', settingsTab });
    assert.equal(url, `/settings/${settingsTab}`);
    assert.deepEqual(parseSpaPath(url), { panel: 'settings', settingsTab });
    assert.equal(isHarnessSubtabOf(settingsTab, harness), true);
  }
});

test('/git is main and /git/worktrees is the only allowlisted sub-view', () => {
  assert.equal(parseSpaPath('/git/worktrees')?.panel, 'git');
  assert.equal(isSpaShellPath('/git/worktrees'), true);
  assert.equal(isSpaShellPath('/git/nope'), false);
  assert.equal(isSpaShellPath('/git/worktrees/deep'), false);
  assert.equal(buildSpaPath({ panel: 'git' }), '/git');
  assert.equal(buildSpaPath({ panel: 'git', subview: 'main' }), '/git');
  assert.equal(buildSpaPath({ panel: 'git', subview: 'worktrees' }), '/git/worktrees');
  // A sub-view is only meaningful on its own panel.
  assert.equal(buildSpaPath({ panel: 'chat', subview: 'worktrees' }), '/chat');
  assert.deepEqual(Object.keys(SPA_PANEL_SUBVIEWS), ['git']);
});

test('parseSpaRoute reads the git sub-view and defaults it to main', () => {
  assert.equal(parseSpaRoute('/git')?.subview, 'main');
  assert.equal(parseSpaRoute('/git/worktrees')?.subview, 'worktrees');
  assert.equal(parseSpaRoute('/git/worktrees/')?.subview, 'worktrees');
  assert.equal(parseSpaRoute('/git/nope'), null);
  assert.equal(parseSpaRoute('/chat')?.subview, '');
  assert.equal(parseSpaRoute('/settings/workspace')?.subview, '');
});

test('parseSpaRoute treats / as the implicit view and rejects non-shell paths', () => {
  assert.equal(parseSpaRoute('/index.html')?.panel, '');
  assert.equal(parseSpaRoute('/login'), null);
  assert.equal(parseSpaRoute('/api/settings'), null);
  assert.equal(parseSpaRoute('/embed/abc'), null);
  assert.equal(parseSpaRoute(''), null);
  assert.equal(parseSpaRoute('//evil.example.com'), null);
  assert.equal(parseSpaRoute('/terminal/extra'), null);
});

test('parseSpaRoute canonicalizes legacy panel/tab aliases on the implicit path', () => {
  const chat = parseSpaRoute({ pathname: '/', search: '?source=pwa&panel=chat&chat=abc-123' });
  assert.equal(chat.panel, 'chat');
  assert.equal(chat.resource.id, 'abc-123');
  assert.equal(chat.canonical, '/chat?chat=abc-123&source=pwa');
  assert.ok(chat.dropped.some((item) => item.key === 'panel' && item.reason === 'aliased'));

  const settings = parseSpaRoute({ pathname: '/', search: '?panel=settings&tab=workspace' });
  assert.equal(settings.canonical, '/settings/workspace');

  const widget = parseSpaRoute({ pathname: '/', search: '?panel=widget' });
  assert.equal(widget.canonical, '/settings/widgets');

  const legacyHarness = parseSpaRoute({ pathname: '/settings/harness-sdk', search: '' });
  assert.equal(legacyHarness.settingsTab, 'harness-sdk-keys');

  // An explicit path wins over the legacy query, which is then dropped.
  const explicit = parseSpaRoute({ pathname: '/todo', search: '?panel=chat&tab=harness' });
  assert.equal(explicit.canonical, '/todo');
  assert.equal(explicit.dropped.filter((item) => item.reason === 'ignored-explicit-path').length, 2);

  const unknownPanel = parseSpaRoute({ pathname: '/', search: '?panel=nope' });
  assert.equal(unknownPanel.canonical, '/');
  assert.ok(unknownPanel.dropped.some((item) => item.key === 'panel' && item.reason === 'invalid-value'));
});

test('query allowlist keeps each panel resource id and drops foreign keys', () => {
  assert.equal(parseSpaRoute('/chat?chat=c1').query.chat, 'c1');
  assert.equal(parseSpaRoute('/todo?todo=t1').query.todo, 't1');
  assert.equal(parseSpaRoute('/tasks?run=r1').query.run, 'r1');
  assert.equal(parseSpaRoute('/agents?run=r2').query.run, 'r2');
  assert.equal(parseSpaRoute('/terminal?session=s1').query.session, 's1');
  assert.equal(parseSpaRoute('/browser?browserSession=b1&browserTab=b2').canonical,
    '/browser?browserSession=b1&browserTab=b2');
  assert.equal(parseSpaRoute('/files?path=src/app.js').resource.id, 'src/app.js');

  const foreign = parseSpaRoute('/chat?todo=t1&run=r1');
  assert.equal(foreign.canonical, '/chat');
  assert.deepEqual(foreign.dropped, [
    { key: 'todo', reason: 'not-allowed-for-panel' },
    { key: 'run', reason: 'not-allowed-for-panel' },
  ]);

  const unknown = parseSpaRoute('/settings/workspace?filter=status:open&secret=token');
  assert.equal(unknown.canonical, '/settings/workspace');
  assert.deepEqual(unknown.dropped.map((item) => item.key), ['filter', 'secret']);

  const repeated = parseSpaRoute('/chat?chat=a&chat=b');
  assert.equal(repeated.query.chat, 'a');
  assert.ok(repeated.dropped.some((item) => item.key === 'chat' && item.reason === 'duplicate'));

  const empty = parseSpaRoute('/chat?chat=');
  assert.equal(empty.canonical, '/chat');
  assert.ok(empty.dropped.some((item) => item.reason === 'empty'));
});

test('the shared context keys work on every panel and reject path-shaped values', () => {
  const folderKey = 'cretli:ws:11111111-2222-3333-4444-555555555555';
  const route = parseSpaRoute(`/todo?ws=${folderKey}&folder=bbbbbbbb-2222-3333-4444-555555555555`);
  assert.equal(route.context.workspaceKey, folderKey);
  assert.equal(route.context.folderKey, 'bbbbbbbb-2222-3333-4444-555555555555');
  // The colon of a folders-workspace id stays readable instead of %3A.
  assert.ok(route.canonical.includes(`ws=${folderKey}`), route.canonical);

  for (const pathname of ['/chat', '/git/worktrees', '/settings/workspace', '/']) {
    const scoped = parseSpaRoute(`${pathname}?ws=${folderKey}`);
    assert.equal(scoped.context.workspaceKey, folderKey, pathname);
  }

  const asPath = parseSpaRoute('/chat?ws=/home/user/project&folder=../../etc');
  assert.equal(asPath.canonical, '/chat');
  assert.deepEqual(asPath.dropped, [
    { key: 'ws', reason: 'invalid-value' },
    { key: 'folder', reason: 'invalid-value' },
  ]);
  assert.equal(isOpaqueRouteId('cretli:ws:abc'), true);
  assert.equal(isOpaqueRouteId('/home/user'), false);
  assert.equal(isOpaqueRouteId('a/b'), false);
  assert.equal(isOpaqueRouteId('..'), false);
  assert.equal(isOpaqueRouteId('fragment#x'), false);
  assert.equal(isOpaqueRouteId(''), false);
});

test('files path stays relative and never carries an absolute or traversing path', () => {
  assert.equal(parseSpaRoute('/files?path=docs/a.md').query.path, 'docs/a.md');
  assert.equal(parseSpaRoute('/files?path=/etc/passwd').canonical, '/files');
  assert.equal(parseSpaRoute('/files?path=../secret').canonical, '/files');
  assert.equal(parseSpaRoute('/files?path=C:\\Windows').canonical, '/files');
  assert.equal(isRelativeRoutePath('a/b'), true);
  assert.equal(isRelativeRoutePath('/a'), false);
  assert.equal(isRelativeRoutePath('a/../b'), false);
  assert.equal(isRelativeRoutePath('x'.repeat(600)), false);
});

test('git scope requires its resource and belongs to the git panel only', () => {
  const scoped = parseSpaRoute('/git/worktrees?ws=cretli:ws:abc&scope=chat&chat=c1');
  assert.equal(scoped.scope, 'chat');
  assert.deepEqual(scoped.resource, { type: 'chat', id: 'c1' });
  assert.equal(scoped.canonical, '/git/worktrees?ws=cretli:ws:abc&scope=chat&chat=c1');

  const todoScope = parseSpaRoute('/git?scope=todo&todo=t1');
  assert.equal(todoScope.scope, 'todo');
  assert.deepEqual(todoScope.resource, { type: 'todo', id: 't1' });

  const dangling = parseSpaRoute('/git/worktrees?scope=chat');
  assert.equal(dangling.scope, '');
  assert.equal(dangling.canonical, '/git/worktrees');
  assert.ok(dangling.dropped.some((item) => item.key === 'scope' && item.reason === 'missing-scope-resource'));

  const wrongPanel = parseSpaRoute('/chat?scope=chat&chat=c1');
  assert.equal(wrongPanel.scope, '');
  assert.equal(wrongPanel.canonical, '/chat?chat=c1');
  assert.ok(wrongPanel.dropped.some((item) => item.key === 'scope' && item.reason === 'not-allowed-for-panel'));

  // Without a scope, Git addresses the workspace context, never a stray chat.
  assert.equal(parseSpaRoute('/git/worktrees?ws=cretli:ws:abc').resource.id, '');
});

test('debug and PWA flags are allowlisted with their values', () => {
  const kept = parseSpaRoute('/chat?chat=c1&source=pwa&debugApi=1&debug-status=true&uiFreezeDiag=on');
  assert.equal(kept.canonical, '/chat?chat=c1&source=pwa&debugApi=1&debug-status=true&uiFreezeDiag=on');
  const badFlag = parseSpaRoute('/chat?debugApi=follow-the-white-rabbit');
  assert.equal(badFlag.canonical, '/chat');
  assert.ok(badFlag.dropped.some((item) => item.key === 'debugApi' && item.reason === 'invalid-value'));
  // A flag is not a filter: an arbitrary value never survives.
  assert.equal(parseSpaRoute('/todo?sort=desc&query=abc').canonical, '/todo');
});

test('embed parameters are scoped to embed mode so paths never leak into a view URL', () => {
  const embedded = parseSpaRoute('/chat?embed=1&workspaceFile=/w/a.code-workspace&workspaceFolder=/w/app&model=x');
  assert.equal(embedded.embed, true);
  assert.ok(embedded.canonical.includes('workspaceFile='), embedded.canonical);
  assert.ok(embedded.canonical.startsWith('/chat?embed=1'));

  const notEmbedded = parseSpaRoute('/chat?workspaceFile=/w/a.code-workspace');
  assert.equal(notEmbedded.embed, false);
  assert.equal(notEmbedded.canonical, '/chat');
  assert.ok(notEmbedded.dropped.some((item) => item.key === 'workspaceFile' && item.reason === 'not-allowed-for-panel'));

  assert.deepEqual(
    spaRouteQueryKeys('git', { embed: false }),
    ['ws', 'folder', 'scope', 'chat', 'todo', ...[
      'source', 'debugApi', 'debugStartup', 'debugOverlay', 'debugRemote',
      'debugConsoleAll', 'debug-status', 'uiFreezeDiag', 'tasksDebug', 'tasksPerf',
    ]],
  );
});

test('route round-trip is idempotent for every panel, sub-view and settings tab', () => {
  const locations = [
    '/',
    ...SPA_PANELS.map((panel) => `/${panel}`),
    '/git/worktrees',
    ...SPA_SETTINGS_TABS.map((tab) => `/settings/${tab}`),
  ];
  for (const location of locations) {
    const route = parseSpaRoute({ pathname: location, search: '?ws=cretli:ws:abc&folder=def' });
    assert.ok(route, location);
    assert.equal(route.canonical, canonicalSpaLocation(location, '?ws=cretli:ws:abc&folder=def'), location);
    assert.equal(parseSpaRoute(route.canonical).canonical, route.canonical, location);
    // No location may put a filesystem path into the query.
    assert.ok(!route.canonical.split('?')[1]?.includes('%2F'), route.canonical);
    assert.ok(!route.canonical.split('?')[1]?.includes('/'), route.canonical);
  }
  assert.equal(SPA_ROUTE_CONTRACT_VERSION, 1);
  assert.equal(parseSpaRoute('/settings/nope'), null);
});

test('buildSpaRoute serializes a hand-built state and drops what is not allowlisted', () => {
  const built = buildSpaRoute({
    panel: 'git',
    subview: 'worktrees',
    context: { workspaceKey: 'cretli:ws:abc', folderKey: 'folder-1' },
    query: { scope: 'chat', chat: 'c1', filter: 'x', source: 'pwa' },
  });
  assert.equal(built, '/git/worktrees?ws=cretli:ws:abc&folder=folder-1&scope=chat&chat=c1&source=pwa');
  assert.equal(buildSpaRoute({ panel: 'chat', query: { ws: '../x' } }), '/chat');
  assert.equal(buildSpaRoute({}), '/');
});

test('buildSpaRoute and parseSpaRoute agree on git scope coupling', () => {
  const dangling = buildSpaRoute({ panel: 'git', query: { scope: 'chat' } });
  assert.equal(dangling, '/git');
  assert.equal(parseSpaRoute(dangling)?.canonical, dangling);
  const coupled = buildSpaRoute({ panel: 'git', query: { scope: 'chat', chat: 'c1' } });
  assert.equal(coupled, '/git?scope=chat&chat=c1');
  assert.equal(parseSpaRoute(coupled)?.canonical, coupled);
  const todoScope = buildSpaRoute({ panel: 'git', query: { scope: 'todo', todo: 't1' } });
  assert.equal(parseSpaRoute(todoScope)?.canonical, todoScope);

  // The coupling uses the same value rules as the serializer, so a scope is never
  // emitted for a resource id that cannot survive in the query. parseSpaRoute
  // drops the id before the coupling runs; buildSpaRoute must not diverge.
  const invalidChat = buildSpaRoute({ panel: 'git', scope: 'chat', query: { chat: 'a/b' } });
  assert.equal(invalidChat, '/git');
  assert.equal(parseSpaRoute(invalidChat)?.canonical, invalidChat);

  const invalidChatFromQuery = buildSpaRoute({
    panel: 'git',
    subview: 'worktrees',
    query: { scope: 'chat', chat: 'a/b' },
  });
  assert.equal(invalidChatFromQuery, '/git/worktrees');
  assert.equal(parseSpaRoute(invalidChatFromQuery)?.canonical, invalidChatFromQuery);

  const invalidTodo = buildSpaRoute({ panel: 'git', scope: 'todo', query: { todo: '../etc' } });
  assert.equal(invalidTodo, '/git');
  assert.equal(parseSpaRoute(invalidTodo)?.canonical, invalidTodo);

  const invalidTodoFromQuery = buildSpaRoute({
    panel: 'git',
    query: { scope: 'todo', todo: 't'.repeat(130) },
  });
  assert.equal(invalidTodoFromQuery, '/git');
  assert.equal(parseSpaRoute(invalidTodoFromQuery)?.canonical, invalidTodoFromQuery);

  // A valid sibling id is still kept when only the scoped one is rejected.
  const mixed = buildSpaRoute({
    panel: 'git',
    scope: 'chat',
    query: { scope: 'chat', chat: 'a/b', todo: 't1' },
  });
  assert.equal(mixed, '/git?todo=t1');
  assert.equal(parseSpaRoute(mixed)?.canonical, mixed);
});

test('login next accepts only shell views plus the widget pages', () => {
  assert.equal(isSpaLoginNextPath('/git/worktrees'), true);
  assert.equal(isSpaLoginNextPath('/settings/workspace'), true);
  assert.equal(isSpaLoginNextPath('/embed/abc'), true);
  assert.equal(isSpaLoginNextPath('/widget-authorize/abc'), true);
  assert.equal(isSpaLoginNextPath('/git/nope'), false);
  assert.equal(isSpaLoginNextPath('/api/settings'), false);
  assert.equal(isSpaLoginNextPath(''), false);
});
