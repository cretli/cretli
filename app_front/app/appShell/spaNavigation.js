/**
 * SPA navigation (plan stage 3): single owner of History API writes.
 *
 * Pipeline: parse → view context → ensurePanelReady → paint panels → restore.
 * A monotonic generation drops late async chunks so a slow A→B cannot repaint B
 * with stale data or switch the view after the user already moved on.
 */

import {
  SPA_ROUTE_QUERY_KEYS,
  buildSpaRoute,
  parseSpaRoute,
  remapLegacySpaPanel,
  remapSettingsTab,
} from '../../../lib/spa-routes.js';
import { buildViewKey } from './viewMemory.js';

export const CR_NAVIGATION_STATE_KEY = 'crNavigation';
export const CR_NAVIGATION_STATE_VERSION = 1;

/**
 * @param {Record<string, unknown>} base
 * @param {Record<string, unknown>} slice
 * @returns {Record<string, unknown>}
 */
export function mergeHistoryState(base, slice) {
  const prev = base && typeof base === 'object' ? base : {};
  const nextNav = slice && typeof slice === 'object' ? slice : {};
  const prevNav = prev[CR_NAVIGATION_STATE_KEY] && typeof prev[CR_NAVIGATION_STATE_KEY] === 'object'
    ? prev[CR_NAVIGATION_STATE_KEY]
    : {};
  return {
    ...prev,
    [CR_NAVIGATION_STATE_KEY]: {
      ...prevNav,
      ...nextNav,
      version: CR_NAVIGATION_STATE_VERSION,
    },
  };
}

/**
 * @param {import('../../../lib/spa-routes.js').SpaRouteState} route
 * @returns {string}
 */
export function buildCrNavigationViewKey(route) {
  return buildViewKey(route);
}

/**
 * @returns {string}
 */
export function createHistoryEntryId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @param {{ pathname?: string, search?: string } | null | undefined} locationInfo
 * @returns {import('../../../lib/spa-routes.js').SpaRouteState | null}
 */
export function readRouteFromLocation(locationInfo) {
  if (!locationInfo) return null;
  return parseSpaRoute({
    pathname: locationInfo.pathname || '/',
    search: locationInfo.search || '',
  });
}

/**
 * Parse a same-origin notification/PWA action URL through the shared route
 * parser (legacy panel/tab/chat aliases included).
 *
 * @param {string} safeRelative path or `?query` validated by resolveNotificationActionUrl
 * @param {string} [origin] default https://app.local
 * @returns {import('../../../lib/spa-routes.js').SpaRouteState | null}
 */
export function parseNotificationActionRoute(safeRelative, origin = 'https://app.local') {
  const text = trimmed(safeRelative);
  if (!text) return null;
  let url = null;
  try {
    url = new URL(text.startsWith('?') ? `/${text}` : text, origin);
  } catch {
    return null;
  }
  return parseSpaRoute({ pathname: url.pathname || '/', search: url.search || '' });
}

/**
 * @param {import('../../../lib/spa-routes.js').SpaRouteState | null | undefined} route
 * @param {string} panel
 * @returns {Record<string, string>}
 */
function panelQueryWithoutForeignResources(route, panel) {
  const source = route?.query && typeof route.query === 'object' ? route.query : {};
  const allowed = new Set(SPA_ROUTE_QUERY_KEYS[panel] || []);
  /** @type {Record<string, string>} */
  const next = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === 'ws' || key === 'folder' || allowed.has(key)) {
      next[key] = value;
    }
  }
  return next;
}

/**
 * Merge a navigation intent onto the current (or implicit) route.
 *
 * @param {import('../../../lib/spa-routes.js').SpaRouteState | null} current
 * @param {object} intent
 * @returns {import('../../../lib/spa-routes.js').SpaRouteState}
 */
export function mergeRouteIntent(current, intent = {}) {
  const source = intent && typeof intent === 'object' ? intent : {};
  const base = current || parseSpaRoute({ pathname: '/', search: '' });
  const panel = trimmed(source.panel) || base?.panel || 'chat';
  const settingsTab = source.settingsTab !== undefined
    ? remapSettingsTab(trimmed(source.settingsTab))
    : (panel === 'settings' ? base?.settingsTab || '' : '');
  const subview = source.subview !== undefined ? trimmed(source.subview) : (base?.subview || '');
  const context = {
    workspaceKey: source.context?.workspaceKey !== undefined
      ? trimmed(source.context.workspaceKey)
      : (base?.context?.workspaceKey || ''),
    folderKey: source.context?.folderKey !== undefined
      ? trimmed(source.context.folderKey)
      : (base?.context?.folderKey || ''),
  };
  let query = panelQueryWithoutForeignResources(base, panel);
  if (source.query && typeof source.query === 'object') {
    query = { ...query, ...source.query };
  }
  if (source.resource?.id && source.resource?.type) {
    const type = trimmed(source.resource.type);
    const id = trimmed(source.resource.id);
    if (type === 'chat') {
      query.chat = id;
      delete query.todo;
    } else if (type === 'todo') {
      query.todo = id;
      delete query.chat;
    }
  }
  let scope = source.scope !== undefined ? trimmed(source.scope) : (base?.scope || '');
  if (panel !== 'git') scope = '';
  const route = {
    version: base?.version || 1,
    panel,
    subview: panel === 'git' ? subview : '',
    settingsTab: panel === 'settings' ? settingsTab : '',
    context,
    scope,
    resource: { type: '', id: '' },
    query,
    dropped: [],
    embed: base?.embed === true || source.embed === true,
    canonical: '',
  };
  route.canonical = buildSpaRoute(route);
  return route;
}

/**
 * @param {{
 *   canonicalNext: string,
 *   canonicalCurrent: string,
 *   popstate?: boolean,
 *   boot?: boolean,
 *   canonicalize?: boolean,
 *   explicit?: boolean,
 * }} input
 * @returns {'push'|'replace'|'none'}
 */
export function resolveHistoryWrite(input) {
  if (input.popstate) return 'none';
  if (input.canonicalNext === input.canonicalCurrent) return 'none';
  if (input.boot || input.canonicalize) return 'replace';
  if (input.explicit) return 'push';
  return 'replace';
}

/**
 * @param {{
 *   readLocation?: () => { pathname?: string, search?: string } | null,
 *   writeHistory?: (url: string, mode: 'push'|'replace'|'none', state: object) => void,
 *   applyRouteContext?: () => Promise<object>,
 *   ensurePanelReady?: (panelId: string) => Promise<void>,
 *   showPanel?: (panelId: string, modeConfig?: object) => void,
 *   applySettingsTab?: (tabId: string) => void,
 *   applyGitSubview?: (subview: string) => void,
 *   applyRouteGitScope?: () => void,
 *   restoreRouteResources?: (route: object, token: number) => Promise<void>,
 *   isPanelAllowed?: (panelId: string, modeConfig?: object) => boolean,
 *   getModeConfig?: () => object,
 *   whenScopedAccessAllowed?: () => Promise<object | null>,
 *   registerPopstate?: (handler: () => void) => void,
 *   persistRoute?: (route: object) => void,
 *   restoreViewMemory?: (route: object, token: number) => void | Promise<void>,
 *   now?: () => number,
 * }} deps
 */
export function createSpaNavigation(deps = {}) {
  const readLocation = typeof deps.readLocation === 'function'
    ? deps.readLocation
    : () => null;
  const writeHistory = typeof deps.writeHistory === 'function'
    ? deps.writeHistory
    : () => {};
  const applyRouteContext = typeof deps.applyRouteContext === 'function'
    ? deps.applyRouteContext
    : async () => ({});
  const ensurePanelReady = typeof deps.ensurePanelReady === 'function'
    ? deps.ensurePanelReady
    : async () => {};
  const showPanel = typeof deps.showPanel === 'function' ? deps.showPanel : () => {};
  const applySettingsTab = typeof deps.applySettingsTab === 'function'
    ? deps.applySettingsTab
    : () => {};
  const applyGitSubview = typeof deps.applyGitSubview === 'function'
    ? deps.applyGitSubview
    : () => {};
  const applyRouteGitScope = typeof deps.applyRouteGitScope === 'function'
    ? deps.applyRouteGitScope
    : () => {};
  const restoreRouteResources = typeof deps.restoreRouteResources === 'function'
    ? deps.restoreRouteResources
    : async () => {};
  const isPanelAllowed = typeof deps.isPanelAllowed === 'function'
    ? deps.isPanelAllowed
    : () => true;
  const getModeConfig = typeof deps.getModeConfig === 'function'
    ? deps.getModeConfig
    : () => ({});
  const whenScopedAccessAllowed = typeof deps.whenScopedAccessAllowed === 'function'
    ? deps.whenScopedAccessAllowed
    : async () => null;
  const registerPopstate = typeof deps.registerPopstate === 'function'
    ? deps.registerPopstate
    : null;
  const persistRoute = typeof deps.persistRoute === 'function'
    ? deps.persistRoute
    : null;
  const restoreViewMemory = typeof deps.restoreViewMemory === 'function'
    ? deps.restoreViewMemory
    : null;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();

  let generation = 0;
  let popstateBound = false;
  let activeEntryId = createHistoryEntryId();

  /** @type {Promise<void> | null} */
  let inFlight = null;

  function currentCanonical() {
    const loc = readLocation();
    if (!loc) return '';
    const route = readRouteFromLocation(loc);
    return route?.canonical || `${loc.pathname || '/'}${loc.search || ''}`;
  }

  function commitHistory(url, mode, route, token) {
    if (mode === 'none') return;
    const foreign = typeof deps.readHistoryState === 'function' ? deps.readHistoryState() : {};
    const foreignNav = foreign?.[CR_NAVIGATION_STATE_KEY];
    if (mode === 'push' || !trimmed(foreignNav?.entryId)) {
      activeEntryId = createHistoryEntryId();
    } else {
      activeEntryId = trimmed(foreignNav?.entryId) || activeEntryId;
    }
    const state = mergeHistoryState(foreign, {
      entryId: activeEntryId,
      viewKey: buildCrNavigationViewKey(route),
      generation: token,
      at: now(),
      panel: route.panel,
      canonical: url,
    });
    writeHistory(url, mode, state);
  }

  /**
   * @param {import('../../../lib/spa-routes.js').SpaRouteState} route
   * @param {{
   *   history?: 'push'|'replace'|'none',
   *   token?: number,
   * }} options
   */
  async function applyRoute(route, options = {}) {
    const token = Number.isFinite(options.token) ? Number(options.token) : ++generation;
    generation = token;
    const modeConfig = getModeConfig();
    const panel = trimmed(route.panel) || 'chat';
    if (!isPanelAllowed(panel, modeConfig)) return;
    await whenScopedAccessAllowed();
    if (token !== generation) return;
    await applyRouteContext();
    if (token !== generation) return;
    await ensurePanelReady(panel === 'settings' ? 'settings' : panel);
    if (token !== generation) return;
    showPanel(panel, modeConfig);
    if (token !== generation) return;
    if (panel === 'settings' && route.settingsTab) applySettingsTab(route.settingsTab);
    if (panel === 'git') applyGitSubview(route.subview || 'main');
    applyRouteGitScope();
    await restoreRouteResources(route, token);
    if (token !== generation) return;
    if (restoreViewMemory) await restoreViewMemory(route, token);
    if (token !== generation) return;
    if (persistRoute) persistRoute(route);
  }

  /**
   * @param {object} intent partial route update
   * @param {{ history?: 'push'|'replace'|'none', explicit?: boolean }} [options]
   */
  async function navigate(intent, options = {}) {
    const token = ++generation;
    const loc = readLocation();
    const current = readRouteFromLocation(loc);
    const merged = mergeRouteIntent(current, intent);
    const canonicalCurrent = current?.canonical || currentCanonical();
    const explicit = options.explicit !== false;
    const history = options.history || resolveHistoryWrite({
      canonicalNext: merged.canonical,
      canonicalCurrent,
      explicit,
    });
    if (history !== 'none' && merged.canonical !== canonicalCurrent) {
      commitHistory(merged.canonical, history, merged, token);
    }
    const run = applyRoute(merged, { history: 'none', token });
    inFlight = run;
    await run;
  }

  async function applyFromLocation(options = {}) {
    const loc = readLocation();
    const route = readRouteFromLocation(loc);
    if (!route) return;
    const token = ++generation;
    const history = options.history || (options.popstate ? 'none' : 'replace');
    if (history !== 'none' && route.canonical !== currentCanonical()) {
      commitHistory(route.canonical, history, route, token);
    }
    const run = applyRoute(route, { history: 'none', token });
    inFlight = run;
    await run;
  }

  /**
   * Boot: canonicalize implicit `/` + legacy query into one replace entry.
   *
   * @param {object} bootIntent panel/settings/resource from resolveInitialPanel
   */
  async function bootApply(bootIntent) {
    const loc = readLocation();
    const parsed = readRouteFromLocation(loc);
    const merged = mergeRouteIntent(parsed, bootIntent);
    const canonicalCurrent = parsed?.canonical
      || `${loc?.pathname || '/'}${loc?.search || ''}`;
    const history = resolveHistoryWrite({
      canonicalNext: merged.canonical,
      canonicalCurrent,
      boot: true,
    });
    const token = ++generation;
    if (history !== 'none' && merged.canonical !== canonicalCurrent) {
      commitHistory(merged.canonical, history, merged, token);
    }
    const run = applyRoute(merged, { history: 'none', token });
    inFlight = run;
    await run;
  }

  function replaceCanonicalUrl(canonicalPath) {
    if (typeof canonicalPath !== 'string' || !canonicalPath.startsWith('/')) return;
    const current = currentCanonical();
    if (current === canonicalPath) return;
    const loc = readLocation();
    const route = readRouteFromLocation(loc) || mergeRouteIntent(null, {});
    const parsed = parseSpaRoute(canonicalPath);
    const merged = parsed || { ...route, canonical: canonicalPath };
    const token = ++generation;
    commitHistory(canonicalPath, 'replace', merged, token);
  }

  function initPopstate() {
    if (popstateBound || !registerPopstate) return;
    popstateBound = true;
    registerPopstate(() => {
      void applyFromLocation({ popstate: true, history: 'none' });
    });
  }

  return {
    getGeneration: () => generation,
    isCurrentGeneration: (token) => token === generation,
    navigate,
    applyFromLocation,
    bootApply,
    replaceCanonicalUrl,
    initPopstate,
    mergeRouteIntent,
    parseNotificationActionRoute: (url) => parseNotificationActionRoute(url),
  };
}

/**
 * Build a route intent from legacy `?panel=` / `?tab=` / `?chat=` aliases.
 *
 * @param {import('../../../lib/spa-routes.js').SpaRouteState | null} route
 * @returns {object | null}
 */
export function legacyPanelOpenDetailFromRoute(route) {
  if (!route?.panel) return null;
  const detail = { panel: route.panel };
  if (route.settingsTab) detail.settingsTab = route.settingsTab;
  if (route.resource?.id) {
    detail.resource = { ...route.resource };
  }
  if (route.context?.workspaceKey || route.context?.folderKey) {
    detail.context = { ...route.context };
  }
  if (route.subview) detail.subview = route.subview;
  if (route.scope) detail.scope = route.scope;
  if (route.query && typeof route.query === 'object') detail.query = { ...route.query };
  return detail;
}

/**
 * @param {unknown} panel
 * @returns {{ panel: string, settingsTab: string } | null}
 */
export function normalizeLegacyPanelAlias(panel) {
  return remapLegacySpaPanel(panel);
}
