/**
 * Route resource adapters (navigation plan stage 5).
 *
 * Best-effort restore for Files, Browser, Tasks, Agents and Terminal query
 * parameters. A missing or expired resource shows a safe screen and replaces
 * the URL — never auto-spawns PTY, browser sessions or Git actions.
 */

import { buildSpaRoute, isRelativeRoutePath, parseSpaRoute } from '../../../lib/spa-routes.js';
import { mergeRouteIntent } from './spaNavigation.js';

/**
 * @param {unknown} value
 * @returns {string}
 */
function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @param {import('../../../lib/spa-routes.js').SpaRouteState} route
 * @param {string[]} removeKeys
 * @returns {string}
 */
export function buildRouteWithoutQueryKeys(route, removeKeys = []) {
  const base = route || parseSpaRoute({ pathname: '/chat', search: '' });
  const query = { ...(base?.query || {}) };
  for (const key of removeKeys) {
    if (typeof key === 'string' && key) delete query[key];
  }
  const strippedBase = { ...base, query };
  const merged = mergeRouteIntent(strippedBase, { query });
  return merged.canonical || buildSpaRoute(merged);
}

/**
 * @param {string} pathValue
 * @returns {{ ok: true, path: string } | { ok: false, reason: string }}
 */
export function validateFilesRoutePath(pathValue) {
  const path = trimmed(pathValue);
  if (!path) return { ok: false, reason: 'missing-path' };
  if (!isRelativeRoutePath(path)) return { ok: false, reason: 'invalid-path' };
  return { ok: true, path };
}

/**
 * @param {{
 *   sessionId: string,
 *   knownSessionIds?: string[],
 *   allowJoin?: boolean,
 * }} input
 * @returns {{ action: 'join'|'clear'|'noop', sessionId: string, reason?: string }}
 */
export function resolveTerminalSessionRestore(input = {}) {
  const sessionId = trimmed(input.sessionId);
  if (!sessionId) return { action: 'noop', sessionId: '' };
  const known = Array.isArray(input.knownSessionIds) ? input.knownSessionIds : null;
  if (known && !known.includes(sessionId)) {
    return { action: 'clear', sessionId, reason: 'session-not-live' };
  }
  if (input.allowJoin === false) {
    return { action: 'clear', sessionId, reason: 'join-disabled' };
  }
  return { action: 'join', sessionId };
}

/**
 * @param {{
 *   browserSession: string,
 *   browserTab: string,
 *   knownSessions?: Array<{ browserSessionId?: string }>,
 *   knownTabs?: Array<{ tabId?: string }>,
 * }} input
 * @returns {{ action: 'select'|'clear-session'|'clear-tab'|'noop', browserSession: string, browserTab: string }}
 */
export function resolveBrowserRouteRestore(input = {}) {
  const browserSession = trimmed(input.browserSession);
  const browserTab = trimmed(input.browserTab);
  if (!browserSession) return { action: 'noop', browserSession: '', browserTab: '' };
  const sessions = Array.isArray(input.knownSessions) ? input.knownSessions : null;
  if (sessions && !sessions.some((row) => trimmed(row?.browserSessionId) === browserSession)) {
    return { action: 'clear-session', browserSession, browserTab };
  }
  if (browserTab) {
    const tabs = Array.isArray(input.knownTabs) ? input.knownTabs : null;
    if (tabs && !tabs.some((row) => trimmed(row?.tabId) === browserTab)) {
      return { action: 'clear-tab', browserSession, browserTab };
    }
  }
  return { action: 'select', browserSession, browserTab };
}

/**
 * @param {{ runId: string, knownRunIds?: string[] }} input
 * @returns {{ action: 'select'|'clear'|'noop', runId: string }}
 */
export function resolveRunRouteRestore(input = {}) {
  const runId = trimmed(input.runId);
  if (!runId) return { action: 'noop', runId: '' };
  const known = Array.isArray(input.knownRunIds) ? input.knownRunIds : null;
  if (known && !known.includes(runId)) {
    return { action: 'clear', runId };
  }
  return { action: 'select', runId };
}

/**
 * @param {{
 *   replaceCanonical: (url: string) => void,
 *   showResourceNotice?: (messageKey: string, detail?: string) => void,
 *   restoreChat?: (chatId: string) => void | Promise<void>,
 *   restoreTodo?: (todoId: string) => void | Promise<void>,
 *   restoreFilesPath?: (path: string) => void | Promise<void>,
 *   restoreTerminalSession?: (sessionId: string) => void | Promise<void>,
 *   clearTerminalSession?: () => void | Promise<void>,
 *   listTerminalSessionIds?: () => Promise<string[]>,
 *   restoreBrowser?: (sessionId: string, tabId: string) => void | Promise<void>,
 *   listBrowserSessions?: () => Promise<Array<{ browserSessionId?: string }>>,
 *   listBrowserTabs?: (sessionId: string) => Promise<Array<{ tabId?: string }>>,
 *   restoreTaskRun?: (runId: string) => void | Promise<void>,
 *   listTaskRunIds?: () => Promise<string[]>,
 *   restoreAgentRun?: (runId: string) => void | Promise<void>,
 *   listAgentRunIds?: () => Promise<string[]>,
 *   isCurrentGeneration?: (token: number) => boolean,
 * }} deps
 */
export function createRouteResourceRestorer(deps = {}) {
  const replaceCanonical = typeof deps.replaceCanonical === 'function'
    ? deps.replaceCanonical
    : () => {};
  const showResourceNotice = typeof deps.showResourceNotice === 'function'
    ? deps.showResourceNotice
    : () => {};
  const isCurrentGeneration = typeof deps.isCurrentGeneration === 'function'
    ? deps.isCurrentGeneration
    : () => true;

  /**
   * @param {import('../../../lib/spa-routes.js').SpaRouteState} route
   * @param {number} token
   */
  return async function restoreRouteResources(route, token) {
    if (!route || !isCurrentGeneration(token)) return;
    const panel = trimmed(route.panel);
    if (panel === 'chat' && route.query?.chat && deps.restoreChat) {
      await deps.restoreChat(trimmed(route.query.chat));
      return;
    }
    if (panel === 'todo' && route.query?.todo && deps.restoreTodo) {
      await deps.restoreTodo(trimmed(route.query.todo));
      return;
    }
    if (panel === 'files' && route.query?.path) {
      const checked = validateFilesRoutePath(route.query.path);
      if (!checked.ok) {
        showResourceNotice('navigation.resourceInvalidPath', checked.reason);
        replaceCanonical(buildRouteWithoutQueryKeys(route, ['path']));
        return;
      }
      if (deps.restoreFilesPath) await deps.restoreFilesPath(checked.path);
      return;
    }
    if (panel === 'terminal' && route.query?.session) {
      const sessionId = trimmed(route.query.session);
      let known = null;
      if (typeof deps.listTerminalSessionIds === 'function') {
        try {
          known = await deps.listTerminalSessionIds();
        } catch {
          known = null;
        }
      }
      if (!isCurrentGeneration(token)) return;
      const decision = resolveTerminalSessionRestore({
        sessionId,
        knownSessionIds: known,
        allowJoin: typeof deps.restoreTerminalSession === 'function',
      });
      if (decision.action === 'join' && deps.restoreTerminalSession) {
        await deps.restoreTerminalSession(decision.sessionId);
        return;
      }
      if (decision.action === 'clear') {
        showResourceNotice('navigation.resourceSessionExpired', decision.reason || '');
        if (deps.clearTerminalSession) await deps.clearTerminalSession();
        replaceCanonical(buildRouteWithoutQueryKeys(route, ['session']));
      }
      return;
    }
    if (panel === 'browser') {
      const browserSession = trimmed(route.query?.browserSession);
      const browserTab = trimmed(route.query?.browserTab);
      if (!browserSession) return;
      let sessions = null;
      let tabs = null;
      if (typeof deps.listBrowserSessions === 'function') {
        try {
          sessions = await deps.listBrowserSessions();
        } catch {
          sessions = null;
        }
      }
      if (typeof deps.listBrowserTabs === 'function') {
        try {
          tabs = await deps.listBrowserTabs(browserSession);
        } catch {
          tabs = null;
        }
      }
      if (!isCurrentGeneration(token)) return;
      const decision = resolveBrowserRouteRestore({
        browserSession,
        browserTab,
        knownSessions: sessions,
        knownTabs: tabs,
      });
      if (decision.action === 'select' && deps.restoreBrowser) {
        await deps.restoreBrowser(decision.browserSession, decision.browserTab);
        return;
      }
      if (decision.action === 'clear-tab') {
        showResourceNotice('navigation.resourceTabExpired', decision.browserTab);
        replaceCanonical(buildRouteWithoutQueryKeys(route, ['browserTab']));
        if (deps.restoreBrowser) await deps.restoreBrowser(decision.browserSession, '');
        return;
      }
      if (decision.action === 'clear-session') {
        showResourceNotice('navigation.resourceSessionExpired', 'browser');
        replaceCanonical(buildRouteWithoutQueryKeys(route, ['browserSession', 'browserTab']));
      }
      return;
    }
    if (panel === 'tasks' && route.query?.run) {
      const runId = trimmed(route.query.run);
      let known = null;
      if (typeof deps.listTaskRunIds === 'function') {
        try {
          known = await deps.listTaskRunIds();
        } catch {
          known = null;
        }
      }
      if (!isCurrentGeneration(token)) return;
      const decision = resolveRunRouteRestore({ runId, knownRunIds: known });
      if (decision.action === 'select' && deps.restoreTaskRun) {
        await deps.restoreTaskRun(decision.runId);
        return;
      }
      if (decision.action === 'clear') {
        showResourceNotice('navigation.resourceRunExpired', 'tasks');
        replaceCanonical(buildRouteWithoutQueryKeys(route, ['run']));
      }
      return;
    }
    if (panel === 'agents' && route.query?.run) {
      const runId = trimmed(route.query.run);
      let known = null;
      if (typeof deps.listAgentRunIds === 'function') {
        try {
          known = await deps.listAgentRunIds();
        } catch {
          known = null;
        }
      }
      if (!isCurrentGeneration(token)) return;
      const decision = resolveRunRouteRestore({ runId, knownRunIds: known });
      if (decision.action === 'select' && deps.restoreAgentRun) {
        await deps.restoreAgentRun(decision.runId);
        return;
      }
      if (decision.action === 'clear') {
        showResourceNotice('navigation.resourceRunExpired', 'agents');
        replaceCanonical(buildRouteWithoutQueryKeys(route, ['run']));
      }
    }
  };
}
