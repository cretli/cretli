/**
 * Handlers for the `panel`, `app_settings` and `app_status` voice tools.
 *
 * Built from injected dependencies so the logic is unit-testable without a DOM
 * or the app modules; `realtimeTools.js` binds the real ones lazily. Every
 * action is risk=safe: UI navigation, UI settings and read-only status.
 */

import {
  capVoiceResult,
  clipVoiceText,
  resolveVoiceLanguage,
  resolveVoiceMicAction,
  resolveVoicePanel,
  resolveVoiceTheme,
} from './voiceAppMatch.js';

const PANEL_SUFFIX = '-panel';

/**
 * @typedef {{
 *   getDocument: () => Document | null,
 *   setTheme: (value: string) => void,
 *   getLang: () => string,
 *   setLang: (value: string) => Promise<void> | void,
 *   getNotificationState: () => Promise<object | null> | object | null,
 *   fetchScout: () => Promise<{ status: number, json: any }>,
 *   fetchHealth: () => Promise<any>,
 *   getConnection: () => { terminalStatus?: string, chatStatus?: string, displayStatus?: string },
 *   getActiveChat: () => Promise<object | null> | object | null,
 *   requestMicMute: (muted: boolean) => boolean,
 * }} AppToolDeps
 */

/**
 * @param {Document | null} doc
 * @returns {string} id of the visible panel ('none' when unknown)
 */
export function readActivePanelId(doc) {
  const active = doc?.querySelector?.('.panel.active');
  const id = String(active?.id || '');
  return id.endsWith(PANEL_SUFFIX) ? id.slice(0, -PANEL_SUFFIX.length) : 'none';
}

/**
 * @param {AppToolDeps} deps
 * @returns {Record<'panel' | 'app_settings' | 'app_status', (args: any) => Promise<object>>}
 */
export function createAppToolHandlers(deps) {
  function connectionLine() {
    const snapshot = deps.getConnection() || {};
    return {
      terminal: snapshot.terminalStatus || 'unknown',
      chat: snapshot.chatStatus || 'unknown',
    };
  }

  async function openPanel(spoken) {
    const panel = resolveVoicePanel(spoken);
    if (!panel) return { ok: false, error: 'Unknown panel. Try chat, todo, files, git, github, browser, tasks, terminal, logs, tests, instances, agents.' };
    const doc = deps.getDocument();
    const tab = doc?.querySelector?.(`.tab[data-panel="${panel}"]`);
    if (!tab || tab.hidden) return { ok: false, error: `The ${panel} panel is not available here.`, panel };
    tab.click();
    return { ok: true, panel };
  }

  async function panelStatus(spoken) {
    const doc = deps.getDocument();
    const panel = spoken ? resolveVoicePanel(spoken) : readActivePanelId(doc);
    if (!panel) return { ok: false, error: 'Unknown panel.' };
    const connection = connectionLine();
    const result = { ok: true, panel, active: readActivePanelId(doc) === panel };
    if (panel === 'chat') result.connection = connection.chat;
    if (panel === 'terminal') result.connection = connection.terminal;
    if (panel === 'chat') {
      const chat = await deps.getActiveChat();
      if (chat) result.title = clipVoiceText(chat.title || 'untitled');
    }
    return capVoiceResult(result);
  }

  async function readNotifications() {
    const state = await deps.getNotificationState();
    if (!state || state.initialized === false) return { ok: false, error: 'Notifications are not loaded yet' };
    const rows = Array.isArray(state.items) ? state.items : [];
    const ordered = [...rows.filter((row) => !row.readAt), ...rows.filter((row) => row.readAt)];
    return capVoiceResult({
      ok: true,
      unread: Math.max(0, Number(state.unreadCount) || 0),
      total: rows.length,
      items: ordered.map((row) => (
        `${row.readAt ? '' : '(unread) '}${clipVoiceText(row.title || row.body || 'notification', 100)}`
      )),
    });
  }

  async function readScout() {
    const response = await deps.fetchScout().catch(() => null);
    if (!response || response.status >= 400 || !response.json) {
      return { ok: false, error: 'Scout findings are not available' };
    }
    const findings = Array.isArray(response.json.findings) ? response.json.findings : [];
    const count = Number.isFinite(Number(response.json.total)) ? Number(response.json.total) : findings.length;
    return capVoiceResult({
      ok: true,
      pending: count,
      titles: findings.map((finding) => clipVoiceText(finding?.title || 'untitled', 100)),
    });
  }

  async function readHealth() {
    const connection = connectionLine();
    const payload = await deps.fetchHealth().catch(() => null);
    const map = payload?.harnesses && typeof payload.harnesses === 'object' ? payload.harnesses : null;
    const problems = [];
    let healthy = 0;
    for (const [id, entry] of Object.entries(map || {})) {
      const errors = Math.max(0, Number(entry?.errorRuns) || 0);
      if (entry?.activeLimit) problems.push(`${id}: usage limit reached`);
      else if (errors > 0) problems.push(`${id}: ${errors} failed run${errors === 1 ? '' : 's'} in 7 days`);
      else if ((Number(entry?.runs) || 0) > 0) healthy += 1;
    }
    return capVoiceResult({
      ok: true,
      connection,
      healthyHarnesses: healthy,
      problems,
      ...(map ? {} : { note: 'Harness health is not available' }),
    });
  }

  async function readContext() {
    const chat = await deps.getActiveChat();
    if (!chat) return { ok: false, error: 'No chat is open' };
    const snapshot = chat._contextUsageSnapshot && typeof chat._contextUsageSnapshot === 'object'
      ? chat._contextUsageSnapshot
      : null;
    const fill = Number(snapshot?.fillPercent);
    const total = Number(chat._contextUsageTotalTokens);
    const result = {
      ok: true,
      title: clipVoiceText(chat.title || 'untitled'),
      model: clipVoiceText(chat.model || 'auto', 60),
      fillPercent: Number.isFinite(fill) ? Math.round(fill) : null,
      level: snapshot?.pressureLevel || 'unknown',
      totalTokens: Number.isFinite(total) ? total : null,
    };
    if (result.fillPercent === null && result.totalTokens === null) result.note = 'No usage data yet';
    return capVoiceResult(result);
  }

  return {
    async panel(args) {
      const action = String(args?.action || '').trim().toLowerCase();
      if (action === 'open') {
        if (!String(args?.panel || '').trim()) return { ok: false, error: 'Missing panel' };
        return openPanel(args.panel);
      }
      if (action === 'status') return panelStatus(String(args?.panel || '').trim());
      return { ok: false, error: 'Action must be open or status' };
    },

    async app_settings(args) {
      const action = String(args?.action || '').trim().toLowerCase();
      if (action === 'theme') {
        const theme = resolveVoiceTheme(args?.value);
        if (!theme) return { ok: false, error: 'Theme must be dark, light, or system' };
        deps.setTheme(theme);
        return { ok: true, theme };
      }
      if (action === 'language') {
        const lang = resolveVoiceLanguage(args?.value);
        if (!lang) return { ok: false, error: 'Language must be en or pl' };
        await deps.setLang(lang);
        return { ok: true, language: deps.getLang() };
      }
      if (action === 'mic') {
        const micAction = resolveVoiceMicAction(args?.value);
        if (!micAction) return { ok: false, error: 'Value must be mute or unmute' };
        const handled = deps.requestMicMute(micAction === 'mute');
        return handled
          ? { ok: true, micMuted: micAction === 'mute' }
          : { ok: false, error: 'No live voice session to mute' };
      }
      return { ok: false, error: 'Action must be theme, language, or mic' };
    },

    async app_status(args) {
      const action = String(args?.action || '').trim().toLowerCase();
      if (action === 'notifications') return readNotifications();
      if (action === 'scout') return readScout();
      if (action === 'health') return readHealth();
      if (action === 'context') return readContext();
      return { ok: false, error: 'Action must be notifications, scout, health, or context' };
    },
  };
}
