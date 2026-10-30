import { html, render, nothing } from 'lit';
import { t } from '../../i18n/index.js';
import { cretliApiFetch } from '../../lib/cretliApiRequest.js';
import { navigateSpa } from '../../app/appShell/spaNavigationBridge.js';
import '../../components/ui/index.js';
import './apps-panel.scss';

const POLL_MS = 4000;
const TTL_OPTIONS = Object.freeze([
  { ms: 3600_000, key: 'apps.ttl1h' },
  { ms: 8 * 3600_000, key: 'apps.ttl8h' },
  { ms: 24 * 3600_000, key: 'apps.ttl24h' },
]);

/** @type {{ status: any, exposures: any[], lanHost: string, error: string, message: string, tone: string, busy: string, dialog: any, ttl: Record<string, number>, qr: Record<string, boolean> }} */
const state = { status: null, exposures: [], lanHost: '', error: '', message: '', tone: '', busy: '', dialog: null, ttl: {}, qr: {} };
let timer = null;

async function api(path, init) {
  const response = await cretliApiFetch(path, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.message || body.error || 'requestFailed'), { code: body.error, body });
  return body;
}
const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

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

function appStateLabel(app) {
  if (app.status === 'running') return ['apps.statusRunning', 'success'];
  if (app.status === 'failed') return ['apps.statusFailed', 'error'];
  return ['apps.statusStopped', ''];
}

function portState(app, p) {
  const e = exposureFor(p.port);
  if (e?.state === 'pending_manual') return ['apps.portPendingManual', ''];
  if (e) return ['apps.portExposed', 'success'];
  if (p.ownedBy === 'foreign') return ['apps.portConflict', 'error'];
  if (p.listening) return ['apps.portListening', ''];
  return ['apps.portClosed', ''];
}

async function runAction(key, fn) {
  if (state.busy) return;
  state.busy = key;
  paint();
  try { await fn(); await load(); }
  catch (err) { setMessage(err?.code === 'port-in-use' ? t('apps.portInUse') : String(err?.message || t('apps.actionFailed')), 'error'); }
  finally { state.busy = ''; paint(); }
}

const appAction = (id, action) => runAction(`${action}:${id}`, () => post(`/api/apps/${encodeURIComponent(id)}/${action}`));

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

/** Adds an orphan as an app; the start command is required by the registry schema, so the user supplies it. */
async function addOrphan() {
  const d = state.dialog;
  const command = String(d?.command || '').trim();
  if (!command) { d.error = t('apps.addCommandRequired'); paint(); return; }
  await runAction(`add:${d.port}`, async () => {
    await post('/api/apps', { app: { id: `port-${d.port}`, name: String(d.name || '').trim() || `Port ${d.port}`, start: { command }, ports: [{ port: d.port, bind: d.bind || '127.0.0.1', role: 'other' }], exposure: 'local' } });
    state.dialog = null;
    setMessage(t('apps.orphanAdded'), 'success');
  });
}

async function load() {
  try {
    const [status, exposures, net] = await Promise.all([
      api('/api/apps/status'),
      api('/api/port-exposures').catch(() => ({ exposures: [] })),
      api('/api/net-env').catch(() => null),
    ]);
    state.status = status;
    state.exposures = exposures.exposures || [];
    state.lanHost = net?.cretli?.lanHost || '';
    state.error = '';
  } catch (err) {
    state.error = String(err?.message || t('apps.loadError'));
  }
  paint();
}

function lanUrl(p, role) {
  if (!state.lanHost) return '';
  return `${role === 'http' || role === 'api' ? 'http' : 'tcp'}://${state.lanHost}:${p.port}`;
}

function portRow(app, p) {
  const [label, tone] = portState(app, p);
  const e = exposureFor(p.port);
  const local = `http://127.0.0.1:${p.port}`;
  const lan = e && e.state !== 'close_pending' ? lanUrl(p, p.role) : '';
  const owner = e ? (String(e.owner || '').startsWith('chat:')
    ? html`<a href=${`/?panel=chat&chat=${encodeURIComponent(String(e.owner).slice(5))}`}>${t('apps.byChat')}</a>`
    : html`${t('apps.byUser')}`) : nothing;
  const busy = Boolean(state.busy);
  return html`<li class="apps-port">
    <div class="apps-port-line">
      <code>:${p.port}</code><span class="apps-meta">${p.role}</span>
      <span class="apps-badge" data-tone=${tone}>${t(label)}</span>
      ${p.listener?.pid ? html`<span class="apps-meta">PID ${p.listener.pid}</span>` : nothing}
    </div>
    ${e ? html`<div class="apps-meta">${owner} · ${t('apps.expires')} ${new Date(e.expiresAt).toLocaleString()}</div>` : nothing}
    ${lan ? html`<div class="apps-port-line"><code>${lan}</code>
      <cr-bar-button ?disabled=${busy} @click=${() => copy(lan)}>${t('apps.copyLan')}</cr-bar-button>
      <cr-bar-button @click=${() => { state.qr[p.port] = !state.qr[p.port]; paint(); }}>${t('apps.qr')}</cr-bar-button></div>
      ${state.qr[p.port] ? html`<img class="apps-qr" alt=${t('apps.qr')} width="160" height="160" src=${`https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(lan)}`} />
        <span class="apps-meta">${t('apps.qrExternal')}</span>` : nothing}` : nothing}
    <div class="cr-row">
      <cr-bar-button @click=${() => copy(local)}>${t('apps.copyLocal')}</cr-bar-button>
      <cr-bar-button @click=${() => openInBrowser(local)}>${t('apps.openBrowser')}</cr-bar-button>
      ${e
        ? html`<cr-bar-button ?disabled=${busy} @click=${() => closeExposure(p)}>${t('apps.closeExposure')}</cr-bar-button>`
        : html`<select class="apps-ttl" aria-label=${t('apps.ttl')} @change=${(ev) => { state.ttl[p.port] = Number(ev.target.value); }}>
            ${TTL_OPTIONS.map((o) => html`<option value=${o.ms} ?selected=${(state.ttl[p.port] || TTL_OPTIONS[1].ms) === o.ms}>${t(o.key)}</option>`)}
          </select>
          <cr-bar-button ?disabled=${busy || !p.listening} @click=${() => expose(app, p)}>${t('apps.expose')}</cr-bar-button>`}
    </div>
  </li>`;
}

function openInBrowser(url) {
  window.open(url, '_blank', 'noopener');
}

function appCard(app) {
  const [label, tone] = appStateLabel(app);
  const running = app.status === 'running';
  const busy = Boolean(state.busy);
  return html`<div class="cr-card">
    <div class="apps-card-head">
      <span class="apps-card-name">${app.name}</span>
      <span class="apps-badge" data-tone=${tone}>${t(label)}</span>
      ${app.pid ? html`<span class="apps-meta">PID ${app.pid}</span>` : nothing}
      ${running && app.lastChangeAt ? html`<span class="apps-meta">${t('apps.uptime')} ${uptime(app.lastChangeAt)}</span>` : nothing}
    </div>
    ${app.errors?.length ? html`<div class="apps-meta" data-tone="error">${app.errors[app.errors.length - 1]?.message || ''}</div>` : nothing}
    <div class="cr-row">
      <cr-bar-button variant="primary" ?disabled=${busy || running} @click=${() => appAction(app.id, 'start')}>${t('apps.start')}</cr-bar-button>
      <cr-bar-button ?disabled=${busy || !running} @click=${() => appAction(app.id, 'stop')}>${t('apps.stop')}</cr-bar-button>
      <cr-bar-button ?disabled=${busy || !running} @click=${() => appAction(app.id, 'restart')}>${t('apps.restart')}</cr-bar-button>
      ${app.runId ? html`<cr-bar-button @click=${() => navigateSpa({ panel: 'tasks', query: { run: app.runId } }, { explicit: true })}>${t('apps.console')}</cr-bar-button>` : nothing}
    </div>
    <ul class="apps-ports">${app.ports.map((p) => portRow(app, p))}</ul>
  </div>`;
}

/** Orphans are read-only on purpose: Cretli never ends a process it did not start. */
function orphansSection(orphans) {
  if (!orphans.length) return nothing;
  return html`<section class="apps-orphans">
    <h3 class="cr-section-title">${t('apps.orphansTitle')}</h3>
    <p class="cr-hint">${t('apps.orphansHint')}</p>
    ${orphans.map((o) => html`<div class="apps-orphan">
      <code>:${o.port}</code><span class="apps-meta">${o.bind}</span>
      ${o.command ? html`<span class="apps-meta">${o.command}</span>` : nothing}
      ${o.pid ? html`<span class="apps-meta">PID ${o.pid}</span>` : nothing}
      <cr-bar-button ?disabled=${Boolean(state.busy)} @click=${() => { state.dialog = { kind: 'add', port: o.port, bind: o.bind, name: o.command ? `${o.command} :${o.port}` : '', command: '' }; paint(); }}>${t('apps.addAsApp')}</cr-bar-button>
      ${o.killHint ? html`<cr-bar-button @click=${() => copy(o.killHint)}>${t('apps.copyKill')}</cr-bar-button>` : nothing}
    </div>`)}
  </section>`;
}

function closeDialog() { state.dialog = null; paint(); }

function dialog() {
  const d = state.dialog;
  if (d?.kind === 'add') {
    return html`<cr-dialog open .heading=${t('apps.addTitle')} @cr-dialog-close=${closeDialog}>
      <p class="cr-hint">${t('apps.addHint', { port: d.port })}</p>
      <div class="cr-field"><label class="cr-field-label">${t('apps.addName')}</label>
        <cr-bar-input .value=${d.name} @input=${(e) => { d.name = e.target.value; }}></cr-bar-input></div>
      <div class="cr-field"><label class="cr-field-label">${t('apps.addCommand')}</label>
        <cr-bar-input .value=${d.command} placeholder="npm run dev" @input=${(e) => { d.command = e.target.value; }}></cr-bar-input></div>
      ${d.error ? html`<p class="cr-status" data-tone="error">${d.error}</p>` : nothing}
      <div slot="actions">
        <cr-bar-button @click=${closeDialog}>${t('apps.close')}</cr-bar-button>
        <cr-bar-button variant="primary" @click=${addOrphan}>${t('apps.addAsApp')}</cr-bar-button>
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

function paint() {
  const root = document.getElementById('apps-root');
  if (!root) return;
  const s = state.status;
  render(html`<div class="apps-root cr-page-body">
    <div class="cr-row">
      <cr-bar-button @click=${() => load()}>${t('apps.refresh')}</cr-bar-button>
      <span class="cr-status" role="status" data-tone=${state.tone}>${state.message}</span>
    </div>
    ${state.error ? html`<p class="cr-status" data-tone="error">${state.error}</p>` : nothing}
    ${s && s.valid === false ? html`<p class="cr-status" data-tone="error">${t('apps.invalidFile')}: ${(s.errors || []).join('; ')}</p>` : nothing}
    ${s && s.valid !== false && !s.apps.length ? html`<p class="cr-hint">${t('apps.empty')}</p>` : nothing}
    <div class="apps-list">${(s?.apps || []).map(appCard)}</div>
    ${orphansSection(s?.orphans || [])}
    ${dialog()}
  </div>`, root);
}

export function refreshAppsPanel() { return load(); }

export function initAppsPanel() {
  paint();
  void load();
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    const panel = document.getElementById('apps-panel');
    if (document.hidden || !panel?.classList.contains('active') || state.dialog) return;
    void load();
  }, POLL_MS);
}
