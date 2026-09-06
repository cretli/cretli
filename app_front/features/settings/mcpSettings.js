/**
 * Settings → MCP integrations.
 */

import { t } from '../../i18n/index.js';
import { cretliApiFetch } from '../../lib/cretliApiRequest.js';
import { getCurrentLang } from '../../i18n/index.js';

const HARNESSES = [
  ['sdk', 'Cursor SDK'],
  ['codex', 'Codex'],
  ['opencode', 'OpenCode'],
  ['qwen', 'Qwen'],
  ['codebuddy', 'CodeBuddy'],
  ['deepseek', 'DeepSeek'],
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
 * @returns {void}
 */
export function initMcpSettingsPanel() {
  const root = document.getElementById('settings-mcp-root');
  if (!root || root.dataset.bound === 'true') return;
  root.dataset.bound = 'true';
  refreshMcpSettingsPanel();
}

/**
 * @returns {Promise<void>}
 */
export async function refreshMcpSettingsPanel() {
  const root = document.getElementById('settings-mcp-root');
  if (!root) return;
  root.innerHTML = `<p class="settings-hint">${escapeHtml(t('settings.mcpLoading'))}</p>`;
  const list = await mcpApi('/api/mcp/servers');
  if (!list.json?.ok) {
    const err = list.json?.corrupt
      ? t('settings.mcpCorrupt')
      : (list.json?.error || t('settings.mcpLoadError'));
    root.innerHTML = `<p class="message" data-tone="error">${escapeHtml(err)}</p>`;
    return;
  }
  const status = await mcpApi('/api/mcp/status');
  const workspaces = await mcpApi('/api/workspaces');
  renderMcpPanel(root, {
    revision: list.json.revision || 0,
    servers: Array.isArray(list.json.servers) ? list.json.servers : [],
    statuses: Array.isArray(status.json?.statuses) ? status.json.statuses : [],
    workspaces: Array.isArray(workspaces.json?.workspaces) ? workspaces.json.workspaces : [],
  });
}

/**
 * @param {HTMLElement} root
 * @param {{ revision: number, servers: object[], statuses: object[], workspaces: object[] }} data
 */
function renderMcpPanel(root, data) {
  const workspaceOptions = [
    `<option value="all">${escapeHtml(t('settings.mcpAllWorkspaces'))}</option>`,
    ...data.workspaces.map((row) => {
      const id = String(row.id || row.workspaceFile || '').trim();
      const label = String(row.label || row.workspaceFile || row.folder || id);
      return `<option value="${escapeAttr(id)}">${escapeHtml(label)}</option>`;
    }),
  ].join('');
  const harnessChecks = HARNESSES.map(([id, label]) => (
    `<label class="cr-check"><input type="checkbox" data-harness="${escapeAttr(id)}"> ${escapeHtml(label)}</label>`
  )).join('');
  const cards = data.servers.length === 0
    ? `<p class="settings-hint">${escapeHtml(t('settings.mcpEmpty'))}</p>`
    : data.servers.map((server) => renderServerCard(server, data.statuses)).join('');
  root.innerHTML = `
    <div class="cr-card mcp-settings-form">
      <div class="cr-field">
        <span class="cr-field-label">${escapeHtml(t('settings.mcpName'))}</span>
        <cr-bar-input id="mcp-form-name"></cr-bar-input>
      </div>
      <div class="cr-field">
        <span class="cr-field-label">${escapeHtml(t('settings.mcpTransport'))}</span>
        <cr-bar-select id="mcp-form-transport">
          <option value="stdio">stdio</option>
          <option value="http">HTTP</option>
        </cr-bar-select>
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
        <cr-bar-input id="mcp-form-secret" type="password"></cr-bar-input>
        <p class="cr-hint">${escapeHtml(t('settings.mcpSecretHint'))}</p>
      </div>
      <div class="cr-field">
        <span class="cr-field-label">${escapeHtml(t('settings.mcpWorkspace'))}</span>
        <select id="mcp-form-scope" class="widget-panel-select">${workspaceOptions}</select>
      </div>
      <div class="cr-field">
        <span class="cr-field-label">${escapeHtml(t('settings.mcpHarnesses'))}</span>
        <div id="mcp-form-harnesses" class="mcp-harness-list">${harnessChecks}</div>
      </div>
      <div class="cr-row">
        <cr-bar-button variant="primary" id="mcp-form-save">${escapeHtml(t('settings.mcpSave'))}</cr-bar-button>
        <cr-bar-button id="mcp-form-reload">${escapeHtml(t('settings.mcpReload'))}</cr-bar-button>
        <span id="mcp-form-status" class="cr-status"></span>
      </div>
    </div>
    <div class="mcp-server-list">${cards}</div>
  `;
  const transport = root.querySelector('#mcp-form-transport');
  transport?.addEventListener('cr-change', () => syncTransportFields(root));
  transport?.addEventListener('change', () => syncTransportFields(root));
  root.querySelector('#mcp-form-save')?.addEventListener('click', () => saveNewServer(root, data.revision));
  root.querySelector('#mcp-form-reload')?.addEventListener('click', () => refreshMcpSettingsPanel());
  root.querySelectorAll('[data-mcp-test]').forEach((btn) => {
    btn.addEventListener('click', () => testServer(btn.getAttribute('data-mcp-test'), data.revision, root));
  });
  root.querySelectorAll('[data-mcp-delete]').forEach((btn) => {
    btn.addEventListener('click', () => deleteServer(btn.getAttribute('data-mcp-delete'), data.revision, root));
  });
  root.querySelectorAll('[data-mcp-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => toggleServer(btn.getAttribute('data-mcp-toggle'), btn.getAttribute('data-enabled') === '1', data.revision, root));
  });
}

function syncTransportFields(root) {
  const transport = root.querySelector('#mcp-form-transport');
  const value = transport?.value || 'stdio';
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

function renderServerCard(server, statuses) {
  const related = statuses.filter((row) => row.serverId === server.id);
  const statusLines = related.length === 0
    ? `<p class="cr-hint">${escapeHtml(t('settings.mcpStatusUnknown'))}</p>`
    : related.map((row) => (
      `<p class="cr-hint">${escapeHtml(formatStatusLine(row))}${row.error ? ` · ${escapeHtml(row.error)}` : ''}</p>`
    )).join('');
  const secrets = Array.isArray(server.secretKeys) && server.secretKeys.length
    ? t('settings.mcpSecretSet')
    : t('settings.mcpSecretEmpty');
  return `
    <article class="cr-card mcp-server-card">
      <h4>${escapeHtml(server.name)}</h4>
      <p class="cr-hint">${escapeHtml(server.transport)} · ${escapeHtml((server.harnesses || []).join(', ') || t('settings.mcpNoHarness'))} · ${escapeHtml(secrets)}</p>
      ${statusLines}
      <div class="cr-row">
        <cr-bar-button data-mcp-test="${escapeAttr(server.id)}">${escapeHtml(t('settings.mcpTest'))}</cr-bar-button>
        <cr-bar-button data-mcp-toggle="${escapeAttr(server.id)}" data-enabled="${server.enabled !== false ? '1' : '0'}">${escapeHtml(server.enabled !== false ? t('settings.mcpDisable') : t('settings.mcpEnable'))}</cr-bar-button>
        <cr-bar-button data-mcp-delete="${escapeAttr(server.id)}">${escapeHtml(t('settings.mcpDelete'))}</cr-bar-button>
      </div>
      <pre class="mcp-tools-preview" data-tools-for="${escapeAttr(server.id)}" hidden></pre>
    </article>
  `;
}

async function saveNewServer(root, revision) {
  const status = root.querySelector('#mcp-form-status');
  const expected = Number(root.dataset.mcpRevision || revision);
  const name = root.querySelector('#mcp-form-name')?.value?.trim() || '';
  const transport = root.querySelector('#mcp-form-transport')?.value || 'stdio';
  const harnesses = [...root.querySelectorAll('#mcp-form-harnesses input:checked')].map((el) => el.getAttribute('data-harness'));
  const scopeValue = root.querySelector('#mcp-form-scope')?.value || 'all';
  const secret = root.querySelector('#mcp-form-secret')?.value || '';
  /** @type {Record<string, unknown>} */
  const body = {
    expectedRevision: Number.isInteger(expected) ? expected : revision,
    name,
    enabled: true,
    kind: 'external',
    transport,
    harnesses,
    scope: scopeValue === 'all' ? 'all' : [scopeValue],
    connection: {},
  };
  if (transport === 'http') {
    body.connection = { url: root.querySelector('#mcp-form-url')?.value?.trim() || '' };
    if (secret) body.connection.headers = { Authorization: { secret: 'Authorization', value: secret } };
  } else {
    const command = root.querySelector('#mcp-form-command')?.value?.trim() || '';
    const args = String(root.querySelector('#mcp-form-args')?.value || '').trim().split(/\s+/).filter(Boolean);
    body.connection = { command, args };
    if (secret) body.connection.env = { MCP_TOKEN: { secret: 'MCP_TOKEN', value: secret } };
  }
  const res = await mcpApi('/api/mcp/servers', { method: 'POST', body });
  if (res.json?.conflict) {
    if (status) status.textContent = t('settings.mcpConflict');
    root.dataset.mcpRevision = String(res.json.revision || revision);
    return;
  }
  if (!res.json?.ok) {
    if (status) status.textContent = res.json?.error || t('settings.mcpSaveError');
    return;
  }
  await refreshMcpSettingsPanel();
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

async function deleteServer(id, revision) {
  await mcpApi(`/api/mcp/servers/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    body: { expectedRevision: revision },
  });
  await refreshMcpSettingsPanel();
}

async function toggleServer(id, enabled, revision) {
  await mcpApi(`/api/mcp/servers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: { expectedRevision: revision, enabled: !enabled },
  });
  await refreshMcpSettingsPanel();
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
