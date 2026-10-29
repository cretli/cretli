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
import { getViewContextRuntimeScope, withViewContextQuery } from '../../app/appShell/viewContextBridge.js';
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

/** Install targets, in tab order. `file` is the path written by "Install in folder". */
const TARGETS = [
  { id: 'claude', file: '.mcp.json', labelKey: 'settings.externalMcpTargetClaude' },
  { id: 'codex', file: '.codex/config.toml', labelKey: 'settings.externalMcpTargetCodex' },
  { id: 'cursor', file: '.cursor/mcp.json', labelKey: 'settings.externalMcpTargetCursor' },
];

/**
 * Configuration text for one client tool.
 *
 * @param {string} target claude | codex | cursor
 * @param {string} url
 * @param {string} token
 * @param {string} [cliToken] Token as written in the shell command (defaults to `token`).
 * @param {boolean} [viaEnv] The token is an environment-variable reference, not a secret.
 */
function targetSnippet(target, url, token, cliToken = token, viaEnv = false) {
  if (target === 'codex') {
    const auth = viaEnv
      ? `bearer_token_env_var = "${TOKEN_ENV}"`
      : `http_headers = { Authorization = "Bearer ${token}" }`;
    return `# Codex (.codex/config.toml)\n[mcp_servers.cretli]\nurl = "${url}"\n${auth}`;
  }
  if (target === 'cursor') {
    const bearer = viaEnv ? `Bearer \${env:${TOKEN_ENV}}` : `Bearer ${token}`;
    const json = JSON.stringify({ mcpServers: { cretli: { url, headers: { Authorization: bearer } } } }, null, 2);
    return `# Cursor (.cursor/mcp.json)\n${json}`;
  }
  const mcpJson = JSON.stringify({
    mcpServers: { cretli: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } },
  }, null, 2);
  const cli = `claude mcp add --transport http cretli ${url} --header "Authorization: Bearer ${cliToken}"`;
  return `# Claude Code (.mcp.json)\n${mcpJson}\n\n# Claude Code (CLI)\n${cli}`;
}

/**
 * Every target one after another (used by exports).
 *
 * @param {string} url
 * @param {string} token
 * @param {string} [cliToken]
 * @param {boolean} [viaEnv]
 */
function configSnippet(url, token, cliToken = token, viaEnv = false) {
  return TARGETS.map((target) => targetSnippet(target.id, url, token, cliToken, viaEnv)).join('\n\n');
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
  return `${header}\n\n${configSnippet(url, `\${${TOKEN_ENV}}`, `$${TOKEN_ENV}`, true)}`;
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

/** Workspace folders offered by the install folder pickers; refreshed with the panel. */
let knownFolders = /** @type {Array<{ value: string, label: string, description: string, group: string }>} */ ([]);
/** Folder of the workspace currently selected in the app; preselected in the pickers. */
let knownCurrentFolder = '';
const CUSTOM_FOLDER = '__custom__';

/**
 * Folders of the current workspace first, so its folders are one tap away.
 *
 * @param {typeof knownFolders} folders
 * @param {string} current
 */
function currentWorkspaceFirst(folders, current) {
  const group = folders.find((row) => row.value.toLowerCase() === current.toLowerCase())?.group;
  if (!group) return folders;
  return [...folders.filter((row) => row.group === group), ...folders.filter((row) => row.group !== group)];
}

/**
 * Install-folder picker: choose the client's workspace folder (empty value), a known
 * workspace folder, or type any absolute path. `host.getFolder()` returns the path
 * to send ('' = default).
 *
 * @param {HTMLElement} host
 */
function mountFolderPicker(host) {
  host.classList.add('external-mcp-folder-picker');
  const select = /** @type {any} */ (document.createElement('cr-searchable-select'));
  select.options = [
    { value: '', label: t('settings.externalMcpFolderDefault') },
    ...currentWorkspaceFirst(knownFolders, knownCurrentFolder),
    { value: CUSTOM_FOLDER, label: t('settings.externalMcpFolderCustom') },
  ];
  // Default to the client's own folder: a token must not land in another project by accident.
  select.value = '';
  select.searchPlaceholder = t('settings.externalMcpSearchFolders');
  select.emptyLabel = t('common.searchDropdownEmpty');
  select.setAttribute('aria-label', t('settings.externalMcpInstallFolder'));
  const input = /** @type {any} */ (document.createElement('cr-bar-input'));
  input.placeholder = t('settings.externalMcpInstallFolderPlaceholder');
  input.setAttribute('aria-label', t('settings.externalMcpInstallFolder'));
  input.hidden = true;
  select.addEventListener('cr-change', (/** @type {CustomEvent} */ event) => {
    select.value = String(event.detail?.value ?? '');
    input.hidden = select.value !== CUSTOM_FOLDER;
  });
  host.append(select, input);
  /** @type {any} */ (host).getFolder = () => (select.value === CUSTOM_FOLDER
    ? String(input.value || '').trim()
    : String(select.value || ''));
}

/** @param {Element | null} host */
function pickedFolder(host) {
  return String(/** @type {any} */ (host)?.getFolder?.() || '');
}

/** Connection modes of the installed entry: direct HTTP or the local stdio bridge. */
function installModeOptions() {
  return [
    { value: 'http', label: t('settings.externalMcpModeHttp') },
    { value: 'stdio', label: t('settings.externalMcpModeStdio') },
  ];
}

/**
 * Add local certificate trust only for the HTTPS stdio bridge.
 * @param {any} modeSelect
 * @param {HTMLElement} container
 * @param {string} url
 */
function mountCertificateTrust(modeSelect, container, url) {
  const field = document.createElement('div');
  const checkbox = /** @type {any} */ (document.createElement('cr-checkbox'));
  checkbox.checked = true;
  checkbox.setAttribute('aria-label', t('settings.externalMcpTrustCertificate'));
  checkbox.textContent = t('settings.externalMcpTrustCertificate');
  const hint = document.createElement('p');
  hint.className = 'cr-hint';
  hint.textContent = t('settings.externalMcpTrustCertificateHint');
  field.append(checkbox, hint);
  container.appendChild(field);
  const update = () => { field.hidden = modeSelect?.value !== 'stdio' || !url.startsWith('https:'); };
  modeSelect?.addEventListener('cr-change', update);
  update();
  return () => !field.hidden && checkbox.checked;
}

/**
 * Modal with a read-only export plus copy and download actions.
 *
 * `rotate` (optional) issues a new token and returns the configuration that
 * replaces the shown text; the old token stops working.
 *
 * `install` writes the configuration into the client's folder; once `rotate`
 * has issued a token it is passed along so the file gets the working token.
 *
 * @param {{ heading: string, text: string, fileName: string, hint?: string,
 *   rotate?: () => Promise<{ text?: string, token?: string, error?: string }>,
 *   install?: (target: string, token: string, folder: string, mode: string, trustCertificate: boolean) => Promise<{ ok: boolean, message: string }> }} params
 */
function openExportDialog({ heading, text: initialText, fileName, hint = '', rotate, install }) {
  let text = initialText;
  let currentToken = '';
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
  /** @type {HTMLElement | null} */
  let installNote = null;
  if (!install) body.appendChild(status);
  if (install) {
    const block = document.createElement('div');
    block.className = 'external-mcp-install-block';
    const blockTitle = document.createElement('div');
    blockTitle.className = 'cr-section-title';
    blockTitle.textContent = t('settings.externalMcpInstallTab');
    block.appendChild(blockTitle);
    const row = document.createElement('div');
    row.className = 'cr-row external-mcp-install';
    const targetSelect = /** @type {any} */ (document.createElement('cr-bar-select'));
    targetSelect.options = TARGETS.map((target) => ({ value: target.id, label: `${t(target.labelKey)} (${target.file})` }));
    targetSelect.value = TARGETS[0].id;
    const modeSelect = /** @type {any} */ (document.createElement('cr-bar-select'));
    modeSelect.options = installModeOptions();
    modeSelect.value = 'http';
    modeSelect.setAttribute('aria-label', t('settings.externalMcpInstallMode'));
    const folderInput = document.createElement('div');
    mountFolderPicker(folderInput);
    const installButton = document.createElement('cr-bar-button');
    installButton.setAttribute('variant', 'primary');
    installButton.textContent = t('settings.externalMcpInstall');
    installButton.addEventListener('click', async () => {
      const result = await install(String(targetSelect.value || TARGETS[0].id), currentToken, pickedFolder(folderInput), String(modeSelect.value || 'http'), trustCertificate());
      status.textContent = result.message;
      status.dataset.tone = result.ok ? 'success' : 'error';
    });
    row.append(targetSelect, modeSelect, folderInput, installButton);
    block.appendChild(row);
    const trustCertificate = mountCertificateTrust(modeSelect, block, window.location.origin);
    block.appendChild(status);
    installNote = document.createElement('p');
    installNote.className = 'cr-hint';
    installNote.textContent = t('settings.externalMcpInstallTokenNote');
    installNote.hidden = true;
    block.appendChild(installNote);
    body.appendChild(block);
  }
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
      currentToken = result.token || '';
      pre.textContent = text;
      if (installNote) installNote.hidden = !currentToken;
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
 * Writes the configuration into the client's workspace folder (token by env reference).
 *
 * @param {string} clientId
 * @param {string} target
 * @param {string} url
 * @param {string} [token] A token known right now (just created or rotated) is written into the file.
 * @param {string} [folder] Absolute folder to install into; the client's workspace folder when empty.
 * @param {string} [mode] `http` (default) or `stdio` (local bridge that survives server restarts).
 * @param {boolean} [trustCertificate] Trust the local Cretli certificate in the stdio bridge.
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
async function installIntoFolder(clientId, target, url, token, folder, mode, trustCertificate = false) {
  const res = await api(`/api/mcp/external-clients/${encodeURIComponent(clientId)}/install`, {
    method: 'POST',
    body: { target, url, trustCertificate, ...(token ? { token } : {}), ...(folder ? { folder } : {}), ...(mode ? { mode } : {}) },
  });
  if (!res.json?.ok) return { ok: false, message: res.json?.error || t('settings.externalMcpError') };
  const key = res.json.tokenWritten
    ? (res.json.existed ? 'settings.externalMcpInstalledTokenUpdated' : 'settings.externalMcpInstalledToken')
    : (res.json.existed ? 'settings.externalMcpInstalledUpdated' : 'settings.externalMcpInstalled');
  return { ok: true, message: t(key, { file: res.json.relativeFile, env: res.json.tokenEnv }) };
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
 * The folder currently selected in the app. A workspace file can list many
 * unrelated projects, so scoping by the whole workspace would show them all.
 *
 * @returns {string[]}
 */
function currentWorkspaceFolderPaths() {
  return knownCurrentFolder ? [knownCurrentFolder] : [];
}

/** Show clients of every workspace instead of only the current one. */
let showAllClients = false;

/** @param {string} value */
function normalizeFolder(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
}

/**
 * Clients bound to the current workspace's folders; everything when the scope is unknown.
 *
 * @param {any[]} clients
 * @returns {any[]}
 */
function clientsInCurrentWorkspace(clients) {
  const scope = new Set(currentWorkspaceFolderPaths().map(normalizeFolder));
  if (!scope.size) return clients;
  return clients.filter((client) => scope.has(normalizeFolder(client.workspaceFolder)));
}

/**
 * Lists where the Cretli MCP entry is installed in the current workspace's folders.
 *
 * @param {HTMLElement | null} host
 */
async function renderInstalls(host) {
  if (!host) return;
  const folders = currentWorkspaceFolderPaths();
  const res = folders.length
    ? await api('/api/mcp/external-installs', { method: 'POST', body: { folders } })
    : { json: { ok: true, installs: [] } };
  if (!res.json?.ok) {
    host.innerHTML = `<p class="message" data-tone="error">${escapeHtml(res.json?.error || t('settings.externalMcpError'))}</p>`;
    return;
  }
  const installs = Array.isArray(res.json.installs) ? res.json.installs : [];
  if (!installs.length) {
    host.innerHTML = `<p class="cr-hint">${escapeHtml(t('settings.externalMcpInstallsEmpty'))}</p>`;
    return;
  }
  host.innerHTML = installs.map((row) => `
    <article class="cr-card mcp-server-card">
      <div class="external-mcp-client-head">
        <h4>${escapeHtml(String(row.folder).split('/').filter(Boolean).pop() || row.folder)}</h4>
        <span class="external-mcp-badge" data-tone="${row.mode === 'stdio' ? 'success' : 'muted'}">${escapeHtml(t(row.mode === 'stdio' ? 'settings.externalMcpModeStdioShort' : 'settings.externalMcpModeHttpShort'))}</span>
      </div>
      <p class="cr-hint">${escapeHtml(row.folder)}/${escapeHtml(row.relativeFile)}</p>
      <p class="cr-hint">${escapeHtml(row.url)} · ${escapeHtml(t(row.tokenInFile ? 'settings.externalMcpInstallsTokenFile' : 'settings.externalMcpInstallsTokenEnv', { env: TOKEN_ENV }))}</p>
    </article>`).join('');
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
      ${client.revokedAt ? '' : `<div class="cr-row external-mcp-install">
        <cr-bar-select data-external-mcp-install-target="${escapeAttr(client.id)}" aria-label="${escapeAttr(t('settings.externalMcpInstallTarget'))}"></cr-bar-select>
        <cr-bar-select data-external-mcp-install-mode="${escapeAttr(client.id)}" aria-label="${escapeAttr(t('settings.externalMcpInstallMode'))}"></cr-bar-select>
        <div data-external-mcp-install-folder="${escapeAttr(client.id)}"></div>
        <cr-bar-button data-external-mcp-install="${escapeAttr(client.id)}">
          <span class="mdi mdi-folder-download-outline" aria-hidden="true"></span> ${escapeHtml(t('settings.externalMcpInstall'))}
        </cr-bar-button>
        <span class="cr-status" data-external-mcp-install-status="${escapeAttr(client.id)}"></span>
      </div>`}
    </article>`;
}

/**
 * @returns {Promise<void>}
 */
export async function refreshExternalMcpSettingsPanel() {
  const root = document.getElementById(ROOT_ID);
  if (!root) return;
  root.innerHTML = `<p class="settings-hint">${escapeHtml(t('settings.mcpLoading'))}</p>`;
  // The active folder comes from the tab's view context (same as chats and todos).
  const scope = getViewContextRuntimeScope();
  const [list, context, workspacesRes] = await Promise.all([
    api('/api/mcp/external-clients'),
    scope.workspaceFolder ? null : api(withViewContextQuery('/api/workspace/context')),
    api('/api/workspaces'),
  ]);
  const activeFolder = String(scope.workspaceFolder || context?.json?.folder?.resolvedPath || '');
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
      activeFolder,
    ),
    currentFolder: activeFolder.replace(/\\/g, '/').replace(/\/$/, ''),
  });
}

/**
 * @param {HTMLElement} root
 * @param {{ enabled: boolean, allowLan: boolean, endpointPath: string, clients: any[],
 *   folders: Array<{ value: string, label: string, description: string, group: string }>, currentFolder: string }} data
 * @param {{ clientId: string, token: string, url: string } | null} [created] One-time token shown right after creating a client.
 */
function renderPanel(root, data, created = null) {
  knownFolders = data.folders;
  knownCurrentFolder = data.currentFolder;
  const url = endpointUrl(data.allowLan, data.endpointPath);
  const visibleClients = showAllClients ? data.clients : clientsInCurrentWorkspace(data.clients);
  const hiddenCount = data.clients.length - visibleClients.length;
  const clients = visibleClients.length === 0
    ? `<p class="settings-hint">${escapeHtml(t('settings.externalMcpEmpty'))}</p>`
    : visibleClients.map(renderClientCard).join('');
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
      <div id="external-mcp-token" class="mcp-code"${created ? '' : ' hidden'}>
        <p class="message" data-tone="warning">${escapeHtml(t('settings.externalMcpTokenOnce'))}</p>
        <div class="mcp-code-tabs" role="tablist">
          ${TARGETS.map((target) => `<button type="button" role="tab" class="mcp-code-tab" data-mcp-target="${target.id}">${escapeHtml(t(target.labelKey))}</button>`).join('')}
        </div>
        <div class="mcp-code-frame">
          <div class="mcp-code-bar">
            <span class="mcp-code-file" id="external-mcp-file"></span>
            <button type="button" class="mcp-code-copy" id="external-mcp-copy">
              <span class="mdi mdi-content-copy" aria-hidden="true"></span>
              <span class="mcp-code-copy-label">${escapeHtml(t('settings.externalMcpCopy'))}</span>
            </button>
          </div>
          <pre class="mcp-code-pre" id="external-mcp-snippet"></pre>
        </div>
        <div class="cr-row external-mcp-install">
          <cr-bar-select id="external-mcp-install-created-mode" aria-label="${escapeAttr(t('settings.externalMcpInstallMode'))}"></cr-bar-select>
          <div id="external-mcp-install-created-folder"></div>
          <cr-bar-button id="external-mcp-install-created">
            <span class="mdi mdi-folder-download-outline" aria-hidden="true"></span> ${escapeHtml(t('settings.externalMcpInstallTab'))}
          </cr-bar-button>
          <span id="external-mcp-install-created-status" class="cr-status"></span>
        </div>
        <p class="cr-hint">${escapeHtml(t('settings.externalMcpInstallHint', { env: TOKEN_ENV }))}</p>
        <p class="cr-hint">${escapeHtml(t('settings.externalMcpTlsHint'))}</p>
      </div>
    </div>
    <div class="external-mcp-client-head external-mcp-clients-head">
      <h4>${escapeHtml(t('settings.externalMcpInstalls'))}</h4>
      <cr-bar-button id="external-mcp-installs-refresh">${escapeHtml(t('settings.externalMcpInstallsRefresh'))}</cr-bar-button>
    </div>
    <div id="external-mcp-installs" class="mcp-server-list"></div>
    <div class="external-mcp-client-head external-mcp-clients-head">
      <h4>${escapeHtml(t('settings.externalMcpClients'))}</h4>
      ${visibleClients.length ? `<cr-bar-button id="external-mcp-export-all">${escapeHtml(t('settings.externalMcpExportAll'))}</cr-bar-button>` : ''}
    </div>
    ${hiddenCount > 0 || showAllClients ? `<p class="cr-hint external-mcp-clients-scope"><cr-bar-button id="external-mcp-clients-scope">${escapeHtml(showAllClients ? t('settings.externalMcpClientsCurrentOnly') : t('settings.externalMcpClientsShowAll', { count: hiddenCount }))}</cr-bar-button></p>` : ''}
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
  if (created) bindCreatedSnippet(root, created);
  root.querySelector('#external-mcp-clients-scope')?.addEventListener('click', () => {
    showAllClients = !showAllClients;
    renderPanel(root, data, created);
  });
  const installsList = /** @type {HTMLElement | null} */ (root.querySelector('#external-mcp-installs'));
  const loadInstalls = () => renderInstalls(installsList);
  root.querySelector('#external-mcp-installs-refresh')?.addEventListener('click', loadInstalls);
  void loadInstalls();

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
    }, {
      clientId: String(res.json.client?.id || ''),
      token: String(res.json.token),
      url: endpointUrl(data.allowLan, String(res.json.endpointPath || data.endpointPath)),
    });
  });

  root.querySelectorAll('[data-external-mcp-install-target]').forEach((element) => {
    const select = /** @type {any} */ (element);
    const id = select.getAttribute('data-external-mcp-install-target') || '';
    select.options = TARGETS.map((target) => ({ value: target.id, label: `${t(target.labelKey)} (${target.file})` }));
    select.value = TARGETS[0].id;
    const modeSelect = /** @type {any} */ (root.querySelector(`[data-external-mcp-install-mode="${CSS.escape(id)}"]`));
    if (modeSelect) {
      modeSelect.options = installModeOptions();
      modeSelect.value = 'http';
    }
    const folderHost = /** @type {HTMLElement | null} */ (root.querySelector(`[data-external-mcp-install-folder="${CSS.escape(id)}"]`));
    if (folderHost) mountFolderPicker(folderHost);
    const certificateContainer = document.createElement('div');
    const installRow = select.closest('.external-mcp-install');
    installRow?.after(certificateContainer);
    const trustCertificate = mountCertificateTrust(modeSelect, certificateContainer, url);
    const button = root.querySelector(`[data-external-mcp-install="${CSS.escape(id)}"]`);
    const out = root.querySelector(`[data-external-mcp-install-status="${CSS.escape(id)}"]`);
    button?.addEventListener('click', async () => {
      if (out) out.textContent = '';
      const result = await installIntoFolder(id, String(select.value || TARGETS[0].id), url, undefined, pickedFolder(folderHost), String(modeSelect?.value || 'http'), trustCertificate());
      if (out) {
        out.textContent = result.message;
        /** @type {HTMLElement} */ (out).dataset.tone = result.ok ? 'success' : 'error';
      }
    });
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
            return {
              text: configSnippet(endpointUrl(data.allowLan, String(res.json.endpointPath || data.endpointPath)), String(res.json.token)),
              token: String(res.json.token),
            };
          }
          : undefined,
        install: clientState(client).tone === 'success'
          ? (target, token, folder, mode, trustCertificate) => installIntoFolder(id, target, url, token, folder, mode, trustCertificate)
          : undefined,
      });
    });
  });

  root.querySelector('#external-mcp-export-all')?.addEventListener('click', () => {
    openExportDialog({
      heading: t('settings.externalMcpExportAll'),
      hint: t('settings.externalMcpExportAllHint'),
      text: allClientsExport(showAllClients ? data.clients : clientsInCurrentWorkspace(data.clients), url),
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

/**
 * Tabs + copy button + install button of the one-time token block.
 *
 * @param {HTMLElement} root
 * @param {{ clientId: string, token: string, url: string }} created
 */
function bindCreatedSnippet(root, created) {
  const pre = root.querySelector('#external-mcp-snippet');
  const fileLabel = root.querySelector('#external-mcp-file');
  const copy = root.querySelector('#external-mcp-copy');
  const installButton = /** @type {any} */ (root.querySelector('#external-mcp-install-created'));
  const installStatus = /** @type {HTMLElement | null} */ (root.querySelector('#external-mcp-install-created-status'));
  const tabs = Array.from(root.querySelectorAll('.mcp-code-tab'));
  let active = TARGETS[0].id;
  const show = (/** @type {string} */ id) => {
    active = id;
    const target = TARGETS.find((row) => row.id === id) || TARGETS[0];
    if (pre) pre.textContent = targetSnippet(target.id, created.url, created.token);
    if (fileLabel) fileLabel.textContent = target.file;
    for (const tab of tabs) {
      const on = tab.getAttribute('data-mcp-target') === id;
      tab.setAttribute('aria-selected', String(on));
      tab.classList.toggle('is-active', on);
    }
    if (installStatus) installStatus.textContent = '';
  };
  tabs.forEach((tab) => tab.addEventListener('click', () => show(tab.getAttribute('data-mcp-target') || active)));
  show(active);

  const label = copy?.querySelector('.mcp-code-copy-label');
  copy?.addEventListener('click', async () => {
    let text = t('settings.externalMcpCopied');
    try {
      await navigator.clipboard.writeText(pre?.textContent || '');
    } catch {
      text = t('settings.externalMcpCopyFailed');
    }
    if (label) label.textContent = text;
    window.setTimeout(() => { if (label) label.textContent = t('settings.externalMcpCopy'); }, 1800);
  });
  const createdFolder = root.querySelector('#external-mcp-install-created-folder');
  if (createdFolder) mountFolderPicker(/** @type {HTMLElement} */ (createdFolder));
  const createdMode = /** @type {any} */ (root.querySelector('#external-mcp-install-created-mode'));
  if (createdMode) {
    createdMode.options = installModeOptions();
    createdMode.value = 'http';
  }
  const certificateContainer = document.createElement('div');
  createdMode?.closest('.external-mcp-install')?.after(certificateContainer);
  const trustCertificate = mountCertificateTrust(createdMode, certificateContainer, created.url);
  installButton?.addEventListener('click', async () => {
    const result = await installIntoFolder(created.clientId, active, created.url, created.token, pickedFolder(createdFolder), String(createdMode?.value || 'http'), trustCertificate());
    if (installStatus) {
      installStatus.textContent = result.message;
      installStatus.dataset.tone = result.ok ? 'success' : 'error';
    }
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
