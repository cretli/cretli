import { html, render, nothing } from 'lit';
import { t } from '../../i18n/index.js';
import { cretliApiFetch } from '../../lib/cretliApiRequest.js';
import { navigateSpa } from '../../app/appShell/spaNavigationBridge.js';
import { readCurrentWorkspaceScope } from '../tasks/state/workspaceScope.js';
import '../../components/ui/index.js';
import './apps-panel.scss';

// Changes arrive as `appsChanged` / `portExposuresChanged` frames; polling only covers a lost socket.
const POLL_MS = 15_000;
const CHANGE_DEBOUNCE_MS = 150;
/** A freshly started app needs a moment before its port listens. */
const AFTER_START_REFRESH_MS = Object.freeze([1500, 4000]);
const TTL_OPTIONS = Object.freeze([
  { ms: 3600_000, key: 'apps.ttl1h' },
  { ms: 8 * 3600_000, key: 'apps.ttl8h' },
  { ms: 24 * 3600_000, key: 'apps.ttl24h' },
]);
const ERROR_KEYS = Object.freeze({
  'port-in-use': 'apps.portInUse',
  'port-loopback-only': 'apps.errorLoopback',
  'port-denylisted': 'apps.errorDenylisted',
  'port-out-of-range': 'apps.errorOutOfRange',
  'already-exposed': 'apps.errorAlreadyExposed',
  'app-running': 'apps.errorRunning',
  'app-external': 'apps.errorExternal',
  'task-not-found': 'apps.errorTaskMissing',
  'workspace-unknown': 'apps.errorWorkspace',
  'takeover-outside-workspace': 'apps.errorTakeoverOutside',
  'takeover-stale': 'apps.errorTakeoverStale',
  'takeover-timeout': 'apps.errorTakeoverTimeout',
  'takeover-failed': 'apps.errorTakeoverFailed',
  'listeners-unavailable': 'apps.errorListeners',
});

const TABS = Object.freeze(['apps', 'suggestions', 'ports']);
// cr-tabs saves the choice under `<storage-key>:default`; reading the same entry here keeps the
// first render on that tab, so the element has nothing to restore while Lit is still rendering.
const TAB_STORAGE_KEY = 'cretli-apps-tab';

function savedTab() {
  try {
    const saved = localStorage.getItem(`${TAB_STORAGE_KEY}:default`);
    return TABS.includes(saved) ? saved : TABS[0];
  } catch { return TABS[0]; }
}

const freshView = () => ({ status: null, exposures: [], foreign: [], suggestions: [], error: '', message: '', tone: '', dialog: null, orphanFilter: '' });

/** @type {ReturnType<typeof freshView> & { folder: string, tab: string, busy: Set<string>, ttl: Record<string, number>, qr: Record<string, boolean> }} */
const state = { ...freshView(), folder: '', tab: savedTab(), busy: new Set(), ttl: {}, qr: {} };
let timer = null;
let changeTimer = null;
let loadSeq = 0;

/** Adds the workspace selected in the header; the server refuses a folder that is not registered. */
function scoped(path) {
  if (!state.folder) return path;
  return `${path}${path.includes('?') ? '&' : '?'}workspaceFolder=${encodeURIComponent(state.folder)}`;
}

async function api(path, init) {
  const response = await cretliApiFetch(path, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.message || body.error || 'requestFailed'), { code: body.error, body });
  return body;
}
const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

const errorText = (err) => (ERROR_KEYS[err?.code] ? t(ERROR_KEYS[err.code], { killHint: err.body?.killHint || '' }) : String(err?.message || t('apps.actionFailed')));
const isLoopback = (addr) => /^127\./.test(String(addr || '')) || addr === '::1' || addr === '[::1]';
const isRemoteUi = () => !['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);
const folderName = (folder) => String(folder || '').split('/').filter(Boolean).pop() || '';
const slug = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56);

/** Formats a duration since an ISO timestamp, e.g. "2h 5m". */
function uptime(iso) {
  const ms = Date.now() - Date.parse(iso || '');
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.floor(ms / 60_000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); setMessage(t('apps.copied'), 'success'); }
  catch { setMessage(t('apps.copyFailed'), 'error'); }
}

function setMessage(message, tone = '') { state.message = message; state.tone = tone; paint(); }

const exposureFor = (port) => state.exposures.find((e) => e.port === port && e.state !== 'closed') || null;
/** A forwarding rule made outside Cretli: the port is on the LAN, but Cretli does not own the rule. */
const foreignRuleFor = (port) => state.foreign.find((r) => r.port === port) || null;

function appStateLabel(app) {
  if (app.external) return app.status === 'running' ? ['apps.statusExternal', 'success'] : ['apps.statusExternalDown', 'error'];
  if (app.status === 'running') return ['apps.statusRunning', 'success'];
  if (app.status === 'failed') return ['apps.statusFailed', 'error'];
  return ['apps.statusStopped', ''];
}

function portState(p) {
  const e = exposureFor(p.port);
  if (e?.state === 'pending_manual') return ['apps.portPendingManual', ''];
  if (e) return ['apps.portExposed', 'success'];
  if (foreignRuleFor(p.port) && p.listening) return ['apps.portExposedForeign', 'success'];
  if (p.ownedBy === 'foreign') return ['apps.portConflict', 'error'];
  if (p.listening) return ['apps.portListening', ''];
  return ['apps.portClosed', ''];
}

/** Runs one action; other rows stay usable while it is in flight. */
async function runAction(key, fn) {
  if (state.busy.has(key)) return;
  state.busy.add(key);
  paint();
  try { await fn(); await load({ refresh: true }); }
  catch (err) { setMessage(errorText(err), 'error'); }
  finally { state.busy.delete(key); paint(); }
}

function appAction(id, action) {
  return runAction(`${action}:${id}`, async () => {
    await post(scoped(`/api/apps/${encodeURIComponent(id)}/${action}`));
    if (action !== 'stop') for (const ms of AFTER_START_REFRESH_MS) setTimeout(() => { void load({ refresh: true }); }, ms);
  });
}

async function expose(app, p) {
  const ttlMs = state.ttl[p.port] || TTL_OPTIONS[1].ms;
  await runAction(`expose:${p.port}`, async () => {
    const result = await post('/api/port-exposures', { port: p.port, ttlMs, owner: `app:${app.id}`, reason: app.name });
    if (result.entry?.state === 'pending_manual' || result.commands?.length) {
      state.dialog = { kind: 'manual', port: p.port, commands: result.commands || [] };
    }
  });
}

async function closeExposure(p) {
  await runAction(`close:${p.port}`, async () => {
    const result = await api(`/api/port-exposures/${p.port}`, { method: 'DELETE' });
    if (result.closeState === 'pending_manual') state.dialog = { kind: 'manual', port: p.port, commands: result.commands || [] };
  });
}

function uniqueId(base) {
  const taken = new Set((state.status?.apps || []).map((a) => a.id));
  let id = base || 'app';
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  return id;
}

/** Without a command the app runs outside Cretli, which then only needs a port to watch. */
async function submitAdd() {
  const d = state.dialog;
  const name = String(d?.name || '').trim();
  const command = String(d?.command || '').trim();
  const port = Number(d?.port);
  d.error = '';
  if (!name) d.error = t('apps.addNameRequired');
  else if (!command && !String(d.port || '').trim()) d.error = t('apps.addCommandOrPortRequired');
  else if (String(d.port || '').trim() && !(Number.isInteger(port) && port >= 1 && port <= 65535)) d.error = t('apps.addPortInvalid');
  if (d.error) { paint(); return; }
  const ports = String(d.port || '').trim() ? [{ port, bind: d.bind || '127.0.0.1', role: 'http' }] : [];
  await runAction('add', async () => {
    await post(scoped('/api/apps'), { app: { id: uniqueId(slug(name)), name, start: command ? { command } : { external: true }, ports, exposure: 'local' } });
    state.dialog = null;
    setMessage(t('apps.orphanAdded'), 'success');
    await loadSuggestions();
  });
}

function addSuggestion(s) {
  state.dialog = { kind: 'suggestion', suggestion: s };
  paint();
}

async function submitSuggestion(s) {
  return runAction(`suggest:${s.app.id}`, async () => {
    await post(scoped('/api/apps'), { app: { ...s.app, id: uniqueId(s.app.id) } });
    state.dialog = null;
    setMessage(t('apps.orphanAdded'), 'success');
    await loadSuggestions();
  });
}

/** The dialog closes either way: a refusal is shown in the panel message with its `kill` hint. */
function takeOver(d) {
  state.dialog = null;
  return runAction(`takeover:${d.app.id}`, async () => {
    await post(scoped(`/api/apps/${encodeURIComponent(d.app.id)}/takeover`), { pids: d.conflicts.map((p) => p.listener.pid) });
    for (const ms of AFTER_START_REFRESH_MS) setTimeout(() => { void load({ refresh: true }); }, ms);
  });
}

function removeApp(app) {
  return runAction(`remove:${app.id}`, async () => {
    await api(scoped(`/api/apps/${encodeURIComponent(app.id)}`), { method: 'DELETE' });
    state.dialog = null;
    await loadSuggestions();
  });
}

async function loadSuggestions() {
  try { state.suggestions = (await api(scoped('/api/apps/suggestions'))).suggestions || []; }
  catch { state.suggestions = []; }
  paint();
}

/** A workspace switch drops the previous view at once, so another project's apps are never shown. */
function syncWorkspace() {
  const folder = readCurrentWorkspaceScope().workspaceFolder;
  if (folder === state.folder) return false;
  Object.assign(state, freshView(), { folder });
  return true;
}

/**
 * Status paints as soon as it arrives; exposures follow on their own, so a slow network report
 * never holds the list back. A response for an older workspace or request is dropped.
 * @param {{ refresh?: boolean }} [opts]
 */
async function load({ refresh = false } = {}) {
  const switched = syncWorkspace();
  const seq = ++loadSeq;
  if (switched) paint();
  const exposuresRequest = api('/api/port-exposures').catch(() => null);
  try {
    const status = await api(scoped(`/api/apps/status${refresh ? '?refresh=1' : ''}`));
    if (seq !== loadSeq) return;
    state.status = status;
    state.error = '';
  } catch (err) {
    if (seq !== loadSeq) return;
    state.error = errorText(err) || t('apps.loadError');
  }
  paint();
  const exposures = await exposuresRequest;
  if (seq === loadSeq && exposures) { state.exposures = exposures.exposures || []; state.foreign = exposures.foreign || []; paint(); }
  if (switched || !state.suggestions.length) void loadSuggestions();
}

function openChat(chatId) {
  return html`<a href=${`/?panel=chat&chat=${encodeURIComponent(chatId)}`}>${t('apps.byChat')}</a>`;
}

function exposeControls(app, p, e) {
  if (e) {
    return html`<cr-bar-button ?disabled=${state.busy.has(`close:${p.port}`)} @click=${() => closeExposure(p)}>${t('apps.closeExposure')}</cr-bar-button>`;
  }
  if (!p.listening) return html`<span class="apps-meta">${t('apps.exposeNeedsListening')}</span>`;
  if (foreignRuleFor(p.port)) return html`<span class="apps-meta">${t('apps.exposedForeignHint')}</span>`;
  if (isLoopback(p.listener?.address)) return html`<span class="apps-meta">${t('apps.exposeLoopback')}</span>`;
  return html`<select class="apps-ttl" aria-label=${t('apps.ttl')} @change=${(ev) => { state.ttl[p.port] = Number(ev.target.value); }}>
      ${TTL_OPTIONS.map((o) => html`<option value=${o.ms} ?selected=${(state.ttl[p.port] || TTL_OPTIONS[1].ms) === o.ms}>${t(o.key)}</option>`)}
    </select>
    <cr-bar-button ?disabled=${state.busy.has(`expose:${p.port}`)} @click=${() => expose(app, p)}>${t('apps.expose')}</cr-bar-button>`;
}

function portRow(app, p) {
  const [label, tone] = portState(p);
  const e = exposureFor(p.port);
  const webPort = p.role === 'http' || p.role === 'api';
  const lanHost = state.status?.lanHost;
  const onLan = (e && e.state === 'active') || (!e && p.listening && foreignRuleFor(p.port));
  const lan = onLan && lanHost ? `${webPort ? 'http' : 'tcp'}://${lanHost}:${p.port}` : '';
  const local = `http://127.0.0.1:${p.port}`;
  // A loopback address means nothing on a phone, so a remote UI only links what it can reach.
  const openUrl = lan || (isRemoteUi() ? '' : local);
  const owner = e && String(e.owner || '').startsWith('chat:') ? openChat(String(e.owner).slice(5)) : (e ? t('apps.byUser') : nothing);
  return html`<li class="apps-port">
    <div class="apps-port-line">
      <code>:${p.port}</code><span class="apps-meta">${p.role}</span>
      <span class="apps-badge" data-tone=${tone}>${t(label)}</span>
      ${p.listener?.pid ? html`<span class="apps-meta">PID ${p.listener.pid}</span>` : nothing}
      ${p.health?.code ? html`<span class="apps-meta" data-tone=${p.health.ok ? 'success' : 'error'}>HTTP ${p.health.code}</span>` : nothing}
    </div>
    ${p.ownedBy === 'foreign' ? html`<div class="apps-meta" data-tone="error">${t('apps.portConflictHint', { command: p.listener?.command || '?' })}</div>` : nothing}
    ${e ? html`<div class="apps-meta">${owner} · ${t('apps.expires')} ${new Date(e.expiresAt).toLocaleString()}</div>` : nothing}
    ${lan ? html`<div class="apps-port-line"><code>${lan}</code>
      <cr-bar-button @click=${() => copy(lan)}>${t('apps.copyLan')}</cr-bar-button>
      <cr-bar-button @click=${() => { state.qr[p.port] = !state.qr[p.port]; paint(); }}>${t('apps.qr')}</cr-bar-button></div>
      ${state.qr[p.port] ? html`<img class="apps-qr" alt=${t('apps.qr')} width="160" height="160" src=${`https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(lan)}`} />
        <span class="apps-meta">${t('apps.qrExternal')}</span>` : nothing}` : nothing}
    <div class="apps-actions">
      ${webPort && p.listening && openUrl ? html`<cr-bar-button @click=${() => window.open(openUrl, '_blank', 'noopener')}>${t('apps.openBrowser')}</cr-bar-button>` : nothing}
      <cr-bar-button @click=${() => copy(local)}>${t('apps.copyLocal')}</cr-bar-button>
      ${exposeControls(app, p, e)}
    </div>
  </li>`;
}

/** One process usually listens on both IPv4 and IPv6; that is one row for a reader. */
function uniqueOrphans(orphans) {
  const seen = new Set();
  return (orphans || []).filter((o) => {
    const key = `${o.port}:${o.pid}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function appCard(app) {
  const [label, tone] = appStateLabel(app);
  const running = app.status === 'running';
  const busy = (action) => state.busy.has(`${action}:${app.id}`);
  const lastError = app.errors?.[app.errors.length - 1]?.message;
  const conflicts = app.ports.filter((p) => p.ownedBy === 'foreign' && p.listener?.pid);
  return html`<div class="cr-card" data-app-id=${app.id}>
    <div class="apps-card-head">
      <span class="apps-card-name">${app.name}</span>
      <span class="apps-badge" data-tone=${tone}>${t(label)}</span>
      ${app.pid ? html`<span class="apps-meta">PID ${app.pid}</span>` : nothing}
      ${running && app.lastChangeAt ? html`<span class="apps-meta">${t('apps.uptime')} ${uptime(app.lastChangeAt)}</span>` : nothing}
    </div>
    ${lastError && !running ? html`<div class="apps-meta" data-tone="error">${lastError}</div>` : nothing}
    <div class="apps-actions">
      ${running && !app.external
        ? html`<cr-bar-button ?disabled=${busy('stop')} @click=${() => appAction(app.id, 'stop')}>${t('apps.stop')}</cr-bar-button>
               <cr-bar-button ?disabled=${busy('restart')} @click=${() => appAction(app.id, 'restart')}>${t('apps.restart')}</cr-bar-button>`
        : nothing}
      ${!running && !app.external && !conflicts.length ? html`<cr-bar-button variant="primary" ?disabled=${busy('start')} @click=${() => appAction(app.id, 'start')}>${t('apps.start')}</cr-bar-button>` : nothing}
      ${!running && !app.external && conflicts.length ? html`<cr-bar-button variant="primary" ?disabled=${busy('takeover')} @click=${() => { state.dialog = { kind: 'takeover', app, conflicts }; paint(); }}>${t('apps.takeover')}</cr-bar-button>` : nothing}
      ${!running || app.external ? html`<cr-bar-button @click=${() => { state.dialog = { kind: 'remove', app }; paint(); }}>${t('apps.remove')}</cr-bar-button>` : nothing}
      ${app.runId ? html`<cr-bar-button @click=${() => navigateSpa({ panel: 'tasks', query: { run: app.runId } }, { explicit: true })}>${t('apps.console')}</cr-bar-button>` : nothing}
    </div>
    ${app.ports.length ? html`<ul class="apps-ports">${app.ports.map((p) => portRow(app, p))}</ul>` : nothing}
  </div>`;
}

function suggestionsSection() {
  const list = state.suggestions;
  if (!list.length) return html`<p class="cr-hint">${t('apps.suggestionsEmpty')}</p>`;
  return html`<section>
    <p class="cr-hint">${t('apps.suggestionsHint')}</p>
    <h3 class="cr-section-title">${t('apps.suggestionsTitle')}</h3>
    ${list.map((s) => html`<div class="apps-orphan" data-suggestion-id=${s.app.id}>
      <span class="apps-card-name">${s.app.name}</span>
      <span class="apps-meta">${s.file || s.source}</span>
      ${s.app.ports.map((p) => html`<code>:${p.port}</code>`)}
      <cr-bar-button @click=${() => addSuggestion(s)}>${t('apps.reviewSuggestion')}</cr-bar-button>
    </div>`)}
  </section>`;
}

/** Orphans are read-only on purpose: Cretli never ends a process it did not start. */
function orphansSection(orphans) {
  if (!orphans.length) return html`<p class="cr-hint">${t('apps.orphansEmpty')}</p>`;
  const needle = state.orphanFilter.trim().toLowerCase();
  const rows = needle ? orphans.filter((o) => `${o.port} ${o.command || ''}`.toLowerCase().includes(needle)) : orphans;
  return html`<section class="apps-orphans">
      <p class="cr-hint">${t('apps.orphansHint')}</p>
      <cr-bar-input .value=${state.orphanFilter} placeholder=${t('apps.orphansFilter')} aria-label=${t('apps.orphansFilter')}
        @input=${(e) => { state.orphanFilter = e.target.value; paint(); }}></cr-bar-input>
      ${rows.map((o) => html`<div class="apps-orphan">
        <code>:${o.port}</code><span class="apps-meta">${o.bind}</span>
        ${o.command ? html`<span class="apps-meta">${o.command}</span>` : nothing}
        ${o.pid ? html`<span class="apps-meta">PID ${o.pid}</span>` : nothing}
        <cr-bar-button @click=${() => openAdd({ port: o.port, bind: o.bind, name: o.command ? `${o.command} :${o.port}` : '' })}>${t('apps.addAsApp')}</cr-bar-button>
        ${o.killHint ? html`<cr-bar-button @click=${() => copy(o.killHint)}>${t('apps.copyKill')}</cr-bar-button>` : nothing}
      </div>`)}
  </section>`;
}

function helperNotice(s) {
  const net = s?.network;
  if (!net || net.platform !== 'wsl2' || net.helper === 'ready' || !s.apps.length) return nothing;
  return html`<p class="apps-notice">
    <span>${t('apps.helperNotice')}</span>
    <cr-bar-button @click=${() => navigateSpa({ panel: 'settings', settingsTab: 'connection-network' }, { explicit: true })}>${t('apps.helperOpenSettings')}</cr-bar-button>
  </p>`;
}

function openAdd(preset = {}) {
  state.dialog = { kind: 'add', name: '', command: '', bind: '127.0.0.1', ...preset, port: String(preset.port ?? '') };
  paint();
}

function closeDialog() { state.dialog = null; paint(); }

function addDialog(d) {
  return html`<cr-dialog open .heading=${t('apps.addTitle')} @cr-dialog-close=${closeDialog}>
    <p class="cr-hint">${t('apps.addHint', { workspace: folderName(state.folder) })}</p>
    <div class="cr-field"><label class="cr-field-label">${t('apps.addName')}</label>
      <cr-bar-input .value=${d.name} placeholder="my-app" @input=${(e) => { d.name = e.target.value; }}></cr-bar-input></div>
    <div class="cr-field"><label class="cr-field-label">${t('apps.addCommand')}</label>
      <cr-bar-input .value=${d.command} placeholder="npm run dev" @input=${(e) => { d.command = e.target.value; }}></cr-bar-input>
      <p class="cr-hint">${t('apps.addCommandHint')}</p></div>
    <div class="cr-field"><label class="cr-field-label">${t('apps.addPort')}</label>
      <cr-bar-input type="number" .value=${d.port} placeholder="5173" @input=${(e) => { d.port = e.target.value; }}></cr-bar-input></div>
    ${d.error ? html`<p class="cr-status" data-tone="error">${d.error}</p>` : nothing}
    <div slot="actions">
      <cr-bar-button @click=${closeDialog}>${t('apps.cancel')}</cr-bar-button>
      <cr-bar-button variant="primary" ?disabled=${state.busy.has('add')} @click=${submitAdd}>${t('apps.addAction')}</cr-bar-button>
    </div>
  </cr-dialog>`;
}

function suggestionDialog(s) {
  const app = s.app;
  const start = app.start || {};
  const command = [start.command, ...(Array.isArray(start.args) ? start.args : [])].filter(Boolean).join(' ');
  return html`<cr-dialog open .heading=${t('apps.reviewTitle', { name: app.name })} @cr-dialog-close=${closeDialog}>
    <p class="cr-hint">${t('apps.suggestionSource', { source: s.file || s.source || '' })}</p>
    <dl class="apps-definition">
      <dt>${t('apps.addName')}</dt><dd>${app.name}</dd>
      <dt>${t('apps.definitionId')}</dt><dd><code>${app.id}</code></dd>
      <dt>${t('apps.startTaskLabel')}</dt><dd>${start.taskLabel || t('apps.notSet')}</dd>
      <dt>${t('apps.startCommand')}</dt><dd><code>${command || start.command || t('apps.notSet')}</code></dd>
      <dt>${t('apps.appPorts')}</dt><dd>${(app.ports || []).map((p) => html`<code>:${p.port} ${p.role} · ${p.bind || '0.0.0.0'}</code> `)}</dd>
      <dt>${t('apps.exposure')}</dt><dd>${app.exposure || t('apps.notSet')}</dd>
    </dl>
    <div slot="actions">
      <cr-bar-button @click=${closeDialog}>${t('apps.cancel')}</cr-bar-button>
      <cr-bar-button variant="primary" ?disabled=${state.busy.has(`suggest:${app.id}`)} @click=${() => submitSuggestion(s)}>${t('apps.addAction')}</cr-bar-button>
    </div>
  </cr-dialog>`;
}

function dialog() {
  const d = state.dialog;
  if (d?.kind === 'add') return addDialog(d);
  if (d?.kind === 'suggestion') return suggestionDialog(d.suggestion);
  if (d?.kind === 'remove') {
    return html`<cr-dialog open .heading=${t('apps.removeTitle')} @cr-dialog-close=${closeDialog}>
      <p class="cr-hint">${t('apps.removeHint', { name: d.app.name })}</p>
      <div slot="actions">
        <cr-bar-button @click=${closeDialog}>${t('apps.cancel')}</cr-bar-button>
        <cr-bar-button variant="primary" @click=${() => removeApp(d.app)}>${t('apps.remove')}</cr-bar-button>
      </div>
    </cr-dialog>`;
  }
  if (d?.kind === 'takeover') {
    return html`<cr-dialog open .heading=${t('apps.takeoverTitle')} @cr-dialog-close=${closeDialog}>
      <p class="cr-hint">${t('apps.takeoverHint', { name: d.app.name })}</p>
      ${d.conflicts.map((p) => html`<code class="apps-dialog-command">:${p.port} · PID ${p.listener.pid} · ${p.listener.command || '?'}</code>`)}
      <div slot="actions">
        <cr-bar-button @click=${closeDialog}>${t('apps.cancel')}</cr-bar-button>
        <cr-bar-button variant="primary" @click=${() => takeOver(d)}>${t('apps.takeover')}</cr-bar-button>
      </div>
    </cr-dialog>`;
  }
  return html`<cr-dialog ?open=${Boolean(d)} .heading=${t('apps.manualTitle')} @cr-dialog-close=${closeDialog}>
    ${d ? html`<p class="cr-hint">${t('apps.manualHint', { port: d.port })}</p>
      ${(d.commands || []).map((c) => html`<code class="apps-dialog-command">${c}</code>`)}` : nothing}
    <div slot="actions">
      <cr-bar-button @click=${() => copy((d?.commands || []).join('\n'))}>${t('apps.copyCommand')}</cr-bar-button>
      <cr-bar-button variant="primary" @click=${closeDialog}>${t('apps.close')}</cr-bar-button>
    </div>
  </cr-dialog>`;
}

function selectTab(tab) { state.tab = tab; paint(); }

function tabButton(tab, key, count) {
  const active = state.tab === tab;
  return html`<button type="button" class="cr-tab" data-tab=${tab} role="tab" aria-selected=${String(active)}>${t(key)}${count ? ` (${count})` : ''}</button>`;
}

function tabBar(s) {
  return html`<cr-tabs class="cr-tabs apps-tabs" storage-key=${TAB_STORAGE_KEY} aria-label=${t('apps.tabsAria')}
      @cr-tabs-change=${(e) => selectTab(e.detail?.value || TABS[0])}>
    ${tabButton('apps', 'apps.tabApps', s?.apps?.length)}
    ${tabButton('suggestions', 'apps.tabSuggestions', state.suggestions.length)}
    ${tabButton('ports', 'apps.tabPorts', uniqueOrphans(s?.orphans).length)}
  </cr-tabs>`;
}

function appsTab(s) {
  if (s?.valid !== false && s && !s.apps.length) {
    return html`<p class="cr-hint">${t('apps.empty')}</p>
      ${state.suggestions.length ? html`<cr-bar-button @click=${() => openTab('suggestions')}>${t('apps.showSuggestions')}</cr-bar-button>` : nothing}`;
  }
  return html`${helperNotice(s)}<div class="apps-list">${(s?.apps || []).map(appCard)}</div>`;
}

/** Moves the selection from inside a tab, keeping the bar and its saved choice in step. */
function openTab(tab) {
  const button = document.querySelector(`#apps-root .apps-tabs [data-tab="${tab}"]`);
  const bar = button?.closest('cr-tabs');
  if (bar && typeof (/** @type {any} */ (bar)).select === 'function') /** @type {any} */ (bar).select(button);
  else selectTab(tab);
}

function tabContent(s) {
  if (state.tab === 'suggestions') return suggestionsSection();
  if (state.tab === 'ports') return orphansSection(uniqueOrphans(s?.orphans));
  return appsTab(s);
}

function summary(s) {
  if (!s?.apps?.length) return nothing;
  const running = s.apps.filter((a) => a.status === 'running').length;
  return html`<span class="apps-meta">${t('apps.summary', { running, total: s.apps.length })}</span>`;
}

function paint() {
  const root = document.getElementById('apps-root');
  if (!root) return;
  const s = state.status;
  const name = folderName(s?.workspace || state.folder);
  render(html`<div class="apps-root cr-page-body">
    <div class="apps-header">
      ${name ? html`<span class="apps-workspace" title=${s?.workspace || state.folder}><span class="mdi mdi-folder-outline"></span>${name}</span>` : nothing}
      ${summary(s)}
      <span class="apps-header-spacer"></span>
      <span class="cr-status" role="status" data-tone=${state.tone}>${state.message}</span>
      <cr-bar-button @click=${() => load({ refresh: true })}>${t('apps.refresh')}</cr-bar-button>
      <cr-bar-button variant="primary" @click=${() => openAdd()}>${t('apps.addNew')}</cr-bar-button>
    </div>
    ${state.error ? html`<p class="cr-status" data-tone="error">${state.error}</p>` : nothing}
    ${!s && !state.error ? html`<p class="cr-hint" data-apps-loading>${t('apps.loading')}</p>` : nothing}
    ${s && s.valid === false ? html`<p class="cr-status" data-tone="error">${t('apps.invalidFile')}: ${(s.errors || []).join('; ')}</p>` : nothing}
    ${s?.listenersAvailable === false ? html`<p class="cr-status" data-tone="error">${t('apps.listenersUnavailable')}</p>` : nothing}
    ${tabBar(s)}
    <div class="apps-tab-body">${s ? tabContent(s) : nothing}</div>
    ${dialog()}
  </div>`, root);
}

const panelVisible = () => !document.hidden && document.getElementById('apps-panel')?.classList.contains('active');

function onChanged() {
  if (changeTimer) clearTimeout(changeTimer);
  changeTimer = setTimeout(() => {
    changeTimer = null;
    if (panelVisible() && !state.dialog) void load();
  }, CHANGE_DEBOUNCE_MS);
}

export function refreshAppsPanel() { return load(); }

export function initAppsPanel() {
  paint();
  window.addEventListener('cretli:apps-changed', onChanged);
  window.addEventListener('cretli:workspace-changed', onChanged);
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    if (panelVisible() && !state.dialog) void load();
  }, POLL_MS);
}
