/**
 * Route persistence v1 (navigation plan stage 5).
 *
 * Remembers the last canonical view per tab (sessionStorage) and globally
 * (localStorage). Legacy `cretli-last-panel` / `cretli-settings-tab` migrate
 * into v1 on read. Volatile resource ids and one-shot notification flags are
 * never written to the global fallback.
 */

import {
  buildSpaRoute,
  parseSpaRoute,
  remapLegacySpaPanel,
  remapSettingsTab,
} from '../../../lib/spa-routes.js';
import { readStorageValueWithAlias } from '../../lib/storageKeyAlias.js';

export const VIEW_ROUTE_STORAGE_VERSION = 1;
export const VIEW_ROUTE_SESSION_KEY = 'cretli-view-route-v1';
export const VIEW_ROUTE_LOCAL_KEY = 'cretli-view-route-v1';
export const LEGACY_LAST_PANEL_KEY = 'cretli-last-panel';
export const LEGACY_SETTINGS_TAB_KEY = 'cretli-settings-tab';

/** Resource query keys that must not survive in the global fallback route. */
export const VOLATILE_ROUTE_QUERY_KEYS = Object.freeze([
  'session',
  'browserSession',
  'browserTab',
  'run',
]);

/** Boot flags that must not be replayed from storage. */
export const ONE_SHOT_ROUTE_QUERY_KEYS = Object.freeze(['source']);

export const VIEW_ROUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const VIEW_ROUTE_MAX_BYTES = 4096;

/**
 * @param {unknown} value
 * @returns {string}
 */
function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @param {{ pathname?: string, search?: string }} location
 * @returns {boolean}
 */
export function isExplicitNavigationLocation(location) {
  const pathname = trimmed(location?.pathname) || '/';
  const normalized = pathname.length > 1 && pathname.endsWith('/')
    ? pathname.slice(0, -1)
    : pathname;
  if (normalized !== '/' && normalized !== '/index.html') return true;
  const search = trimmed(location?.search);
  if (!search) return false;
  const params = new URLSearchParams(search.startsWith('?') ? search : `?${search}`);
  if (params.get('panel') || params.get('tab')) return true;
  const route = parseSpaRoute({ pathname: '/', search });
  if (!route) return false;
  const hasContext = Boolean(route.context?.workspaceKey || route.context?.folderKey);
  const hasResource = Boolean(route.resource?.id);
  const hasScope = Boolean(route.scope);
  const hasFlags = ONE_SHOT_ROUTE_QUERY_KEYS.some((key) => params.has(key));
  return hasContext || hasResource || hasScope || hasFlags || Boolean(route.panel);
}

/**
 * @param {Record<string, string>} query
 * @returns {Record<string, string>}
 */
export function stripVolatileRouteQuery(query = {}) {
  const next = { ...query };
  for (const key of [...VOLATILE_ROUTE_QUERY_KEYS, ...ONE_SHOT_ROUTE_QUERY_KEYS]) {
    delete next[key];
  }
  return next;
}

/**
 * @param {import('../../../lib/spa-routes.js').SpaRouteState | null | undefined} route
 * @returns {string}
 */
export function sanitizeRouteForPersistence(route) {
  if (!route) return '/chat';
  const panel = trimmed(route.panel) || 'chat';
  let subview = trimmed(route.subview);
  if (panel === 'git') subview = 'main';
  const intent = {
    panel,
    settingsTab: panel === 'settings' ? trimmed(route.settingsTab) : '',
    subview: panel === 'git' ? subview : (panel === 'settings' ? '' : subview),
    context: {
      workspaceKey: trimmed(route.context?.workspaceKey),
      folderKey: trimmed(route.context?.folderKey),
    },
    scope: panel === 'git' ? trimmed(route.scope) : '',
    query: stripVolatileRouteQuery(route.query || {}),
  };
  if (intent.scope && intent.query[intent.scope]) {
    intent.query = { ...intent.query };
  } else if (intent.scope) {
    intent.scope = '';
  }
  const merged = parseSpaRoute(buildSpaRoute({
    version: route.version || VIEW_ROUTE_STORAGE_VERSION,
    panel: intent.panel,
    subview: intent.subview,
    settingsTab: intent.settingsTab,
    context: intent.context,
    scope: intent.scope,
    resource: { type: '', id: '' },
    query: intent.query,
    dropped: [],
    embed: route.embed === true,
    canonical: '',
  }));
  return merged?.canonical || buildSpaRoute({
    version: VIEW_ROUTE_STORAGE_VERSION,
    panel: intent.panel,
    subview: intent.subview,
    settingsTab: intent.settingsTab,
    context: intent.context,
    scope: intent.scope,
    resource: { type: '', id: '' },
    query: intent.query,
    dropped: [],
    embed: false,
    canonical: '',
  });
}

/**
 * @param {unknown} raw
 * @param {number} now
 * @returns {{ version: number, route: string, updatedAt: number } | null}
 */
export function parseViewRouteRecord(raw, now = Date.now()) {
  if (typeof raw !== 'string' || !raw) return null;
  if (raw.length > VIEW_ROUTE_MAX_BYTES) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (Number(parsed.version) !== VIEW_ROUTE_STORAGE_VERSION) return null;
  const route = trimmed(parsed.route);
  if (!route.startsWith('/')) return null;
  const updatedAt = Number(parsed.updatedAt);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return null;
  if (now - updatedAt > VIEW_ROUTE_TTL_MS) return null;
  const state = parseSpaRoute(route);
  if (!state) return null;
  return { version: VIEW_ROUTE_STORAGE_VERSION, route: state.canonical || route, updatedAt };
}

/**
 * @param {string} canonicalRoute
 * @param {number} [now]
 * @returns {string}
 */
export function serializeViewRouteRecord(canonicalRoute, now = Date.now()) {
  const route = trimmed(canonicalRoute);
  const payload = {
    version: VIEW_ROUTE_STORAGE_VERSION,
    route: route || '/chat',
    updatedAt: now,
  };
  const text = JSON.stringify(payload);
  if (text.length > VIEW_ROUTE_MAX_BYTES) {
    return JSON.stringify({
      version: VIEW_ROUTE_STORAGE_VERSION,
      route: '/chat',
      updatedAt: now,
    });
  }
  return text;
}

/**
 * @param {import('../../../lib/spa-routes.js').SpaRouteState | null | undefined} route
 * @returns {object}
 */
export function routeStateToBootIntent(route) {
  if (!route) return { panel: 'chat' };
  const panel = trimmed(route.panel) || 'chat';
  const routeSubview = trimmed(route.subview);
  const intent = {
    panel,
    settingsTab: panel === 'settings' ? trimmed(route.settingsTab) : '',
    subview: panel === 'git' ? (routeSubview || 'main') : routeSubview,
    context: {
      workspaceKey: trimmed(route.context?.workspaceKey),
      folderKey: trimmed(route.context?.folderKey),
    },
    query: { ...(route.query || {}) },
  };
  if (panel === 'git' && route.scope && route.query?.[route.scope]) {
    intent.scope = route.scope;
    if (route.resource?.id) {
      intent.resource = { type: route.resource.type, id: route.resource.id };
    }
  }
  return intent;
}

/**
 * @param {Storage | null | undefined} storage
 * @returns {string}
 */
export function legacyPanelRouteFromStorage(storage) {
  if (!storage) return '';
  let panel = '';
  let settingsTab = '';
  try {
    panel = readStorageValueWithAlias(storage, LEGACY_LAST_PANEL_KEY, '');
    settingsTab = readStorageValueWithAlias(storage, LEGACY_SETTINGS_TAB_KEY, '');
  } catch {
    return '';
  }
  const remapped = remapLegacySpaPanel(panel);
  const resolvedPanel = remapped?.panel || panel;
  const resolvedTab = remapped?.settingsTab
    || (resolvedPanel === 'settings' ? remapSettingsTab(settingsTab) : '');
  if (!resolvedPanel) return '';
  const route = parseSpaRoute(buildSpaRoute({
    version: VIEW_ROUTE_STORAGE_VERSION,
    panel: resolvedPanel,
    subview: resolvedPanel === 'git' ? 'main' : '',
    settingsTab: resolvedTab,
    context: { workspaceKey: '', folderKey: '' },
    scope: '',
    resource: { type: '', id: '' },
    query: {},
    dropped: [],
    embed: false,
    canonical: '',
  }));
  return route?.canonical || '';
}

/**
 * @param {{
 *   location: { pathname?: string, search?: string },
 *   sessionStorage?: Storage | null,
 *   localStorage?: Storage | null,
 *   defaultPanel?: string,
 *   now?: () => number,
 * }} input
 * @returns {{ explicit: boolean, canonical: string, intent: object, source: string }}
 */
export function resolveBootRouteIntent(input = {}) {
  const location = input.location || { pathname: '/', search: '' };
  const now = typeof input.now === 'function' ? input.now() : Date.now();
  const defaultPanel = trimmed(input.defaultPanel) || 'chat';
  const parsed = parseSpaRoute(location);
  if (isExplicitNavigationLocation(location) && parsed) {
    return {
      explicit: true,
      canonical: parsed.canonical || '/chat',
      intent: routeStateToBootIntent(parsed),
      source: 'url',
    };
  }
  let sessionRecord = null;
  try {
    sessionRecord = parseViewRouteRecord(
      input.sessionStorage?.getItem(VIEW_ROUTE_SESSION_KEY),
      now,
    );
  } catch {
    sessionRecord = null;
  }
  if (sessionRecord) {
    const route = parseSpaRoute(sessionRecord.route);
    return {
      explicit: false,
      canonical: sessionRecord.route,
      intent: routeStateToBootIntent(route),
      source: 'session',
    };
  }
  let localRecord = null;
  try {
    localRecord = parseViewRouteRecord(
      input.localStorage?.getItem(VIEW_ROUTE_LOCAL_KEY),
      now,
    );
  } catch {
    localRecord = null;
  }
  if (localRecord) {
    const route = parseSpaRoute(localRecord.route);
    return {
      explicit: false,
      canonical: localRecord.route,
      intent: routeStateToBootIntent(route),
      source: 'local',
    };
  }
  const legacy = legacyPanelRouteFromStorage(input.localStorage);
  if (legacy) {
    const route = parseSpaRoute(legacy);
    return {
      explicit: false,
      canonical: legacy,
      intent: routeStateToBootIntent(route),
      source: 'legacy',
    };
  }
  const fallback = parseSpaRoute(buildSpaRoute({
    version: VIEW_ROUTE_STORAGE_VERSION,
    panel: defaultPanel,
    subview: '',
    settingsTab: '',
    context: { workspaceKey: '', folderKey: '' },
    scope: '',
    resource: { type: '', id: '' },
    query: {},
    dropped: [],
    embed: false,
    canonical: '',
  }));
  return {
    explicit: false,
    canonical: fallback?.canonical || '/chat',
    intent: routeStateToBootIntent(fallback),
    source: 'default',
  };
}

/**
 * @param {import('../../../lib/spa-routes.js').SpaRouteState | null | undefined} route
 * @param {{
 *   sessionStorage?: Storage | null,
 *   localStorage?: Storage | null,
 *   now?: () => number,
 * }} [targets]
 */
export function persistViewRoute(route, targets = {}) {
  const canonical = sanitizeRouteForPersistence(route);
  const now = typeof targets.now === 'function' ? targets.now() : Date.now();
  const payload = serializeViewRouteRecord(canonical, now);
  try {
    targets.sessionStorage?.setItem(VIEW_ROUTE_SESSION_KEY, payload);
  } catch {
    // Storage may be unavailable; boot must still work.
  }
  try {
    targets.localStorage?.setItem(VIEW_ROUTE_LOCAL_KEY, payload);
  } catch {
    // Ignore quota/private mode for the global fallback.
  }
}
