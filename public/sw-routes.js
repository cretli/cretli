/**
 * Offline shell route rules for public/sw.js.
 *
 * Classic script on purpose: service workers here are registered without
 * `type: 'module'`, so sw.js loads this with importScripts(). The unit test
 * loads the same file through node:vm, so this file must not use import/export
 * or Node globals. It exposes `cretliSwRoutes` on the global object.
 *
 * The route set must equal lib/spa-routes.js (the shared server/client
 * contract). SW cannot import ESM, so tests/spa-route-shell-contract.test.js
 * fails when either side drifts.
 */
(function attachSwRoutes(root) {
  'use strict';

  // Panels from lib/spa-routes.js SPA_PANELS plus SPA_PATH_ALIASES keys.
  var SPA_VIEW_PANELS = [
    'chat',
    'terminal',
    'tasks',
    'agents',
    'todo',
    'browser',
    'files',
    'git',
    'github',
    'logs',
    'instances',
    'tests',
    'settings',
    // Legacy alias for /settings/widgets.
    'widget',
  ];

  // Sub-views from lib/spa-routes.js SPA_PANEL_SUBVIEWS. Only these nested
  // segments are shell routes, so /git/worktrees resolves while /git/<unknown>
  // stays out of the offline shell instead of serving a page that cannot render.
  var SPA_VIEW_SUBVIEWS = {
    git: ['worktrees'],
  };

  var SPA_HARNESS_IDS = [
    'sdk',
    'openrouter',
    'opencode',
    'codebuddy',
    'deepseek',
    'mistral',
    'zai',
    'qwen',
    'claude',
    'codex',
  ];

  var HARNESS_SUBTAB_SUFFIXES = ['keys', 'models', 'stats'];

  /**
   * @returns {string[]}
   */
  function buildHarnessSubtabTabIds() {
    var ids = [];
    for (var h = 0; h < SPA_HARNESS_IDS.length; h += 1) {
      var harnessId = SPA_HARNESS_IDS[h];
      for (var s = 0; s < HARNESS_SUBTAB_SUFFIXES.length; s += 1) {
        ids.push('harness-' + harnessId + '-' + HARNESS_SUBTAB_SUFFIXES[s]);
      }
    }
    ids.push('harness-opencode-approvals');
    return ids;
  }

  /**
   * @returns {Record<string, string>}
   */
  function buildHarnessTabAliases() {
    /** @type {Record<string, string>} */
    var aliases = {};
    for (var i = 0; i < SPA_HARNESS_IDS.length; i += 1) {
      var harnessId = SPA_HARNESS_IDS[i];
      aliases['harness-' + harnessId] = 'harness-' + harnessId + '-keys';
    }
    return aliases;
  }

  var SPA_SETTINGS_TAB_ALIASES = Object.assign({ browser: 'interface-browser' }, buildHarnessTabAliases());

  // Settings tabs from lib/spa-routes.js SPA_SETTINGS_TABS.
  var SPA_VIEW_SETTINGS_TABS = [
    'workspace',
    'connection',
    'harness',
    'harness-sdk',
    'harness-openrouter',
    'harness-opencode',
    'harness-codebuddy',
    'harness-deepseek',
    'harness-mistral',
    'harness-zai',
    'harness-qwen',
    'harness-codex',
    'harness-claude',
  ].concat(buildHarnessSubtabTabIds(), [
    'interface',
    'interface-notifications',
    'interface-terminal',
    'interface-voice',
    'interface-browser',
    'chat',
    'chat-titles',
    'delegations',
    'delegations-limits',
    'delegations-review',
    'delegations-models',
    'widgets',
    'mcp',
    'execution',
    'watcher',
    'watcher-monitor',
    'watcher-settings',
    'watcher-scout',
    'watcher-actions',
    'usage',
    'account',
  ]);

  /** @type {Record<string, true>} */
  var SPA_VIEW_SETTINGS_TAB_SET = {};
  for (var t = 0; t < SPA_VIEW_SETTINGS_TABS.length; t += 1) {
    SPA_VIEW_SETTINGS_TAB_SET[SPA_VIEW_SETTINGS_TABS[t]] = true;
  }

  /**
   * @param {string} tabId
   * @returns {string}
   */
  function remapSettingsTab(tabId) {
    if (!tabId) return '';
    return SPA_SETTINGS_TAB_ALIASES[tabId] || tabId;
  }

  /**
   * Offline navigation fallback rule. Must match lib/spa-routes.js shell paths:
   * allowlisted settings tabs and panel sub-views only.
   *
   * @param {string} pathname
   * @returns {boolean}
   */
  function isSpaViewPath(pathname) {
    var text = String(pathname || '');
    if (text === '/' || text === '/index.html') return true;
    var parts = text.replace(/\/$/, '').split('/').filter(Boolean);
    if (parts.length === 0 || parts.length > 2) return false;
    if (SPA_VIEW_PANELS.indexOf(parts[0]) === -1) return false;
    if (parts.length === 1) return true;
    if (parts[0] === 'settings') {
      var settingsTab = remapSettingsTab(parts[1]);
      return !!settingsTab && SPA_VIEW_SETTINGS_TAB_SET[settingsTab] === true;
    }
    var allowed = SPA_VIEW_SUBVIEWS[parts[0]];
    return !!allowed && allowed.indexOf(parts[1]) !== -1;
  }

  root.cretliSwRoutes = {
    SPA_VIEW_PANELS: SPA_VIEW_PANELS.slice(),
    SPA_VIEW_SUBVIEWS: {
      git: SPA_VIEW_SUBVIEWS.git.slice(),
    },
    SPA_VIEW_SETTINGS_TABS: SPA_VIEW_SETTINGS_TABS.slice(),
    isSpaViewPath: isSpaViewPath,
  };
})(typeof self !== 'undefined' ? self : globalThis);
