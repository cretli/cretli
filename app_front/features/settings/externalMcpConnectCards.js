/**
 * Settings → MCP → External clients: the two one-click cards for clients on
 * this computer — "Connect" (managed MCP connection, lib/mcp/mcp-external-connect.js)
 * and "Operator chats" (Claude Remote Control sessions, lib/remote-control/rc-sessions.js).
 * Built with DOM APIs; the host panel (externalMcpSettings.js) passes its helpers in.
 */

import { t } from '../../i18n/index.js';
import { CLAUDE_PERMISSION_PROFILES, PROFILE_ORDER } from '../../../lib/mcp/claude-permission-profiles.js';

/**
 * @typedef {{ value: string, label: string, description: string, group: string }} FolderOption
 * @typedef {{
 *   api: (path: string, options?: { method?: string, body?: unknown }) => Promise<{ status: number, json: any }>,
 *   targets: Array<{ id: string, file: string, labelKey: string }>,
 *   modeOptions: () => Array<{ value: string, label: string }>,
 *   orderFolders: (folders: FolderOption[], current: string) => FolderOption[],
 *   refreshPanel: () => Promise<void>,
 * }} ConnectCardDeps
 * @typedef {{ enabled: boolean, folders: FolderOption[], currentFolder: string }} ConnectCardData
 */

const RC_POLL_MS = 3000;
/** Poll timer of the operator chat list while a session is still starting. */
let rcPollTimer = 0;

/**
 * Small element builder: attributes (`class`, `text`, `data-*`, `aria-*`, booleans) and children.
 *
 * @param {string} tag
 * @param {Record<string, string | boolean | undefined>} [attrs]
 * @param {Array<Node | string | null | undefined | false>} [children]
 * @returns {any}
 */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === 'text') node.textContent = String(value);
    else if (key === 'class') node.className = String(value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

/** @param {string} icon @param {string} label */
function iconLabel(icon, label) {
  return [el('span', { class: `mdi ${icon}`, 'aria-hidden': 'true' }), ` ${label}`];
}

/**
 * Folder picker preset to the current folder.
 *
 * @param {ConnectCardData} data
 * @param {ConnectCardDeps} deps
 */
function folderSelect(data, deps) {
  const select = el('cr-searchable-select', { 'aria-label': t('settings.externalMcpWorkspace') });
  select.options = deps.orderFolders(data.folders, data.currentFolder);
  select.value = data.currentFolder || data.folders[0]?.value || '';
  select.searchPlaceholder = t('settings.externalMcpSearchFolders');
  select.emptyLabel = t('common.searchDropdownEmpty');
  return select;
}

/** @param {ConnectCardDeps} deps @param {string} value */
function modeSelect(deps, value) {
  const select = el('cr-bar-select', { 'aria-label': t('settings.externalMcpMode') });
  select.options = deps.modeOptions();
  select.value = value;
  return select;
}

/**
 * Permission profile select for Claude Code with a description of the chosen
 * profile; the guarded profile lists the rules that ask or are blocked, taken
 * from the same constant the server writes.
 *
 * @param {string} initial profile selected by default
 */
function permissionProfileField(initial) {
  const select = el('cr-bar-select', { 'aria-label': t('settings.externalMcpPermissionProfile') });
  select.options = PROFILE_ORDER.map((name) => ({ value: name, label: t(`settings.externalMcpProfile_${name}`) }));
  select.value = initial;
  const hint = el('p', { class: 'cr-hint' });
  const rules = el('div', { class: 'cr-hint' });
  const render = () => {
    const value = String(select.value || initial);
    hint.textContent = t(`settings.externalMcpProfile_${value}Hint`);
    const profile = CLAUDE_PERMISSION_PROFILES[value];
    rules.replaceChildren();
    if (value === 'edits_bash_guarded' && profile) {
      rules.append(
        el('p', { text: `${t('settings.externalMcpProfileAsks')}: ${profile.ask.join(', ')}` }),
        el('p', { text: `${t('settings.externalMcpProfileBlocks')}: ${profile.deny.join(', ')}` }),
        el('p', { text: t('settings.externalMcpProfileLimit') }),
      );
    }
  };
  select.addEventListener('cr-change', (/** @type {any} */ event) => {
    select.value = String(event.detail?.value ?? select.value);
    render();
  });
  render();
  const field = el('div', {}, [select, hint, rules]);
  return { field, select };
}

/** @param {HTMLElement | null} status */
function reporter(status) {
  return (/** @type {string} */ text, /** @type {string} */ tone) => {
    if (!status) return;
    status.textContent = text;
    status.dataset.tone = tone;
  };
}

/**
 * Extra lines about the tool-permission rule of a connect result.
 *
 * @param {any} toolPermission
 * @returns {string}
 */
function toolPermissionNote(toolPermission) {
  if (!toolPermission) return '';
  if (toolPermission.error) return t('settings.externalMcpAllowToolsFailed', { error: String(toolPermission.error) });
  const notes = [];
  if (toolPermission.allowed && toolPermission.gitIgnored === false) {
    notes.push(t('settings.externalMcpAllowToolsNotIgnored', { file: String(toolPermission.relativeFile || '') }));
  }
  if (toolPermission.defaultModeKept) {
    notes.push(t('settings.externalMcpDefaultModeKept', { mode: String(toolPermission.defaultModeKept) }));
  }
  return notes.join(' ');
}

/**
 * Turn external MCP on first when the card offers "Enable and …".
 *
 * @param {ConnectCardData} data
 * @param {ConnectCardDeps} deps
 * @param {(text: string, tone: string) => void} report
 */
async function ensureEnabled(data, deps, report) {
  if (data.enabled) return true;
  const res = await deps.api('/api/settings', { method: 'PATCH', body: { externalMcpEnabled: true } });
  if (!res.json?.ok) {
    report(res.json?.error || t('settings.externalMcpError'), 'error');
    return false;
  }
  data.enabled = true;
  return true;
}

/**
 * @param {ConnectCardData} data
 * @param {ConnectCardDeps} deps
 */
function connectCard(data, deps) {
  const target = el('cr-bar-select', { 'aria-label': t('settings.externalMcpInstallTarget') });
  target.options = deps.targets.map((row) => ({ value: row.id, label: t(row.labelKey) }));
  target.value = deps.targets[0].id;
  const folder = folderSelect(data, deps);
  const mode = modeSelect(deps, 'agent');
  const button = el('cr-bar-button', { variant: 'primary', id: 'external-mcp-connect' },
    iconLabel('mdi-connection', t(data.enabled ? 'settings.externalMcpConnect' : 'settings.externalMcpEnableAndConnect')));
  const allow = permissionProfileField('cretli_tools');
  const status = el('span', { id: 'external-mcp-connect-status', class: 'cr-status', role: 'status' });
  const report = reporter(status);
  target.addEventListener('cr-change', (/** @type {any} */ event) => {
    target.value = String(event.detail?.value ?? target.value);
    // The rule is a Claude Code setting; Codex and Cursor have their own approval models.
    allow.field.hidden = target.value !== 'claude';
  });
  button.addEventListener('click', async () => {
    const targetId = String(target.value || deps.targets[0].id);
    const folderPath = String(folder.value || '');
    if (!folderPath) return report(t('settings.externalMcpConnectNoFolder'), 'error');
    button.disabled = true;
    report(t('settings.externalMcpConnecting'), '');
    try {
      if (!(await ensureEnabled(data, deps, report))) return undefined;
      const res = await deps.api('/api/mcp/external-clients/connect', {
        method: 'POST',
        body: {
          target: targetId,
          folder: folderPath,
          mode: String(mode.value || 'agent'),
          ...(targetId === 'claude' ? { permissionProfile: String(allow.select.value || 'cretli_tools') } : {}),
        },
      });
      if (!res.json?.ok) return report(res.json?.error || t('settings.externalMcpError'), 'error');
      const label = t(deps.targets.find((row) => row.id === targetId)?.labelKey || deps.targets[0].labelKey);
      const note = toolPermissionNote(res.json.toolPermission);
      const message = [
        t('settings.externalMcpConnected', { client: label, file: String(res.json.relativeFile || '') }),
        t(targetId === 'claude' ? 'settings.externalMcpConnectedNextClaude' : 'settings.externalMcpConnectedNext', { client: label }),
        note,
      ].filter(Boolean).join(' ');
      await deps.refreshPanel();
      // The panel re-rendered: report on the fresh status element.
      reporter(document.getElementById('external-mcp-connect-status'))(message, note ? 'warning' : 'success');
    } finally {
      button.disabled = false;
    }
    return undefined;
  });
  return el('div', { class: 'cr-card mcp-settings-form external-mcp-connect' }, [
    el('h4', { text: t('settings.externalMcpConnectTitle') }),
    el('p', { class: 'cr-hint', text: t('settings.externalMcpConnectIntro') }),
    el('div', { class: 'cr-row external-mcp-install' }, [target, folder, mode, button]),
    allow.field,
    status,
  ]);
}

/**
 * @param {any} session
 * @returns {{ label: string, tone: string }}
 */
function rcState(session) {
  if (session.status === 'connected') return { label: t('settings.rcConnected'), tone: 'success' };
  if (session.status === 'starting') return { label: t('settings.rcStarting'), tone: 'warning' };
  return { label: t('settings.rcStopped'), tone: 'muted' };
}

/**
 * One operator chat with its actions.
 *
 * @param {any} session
 * @param {ConnectCardDeps} deps
 * @param {() => Promise<void>} refresh
 * @param {(text: string, tone: string) => void} report
 */
function rcCard(session, deps, refresh, report) {
  const state = rcState(session);
  const running = session.status !== 'stopped';
  const base = `/api/remote-control/sessions/${encodeURIComponent(session.id)}`;
  const modeLabel = deps.modeOptions().find((option) => option.value === session.mcpMode)?.label || session.mcpMode;
  const mcpLine = session.mcpConnected
    ? [t('settings.rcMcpConnected', { mode: modeLabel }), session.toolsAllowed ? t('settings.rcToolsAllowed') : '', session.permissionProfile === 'edits_bash_guarded' ? t('settings.externalMcpProfile_edits_bash_guarded') : ''].filter(Boolean).join(' · ')
    : t('settings.rcMcpMissing');

  /** @param {string} action @param {string} label @param {Record<string, string>} [attrs] */
  const action = (action, label, attrs = {}) => {
    const button = el('cr-bar-button', attrs, [label]);
    button.addEventListener('click', async () => {
      if (action === 'delete' && !window.confirm(t('settings.rcDeleteConfirm'))) return;
      button.disabled = true;
      const result = action === 'delete'
        ? await deps.api(base, { method: 'DELETE' })
        : await deps.api(`${base}/${action}`, { method: 'POST' });
      if (!result.json?.ok) report(result.json?.error || t('settings.externalMcpError'), 'error');
      await refresh();
    });
    return button;
  };

  let open = null;
  if (session.url && String(session.url).startsWith('https://claude.ai/')) {
    open = el('cr-bar-button', { variant: 'primary' }, iconLabel('mdi-open-in-new', t('settings.rcOpen')));
    open.addEventListener('click', () => window.open(session.url, '_blank', 'noopener,noreferrer'));
  }
  const autoStart = el('cr-checkbox', { checked: session.autoStart === true, text: t('settings.rcAutoStart') });
  autoStart.addEventListener('cr-change', async (/** @type {any} */ event) => {
    const result = await deps.api(base, { method: 'PATCH', body: { autoStart: event.detail?.checked === true } });
    if (!result.json?.ok) report(result.json?.error || t('settings.externalMcpError'), 'error');
  });

  return el('article', { class: 'cr-card mcp-server-card external-mcp-client' }, [
    el('div', { class: 'external-mcp-client-head' }, [
      el('h4', { text: session.name }),
      el('span', { class: 'external-mcp-badge', 'data-tone': state.tone, text: state.label }),
    ]),
    el('p', { class: 'cr-hint' }, iconLabel('mdi-folder-outline', session.folder)),
    el('p', { class: 'cr-hint', text: mcpLine }),
    !running && session.lastOutput ? el('pre', { class: 'mcp-tools-preview', text: session.lastOutput }) : null,
    el('div', { class: 'cr-row' }, [
      open,
      action(running ? 'stop' : 'start', t(running ? 'settings.rcStop' : 'settings.rcStart')),
      autoStart,
      action('delete', t('settings.rcDelete')),
    ]),
  ]);
}

/**
 * Lists the operator chats; polls while one is still starting.
 *
 * @param {HTMLElement} host
 * @param {ConnectCardDeps} deps
 * @param {(text: string, tone: string) => void} report
 */
async function renderRcList(host, deps, report) {
  window.clearTimeout(rcPollTimer);
  const res = await deps.api('/api/remote-control/sessions');
  if (!host.isConnected) return;
  const refresh = () => renderRcList(host, deps, report);
  if (!res.json?.ok) {
    host.replaceChildren(el('p', { class: 'message', 'data-tone': 'error', text: res.json?.error || t('settings.externalMcpError') }));
    return;
  }
  const sessions = Array.isArray(res.json.sessions) ? res.json.sessions : [];
  host.replaceChildren(...(sessions.length
    ? sessions.map((session) => rcCard(session, deps, refresh, report))
    : [el('p', { class: 'cr-hint', text: t('settings.rcEmpty') })]));
  if (sessions.some((session) => session.status === 'starting')) rcPollTimer = window.setTimeout(refresh, RC_POLL_MS);
}

/**
 * @param {ConnectCardData} data
 * @param {ConnectCardDeps} deps
 */
function remoteControlCard(data, deps) {
  const folder = folderSelect(data, deps);
  const mode = modeSelect(deps, 'operator');
  const button = el('cr-bar-button', { variant: 'primary' },
    iconLabel('mdi-cellphone-link', t(data.enabled ? 'settings.rcCreate' : 'settings.rcEnableAndCreate')));
  const autoStart = el('cr-checkbox', { checked: true, text: t('settings.rcAutoStart') });
  const allow = permissionProfileField('edits_bash_guarded');
  const status = el('span', { class: 'cr-status', role: 'status' });
  const list = el('div', { class: 'mcp-server-list' });
  const report = reporter(status);
  void renderRcList(list, deps, report);
  button.addEventListener('click', async () => {
    const folderPath = String(folder.value || '');
    if (!folderPath) return report(t('settings.externalMcpConnectNoFolder'), 'error');
    button.disabled = true;
    report(t('settings.rcCreating'), '');
    try {
      if (!(await ensureEnabled(data, deps, report))) return undefined;
      const res = await deps.api('/api/remote-control/sessions', {
        method: 'POST',
        body: {
          folder: folderPath,
          mode: String(mode.value || 'operator'),
          autoStart: autoStart.checked !== false,
          permissionProfile: String(allow.select.value || 'edits_bash_guarded'),
        },
      });
      if (!res.json?.ok) return report(res.json?.error || t('settings.externalMcpError'), 'error');
      const note = toolPermissionNote(res.json.session?.toolPermission);
      report([t('settings.rcCreated', { name: String(res.json.session?.name || '') }), note].filter(Boolean).join(' '), note ? 'warning' : 'success');
      await renderRcList(list, deps, report);
    } finally {
      button.disabled = false;
    }
    return undefined;
  });
  return el('div', { class: 'cr-card mcp-settings-form external-mcp-rc' }, [
    el('h4', { text: t('settings.rcTitle') }),
    el('p', { class: 'cr-hint', text: t('settings.rcIntro') }),
    el('div', { class: 'cr-row external-mcp-install' }, [folder, mode, button]),
    autoStart,
    allow.field,
    status,
    list,
  ]);
}

/**
 * Render both cards into `host` (replacing its content).
 *
 * @param {HTMLElement} host
 * @param {ConnectCardData} data
 * @param {ConnectCardDeps} deps
 */
export function mountExternalMcpConnectCards(host, data, deps) {
  host.replaceChildren(connectCard(data, deps), remoteControlCard(data, deps));
}
