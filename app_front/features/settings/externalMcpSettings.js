/**
 * Settings → MCP → External clients: tools such as Claude Code or Cursor that
 * use Cretli's built-in MCP tools over Streamable HTTP at /mcp. Server side:
 * lib/routes/mcp-external-routes.js and lib/mcp/mcp-external-clients.js.
 *
 * Markup uses the shared Lit controls; their options/values are set as
 * properties after each render (cr-bar-select and cr-searchable-select read
 * `options`, not child <option> elements).
 */

import { t, getCurrentLang } from '../../i18n/index.js';
import { cretliApiFetch } from '../../lib/cretliApiRequest.js';
import { readBarInputLiveValue } from '../../components/ui/read-bar-input-live-value.js';
import { collectWorkspaceFolders } from '../voice/voiceWorkspaceMatch.js';

const ROOT_ID = 'settings-external-mcp-root';
const TTL_DAY_CHOICES = [7, 30, 90, 365];

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown }} [options]
 */
async function api(path, options = {}) {
  /** @type {Record<string, string>} */
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
 * Localhost URL by default (the endpoint only accepts loopback peers unless
 * LAN access is on); the page origin when LAN access is allowed.
 *
 * @param {boolean} allowLan
 * @param {string} endpointPath
 */
function endpointUrl(allowLan, endpointPath) {
  if (allowLan) return `${window.location.origin}${endpointPath}`;
  const port = window.location.port ? `:${window.location.port}` : '';
  return `${window.location.protocol}//127.0.0.1${port}${endpointPath}`;
}

/**
 * @param {string} url
 * @param {string} token
 * @param {string} [cliToken] Token as written in the shell command (defaults to `token`).
 */
function configSnippet(url, token, cliToken = token) {
  const mcpJson = JSON.stringify({
    mcpServers: { cretli: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } },
  }, null, 2);
  const cli = `claude mcp add --transport http cretli ${url} --header "Authorization: Bearer ${cliToken}"`;
  return `# Claude Code (.mcp.json)\n${mcpJson}\n\n# Claude Code (CLI)\n${cli}`;
}

/** Environment variable the exported configuration reads the token from. */
const TOKEN_ENV = 'CRETLI_MCP_TOKEN';

/**
 * Configuration of an existing client. The server keeps only a hash of the
 * token, so the export references an environment variable instead: Claude Code
 * expands `${VAR}` in .mcp.json and the shell expands `$VAR` in the command.
 *
 * @param {any} client
 * @param {string} url
 */
function clientExportSnippet(client, url) {
  const modeLabel = modeOptions().find((option) => option.value === client.mode)?.label || client.mode;
  const header = [
    `# ${t('settings.externalMcpExportClient')}: ${client.name}`,
    `# ${t('settings.externalMcpWorkspace')}: ${client.workspaceFolder}`,
    `# ${t('settings.externalMcpMode')}: ${modeLabel}`,
    `# ${t('settings.externalMcpExpires')}: ${formatDate(client.expiresAt)}`,
    `# ${t('settings.externalMcpExportTokenNote', { env: TOKEN_ENV })}`,
  ].join('\n');
  return `${header}\n\n${configSnippet(url, `\${${TOKEN_ENV}}`, `$${TOKEN_ENV}`)}`;
}

/**
 * Every defined client as JSON (no secrets), e.g. to recreate them elsewhere.
 *
 * @param {any[]} clients
 * @param {string} url
 */
function allClientsExport(clients, url) {
  return JSON.stringify({
    endpoint: url,
    tokenEnv: TOKEN_ENV,
    clients: clients.map((client) => ({
      name: client.name,
      workspaceFolder: client.workspaceFolder,
      mode: client.mode,
      state: client.revokedAt ? 'revoked' : (client.expiresAt && Date.parse(client.expiresAt) <= Date.now() ? 'expired' : 'active'),
      createdAt: client.createdAt || null,
      expiresAt: client.expiresAt || null,
      lastUsedAt: client.lastUsedAt || null,
    })),
  }, null, 2);
}

/**
 * Modal with a read-only export plus copy and download actions.
 *
 * `rotate` (optional) issues a new token and returns the configuration that
 * replaces the shown text; the old token stops working.
 *
 * @param {{ heading: string, text: string, fileName: string, hint?: string,
 *   rotate?: () => Promise<{ text?: string, error?: string }> }} params
 */
function openExportDialog({ heading, text: initialText, fileName, hint = '', rotate }) {
  let text = initialText;
  const dialog = /** @type {any} */ (document.createElement('cr-dialog'));
  dialog.className = 'external-mcp-export-dialog';
  dialog.heading = heading;
  dialog.closable = true;
  dialog.closeLabel = t('settings.externalMcpExportClose');
  dialog.style.setProperty('--cr-dialog-max-width', '42rem');

  const body = document.createElement('div');
  if (hint) {
    const hintEl = document.createElement('p');
    hintEl.className = 'cr-hint';
    hintEl.textContent = hint;
    body.appendChild(hintEl);
  }
  const warning = document.createElement('p');
  warning.className = 'message';
  warning.dataset.tone = 'warning';
  warning.textContent = t('settings.externalMcpTokenOnce');
  warning.hidden = true;
  body.appendChild(warning);
  const pre = document.createElement('pre');
  pre.className = 'mcp-tools-preview external-mcp-export-text';
  pre.textContent = text;
  body.appendChild(pre);
  const status = document.createElement('span');
  status.className = 'cr-status';
  body.appendChild(status);
  dialog.appendChild(body);

  const actions = document.createElement('div');
  actions.slot = 'actions';
  actions.className = 'cr-row';
  const copy = document.createElement('cr-bar-button');
  copy.setAttribute('variant', 'primary');
  copy.textContent = t('settings.externalMcpCopy');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = t('settings.externalMcpCopied');
    } catch {
      // Clipboard needs a secure context; select the text so a manual copy is one tap.
      const range = document.createRange();
      range.selectNodeContents(pre);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      status.textContent = t('settings.externalMcpCopyFailed');
    }
  });
  const download = document.createElement('cr-bar-button');
  download.textContent = t('settings.externalMcpDownload');
  download.addEventListener('click', () => {
    const blob = new Blob([text], { type: fileName.endsWith('.json') ? 'application/json' : 'text/plain' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = fileName;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  });
  actions.append(copy, download);
  if (rotate) {
    const regenerate = /** @type {any} */ (document.createElement('cr-bar-button'));
    regenerate.textContent = t('settings.externalMcpRotate');
    regenerate.addEventListener('click', async () => {
      if (!window.confirm(t('settings.externalMcpRotateConfirm'))) return;
      regenerate.disabled = true;
      const result = await rotate();
      if (!result.text) {
        status.textContent = result.error || t('settings.externalMcpError');
        regenerate.disabled = false;
        return;
      }
      text = result.text;
      pre.textContent = text;
      warning.hidden = false;
      regenerate.remove();
      status.textContent = t('settings.externalMcpRotated');
    });
    actions.appendChild(regenerate);
  }
  dialog.appendChild(actions);

  dialog.addEventListener('cr-dialog-close', () => dialog.remove());
  document.body.appendChild(dialog);
  dialog.show();
}

/** @param {string} value */
function fileSlug(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'client';
}

/**
 * Folder choices grouped by workspace (the same folders as the new-chat
 * location picker); `current` is kept even when no workspace lists it.
 *
 * @param {object[]} workspaces
 * @param {string} current
 * @returns {Array<{ value: string, label: string, description: string, group: string }>}
 */
function folderOptions(workspaces, current) {
  const seen = new Set();
  /** @type {Array<{ value: string, label: string, description: string, group: string }>} */
  const options = [];
  for (const workspace of workspaces) {
    const group = String(/** @type {any} */ (workspace).label || /** @type {any} */ (workspace).id || '');
    for (const folder of collectWorkspaceFolders(workspace)) {
      const key = folder.path.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      options.push({ value: folder.path, label: folder.name, description: folder.path, group });
    }
  }
  const currentPath = current.replace(/\\/g, '/').replace(/\/$/, '');
  if (currentPath && !seen.has(currentPath.toLowerCase())) {
    options.unshift({ value: currentPath, label: currentPath.split('/').filter(Boolean).pop() || currentPath, description: currentPath, group: '' });
  }
  return options;
}

/**
 * @param {{ revokedAt?: string | null, expiresAt?: string }} client
 * @returns {{ label: string, tone: string }}
 */
function clientState(client) {
  if (client.revokedAt) return { label: t('settings.externalMcpRevoked'), tone: 'muted' };
  if (client.expiresAt && Date.parse(client.expiresAt) <= Date.now()) return { label: t('settings.externalMcpExpired'), tone: 'warning' };
  return { label: t('settings.externalMcpActive'), tone: 'success' };
}

/** @param {string | null | undefined} iso */
function formatDate(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(getCurrentLang());
}

/** @returns {Array<{ value: string, label: string }>} */
function modeOptions() {
  return [
    { value: 'plan', label: t('settings.externalMcpModePlan') },
    { value: 'agent', label: t('settings.externalMcpModeAgent') },
    { value: 'operator', label: t('settings.externalMcpModeOperator') },
  ];
}

/**
 * @param {any} client
 */
function renderClientCard(client) {
  const state = clientState(client);
  const used = client.lastUsedAt
    ? `${t('settings.externalMcpLastUsed')} ${formatDate(client.lastUsedAt)}`
    : t('settings.externalMcpNeverUsed');
  const modeLabel = modeOptions().find((option) => option.value === client.mode)?.label || client.mode;
  return `
    <article class="cr-card mcp-server-card external-mcp-client">
      <div class="external-mcp-client-head">
        <h4>${escapeHtml(client.name)}</h4>
        <span class="external-mcp-badge" data-tone="${state.tone}">${escapeHtml(state.label)}</span>
      </div>
      <p class="cr-hint"><span class="mdi mdi-folder-outline" aria-hidden="true"></span> ${escapeHtml(client.workspaceFolder)}</p>
      <p class="cr-hint">${escapeHtml(modeLabel)} · ${escapeHtml(t('settings.externalMcpExpires'))} ${escapeHtml(formatDate(client.expiresAt))} · ${escapeHtml(used)}</p>
      ${client.revokedAt ? '' : `<div class="cr-row">
        <cr-bar-select data-external-mcp-client-mode="${escapeAttr(client.id)}" data-current="${escapeAttr(client.mode)}" aria-label="${escapeAttr(t('settings.externalMcpChangeMode'))}"></cr-bar-select>
        <cr-bar-button data-external-mcp-revoke="${escapeAttr(client.id)}">${escapeHtml(t('settings.externalMcpRevoke'))}</cr-bar-button>
      </div>`}
      <div class="cr-row">
        <cr-bar-button data-external-mcp-export="${escapeAttr(client.id)}">
          <span class="mdi mdi-export-variant" aria-hidden="true"></span> ${escapeHtml(t('settings.externalMcpExport'))}
        </cr-bar-button>
      </div>
    </article>`;
}

/**
 * @returns {Promise<void>}
 */
export async function refreshExternalMcpSettingsPanel() {
  const root = document.getElementById(ROOT_ID);
  if (!root) return;
  root.innerHTML = `<p class="settings-hint">${escapeHtml(t('settings.mcpLoading'))}</p>`;
  const [list, context, workspacesRes] = await Promise.all([
    api('/api/mcp/external-clients'),
    api('/api/workspace/context'),
    api('/api/workspaces'),
  ]);
  if (!list.json?.ok) {
    root.innerHTML = `<p class="message" data-tone="error">${escapeHtml(list.json?.error || t('settings.externalMcpError'))}</p>`;
    return;
  }
  renderPanel(root, {
    enabled: list.json.enabled === true,
    allowLan: list.json.allowLan === true,
    endpointPath: String(list.json.endpointPath || '/mcp'),
    clients: Array.isArray(list.json.clients) ? list.json.clients : [],
    folders: folderOptions(
      Array.isArray(workspacesRes.json?.workspaces) ? workspacesRes.json.workspaces : [],
      String(context.json?.folder?.resolvedPath || ''),
    ),
    currentFolder: String(context.json?.folder?.resolvedPath || '').replace(/\\/g, '/').replace(/\/$/, ''),
  });
}

/**
 * @param {HTMLElement} root
 * @param {{ enabled: boolean, allowLan: boolean, endpointPath: string, clients: any[],
 *   folders: Array<{ value: string, label: string, description: string, group: string }>, currentFolder: string }} data
 * @param {string} [snippet] One-time configuration shown right after creating a client.
 */
function renderPanel(root, data, snippet = '') {
  const url = endpointUrl(data.allowLan, data.endpointPath);
  const clients = data.clients.length === 0
    ? `<p class="settings-hint">${escapeHtml(t('settings.externalMcpEmpty'))}</p>`
    : data.clients.map(renderClientCard).join('');
  root.innerHTML = `
    <div class="cr-card mcp-settings-form">
      <h4>${escapeHtml(t('settings.externalMcpAccess'))}</h4>
      <cr-checkbox id="external-mcp-enabled">${escapeHtml(t('settings.externalMcpEnable'))}</cr-checkbox>
      <cr-checkbox id="external-mcp-allow-lan">${escapeHtml(t('settings.externalMcpAllowLan'))}</cr-checkbox>
      <p class="cr-hint">${escapeHtml(t('settings.externalMcpEndpoint'))} <code>${escapeHtml(url)}</code>${data.enabled ? '' : ` · ${escapeHtml(t('settings.externalMcpOff'))}`}</p>
    </div>
    <div class="cr-card mcp-settings-form">
      <h4>${escapeHtml(t('settings.externalMcpNewClient'))}</h4>
      <div class="cr-field">
        <span class="cr-field-label">${escapeHtml(t('settings.externalMcpName'))}</span>
        <cr-bar-input id="external-mcp-name" placeholder="Claude Code"></cr-bar-input>
      </div>
      <div class="cr-field">
        <span class="cr-field-label">${escapeHtml(t('settings.externalMcpWorkspace'))}</span>
        <cr-searchable-select id="external-mcp-workspace"></cr-searchable-select>
      </div>
      <div class="cr-field">
        <span class="cr-field-label">${escapeHtml(t('settings.externalMcpMode'))}</span>
        <cr-bar-select id="external-mcp-mode"></cr-bar-select>
      </div>
      <div class="cr-field">
        <span class="cr-field-label">${escapeHtml(t('settings.externalMcpTtl'))}</span>
        <cr-bar-select id="external-mcp-ttl"></cr-bar-select>
      </div>
      <div class="cr-row">
        <cr-bar-button variant="primary" id="external-mcp-create">${escapeHtml(t('settings.externalMcpCreate'))}</cr-bar-button>
        <span id="external-mcp-status" class="cr-status"></span>
      </div>
      <div id="external-mcp-token"${snippet ? '' : ' hidden'}>
        <p class="message" data-tone="warning">${escapeHtml(t('settings.externalMcpTokenOnce'))}</p>
        <pre class="mcp-tools-preview" id="external-mcp-snippet"></pre>
        <div class="cr-row">
          <cr-bar-button id="external-mcp-copy">${escapeHtml(t('settings.externalMcpCopy'))}</cr-bar-button>
        </div>
        <p class="cr-hint">${escapeHtml(t('settings.externalMcpTlsHint'))}</p>
      </div>
    </div>
    <div class="external-mcp-client-head external-mcp-clients-head">
      <h4>${escapeHtml(t('settings.externalMcpClients'))}</h4>
      ${data.clients.length ? `<cr-bar-button id="external-mcp-export-all">${escapeHtml(t('settings.externalMcpExportAll'))}</cr-bar-button>` : ''}
    </div>
    <div class="mcp-server-list">${clients}</div>
  `;

  const enabledBox = /** @type {any} */ (root.querySelector('#external-mcp-enabled'));
  const lanBox = /** @type {any} */ (root.querySelector('#external-mcp-allow-lan'));
  const workspaceSelect = /** @type {any} */ (root.querySelector('#external-mcp-workspace'));
  const modeSelect = /** @type {any} */ (root.querySelector('#external-mcp-mode'));
  const ttlSelect = /** @type {any} */ (root.querySelector('#external-mcp-ttl'));
  const status = root.querySelector('#external-mcp-status');
  if (enabledBox) enabledBox.checked = data.enabled;
  if (lanBox) lanBox.checked = data.allowLan;
  if (workspaceSelect) {
    workspaceSelect.options = data.folders;
    workspaceSelect.value = data.currentFolder || data.folders[0]?.value || '';
    workspaceSelect.searchPlaceholder = t('settings.externalMcpSearchFolders');
    workspaceSelect.emptyLabel = t('common.searchDropdownEmpty');
  }
  if (modeSelect) {
    modeSelect.options = modeOptions();
    modeSelect.value = 'plan';
  }
  if (ttlSelect) {
    ttlSelect.options = TTL_DAY_CHOICES.map((days) => ({ value: String(days), label: t('settings.externalMcpTtlDays', { days }) }));
    ttlSelect.value = '30';
  }
  const snippetEl = root.querySelector('#external-mcp-snippet');
  if (snippetEl) snippetEl.textContent = snippet;

  /**
   * @param {string} key
   * @param {boolean} value
   */
  const patchSetting = async (key, value) => {
    const res = await api('/api/settings', { method: 'PATCH', body: { [key]: value } });
    if (!res.json?.ok) {
      if (status) status.textContent = res.json?.error || t('settings.externalMcpError');
      return;
    }
    await refreshExternalMcpSettingsPanel();
  };
  enabledBox?.addEventListener('cr-change', (/** @type {CustomEvent} */ event) => {
    void patchSetting('externalMcpEnabled', event.detail?.checked === true);
  });
  lanBox?.addEventListener('cr-change', (/** @type {CustomEvent} */ event) => {
    void patchSetting('externalMcpAllowLan', event.detail?.checked === true);
  });

  root.querySelector('#external-mcp-create')?.addEventListener('click', async () => {
    const res = await api('/api/mcp/external-clients', {
      method: 'POST',
      body: {
        name: String(readBarInputLiveValue(root.querySelector('#external-mcp-name')) || '').trim(),
        workspaceFolder: String(workspaceSelect?.value || ''),
        mode: String(modeSelect?.value || 'plan'),
        ttlDays: Number(ttlSelect?.value || 30),
      },
    });
    if (!res.json?.ok) {
      if (status) status.textContent = res.json?.error || t('settings.externalMcpError');
      return;
    }
    const refreshed = await api('/api/mcp/external-clients');
    renderPanel(root, {
      ...data,
      clients: Array.isArray(refreshed.json?.clients) ? refreshed.json.clients : data.clients,
    }, configSnippet(endpointUrl(data.allowLan, String(res.json.endpointPath || data.endpointPath)), String(res.json.token)));
  });

  root.querySelector('#external-mcp-copy')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      if (status) status.textContent = t('settings.externalMcpCopied');
    } catch {
      if (status) status.textContent = t('settings.externalMcpCopyFailed');
    }
  });

  root.querySelectorAll('[data-external-mcp-client-mode]').forEach((element) => {
    const select = /** @type {any} */ (element);
    const id = select.getAttribute('data-external-mcp-client-mode') || '';
    const current = select.getAttribute('data-current') || 'plan';
    select.options = modeOptions();
    select.value = current;
    select.addEventListener('cr-change', async (/** @type {CustomEvent} */ event) => {
      const mode = String(event.detail?.value || '');
      if (!mode || mode === current) return;
      const res = await api(`/api/mcp/external-clients/${encodeURIComponent(id)}`, { method: 'PATCH', body: { mode } });
      if (!res.json?.ok) {
        if (status) status.textContent = res.json?.error || t('settings.externalMcpError');
        select.value = current;
        return;
      }
      await refreshExternalMcpSettingsPanel();
    });
  });

  root.querySelectorAll('[data-external-mcp-export]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.getAttribute('data-external-mcp-export') || '';
      const client = data.clients.find((row) => row.id === id);
      if (!client) return;
      openExportDialog({
        heading: `${t('settings.externalMcpExportClient')}: ${client.name}`,
        hint: t('settings.externalMcpExportHint', { env: TOKEN_ENV }),
        text: clientExportSnippet(client, url),
        fileName: `cretli-mcp-${fileSlug(client.name)}.txt`,
        rotate: clientState(client).tone === 'success'
          ? async () => {
            const res = await api(`/api/mcp/external-clients/${encodeURIComponent(id)}/rotate`, { method: 'POST' });
            if (!res.json?.ok) return { error: res.json?.error };
            return { text: configSnippet(endpointUrl(data.allowLan, String(res.json.endpointPath || data.endpointPath)), String(res.json.token)) };
          }
          : undefined,
      });
    });
  });

  root.querySelector('#external-mcp-export-all')?.addEventListener('click', () => {
    openExportDialog({
      heading: t('settings.externalMcpExportAll'),
      hint: t('settings.externalMcpExportAllHint'),
      text: allClientsExport(data.clients, url),
      fileName: 'cretli-mcp-clients.json',
    });
  });

  root.querySelectorAll('[data-external-mcp-revoke]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.getAttribute('data-external-mcp-revoke') || '';
      await api(`/api/mcp/external-clients/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await refreshExternalMcpSettingsPanel();
    });
  });
}

/** @param {unknown} value */
function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** @param {unknown} value */
function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, '&#39;');
}
