/**
 * Shared SPA view paths. No Node APIs — imported by the server and the frontend.
 */

export const SPA_PANELS = Object.freeze([
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
]);

/**
 * Backend harness ids that expose the third-level Keys/Models sub-tabs.
 * OpenCode additionally exposes Approvals.
 */
export const SPA_HARNESS_IDS = Object.freeze([
  'sdk',
  'openrouter',
  'opencode',
  'codebuddy',
  'deepseek',
  'mistral',
  'zai',
  'mimo',
  'qwen',
  'claude',
  'codex',
]);

const HARNESS_SUBTAB_SUFFIXES = Object.freeze(['keys', 'models', 'stats']);

/**
 * Builds the third-level harness tab ids: harness-{id}-keys / harness-{id}-models
 * plus harness-opencode-approvals.
 *
 * @returns {string[]}
 */
function buildHarnessSubtabTabIds() {
  const ids = [];
  for (const harnessId of SPA_HARNESS_IDS) {
    for (const suffix of HARNESS_SUBTAB_SUFFIXES) {
      ids.push(`harness-${harnessId}-${suffix}`);
    }
  }
  ids.push('harness-opencode-approvals');
  return ids;
}

/**
 * Legacy second-level harness ids -> their Keys sub-tab.
 *
 * @returns {Record<string, string>}
 */
function buildHarnessTabAliases() {
  /** @type {Record<string, string>} */
  const aliases = {};
  for (const harnessId of SPA_HARNESS_IDS) {
    aliases[`harness-${harnessId}`] = `harness-${harnessId}-keys`;
  }
  return aliases;
}

export const SPA_SETTINGS_TABS = Object.freeze([
  'workspace',
  'connection',
  'harness',
  'harness-overview-plugins',
  'harness-overview-diagnostics',
  'harness-overview-roles',
  'harness-overview-statistics',
  'harness-overview-sources',
  'harness-sdk',
  'harness-openrouter',
  'harness-opencode',
  'harness-codebuddy',
  'harness-deepseek',
  'harness-mistral',
  'harness-zai',
  'harness-mimo',
  'harness-qwen',
  'harness-codex',
  'harness-claude',
  ...buildHarnessSubtabTabIds(),
  'interface',
  'interface-notifications',
  'interface-terminal',
  'interface-voice',
  'interface-browser',
  'chat',
  'chat-titles',
  'delegations',
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

/**
 * @param {unknown} tabId
 * @returns {boolean}
 */
export function isHarnessSettingsTab(tabId) {
  if (typeof tabId !== 'string' || !tabId) return false;
  return tabId === 'harness' || tabId.startsWith('harness-');
}

/**
 * True when the tab belongs to the given harness: its legacy base id or any of
 * its third-level sub-tabs (keys / models / approvals). Aliases are resolved so
 * `harness-sdk` still matches the `sdk` harness.
 *
 * @param {unknown} tabId
 * @param {unknown} harnessId
 * @returns {boolean}
 */
export function isHarnessSubtabOf(tabId, harnessId) {
  const id = typeof harnessId === 'string' ? harnessId.trim() : '';
  if (!id) return false;
  const tab = remapSettingsTab(tabId);
  if (typeof tab !== 'string' || !tab) return false;
  return tab === `harness-${id}` || tab.startsWith(`harness-${id}-`);
}

/**
 * @param {unknown} tabId
 * @returns {boolean}
 */
export function isInterfaceSettingsTab(tabId) {
  if (typeof tabId !== 'string' || !tabId) return false;
  return tabId === 'interface' || tabId.startsWith('interface-');
}

/**
 * @param {unknown} tabId
 * @returns {boolean}
 */
export function isChatSettingsTab(tabId) {
  if (typeof tabId !== 'string' || !tabId) return false;
  return tabId === 'chat' || tabId.startsWith('chat-');
}

/**
 * @param {unknown} tabId
 * @returns {boolean}
 */
export function isWatcherSettingsTab(tabId) {
  if (typeof tabId !== 'string' || !tabId) return false;
  return tabId === 'watcher' || tabId.startsWith('watcher-');
}

/**
 * RouteState contract version. Bumped when the shape of a parsed route or the
 * query allowlist changes in a way a saved URL must not be re-read with.
 */
export const SPA_ROUTE_CONTRACT_VERSION = 1;

/**
 * Second-level pathname segments that are sub-views of a panel (not settings
 * tabs). Only these are shell routes, so `/git/worktrees` is served while
 * `/git/<anything-else>` stays a 404 instead of loading a shell that cannot
 * render the view.
 */
export const SPA_PANEL_SUBVIEWS = Object.freeze({
  git: Object.freeze(['worktrees']),
});

/** `/git` without a sub-view segment always means the main worktree view. */
export const SPA_PANEL_DEFAULT_SUBVIEWS = Object.freeze({
  git: 'main',
});

/**
 * Query keys that carry the durable view context (opaque route ids minted by
 * the server, never paths or slugs).
 */
export const SPA_ROUTE_CONTEXT_KEYS = Object.freeze(['ws', 'folder']);

/** Values of the explicit Git scope; without it the panel uses the view context. */
export const SPA_ROUTE_SCOPE_VALUES = Object.freeze(['chat', 'todo']);

/**
 * Panel -> allowlisted resource query keys. A key is only kept on its own panel,
 * so leaving a panel drops the previous panel's resource parameter.
 */
export const SPA_ROUTE_QUERY_KEYS = Object.freeze({
  chat: Object.freeze(['chat']),
  terminal: Object.freeze(['session']),
  tasks: Object.freeze(['run']),
  agents: Object.freeze(['run']),
  todo: Object.freeze(['todo']),
  browser: Object.freeze(['browserSession', 'browserTab']),
  files: Object.freeze(['path']),
  git: Object.freeze(['scope', 'chat', 'todo']),
  github: Object.freeze([]),
  logs: Object.freeze([]),
  instances: Object.freeze([]),
  tests: Object.freeze([]),
  settings: Object.freeze([]),
});

/**
 * Non-navigation parameters that a view URL may keep. Flags are debug switches
 * read at boot, `source` is the PWA/notification marker.
 */
export const SPA_ROUTE_FLAG_KEYS = Object.freeze([
  'source',
  'debugApi',
  'debugStartup',
  'debugOverlay',
  'debugRemote',
  'debugConsoleAll',
  'debug-status',
  'uiFreezeDiag',
  'tasksDebug',
  'tasksPerf',
]);

/**
 * Legacy embed/widget parameters. Accepted only while the URL opts into embed
 * mode, so a normal view URL can never carry a filesystem path in its query.
 */
export const SPA_ROUTE_EMBED_KEYS = Object.freeze([
  'embed',
  'widgetCreatePageChat',
  'workspaceFile',
  'workspaceFolder',
  'model',
]);

/** Legacy query aliases: read on input, always canonicalized away on output. */
export const SPA_LEGACY_QUERY_KEYS = Object.freeze(['panel', 'tab']);

/** Which query key holds the primary resource of a panel. */
const SPA_PANEL_RESOURCE_KEYS = Object.freeze({
  chat: 'chat',
  todo: 'todo',
  files: 'path',
  browser: 'browserSession',
  tasks: 'run',
  agents: 'run',
  terminal: 'session',
});

/** Query keys whose value is an opaque durable route id. */
const SPA_OPAQUE_ID_QUERY_KEYS = new Set([
  'ws',
  'folder',
  'chat',
  'todo',
  'run',
  'session',
  'browserSession',
  'browserTab',
]);

const OPAQUE_ROUTE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const FLAG_VALUE_SET = new Set(['1', '0', 'true', 'false', 'yes', 'no', 'on', 'off']);

/**
 * True for an opaque server-minted route id (a `cretli:ws:<uuid>` workspace key
 * or a folder/run/session/chat uuid). Paths, hashes, slugs of absolute paths and
 * traversal segments are rejected, so no filesystem path can enter a view URL.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isOpaqueRouteId(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text) return false;
  if (text.includes('/') || text.includes('\\') || text.includes('#')) return false;
  if (text === '.' || text === '..') return false;
  return OPAQUE_ROUTE_ID_PATTERN.test(text);
}

/**
 * Relative path accepted by the Files adapter (`/files?path=`). Absolute paths,
 * drive letters and traversal segments are rejected — the server resolves the
 * path inside the workspace instead.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isRelativeRoutePath(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text || text.length > 512) return false;
  if (text.startsWith('/') || text.startsWith('\\')) return false;
  if (/^[A-Za-z]:[\\/]/.test(text)) return false;
  return !text.split(/[\\/]/).some((segment) => segment === '..' || segment === '.');
}

/**
 * Git scope must reference a resource id that can actually survive query
 * serialization, matching parseSpaRoute coupling — there the invalid id is
 * dropped by `readAllowedQuery` before the coupling runs, so the scope never
 * outlives its resource. Scope and resource are omitted together here so a
 * hand-built state cannot serialize `/git?scope=chat` with no chat behind it.
 *
 * @param {string} panel
 * @param {Record<string, string>} values
 */
function applyGitScopeCoupling(panel, values) {
  if (panel !== 'git' || !values) return;
  const scope = typeof values.scope === 'string' ? values.scope.trim() : '';
  if (!scope) return;
  if (!SPA_ROUTE_SCOPE_VALUES.includes(scope)) {
    delete values.scope;
    return;
  }
  const resourceId = typeof values[scope] === 'string' ? values[scope].trim() : '';
  if (!resourceId || !isValidQueryValue(scope, resourceId)) {
    delete values.scope;
    delete values[scope];
  }
}

/**
 * @param {unknown} value
 * @param {string} key
 * @returns {boolean}
 */
function isValidQueryValue(key, value) {
  if (typeof value !== 'string') return false;
  if (key === 'path') return isRelativeRoutePath(value);
  if (key === 'scope') return SPA_ROUTE_SCOPE_VALUES.includes(value);
  if (SPA_OPAQUE_ID_QUERY_KEYS.has(key)) return isOpaqueRouteId(value);
  if (SPA_ROUTE_FLAG_KEYS.includes(key) && key !== 'source') return FLAG_VALUE_SET.has(value);
  if (key === 'source') return isOpaqueRouteId(value);
  return true;
}

/**
 * Canonical sub-view for a panel. `''` means the panel has no sub-view state.
 *
 * @param {unknown} panel
 * @param {unknown} subview
 * @returns {string|null} null when the sub-view is not part of the contract
 */
export function normalizeSpaSubview(panel, subview) {
  if (typeof panel !== 'string' || !panel) return '';
  const allowed = SPA_PANEL_SUBVIEWS[panel];
  if (!allowed) return typeof subview === 'string' && subview ? null : '';
  const text = typeof subview === 'string' ? subview.trim() : '';
  if (!text) return SPA_PANEL_DEFAULT_SUBVIEWS[panel] || '';
  return allowed.includes(text) ? text : null;
}

/**
 * Truthy token of a query flag (`embed=1`, `debugOverlay=true`, ...). Mirrors the
 * readers in app_front so the contract accepts what the UI actually emits.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isTruthyFlagValue(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return text === '1' || text === 'true' || text === 'yes' || text === 'on';
}

/** Legacy view paths that still serve the SPA shell. */
export const SPA_PATH_ALIASES = Object.freeze({
  widget: Object.freeze({ panel: 'settings', settingsTab: 'widgets' }),
});

/** Legacy settings tab ids that still resolve to a current tab. */
export const SPA_SETTINGS_TAB_ALIASES = Object.freeze({
  browser: 'interface-browser',
  ...buildHarnessTabAliases(),
});

const SPA_PANEL_SET = new Set(SPA_PANELS);
const SPA_SETTINGS_TAB_SET = new Set(SPA_SETTINGS_TABS);

/**
 * @param {unknown} panel
 * @returns {{ panel: string, settingsTab: string } | null}
 */
export function remapLegacySpaPanel(panel) {
  if (typeof panel !== 'string' || !panel) return null;
  return SPA_PATH_ALIASES[panel] || null;
}

/**
 * @param {unknown} tabId
 * @returns {string}
 */
export function remapSettingsTab(tabId) {
  if (typeof tabId !== 'string' || !tabId) return '';
  return SPA_SETTINGS_TAB_ALIASES[tabId] || tabId;
}

/**
 * @param {unknown} pathname
 * @returns {string}
 */
function normalizePathname(pathname) {
  if (typeof pathname !== 'string' || !pathname) return '';
  const trimmed = pathname.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return '';
  const noQuery = trimmed.split('?')[0].split('#')[0];
  if (noQuery.length > 1 && noQuery.endsWith('/')) return noQuery.slice(0, -1);
  return noQuery;
}

/**
 * Parse a view path into its contract parts. Returns null for anything that is
 * not an allowlisted SPA shell route.
 *
 * @param {unknown} pathname
 * @returns {{ panel: string, settingsTab: string, subview: string } | null}
 */
function parseSpaPathParts(pathname) {
  const path = normalizePathname(pathname);
  if (!path || path === '/' || path === '/index.html') return null;
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0 || parts.length > 2) return null;
  const panel = parts[0];
  if (parts.length === 1) {
    const alias = SPA_PATH_ALIASES[panel];
    if (alias) return { panel: alias.panel, settingsTab: alias.settingsTab, subview: '' };
  }
  if (!SPA_PANEL_SET.has(panel)) return null;
  if (parts.length === 1) {
    return { panel, settingsTab: '', subview: normalizeSpaSubview(panel, '') || '' };
  }
  if (panel === 'settings') {
    const settingsTab = remapSettingsTab(parts[1]);
    if (!settingsTab || !SPA_SETTINGS_TAB_SET.has(settingsTab)) return null;
    return { panel, settingsTab, subview: '' };
  }
  const subview = normalizeSpaSubview(panel, parts[1]);
  if (!subview) return null;
  return { panel, settingsTab: '', subview };
}

/**
 * @param {unknown} pathname
 * @returns {{ panel: string, settingsTab: string } | null}
 */
export function parseSpaPath(pathname) {
  const parsed = parseSpaPathParts(pathname);
  if (!parsed) return null;
  return { panel: parsed.panel, settingsTab: parsed.settingsTab };
}

/**
 * @param {{ panel?: string, settingsTab?: string, subview?: string }} view
 * @returns {string}
 */
export function buildSpaPath(view = {}) {
  const panel = typeof view.panel === 'string' ? view.panel.trim() : '';
  if (!SPA_PANEL_SET.has(panel)) return '/chat';
  if (panel !== 'settings') {
    const subview = normalizeSpaSubview(panel, view.subview);
    if (!subview || subview === SPA_PANEL_DEFAULT_SUBVIEWS[panel]) return `/${panel}`;
    return `/${panel}/${subview}`;
  }
  const settingsTab = remapSettingsTab(
    typeof view.settingsTab === 'string' ? view.settingsTab.trim() : '',
  );
  if (!settingsTab || !SPA_SETTINGS_TAB_SET.has(settingsTab)) return '/settings';
  return `/settings/${settingsTab}`;
}

/**
 * @param {unknown} pathname
 * @returns {boolean}
 */
export function isSpaShellPath(pathname) {
  const path = normalizePathname(pathname);
  if (path === '/' || path === '/index.html') return true;
  return parseSpaPath(path) !== null;
}

/**
 * Same-origin HTML pages a login redirect may return to. The SPA shell views are
 * the normal case; a widget host additionally returns to its embed page or to
 * the widget authorization page, which are shells in their own right and are
 * never produced from a URL the client controls beyond the installation id.
 */
const LOGIN_NEXT_EXTRA_PATTERNS = Object.freeze([
  /^\/embed\/[^/?#]+$/,
  /^\/widget-authorize\/[^/?#]+$/,
]);

/**
 * @param {unknown} pathname
 * @returns {boolean}
 */
export function isSpaLoginNextPath(pathname) {
  const path = normalizePathname(pathname);
  if (!path) return false;
  if (isSpaShellPath(path)) return true;
  return LOGIN_NEXT_EXTRA_PATTERNS.some((pattern) => pattern.test(path));
}

/**
 * Build a same-origin view URL. Drops legacy `panel` / `tab` query aliases.
 *
 * @param {{
 *   search?: string,
 *   panel?: string,
 *   subview?: string,
 *   settingsTab?: string
 * }} params
 * @returns {string}
 */
export function buildSpaLocation(params = {}) {
  const path = buildSpaPath({
    panel: params.panel,
    subview: params.subview,
    settingsTab: params.settingsTab,
  });
  const search = typeof params.search === 'string' ? params.search : '';
  const query = search.startsWith('?') ? search.slice(1) : search;
  const nextParams = new URLSearchParams(query);
  nextParams.delete('panel');
  nextParams.delete('tab');
  const nextQuery = nextParams.toString();
  return nextQuery ? `${path}?${nextQuery}` : path;
}

/**
 * @typedef {Object} SpaRouteState
 * @property {number} version contract version (RouteState v1)
 * @property {string} panel allowlisted panel id, `''` for the implicit view (`/`)
 * @property {string} subview canonical sub-view (`main` for `/git`, `''` if the panel has none)
 * @property {string} settingsTab resolved settings tab id (`''` outside settings)
 * @property {{ workspaceKey: string, folderKey: string }} context durable route ids
 * @property {string} scope explicit Git scope (`chat` | `todo` | `''`)
 * @property {{ type: string, id: string }} resource derived view of the panel's primary id param
 * @property {Record<string, string>} query allowlisted parameters, canonical order
 * @property {Array<{ key: string, reason: string }>} dropped parameters with the reason
 * @property {boolean} embed whether the URL opted into embed scope
 * @property {string} canonical canonical `path?query` location of this state
 */

/**
 * Query keys a panel may carry, including the shared context and flag params.
 * Used by the contract tests and by later adapters so they never invent a key.
 *
 * @param {unknown} panel
 * @param {{ embed?: boolean }} [options]
 * @returns {string[]}
 */
export function spaRouteQueryKeys(panel, options = {}) {
  const panelKeys = SPA_ROUTE_QUERY_KEYS[typeof panel === 'string' ? panel : ''] || [];
  const keys = [...SPA_ROUTE_CONTEXT_KEYS, ...panelKeys, ...SPA_ROUTE_FLAG_KEYS];
  if (options.embed) keys.push(...SPA_ROUTE_EMBED_KEYS);
  return Array.from(new Set(keys));
}

/**
 * Percent-encode a query value while keeping opaque route ids readable (`:` in
 * `cretli:ws:<uuid>`). Values are validated before they get here, so no
 * delimiter (&, =, #) can survive unencoded.
 *
 * @param {string} value
 * @returns {string}
 */
function encodeRouteQueryValue(value) {
  return encodeURIComponent(value)
    .replace(/%3A/gi, ':')
    .replace(/%40/gi, '@');
}

/**
 * @param {unknown} pathname
 * @param {unknown} search
 * @returns {string}
 */
function normalizeRouteSearch(pathname, search) {
  const fromPathname = typeof pathname === 'string' ? pathname.split('?')[1] : '';
  const raw = typeof search === 'string' && search ? search : fromPathname || '';
  if (!raw) return '';
  const withoutPrefix = raw.startsWith('?') ? raw.slice(1) : raw;
  const hashIndex = withoutPrefix.indexOf('#');
  return hashIndex === -1 ? withoutPrefix : withoutPrefix.slice(0, hashIndex);
}

/**
 * Read the allowlisted parameters of a view URL. Unknown keys, keys that belong
 * to another panel, values that fail validation and repeated keys are dropped
 * and reported, so a route can never smuggle a path, a secret or an arbitrary
 * filter into the SPA.
 *
 * @param {string} panel
 * @param {URLSearchParams} params
 * @param {{ embed: boolean }} scope
 * @returns {{ query: Record<string, string>, dropped: Array<{ key: string, reason: string }> }}
 */
function readAllowedQuery(panel, params, scope) {
  const allowedKeys = spaRouteQueryKeys(panel, { embed: scope.embed });
  const allowlist = new Set(allowedKeys);
  const seen = new Set();
  const query = {};
  /** @type {Array<{ key: string, reason: string }>} */
  const dropped = [];
  for (const [key, value] of params.entries()) {
    if (SPA_LEGACY_QUERY_KEYS.includes(key)) continue;
    const trimmed = value.trim();
    if (!allowlist.has(key)) {
      dropped.push({ key, reason: seen.has(key) ? 'duplicate' : 'not-allowed-for-panel' });
      continue;
    }
    if (seen.has(key)) {
      dropped.push({ key, reason: 'duplicate' });
      continue;
    }
    seen.add(key);
    if (!trimmed) {
      dropped.push({ key, reason: 'empty' });
      continue;
    }
    if (!isValidQueryValue(key, trimmed)) {
      dropped.push({ key, reason: 'invalid-value' });
      continue;
    }
    query[key] = trimmed;
  }
  // `embed` is a flag: keep the raw token so a builder can re-emit it.
  if (scope.embed && !('embed' in query)) query.embed = '1';
  return { query, dropped };
}

/**
 * Parse a location into RouteState v1. Returns null when the pathname is not an
 * allowlisted shell route (the server must answer 404 instead of serving a shell).
 *
 * Legacy input is accepted and canonicalized: `?panel=`/`?tab=` aliases, the
 * `/widget` path alias and legacy harness/browser settings tabs.
 *
 * @param {unknown} input pathname string or `{ pathname, search }`
 * @param {unknown} [maybeSearch]
 * @returns {SpaRouteState | null}
 */
export function parseSpaRoute(input, maybeSearch) {
  const pathname = typeof input === 'string' ? input : input?.pathname;
  const search = normalizeRouteSearch(
    pathname,
    typeof input === 'string' ? maybeSearch : input?.search,
  );
  const path = normalizePathname(pathname);
  if (!path) return null;
  const implicit = path === '/' || path === '/index.html';
  const parsed = implicit ? null : parseSpaPathParts(path);
  if (!implicit && !parsed) return null;
  const params = new URLSearchParams(search);
  const embed = isTruthyFlagValue(params.get('embed')) || path.startsWith('/embed/');

  let panel = parsed?.panel || '';
  let settingsTab = parsed?.settingsTab || '';
  let subview = parsed?.subview || '';
  /** @type {Array<{ key: string, reason: string }>} */
  const dropped = [];
  if (implicit) {
    const legacyPanel = (params.get('panel') || '').trim();
    const legacyTab = (params.get('tab') || '').trim();
    const alias = remapLegacySpaPanel(legacyPanel);
    if (alias) {
      panel = alias.panel;
      settingsTab = alias.settingsTab;
      dropped.push({ key: 'panel', reason: 'aliased' });
    } else if (legacyPanel) {
      const known = SPA_PANEL_SET.has(legacyPanel) ? legacyPanel : '';
      if (known) {
        panel = known;
        subview = normalizeSpaSubview(known, '') || '';
      } else {
        dropped.push({ key: 'panel', reason: 'invalid-value' });
      }
      if (panel) dropped.push({ key: 'panel', reason: 'aliased' });
    }
    if (legacyTab) {
      if (panel === 'settings') {
        const tab = remapSettingsTab(legacyTab);
        if (tab && SPA_SETTINGS_TAB_SET.has(tab)) settingsTab = tab;
        else dropped.push({ key: 'tab', reason: 'invalid-value' });
        dropped.push({ key: 'tab', reason: 'aliased' });
      } else {
        dropped.push({ key: 'tab', reason: 'not-allowed-for-panel' });
      }
    }
  } else if (params.has('panel') || params.has('tab')) {
    if (params.has('panel')) dropped.push({ key: 'panel', reason: 'ignored-explicit-path' });
    if (params.has('tab')) dropped.push({ key: 'tab', reason: 'ignored-explicit-path' });
  }

  const allowed = readAllowedQuery(panel, params, { embed });
  dropped.push(...allowed.dropped);
  const query = allowed.query;
  const context = {
    workspaceKey: query.ws || '',
    folderKey: query.folder || '',
  };
  let scope = '';
  if (panel === 'git' && query.scope) {
    const scopedResourceId = query[query.scope] || '';
    if (scopedResourceId) scope = query.scope;
    else {
      delete query.scope;
      dropped.push({ key: 'scope', reason: 'missing-scope-resource' });
    }
  } else if (query.scope) {
    delete query.scope;
    dropped.push({ key: 'scope', reason: 'not-allowed-for-panel' });
  }
  const resourceKey = panel === 'git' ? (scope || '') : SPA_PANEL_RESOURCE_KEYS[panel] || '';
  const resource = {
    type: panel === 'git' ? scope : resourceKey,
    id: resourceKey ? query[resourceKey] || '' : '',
  };
  const route = {
    version: SPA_ROUTE_CONTRACT_VERSION,
    panel,
    subview,
    settingsTab,
    context,
    scope,
    resource,
    query,
    dropped,
    embed,
    canonical: '',
  };
  route.canonical = buildSpaRoute(route);
  return route;
}

/**
 * Serialize RouteState v1 into its canonical same-origin location. `query` is the
 * single source of truth for parameters; `resource` and `scope` are views of it.
 * Keys are emitted in a fixed order so the same state always yields one address.
 *
 * @param {Partial<SpaRouteState> & { query?: Record<string, string> }} route
 * @returns {string}
 */
export function buildSpaRoute(route = {}) {
  const panel = typeof route.panel === 'string' ? route.panel : '';
  const path = panel
    ? buildSpaPath({ panel, subview: route.subview, settingsTab: route.settingsTab })
    : '/';
  const source = route.query && typeof route.query === 'object' ? route.query : {};
  const context = route.context && typeof route.context === 'object' ? route.context : {};
  /** @type {Record<string, string>} */
  const values = { ...source };
  if (typeof context.workspaceKey === 'string' && context.workspaceKey) values.ws = context.workspaceKey;
  if (typeof context.folderKey === 'string' && context.folderKey) values.folder = context.folderKey;
  if (panel === 'git' && typeof route.scope === 'string' && route.scope.trim()) {
    values.scope = route.scope.trim();
  }
  applyGitScopeCoupling(panel, values);
  const allowed = new Set(spaRouteQueryKeys(panel, { embed: route.embed === true }));
  const order = Array.from(new Set([
    ...SPA_ROUTE_CONTEXT_KEYS,
    ...(panel === 'git' ? ['scope'] : []),
    ...(SPA_ROUTE_QUERY_KEYS[panel] || []),
    ...SPA_ROUTE_FLAG_KEYS,
    ...(route.embed === true ? SPA_ROUTE_EMBED_KEYS : []),
  ]));
  const parts = [];
  for (const key of order) {
    if (!allowed.has(key)) continue;
    const value = typeof values[key] === 'string' ? values[key].trim() : '';
    if (!value) continue;
    if (!isValidQueryValue(key, value)) continue;
    parts.push(`${encodeRouteQueryValue(key)}=${encodeRouteQueryValue(value)}`);
  }
  return parts.length ? `${path}?${parts.join('&')}` : path;
}

/**
 * Canonical location for a request URL, or `''` when it is not a shell route.
 * Server shell routes and the service worker use this so they cannot drift.
 *
 * @param {unknown} pathname
 * @param {unknown} [search]
 * @returns {string}
 */
export function canonicalSpaLocation(pathname, search) {
  const route = parseSpaRoute(
    typeof pathname === 'string' ? { pathname, search } : pathname,
  );
  return route ? route.canonical : '';
}
