/**
 * Settings -> Connection -> Network: read-only network report, repair suggestions,
 * Windows helper card (install/uninstall from the UI) and the port exposure policy.
 */
import { html, render, nothing } from 'lit';
import { t } from '../../i18n/index.js';
import { cretliApiFetch } from '../../lib/cretliApiRequest.js';
import '../../components/ui/index.js';
import './network-settings.scss';

const HOUR_MS = 3600_000;
const BACKENDS = ['auto', 'wsl-nat', 'wsl-mirrored', 'linux', 'manual'];
const AGENT_MODES = ['ask', 'allow_in_range', 'never'];

const state = {
  report: null, exposures: [], policy: null, draft: null, loadError: '',
  message: '', tone: '', busy: false,
  /** Install flow: null | { action, info, remote } for the confirm dialog. */
  confirm: null,
  /** Result of the last install/uninstall: { state: 'success'|'cancelled'|'failed'|'busy'|..., message? } */
  installResult: null, installing: false,
};

async function api(path, init) {
  const response = await cretliApiFetch(path, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok && !body.state) throw Object.assign(new Error(body.message || body.error || 'requestFailed'), { body });
  return body;
}
const postJson = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

async function copy(text) {
  try { await navigator.clipboard.writeText(text); setStatus(t('settings.networkCopied'), 'success'); }
  catch { setStatus(t('settings.networkCopyFailed'), 'error'); }
}

function setStatus(message, tone = '') { state.message = message; state.tone = tone; paint(); }

const isRemoteUi = () => !['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);
const isWsl = () => state.report?.platform === 'wsl2';
const ruleLedgerPort = (issue) => Number(/Proxy port (\d+)/.exec(issue.description || '')?.[1]) || null;
const ledgerHas = (port) => state.exposures.some((e) => e.port === port && e.state !== 'closed');

async function repair(port) {
  if (state.busy) return;
  state.busy = true; paint();
  try {
    await api(`/api/port-exposures/${port}`, { method: 'DELETE' });
    setStatus(t('settings.networkRepaired'), 'success');
    await load();
  } catch (err) { setStatus(String(err?.message || t('settings.networkRepairFailed')), 'error'); }
  finally { state.busy = false; paint(); }
}

function issueRow(issue) {
  const port = ruleLedgerPort(issue);
  const repairable = state.report?.helper?.state === 'ready' && port && ['dead-proxy', 'stale-wsl-address'].includes(issue.code) && ledgerHas(port);
  const tone = issue.level === 'error' ? 'error' : '';
  return html`<div class="network-issue">
    <span class="network-badge" data-tone=${tone}>${issue.code}</span>
    <span>${issue.description}</span>
    ${issue.command ? html`<code class="network-command">${issue.command}</code>
      <cr-bar-button @click=${() => copy(issue.command)}>${t('settings.networkCopyCommand')}</cr-bar-button>` : nothing}
    ${issue.needsAdmin ? html`<span class="network-meta">${t('settings.networkNeedsAdmin')}</span>` : nothing}
    ${repairable ? html`<cr-bar-button variant="primary" ?disabled=${state.busy} @click=${() => repair(port)}>${t('settings.networkRepair')}</cr-bar-button>` : nothing}
  </div>`;
}

/** Tags a portproxy rule as dead, stale or foreign (not created by Cretli's ledger). */
function ruleRow(rule) {
  const tags = [];
  for (const issue of state.report.issues || []) {
    if (ruleLedgerPort(issue) !== rule.listenPort) continue;
    if (issue.code === 'dead-proxy') tags.push(['settings.networkTagDead', 'error']);
    if (issue.code === 'stale-wsl-address') tags.push(['settings.networkTagStale', 'error']);
  }
  if (!ledgerHas(rule.listenPort)) tags.push(['settings.networkTagForeign', '']);
  return html`<div class="network-rule">
    <code>${rule.listenAddress}:${rule.listenPort} → ${rule.connectAddress}:${rule.connectPort}</code>
    ${tags.map(([key, tone]) => html`<span class="network-badge" data-tone=${tone}>${t(key)}</span>`)}
  </div>`;
}

function reportCard() {
  const r = state.report;
  if (!r) return nothing;
  return html`<div class="cr-card">
    <h3 class="cr-section-title">${t('settings.networkReportTitle')}</h3>
    <p class="network-meta">${t('settings.networkPlatform')}: ${r.platform} · ${t('settings.networkMode')}: ${r.networkingMode || '—'} · ${t('settings.networkCollected')}: ${new Date(r.collectedAt).toLocaleString()}</p>
    ${r.partial ? html`<p class="cr-hint">${t('settings.networkPartial')}</p>` : nothing}
    ${(r.portproxy || []).length ? html`<h4 class="cr-section-title">${t('settings.networkRules')}</h4>${r.portproxy.map(ruleRow)}` : nothing}
    <h4 class="cr-section-title">${t('settings.networkSuggestions')}</h4>
    ${(r.issues || []).filter((i) => i.code !== 'loopback-only').length
      ? r.issues.filter((i) => i.code !== 'loopback-only').map(issueRow)
      : html`<p class="cr-hint">${t('settings.networkNoIssues')}</p>`}
  </div>`;
}

const HELPER_KEYS = { ready: 'settings.networkHelperReady' };
function helperCard() {
  const r = state.report;
  if (!r) return nothing;
  if (!isWsl()) return html`<div class="cr-card"><h3 class="cr-section-title">${t('settings.networkHelperTitle')}</h3><p class="cr-hint">${t('settings.networkHelperNotApplicable')}</p></div>`;
  const h = r.helper || {};
  const installed = Boolean(h.installed) && h.state !== 'helper_missing';
  const running = h.state === 'ready';
  const res = state.installResult;
  return html`<div class="cr-card">
    <h3 class="cr-section-title">${t('settings.networkHelperTitle')}</h3>
    <p><span class="network-badge" data-tone=${running ? 'success' : 'error'}>${t(HELPER_KEYS[h.state] || 'settings.networkHelperNotRunning')}</span>
      ${h.state && !running ? html`<span class="network-meta"> ${h.state}</span>` : nothing}
      ${h.version ? html`<span class="network-meta"> v${h.version}</span>` : nothing}</p>
    <p class="cr-hint">${t('settings.networkHelperHint')}</p>
    <div class="cr-row">
      ${installed
        ? html`<cr-bar-button ?disabled=${state.installing} @click=${() => openConfirm('reinstall')}>${t('settings.networkHelperReinstall')}</cr-bar-button>
               <cr-bar-button ?disabled=${state.installing} @click=${() => openConfirm('uninstall')}>${t('settings.networkHelperUninstall')}</cr-bar-button>`
        : html`<cr-bar-button variant="primary" ?disabled=${state.installing} @click=${() => openConfirm('install')}>${t('settings.networkHelperInstall')}</cr-bar-button>`}
    </div>
    ${state.installing ? html`<p class="cr-status" role="status">${t('settings.networkInstallWaiting')}</p>` : nothing}
    ${res ? html`<p class="cr-status" role="status" data-tone=${res.state === 'success' ? 'success' : 'error'} data-install-state=${res.state}>
      ${t(`settings.networkInstallState_${res.state}`)}${res.message ? html`: ${res.message}` : nothing}</p>` : nothing}
  </div>`;
}

async function openConfirm(action) {
  let info = null;
  try { info = await api('/api/net-env/netd/install-info'); } catch { /* the dialog still works without the hash */ }
  state.confirm = { action, info, remote: isRemoteUi() };
  paint();
}

async function runInstall() {
  const c = state.confirm;
  if (!c || state.installing) return;
  state.confirm = null;
  state.installing = true; state.installResult = null; paint();
  try {
    const path = c.action === 'uninstall' ? '/api/net-env/netd/uninstall' : `/api/net-env/netd/install${c.action === 'reinstall' ? '?reinstall=1' : ''}`;
    const body = await postJson(path, {});
    state.installResult = { state: body.state || (body.ok ? 'success' : 'failed'), message: body.message };
  } catch (err) {
    state.installResult = { state: 'failed', message: String(err?.message || '') };
  }
  state.installing = false;
  await load();
}

function confirmDialog() {
  const c = state.confirm;
  const uninstall = c?.action === 'uninstall';
  return html`<cr-dialog ?open=${Boolean(c)} .heading=${t(uninstall ? 'settings.networkUninstallTitle' : 'settings.networkInstallTitle')} @cr-dialog-close=${() => { state.confirm = null; paint(); }}>
    ${c ? html`
      <p>${t('settings.networkUacWarning')}</p>
      ${c.remote ? html`<p class="cr-status" data-tone="error">${t('settings.networkUacRemote')}</p>` : nothing}
      ${uninstall ? html`<p class="cr-hint">${t('settings.networkUninstallNote')}</p>` : nothing}
      ${c.info?.command && !uninstall ? html`<p class="cr-hint">${t('settings.networkInstallCommand')}</p><code class="network-command">${c.info.command}</code>` : nothing}
      ${c.info?.sha256 ? html`<p class="cr-hint">${t('settings.networkInstallerHash')}</p><code class="network-command">${c.info.sha256}</code>` : nothing}
      <p class="cr-hint">${t('settings.networkInstallTrust')}</p>` : nothing}
    <div slot="actions">
      ${c?.info?.command && !uninstall ? html`<cr-bar-button @click=${() => copy(c.info.command)}>${t('settings.networkCopyCommand')}</cr-bar-button>` : nothing}
      <cr-bar-button @click=${() => { state.confirm = null; paint(); }}>${t('settings.networkCancel')}</cr-bar-button>
      <cr-bar-button variant="primary" data-install-confirm @click=${runInstall}>${t(uninstall ? 'settings.networkHelperUninstall' : 'settings.networkInstallContinue')}</cr-bar-button>
    </div>
  </cr-dialog>`;
}

function field(label, control) {
  return html`<div class="cr-field"><label class="cr-field-label">${label}</label>${control}</div>`;
}

function policyCard() {
  const d = state.draft;
  if (!d) return nothing;
  const set = (key) => (e) => { d[key] = e.target.value; };
  return html`<div class="cr-card">
    <h3 class="cr-section-title">${t('settings.networkPolicyTitle')}</h3>
    <div class="network-policy-grid">
      ${field(t('settings.networkRangeMin'), html`<cr-bar-input type="number" .value=${String(d.min)} @input=${set('min')}></cr-bar-input>`)}
      ${field(t('settings.networkRangeMax'), html`<cr-bar-input type="number" .value=${String(d.max)} @input=${set('max')}></cr-bar-input>`)}
      ${field(t('settings.networkDefaultTtl'), html`<cr-bar-input type="number" .value=${String(d.defaultHours)} @input=${set('defaultHours')}></cr-bar-input>`)}
      ${field(t('settings.networkMaxTtl'), html`<cr-bar-input type="number" .value=${String(d.maxHours)} @input=${set('maxHours')}></cr-bar-input>`)}
    </div>
    ${field(t('settings.networkDenylist'), html`<cr-bar-input .value=${d.denylist} @input=${set('denylist')}></cr-bar-input>`)}
    <p class="cr-hint">${t('settings.networkDenylistHint')}</p>
    <div class="network-policy-grid">
      ${field(t('settings.networkAgentMode'), html`<select @change=${set('agentMode')}>${AGENT_MODES.map((m) => html`<option value=${m} ?selected=${d.agentMode === m}>${t(`settings.networkAgentMode_${m}`)}</option>`)}</select>`)}
      ${field(t('settings.networkBackend'), html`<select @change=${set('backend')}>${BACKENDS.map((m) => html`<option value=${m} ?selected=${d.backend === m}>${m}</option>`)}</select>`)}
    </div>
  </div>`;
}

const toDraft = (p) => ({
  min: p.range.min, max: p.range.max, defaultHours: +(p.defaultTtlMs / HOUR_MS).toFixed(2), maxHours: +(p.maxTtlMs / HOUR_MS).toFixed(2),
  denylist: (p.denylist || []).join(', '), agentMode: p.agentMode, backend: p.backend,
});

export async function saveNetworkSettings() {
  const d = state.draft;
  if (!d || state.busy) return;
  state.busy = true; paint();
  try {
    const policy = {
      range: { min: Number(d.min), max: Number(d.max) },
      denylist: String(d.denylist).split(/[\s,]+/).map(Number).filter((n) => Number.isInteger(n)),
      defaultTtlMs: Math.round(Number(d.defaultHours) * HOUR_MS), maxTtlMs: Math.round(Number(d.maxHours) * HOUR_MS),
      agentMode: d.agentMode, backend: d.backend,
    };
    const res = await api('/api/port-exposures/policy', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ policy }) });
    state.policy = res.policy; state.draft = toDraft(res.policy);
    setStatus(t('settings.networkSaved'), 'success');
  } catch (err) { setStatus(String(err?.message || t('settings.networkSaveFailed')), 'error'); }
  finally { state.busy = false; paint(); }
}

function paint() {
  document.querySelectorAll('.network-settings-root').forEach((root) => {
    if (!(root instanceof HTMLElement)) return;
    render(html`
      <div class="cr-row">
        <cr-bar-button ?disabled=${state.busy} @click=${() => load(true)}>${t('settings.networkRefresh')}</cr-bar-button>
        <span class="cr-status" role="status" data-tone=${state.tone}>${state.message}</span>
      </div>
      ${state.loadError ? html`<p class="cr-status" data-tone="error">${state.loadError}</p>` : nothing}
      ${reportCard()}${helperCard()}${policyCard()}${confirmDialog()}`, root);
  });
  const status = document.getElementById('network-save-status');
  if (status) { status.textContent = state.message; status.setAttribute('data-tone', state.tone); }
}

async function load(refresh = false) {
  try {
    const [report, list, policy] = await Promise.all([
      api(`/api/net-env${refresh ? '?refresh=1' : ''}`),
      api('/api/port-exposures').catch(() => ({ exposures: [] })),
      api('/api/port-exposures/policy'),
    ]);
    state.report = report; state.exposures = list.exposures || [];
    state.policy = policy.policy;
    if (!state.draft) state.draft = toDraft(policy.policy);
    state.loadError = '';
  } catch (err) { state.loadError = String(err?.message || t('settings.networkLoadError')); }
  paint();
}

let saveBound = false;
export function refreshNetworkSettings() {
  const btn = document.getElementById('network-save-btn');
  if (btn && !saveBound) { btn.addEventListener('click', saveNetworkSettings); saveBound = true; }
  return load(true);
}
