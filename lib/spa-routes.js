/**
 * Shared SPA view paths. No Node APIs — imported by the server and the frontend.
 */

export const SPA_PANELS = Object.freeze([
  'chat',
  'terminal',
  'tasks',
  'agents',
  'todo',
  'files',
  'git',
  'github',
  'logs',
  'instances',
  'tests',
  'settings',
]);

export const SPA_SETTINGS_TABS = Object.freeze([
  'workspace',
  'connection',
  'harness',
  'interface',
  'browser',
  'chat',
  'widgets',
  'usage',
  'account',
]);

/** Legacy view paths that still serve the SPA shell. */
export const SPA_PATH_ALIASES = Object.freeze({
  widget: Object.freeze({ panel: 'settings', settingsTab: 'widgets' }),
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
 * @param {unknown} pathname
 * @returns {{ panel: string, settingsTab: string } | null}
 */
export function parseSpaPath(pathname) {
  const path = normalizePathname(pathname);
  if (!path || path === '/' || path === '/index.html') return null;
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0 || parts.length > 2) return null;
  const panel = parts[0];
  if (parts.length === 1) {
    const alias = SPA_PATH_ALIASES[panel];
    if (alias) return { panel: alias.panel, settingsTab: alias.settingsTab };
  }
  if (!SPA_PANEL_SET.has(panel)) return null;
  if (parts.length === 1) return { panel, settingsTab: '' };
  if (panel !== 'settings') return null;
  const settingsTab = parts[1];
  if (!SPA_SETTINGS_TAB_SET.has(settingsTab)) return null;
  return { panel, settingsTab };
}

/**
 * @param {{ panel?: string, settingsTab?: string }} view
 * @returns {string}
 */
export function buildSpaPath(view = {}) {
  const panel = typeof view.panel === 'string' ? view.panel.trim() : '';
  if (!SPA_PANEL_SET.has(panel)) return '/chat';
  if (panel !== 'settings') return `/${panel}`;
  const settingsTab = typeof view.settingsTab === 'string' ? view.settingsTab.trim() : '';
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
 * Build a same-origin view URL. Drops legacy `panel` / `tab` query aliases.
 *
 * @param {{
 *   search?: string,
 *   panel?: string,
 *   settingsTab?: string
 * }} params
 * @returns {string}
 */
export function buildSpaLocation(params = {}) {
  const path = buildSpaPath({
    panel: params.panel,
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
