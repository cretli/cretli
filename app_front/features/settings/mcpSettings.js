/**
 * Settings → MCP integrations.
 */

import { t } from '../../i18n/index.js';
import { cretliApiFetch } from '../../lib/cretliApiRequest.js';
import { getCurrentLang } from '../../i18n/index.js';
export { refreshExternalMcpSettingsPanel } from './externalMcpSettings.js';

const HARNESSES = [
  ['sdk', 'Cursor SDK'],
  ['codex', 'Codex'],
  ['opencode', 'OpenCode'],
  ['qwen', 'Qwen'],
  ['claude', 'Claude'],
  ['codebuddy', 'CodeBuddy'],
  ['deepseek', 'DeepSeek'],
  ['mistral', 'Mistral'],
  ['zai', 'Z.AI SDK'],
  ['mimo', 'MiMo'],
  ['antigravity', 'Antigravity'],
  ['openrouter', 'OpenRouter'],
];

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown }} [options]
 */
async function mcpApi(path, options = {}) {
  const headers = { Accept: 'application/json', 'Accept-Language': getCurrentLang() };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await cretliApiFetch(path, {
    method: options.method || 'GET',
    headers,
    credentials: 'include',
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

/**
 * Binds the panel once. It deliberately does not fetch: the caller (the Settings
 * tab switch) runs {@link refreshMcpSettingsPanel} right after the module is
 * ready, so fetching here would send every request twice on first entry.
 * @returns {void}
 */
export function initMcpSettingsPanel() {
  const root = document.getElementById('settings-mcp-root');
  if (!root || root.dataset.bound === 'true') return;
  root.dataset.bound = 'true';
}

/** Signature of the last rendered data; an identical refresh skips the re-render. */
let renderedSignature = '';
/** @type {Promise<void>|null} */
let inflightRefresh = null;
/** Monotonic id of the newest refresh; an older response never overwrites a newer render. */
let latestRefreshId = 0;

/**
 * Fetches servers, status and workspaces in parallel. "Loading…" is shown only
 * while nothing has been rendered yet; on re-entry the previous list stays
 * visible and is replaced only if the data changed.
 * Plain calls share an in-flight refresh; `force` (used after a mutation or an
 * explicit reload) always starts a fresh fetch, so its result reflects the
 * state after the change and supersedes any older in-flight response.
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<void>}
 */
export function refreshMcpSettingsPanel(options = {}) {
  if (inflightRefresh && !options.force) return inflightRefresh;
  const id = ++latestRefreshId;
  const run = runMcpRefresh(id).finally(() => {
    if (inflightRefresh === run) inflightRefresh = null;
  });
  inflightRefresh = run;
  return run;
}

async function runMcpRefresh(id) {
  const root = document.getElementById('settings-mcp-root');
  if (!root) return;
  if (!renderedSignature || !root.firstElementChild) {
    renderedSignature = '';
    root.innerHTML = `<p class="settings-hint">${escapeHtml(t('settings.mcpLoading'))}</p>`;
  }
  const [list, status, workspaces] = await Promise.all([
    mcpApi('/api/mcp/servers'),
    mcpApi('/api/mcp/status'),
    mcpApi('/api/workspaces'),
  ]);
  if (id !== latestRefreshId) return; // superseded by a newer refresh
  if (!list.json?.ok) {
    // Keep a previously rendered list on a transient failure; only an empty panel shows the error.
    if (renderedSignature) return;
    const err = list.json?.corrupt
      ? t('settings.mcpCorrupt')
      : (list.json?.error || t('settings.mcpLoadError'));
    root.innerHTML = `<p class="message" data-tone="error">${escapeHtml(err)}</p>`;
    return;
  }
  const data = {
    revision: list.json.revision || 0,
    servers: Array.isArray(list.json.servers) ? list.json.servers : [],
    statuses: Array.isArray(status.json?.statuses) ? status.json.statuses : [],
    workspaces: Array.isArray(workspaces.json?.workspaces) ? workspaces.json.workspaces : [],
    oauthPresets: Array.isArray(list.json.oauthPresets) ? list.json.oauthPresets : [],
  };
  const signature = JSON.stringify(data);
  if (signature === renderedSignature) return;
  renderedSignature = signature;
  renderMcpPanel(root, data);
}

/**
 * @param {HTMLElement} root
 * @param {{ revision: number, servers: object[], statuses: object[], workspaces: object[], oauthPresets: { id: string, label: string, clientIdKey: string, clientSecretKey: string }[] }} data
 */
function renderMcpPanel(root, data) {
  const workspaceOptions = [
    { value: 'all', label: t('settings.mcpAllWorkspaces') },
    ...data.workspaces.map((row) => {
      const id = String(row.id || row.workspaceFile || '').trim();
      return { value: id, label: String(row.label || row.workspaceFile || row.folder || id) };
    }),
  ];
  const harnessChecks = HARNESSES.map(([id, label]) => (
    `<cr-checkbox data-harness="${escapeAttr(id)}">${escapeHtml(label)}</cr-checkbox>`
  )).join('');
  const cards = data.servers.length === 0
    ? `<p class="settings-hint">${escapeHtml(t('settings.mcpEmpty'))}</p>`
    : data.servers.map((server) => renderServerCard(server, data.statuses, data.workspaces)).join('');
  root.innerHTML = `
    <div class="cr-card mcp-settings-form" id="mcp-form">
      <h4 id="mcp-form-title">${escapeHtml(t('settings.mcpAddTitle'))}</h4>
      <div class="cr-field">
        <span class="cr-field-label">${escapeHtml(t('settings.mcpName'))}</span>
        <cr-bar-input id="mcp-form-name"></cr-bar-input>
      </div>
      <div class="cr-field">
        <span class="cr-field-label">${escapeHtml(t('settings.mcpTransport'))}</span>
        <cr-bar-select id="mcp-form-transport"></cr-bar-select>
      </div>
      <div class="cr-field" data-stdio>
        <span class="cr-field-label">${escapeHtml(t('settings.mcpCommand'))}</span>
        <cr-bar-input id="mcp-form-command" placeholder="npx"></cr-bar-input>
      </div>
      <div class="cr-field" data-stdio>
        <span class="cr-field-label">${escapeHtml(t('settings.mcpArgs'))}</span>
        <cr-bar-input id="mcp-form-args" placeholder="-y @modelcontextprotocol/server-filesystem /tmp"></cr-bar-input>
      </div>
      <div class="cr-field" data-http hidden>
        <span class="cr-field-label">${escapeHtml(t('settings.mcpUrl'))}</span>
        <cr-bar-input id="mcp-form-url" placeholder="https://example.com/mcp"></cr-bar-input>
      </div>
      <div class="cr-field">
        <span class="cr-field-label">${escapeHtml(t('settings.mcpSecret'))}</span>
        <div class="mcp-secret-row">
          <cr-bar-input id="mcp-form-secret-name" placeholder="${escapeAttr(t('settings.mcpSecretNameLabel'))}"></cr-bar-input>
          <cr-bar-input id="mcp-form-secret" type="password"></cr-bar-input>
        </div>
        <p class="cr-hint">${escapeHtml(t('settings.mcpSecretNameHint'))} ${escapeHtml(t('settings.mcpSecretHint'))}</p>
      </div>
      <div class="cr-field" data-stdio>
        <span class="cr-field-label">${escapeHtml(t('settings.mcpOAuthPreset'))}</span>
        <cr-bar-select id="mcp-form-oauth-preset"></cr-bar-select>
        <p class="cr-hint">${escapeHtml(t('settings.mcpOAuthPresetHint'))}</p>
      </div>
      <div class="cr-field" data-oauth-fields hidden>
        <span class="cr-field-label">${escapeHtml(t('settings.mcpOAuthAccount'))}</span>
        <cr-bar-input id="mcp-form-oauth-hint" placeholder="name@example.com"></cr-bar-input>
        <div class="mcp-secret-row">
          <cr-bar-input id="mcp-form-oauth-client-id" placeholder="${escapeAttr(t('settings.mcpOAuthClientId'))}"></cr-bar-input>
          <cr-bar-input id="mcp-form-oauth-client-secret" type="password" placeholder="${escapeAttr(t('settings.mcpOAuthClientSecret'))}"></cr-bar-input>
        </div>
        <p class="cr-hint">${escapeHtml(t('settings.mcpOAuthClientHint'))}</p>
      </div>
      <div class="cr-field">
        <span class="cr-field-label">${escapeHtml(t('settings.mcpWorkspace'))}</span>
        <cr-bar-select id="mcp-form-scope"></cr-bar-select>
      </div>
      <div class="cr-field">
        <span class="cr-field-label">${escapeHtml(t('settings.mcpHarnesses'))}</span>
        <div id="mcp-form-harnesses" class="mcp-harness-list">${harnessChecks}</div>
      </div>
      <div class="cr-row">
        <cr-bar-button variant="primary" id="mcp-form-save">${escapeHtml(t('settings.mcpSave'))}</cr-bar-button>
        <cr-bar-button id="mcp-form-cancel" hidden>${escapeHtml(t('settings.mcpCancel'))}</cr-bar-button>
        <cr-bar-button id="mcp-form-reload">${escapeHtml(t('settings.mcpReload'))}</cr-bar-button>
        <span id="mcp-form-status" class="cr-status"></span>
      </div>
    </div>
    <div class="mcp-server-list">${cards}</div>
  `;
  const transport = /** @type {any} */ (root.querySelector('#mcp-form-transport'));
  if (transport) {
    transport.options = [{ value: 'stdio', label: 'stdio' }, { value: 'http', label: 'HTTP' }];
    transport.value = 'stdio';
  }
  const scope = /** @type {any} */ (root.querySelector('#mcp-form-scope'));
  if (scope) {
    scope.options = workspaceOptions;
    scope.value = 'all';
  }
  oauthPresets = data.oauthPresets || [];
  const presetSelect = /** @type {any} */ (root.querySelector('#mcp-form-oauth-preset'));
  if (presetSelect) {
    presetSelect.options = [
      { value: '', label: t('settings.mcpOAuthPresetNone') },
      ...oauthPresets.map((preset) => ({ value: preset.id, label: preset.label })),
    ];
    presetSelect.value = '';
    presetSelect.addEventListener('cr-change', () => syncTransportFields(root));
    presetSelect.addEventListener('change', () => syncTransportFields(root));
  }
  transport?.addEventListener('cr-change', () => syncTransportFields(root));
  transport?.addEventListener('change', () => syncTransportFields(root));
  root.querySelector('#mcp-form-save')?.addEventListener('click', () => saveServerForm(root, data));
  root.querySelector('#mcp-form-cancel')?.addEventListener('click', () => resetServerForm(root));
  root.querySelector('#mcp-form-reload')?.addEventListener('click', () => refreshMcpSettingsPanel({ force: true }));
  root.querySelectorAll('[data-mcp-test]').forEach((btn) => {
    btn.addEventListener('click', () => testServer(btn.getAttribute('data-mcp-test'), data.revision, root));
  });
  root.querySelectorAll('[data-mcp-refresh]').forEach((btn) => {
    btn.addEventListener('click', () => refreshServerTools(btn.getAttribute('data-mcp-refresh'), root));
  });
  root.querySelectorAll('[data-mcp-delete]').forEach((btn) => {
    btn.addEventListener('click', () => confirmDelete(btn, data.revision));
  });
  root.querySelectorAll('[data-mcp-edit]').forEach((btn) => {
    const server = data.servers.find((row) => row.id === btn.getAttribute('data-mcp-edit'));
    btn.addEventListener('click', () => server && startEdit(root, server));
  });
  root.querySelectorAll('[data-mcp-duplicate]').forEach((btn) => {
    btn.addEventListener('click', () => duplicateServer(btn.getAttribute('data-mcp-duplicate'), data.revision, root));
  });
  root.querySelectorAll('[data-mcp-rename]').forEach((btn) => {
    btn.addEventListener('click', () => startRename(btn.getAttribute('data-mcp-rename'), data, root));
  });
  root.querySelectorAll('[data-mcp-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => toggleServer(btn.getAttribute('data-mcp-toggle'), btn.getAttribute('data-enabled') === '1', data.revision));
  });
  root.querySelectorAll('[data-mcp-oauth-login]').forEach((btn) => {
    btn.addEventListener('click', () => startOAuthLogin(btn.getAttribute('data-mcp-oauth-login'), root));
  });
  root.querySelectorAll('[data-mcp-access-log]').forEach((btn) => {
    btn.addEventListener('click', () => toggleAccessLog(btn.getAttribute('data-mcp-access-log'), root));
  });
  root.querySelectorAll('[data-mcp-oauth-manual]').forEach((btn) => {
    btn.addEventListener('click', () => startOAuthLogin(btn.getAttribute('data-mcp-oauth-manual'), root, { manual: true }));
  });
  root.querySelectorAll('[data-oauth-paste-submit]').forEach((btn) => {
    btn.addEventListener('click', () => submitOAuthPaste(btn.getAttribute('data-oauth-paste-submit'), root));
  });
  root.querySelectorAll('[data-mcp-oauth-logout]').forEach((btn) => {
    btn.addEventListener('click', () => oauthLogout(btn.getAttribute('data-mcp-oauth-logout')));
  });
}

/**
 * Shows or hides the recent tool calls made to one server (who, which tool, outcome).
 * @param {string | null} id
 * @param {HTMLElement} root
 */
async function toggleAccessLog(id, root) {
  if (!id) return;
  const box = root.querySelector(`[data-access-log-for="${CSS.escape(id)}"]`);
  if (!box) return;
  if (!box.hidden) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.textContent = t('settings.mcpLoading');
  const res = await mcpApi(`/api/mcp/access-log?serverId=${encodeURIComponent(id)}&limit=30`);
  const entries = Array.isArray(res.json?.entries) ? res.json.entries : [];
  if (!res.json?.ok) {
    box.textContent = res.json?.error || t('settings.mcpLoadError');
    return;
  }
  // Built with DOM nodes: every value here comes from the server log, so nothing is parsed as HTML.
  const node = (tag, className, text) => {
    const el = document.createElement(tag);
    el.className = className;
    if (text != null) el.textContent = String(text);
    return el;
  };
  if (!entries.length) {
    box.replaceChildren(node('p', 'cr-hint', t('settings.mcpAccessLogEmpty')));
    return;
  }
  const tone = { ok: 'success', error: 'warning', denied: 'warning', unavailable: 'muted' };
  const list = node('ul', 'mcp-access-list');
  for (const row of entries) {
    const badge = node('span', 'mcp-badge', t(`settings.mcpAccessOutcome_${row.outcome}`));
    badge.dataset.tone = tone[row.outcome] || 'muted';
    const item = node('li', '');
    item.append(
      node('span', 'mcp-access-time', new Date(row.at).toLocaleString()),
      node('span', 'mcp-access-tool', row.tool),
      badge,
      node('span', 'mcp-access-meta', [row.harness, row.mode, row.ms != null ? `${row.ms} ms` : ''].filter(Boolean).join(' · ')),
    );
    if (row.reason) item.append(node('span', 'mcp-access-reason', row.reason));
    list.append(item);
  }
  box.replaceChildren(node('p', 'cr-hint', t('settings.mcpAccessLogHint')), list);
}

/** Select value that leaves a hand-written `oauth` block (mcp.json) untouched. */
const OAUTH_KEEP_CUSTOM = '__custom__';

/** Secret key under which the server stores OAuth tokens (lib/mcp/mcp-oauth.js). */
const OAUTH_TOKENS_KEY = 'oauth_tokens';

let oauthMessageListenerBound = false;

/** The login window posts back when the callback finished; refresh to show the new state. */
function bindOAuthMessageListener() {
  if (oauthMessageListenerBound) return;
  oauthMessageListenerBound = true;
  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) return;
    if (event.data?.type !== 'cretli-mcp-oauth') return;
    void refreshMcpSettingsPanel({ force: true });
  });
}

/**
 * @param {string | null} id
 * @param {HTMLElement} root
 * @param {{ manual?: boolean }} [options]  manual = the login window ends on a page that cannot load; the user pastes its address
 */
async function startOAuthLogin(id, root, options = {}) {
  if (!id) return;
  const status = root.querySelector(`[data-oauth-status-for="${CSS.escape(id)}"]`);
  const show = (text) => {
    if (!status) return;
    status.hidden = false;
    status.textContent = text;
  };
  bindOAuthMessageListener();
  // Open the window synchronously with the click, so pop-up blockers allow it.
  const popup = window.open('about:blank', 'cretli-mcp-oauth', 'width=560,height=720');
  const res = await mcpApi(`/api/mcp/servers/${encodeURIComponent(id)}/oauth/start`, { method: 'POST', body: { manual: options.manual === true } });
  if (!res.json?.ok) {
    popup?.close();
    show(`${t('settings.mcpOAuthError')}: ${res.json?.error || res.status}`);
    return;
  }
  if (res.json.authorized) {
    popup?.close();
    await refreshMcpSettingsPanel({ force: true });
    return;
  }
  const url = String(res.json.authorizeUrl || '');
  const manual = res.json.manual === true;
  if (manual) root.querySelector(`[data-oauth-paste-for="${CSS.escape(id)}"]`)?.removeAttribute('hidden');
  if (popup && !popup.closed) {
    popup.location.href = url;
    show(t(manual ? 'settings.mcpOAuthWaitingManual' : 'settings.mcpOAuthWaiting'));
  } else {
    show(`${t('settings.mcpOAuthPopupBlocked')} ${url}`);
  }
}

/**
 * Manual flow, last step: the pasted address carries the authorization code.
 * @param {string | null} id
 * @param {HTMLElement} root
 */
async function submitOAuthPaste(id, root) {
  if (!id) return;
  const box = root.querySelector(`[data-oauth-paste-for="${CSS.escape(id)}"]`);
  const status = root.querySelector(`[data-oauth-status-for="${CSS.escape(id)}"]`);
  const redirectUrl = String(box?.querySelector('[data-oauth-paste-input]')?.value || '').trim();
  if (!redirectUrl) return;
  const res = await mcpApi(`/api/mcp/servers/${encodeURIComponent(id)}/oauth/complete`, { method: 'POST', body: { redirectUrl } });
  if (!res.json?.ok) {
    if (status) {
      status.hidden = false;
      status.textContent = `${t('settings.mcpOAuthError')}: ${res.json?.error || res.status}`;
    }
    return;
  }
  await refreshMcpSettingsPanel({ force: true });
}

/**
 * @param {string | null} id
 */
async function oauthLogout(id) {
  if (!id) return;
  await mcpApi(`/api/mcp/servers/${encodeURIComponent(id)}/oauth/logout`, { method: 'POST', body: {} });
  await refreshMcpSettingsPanel({ force: true });
}

/** Presets from the server (client-credential secret names), set on every render. */
let oauthPresets = [];

function syncTransportFields(root) {
  const transport = root.querySelector('#mcp-form-transport');
  const value = transport?.value || 'stdio';
  const preset = root.querySelector('#mcp-form-oauth-preset')?.value || '';
  root.querySelectorAll('[data-oauth-fields]').forEach((el) => {
    el.hidden = value !== 'stdio' || !preset || preset === OAUTH_KEEP_CUSTOM;
  });
  root.querySelectorAll('[data-stdio]').forEach((el) => {
    el.hidden = value !== 'stdio';
  });
  root.querySelectorAll('[data-http]').forEach((el) => {
    el.hidden = value !== 'http';
  });
}

function formatStatusLine(row) {
  if (row.source === 'diagnostic') {
    return `${t('settings.mcpStatusDiagnostic')} · ${row.connectionState || 'tested'}`;
  }
  const config = row.configState === 'applied'
    ? t('settings.mcpStatusApplied')
    : row.configState === 'stale'
      ? t('settings.mcpStatusStale')
      : row.configState === 'pending'
        ? t('settings.mcpStatusPending')
        : (row.configState || t('settings.mcpStatusUnknown'));
  return `${row.harness || '-'} · ${config} · ${row.connectionState || 'unknown'}`;
}

/**
 * Identical status lines (one per chat) collapse into one line with a count.
 * @param {object[]} rows
 * @returns {{ line: string, count: number, bad: boolean }[]}
 */
function groupStatusLines(rows) {
  /** @type {Map<string, { line: string, count: number, bad: boolean }>} */
  const groups = new Map();
  for (const row of rows) {
    const line = `${formatStatusLine(row)}${row.error ? ` · ${row.error}` : ''}`;
    const group = groups.get(line) || {
      line,
      count: 0,
      bad: Boolean(row.error) || row.configState === 'stale' || row.connectionState === 'failed',
    };
    group.count += 1;
    groups.set(line, group);
  }
  return [...groups.values()];
}

/**
 * Compact "where does this server work" chips: transport, workspaces, harnesses and
 * whether the Operator can use it (internal operator runs never see external servers).
 *
 * @param {Record<string, any>} server
 * @param {Record<string, any>[]} workspaces
 * @returns {string}
 */
function renderScopeChips(server, workspaces) {
  const chip = (text, tone = '', title = '') => `<span class="mcp-badge" ${tone ? `data-tone="${tone}"` : ''} ${title ? `title="${escapeAttr(title)}"` : ''}>${escapeHtml(text)}</span>`;
  let scopeLabel;
  let scopeTitle = '';
  if (!Array.isArray(server.scope)) {
    scopeLabel = t('settings.mcpScopeAll');
  } else if (server.scope.length === 0) {
    scopeLabel = t('settings.mcpScopeNone');
  } else {
    const names = server.scope.map((id) => {
      const row = workspaces.find((w) => String(w.id || w.workspaceFile || '').trim() === id);
      return String(row?.label || row?.workspaceFile || row?.folder || id).split('/').pop();
    });
    scopeLabel = server.scope.length === 1 ? names[0] : t('settings.mcpScopeCount', { count: server.scope.length });
    scopeTitle = names.join(', ');
  }
  const harnesses = server.harnesses || [];
  const harnessLabel = harnesses.length === 0
    ? t('settings.mcpNoHarness')
    : harnesses.length === HARNESSES.length
      ? t('settings.mcpHarnessesAll', { count: HARNESSES.length })
      : t('settings.mcpHarnessesCount', { count: harnesses.length });
  const harnessTitle = harnesses.map((id) => HARNESSES.find(([hid]) => hid === id)?.[1] || id).join(', ');
  return `<div class="mcp-scope-chips">
    ${chip(server.transport)}
    ${chip(`${t('settings.mcpWorkspace')}: ${scopeLabel}`, Array.isArray(server.scope) && server.scope.length === 0 ? 'warning' : '', scopeTitle)}
    ${chip(`${t('settings.mcpHarnesses')}: ${harnessLabel}`, harnesses.length === 0 ? 'warning' : '', harnessTitle)}
    ${chip(t('settings.mcpOperatorBlocked'), 'muted', t('settings.mcpOperatorBlockedHint'))}
  </div>`;
}

function renderServerCard(server, statuses, workspaces = []) {
  const related = statuses.filter((row) => row.serverId === server.id);
  const groups = groupStatusLines(related);
  const statusBlock = groups.length === 0
    ? `<p class="cr-hint">${escapeHtml(t('settings.mcpStatusUnknown'))}</p>`
    : `<details class="mcp-status-details">
        <summary>${escapeHtml(t('settings.mcpStatusSummary', { count: related.length }))}${groups.some((g) => g.bad) ? ' ⚠' : ''}</summary>
        ${groups.map((g) => (
    `<p class="cr-hint"${g.bad ? ' data-tone="warning"' : ''}>${escapeHtml(g.line)}${g.count > 1 ? ` <span class="mcp-status-count">×${g.count}</span>` : ''}</p>`
  )).join('')}
      </details>`;
  const secretKeys = Array.isArray(server.secretKeys) ? server.secretKeys : [];
  const secretOAuth = server.transport === 'stdio' && server.oauth ? server.oauth : null;
  const oauthConnected = secretOAuth ? Boolean(secretOAuth.connected) : secretKeys.includes(OAUTH_TOKENS_KEY);
  const secrets = oauthConnected
    ? (secretOAuth?.account ? t('settings.mcpOAuthConnectedAs', { account: secretOAuth.account }) : t('settings.mcpOAuthConnected'))
    : secretKeys.some((key) => !key.startsWith('oauth_'))
      ? t('settings.mcpSecretSet')
      : t('settings.mcpSecretEmpty');
  const oauthButtons = server.transport !== 'http' && !secretOAuth
    ? ''
    : oauthConnected
      ? `<cr-bar-button data-mcp-oauth-logout="${escapeAttr(server.id)}">${escapeHtml(t('settings.mcpOAuthLogout'))}</cr-bar-button>`
      : `<cr-bar-button data-mcp-oauth-login="${escapeAttr(server.id)}">${escapeHtml(t('settings.mcpOAuthLogin'))}</cr-bar-button>`;
  // Relogin (also from another device) is possible without logging out first.
  const oauthExtra = secretOAuth
    ? `${oauthConnected ? `<cr-bar-button data-mcp-oauth-login="${escapeAttr(server.id)}">${escapeHtml(t('settings.mcpOAuthRelogin'))}</cr-bar-button>` : ''}
        <cr-bar-button data-mcp-oauth-manual="${escapeAttr(server.id)}" title="${escapeAttr(t('settings.mcpOAuthManualHint'))}">${escapeHtml(t('settings.mcpOAuthManual'))}</cr-bar-button>`
    : '';
  const enabled = server.enabled !== false;
  const id = escapeAttr(server.id);
  return `
    <article class="cr-card mcp-server-card" data-enabled="${enabled ? '1' : '0'}" data-server-id="${id}">
      <div class="mcp-server-head">
        <h4 data-mcp-name-for="${id}">${escapeHtml(server.name)}</h4>
        <cr-bar-button data-mcp-rename="${id}" title="${escapeAttr(t('settings.mcpRename'))}">${escapeHtml(t('settings.mcpRename'))}</cr-bar-button>
        <span class="mcp-badge" data-tone="${enabled ? 'success' : 'muted'}">${escapeHtml(enabled ? t('settings.mcpBadgeEnabled') : t('settings.mcpBadgeDisabled'))}</span>
      </div>
      ${renderScopeChips(server, workspaces)}
      <p class="cr-hint">${escapeHtml(secrets)}</p>
      ${statusBlock}
      <div class="cr-row mcp-server-actions">
        <cr-bar-button data-mcp-test="${id}">${escapeHtml(t('settings.mcpTest'))}</cr-bar-button>
        <cr-bar-button data-mcp-refresh="${id}">${escapeHtml(t('settings.mcpRefresh'))}</cr-bar-button>
        ${oauthButtons}
        ${oauthExtra}
        <cr-bar-button data-mcp-access-log="${id}">${escapeHtml(t('settings.mcpAccessLog'))}</cr-bar-button>
        <cr-bar-button data-mcp-edit="${id}">${escapeHtml(t('settings.mcpEdit'))}</cr-bar-button>
        <cr-bar-button data-mcp-duplicate="${id}">${escapeHtml(t('settings.mcpDuplicate'))}</cr-bar-button>
        <cr-bar-button data-mcp-toggle="${id}" data-enabled="${enabled ? '1' : '0'}">${escapeHtml(enabled ? t('settings.mcpDisable') : t('settings.mcpEnable'))}</cr-bar-button>
        <cr-bar-button class="mcp-danger" data-mcp-delete="${id}">${escapeHtml(t('settings.mcpDelete'))}</cr-bar-button>
      </div>
      <p class="cr-hint" data-oauth-status-for="${id}" hidden></p>
      <div class="cr-row mcp-oauth-paste" data-oauth-paste-for="${id}" hidden>
        <cr-bar-input data-oauth-paste-input placeholder="${escapeAttr(t('settings.mcpOAuthPastePlaceholder'))}"></cr-bar-input>
        <cr-bar-button variant="primary" data-oauth-paste-submit="${id}">${escapeHtml(t('settings.mcpOAuthPasteSubmit'))}</cr-bar-button>
      </div>
      <div class="mcp-access-log" data-access-log-for="${id}" hidden></div>
      <pre class="mcp-tools-preview" data-tools-for="${id}" hidden></pre>
    </article>
  `;
}

/** Id of the server loaded into the form; null while the form adds a new one. */
let editingId = null;

/** @param {HTMLElement} root */
function resetServerForm(root) {
  editingId = null;
  const set = (sel, value) => {
    const el = /** @type {any} */ (root.querySelector(sel));
    if (el) el.value = value;
  };
  set('#mcp-form-name', '');
  set('#mcp-form-command', '');
  set('#mcp-form-args', '');
  set('#mcp-form-url', '');
  set('#mcp-form-secret', '');
  set('#mcp-form-secret-name', '');
  set('#mcp-form-transport', 'stdio');
  set('#mcp-form-scope', 'all');
  set('#mcp-form-oauth-preset', '');
  set('#mcp-form-oauth-hint', '');
  set('#mcp-form-oauth-client-id', '');
  set('#mcp-form-oauth-client-secret', '');
  root.querySelectorAll('#mcp-form-harnesses cr-checkbox').forEach((el) => { /** @type {any} */ (el).checked = false; });
  syncTransportFields(root);
  syncFormMode(root, null);
}

/**
 * @param {HTMLElement} root
 * @param {Record<string, any> | null} server
 */
function syncFormMode(root, server) {
  const title = root.querySelector('#mcp-form-title');
  if (title) title.textContent = server ? t('settings.mcpEditTitle', { name: server.name }) : t('settings.mcpAddTitle');
  const save = root.querySelector('#mcp-form-save');
  if (save) save.textContent = server ? t('settings.mcpSaveChanges') : t('settings.mcpSave');
  const cancel = /** @type {HTMLElement | null} */ (root.querySelector('#mcp-form-cancel'));
  if (cancel) cancel.hidden = !server;
  const secretHint = root.querySelector('#mcp-form-secret');
  if (secretHint) secretHint.setAttribute('placeholder', server ? t('settings.mcpSecretKeepPlaceholder') : '');
  root.querySelector('#mcp-form')?.toggleAttribute('data-editing', Boolean(server));
}

/**
 * @param {HTMLElement} root
 * @param {Record<string, any>} server
 */
function startEdit(root, server) {
  resetServerForm(root);
  editingId = server.id;
  const set = (sel, value) => {
    const el = /** @type {any} */ (root.querySelector(sel));
    if (el) el.value = value;
  };
  const conn = server.connection || {};
  set('#mcp-form-name', server.name);
  set('#mcp-form-transport', server.transport || 'stdio');
  set('#mcp-form-command', conn.command || '');
  set('#mcp-form-args', (conn.args || []).join(' '));
  set('#mcp-form-url', conn.url || '');
  const bag = server.transport === 'http' ? conn.headers : conn.env;
  set('#mcp-form-secret-name', Object.keys(bag || {}).find((key) => typeof bag[key] === 'object') || '');
  if (server.oauth) {
    const presetEl = /** @type {any} */ (root.querySelector('#mcp-form-oauth-preset'));
    const known = oauthPresets.some((preset) => preset.id === server.oauth.preset);
    if (presetEl && !known) {
      presetEl.options = [...presetEl.options, { value: OAUTH_KEEP_CUSTOM, label: t('settings.mcpOAuthPresetCustom') }];
    }
    set('#mcp-form-oauth-preset', known ? server.oauth.preset : OAUTH_KEEP_CUSTOM);
    set('#mcp-form-oauth-hint', server.oauth.loginHint || '');
  }
  const scope = Array.isArray(server.scope) ? (server.scope.length === 1 ? server.scope[0] : '') : 'all';
  const scopeEl = /** @type {any} */ (root.querySelector('#mcp-form-scope'));
  // A multi-workspace scope has no single-select value: keep it untouched unless changed.
  root.dataset.mcpInitialScope = Array.isArray(server.scope) && server.scope.length !== 1 ? 'multi' : '';
  if (scopeEl && scope) scopeEl.value = scope;
  root.querySelectorAll('#mcp-form-harnesses cr-checkbox').forEach((el) => {
    /** @type {any} */ (el).checked = (server.harnesses || []).includes(el.getAttribute('data-harness'));
  });
  syncTransportFields(root);
  syncFormMode(root, server);
  const form = root.querySelector('#mcp-form');
  form?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  /** @type {any} */ (root.querySelector('#mcp-form-name'))?.focus?.();
}

/**
 * Creates a server, or patches the one loaded by {@link startEdit}.
 * @param {HTMLElement} root
 * @param {{ revision: number, servers: object[] }} data
 */
async function saveServerForm(root, data) {
  const revision = data.revision;
  const status = root.querySelector('#mcp-form-status');
  const expected = Number(root.dataset.mcpRevision || revision);
  const name = root.querySelector('#mcp-form-name')?.value?.trim() || '';
  if (!name) {
    if (status) status.textContent = t('settings.mcpNameRequired');
    root.querySelector('#mcp-form-name')?.focus?.();
    return;
  }
  const transport = root.querySelector('#mcp-form-transport')?.value || 'stdio';
  const harnesses = [...root.querySelectorAll('#mcp-form-harnesses cr-checkbox')].filter((el) => el.checked).map((el) => el.getAttribute('data-harness'));
  const scopeValue = root.querySelector('#mcp-form-scope')?.value || 'all';
  const secret = root.querySelector('#mcp-form-secret')?.value || '';
  const existing = editingId ? data.servers.find((row) => row.id === editingId) : null;
  /** @type {Record<string, unknown>} */
  const body = {
    expectedRevision: Number.isInteger(expected) ? expected : revision,
    name,
    transport,
    harnesses,
    connection: {},
  };
  if (!existing) {
    body.enabled = true;
    body.kind = 'external';
  }
  if (!existing || root.dataset.mcpInitialScope !== 'multi') {
    body.scope = scopeValue === 'all' ? 'all' : [scopeValue];
  }
  const secretName = String(root.querySelector('#mcp-form-secret-name')?.value || '').trim()
    || (transport === 'http' ? 'Authorization' : 'MCP_TOKEN');
  /** Plain entries and secret references of the stored bag survive; the API only returns { set } for secrets. */
  const keepEntries = (bag) => Object.fromEntries(
    Object.entries(bag || {}).map(([key, value]) => [
      key,
      typeof value === 'string' ? value : { secret: key },
    ]),
  );
  if (transport === 'http') {
    body.connection = { url: root.querySelector('#mcp-form-url')?.value?.trim() || '' };
    if (secret) {
      body.connection.headers = {
        ...keepEntries(existing?.connection?.headers),
        [secretName]: { secret: secretName, value: secret },
      };
    }
  } else {
    const command = root.querySelector('#mcp-form-command')?.value?.trim() || '';
    const args = String(root.querySelector('#mcp-form-args')?.value || '').trim().split(/\s+/).filter(Boolean);
    body.connection = { command, args };
    if (secret) {
      body.connection.env = {
        ...keepEntries(existing?.connection?.env),
        [secretName]: { secret: secretName, value: secret },
      };
    }
  }
  const presetId = transport === 'stdio' ? (root.querySelector('#mcp-form-oauth-preset')?.value || '') : '';
  const preset = oauthPresets.find((row) => row.id === presetId);
  if (preset) {
    body.oauth = { preset: preset.id, loginHint: root.querySelector('#mcp-form-oauth-hint')?.value?.trim() || '' };
    const clientId = root.querySelector('#mcp-form-oauth-client-id')?.value?.trim() || '';
    const clientSecret = root.querySelector('#mcp-form-oauth-client-secret')?.value?.trim() || '';
    // Blank fields keep the stored credentials.
    body.secrets = {
      ...(clientId ? { [preset.clientIdKey]: clientId } : {}),
      ...(clientSecret ? { [preset.clientSecretKey]: clientSecret } : {}),
    };
  } else if (existing?.oauth && presetId !== OAUTH_KEEP_CUSTOM) {
    body.oauth = null;
  }
  const res = existing
    ? await mcpApi(`/api/mcp/servers/${encodeURIComponent(existing.id)}`, { method: 'PATCH', body })
    : await mcpApi('/api/mcp/servers', { method: 'POST', body });
  if (res.json?.conflict) {
    if (status) status.textContent = t('settings.mcpConflict');
    root.dataset.mcpRevision = String(res.json.revision || revision);
    return;
  }
  if (!res.json?.ok) {
    if (status) status.textContent = res.json?.error || t('settings.mcpSaveError');
    return;
  }
  editingId = null;
  await refreshMcpSettingsPanel({ force: true });
}

/**
 * Duplicates a server (secrets included, server-side); the copy starts disabled.
 * @param {string | null} id
 * @param {number} revision
 * @param {HTMLElement} root
 */
async function duplicateServer(id, revision, root) {
  if (!id) return;
  const res = await mcpApi(`/api/mcp/servers/${encodeURIComponent(id)}/duplicate`, {
    method: 'POST',
    body: { expectedRevision: revision },
  });
  const status = root.querySelector('#mcp-form-status');
  if (!res.json?.ok) {
    if (status) status.textContent = res.json?.error || t('settings.mcpSaveError');
    return;
  }
  await refreshMcpSettingsPanel({ force: true });
  const copyId = res.json.server?.id;
  const card = copyId ? root.querySelector(`[data-server-id="${CSS.escape(copyId)}"]`) : null;
  card?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  const hint = card?.querySelector('[data-oauth-status-for]');
  if (hint) {
    hint.hidden = false;
    hint.textContent = t('settings.mcpDuplicated');
  }
}

/**
 * Swaps the card heading for an input; Enter saves, Escape cancels.
 * @param {string | null} id
 * @param {{ revision: number, servers: object[] }} data
 * @param {HTMLElement} root
 */
function startRename(id, data, root) {
  if (!id) return;
  const heading = /** @type {HTMLElement | null} */ (root.querySelector(`[data-mcp-name-for="${CSS.escape(id)}"]`));
  const server = data.servers.find((row) => row.id === id);
  if (!heading || !server || heading.querySelector('cr-bar-input')) return;
  const input = /** @type {any} */ (document.createElement('cr-bar-input'));
  input.value = server.name;
  input.className = 'mcp-rename-input';
  heading.textContent = '';
  heading.append(input);
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const next = String(input.value || '').trim();
    if (commit && next && next !== server.name) {
      await mcpApi(`/api/mcp/servers/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: { expectedRevision: data.revision, name: next },
      });
      await refreshMcpSettingsPanel({ force: true });
    } else {
      heading.textContent = server.name;
    }
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); void finish(true); }
    if (event.key === 'Escape') { event.preventDefault(); void finish(false); }
  });
  input.addEventListener('blur', () => void finish(true));
  requestAnimationFrame(() => input.focus?.());
}

/**
 * First click arms the button, a second one within 3 s deletes.
 * @param {Element} btn
 * @param {number} revision
 */
function confirmDelete(btn, revision) {
  const id = btn.getAttribute('data-mcp-delete');
  if (!id) return;
  if (btn.getAttribute('data-armed') === '1') {
    void deleteServer(id, revision);
    return;
  }
  const label = btn.textContent;
  btn.setAttribute('data-armed', '1');
  btn.textContent = t('settings.mcpDeleteConfirm');
  setTimeout(() => {
    btn.removeAttribute('data-armed');
    btn.textContent = label;
  }, 3000);
}

async function testServer(id, _revision, root) {
  const preview = root.querySelector(`[data-tools-for="${CSS.escape(id)}"]`);
  const res = await mcpApi(`/api/mcp/servers/${encodeURIComponent(id)}/test`, { method: 'POST', body: {} });
  if (preview) {
    preview.hidden = false;
    const tools = Array.isArray(res.json?.tools) ? res.json.tools : [];
    const names = tools.map((tool) => tool.name).join('\n') || (res.json?.error || t('settings.mcpNoTools'));
    preview.textContent = `${t('settings.mcpTestResult')}\n${names}`;
  }
}

/** Drops cached tool lists of one server for every chat; open chats re-read it. */
async function refreshServerTools(id, root) {
  const res = await mcpApi(`/api/mcp/servers/${encodeURIComponent(id)}/refresh`, { method: 'POST', body: {} });
  const json = res.json || {};
  const message = json.ok
    ? t('settings.mcpRefreshResult', {
      count: json.tools,
      state: t(json.changed ? 'settings.mcpRefreshChanged' : 'settings.mcpRefreshUnchanged'),
    })
    : (json.error || t('settings.mcpRefreshError'));
  await refreshMcpSettingsPanel({ force: true });
  const preview = root.querySelector(`[data-tools-for="${CSS.escape(id)}"]`);
  if (preview) {
    preview.hidden = false;
    preview.textContent = message;
  }
}

async function deleteServer(id, revision) {
  await mcpApi(`/api/mcp/servers/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    body: { expectedRevision: revision },
  });
  await refreshMcpSettingsPanel({ force: true });
}

async function toggleServer(id, enabled, revision) {
  await mcpApi(`/api/mcp/servers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: { expectedRevision: revision, enabled: !enabled },
  });
  await refreshMcpSettingsPanel({ force: true });
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, '&#39;');
}
