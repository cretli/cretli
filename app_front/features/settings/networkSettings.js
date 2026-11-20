/**
 * Settings -> Connection -> Network: read-only network report, repair suggestions,
 * Windows helper card (install/uninstall from the UI) and the port exposure policy.
 */
import { html, render, nothing } from 'lit';
import { t } from '../../i18n/index.js';
import { cretliApiFetch } from '../../lib/cretliApiRequest.js';
import { navigateSpa } from '../../app/appShell/spaNavigationBridge.js';
import '../../components/ui/index.js';
import './network-settings.scss';

const HOUR_MS = 3600_000;
const BACKENDS = ['auto', 'wsl-nat', 'wsl-mirrored', 'linux', 'manual'];
const AGENT_MODES = ['ask', 'allow_in_range', 'never'];

/** A report older than this is shown at once and followed by one re-read of the renewed copy. */
const REPORT_FRESH_MS = 20_000;
const REPORT_RENEW_DELAY_MS = 1500;
const ISSUE_ORDER = ['stale-wsl-address', 'dead-proxy', 'unsafe-debug-proxy', 'missing-proxy', 'recommend-mirrored'];

const TABS = Object.freeze(['status', 'exposures', 'diagnostics', 'policy']);
// See the Apps panel: the same entry cr-tabs writes, read before the first render.
const TAB_STORAGE_KEY = 'cretli-network-tab';

function savedTab() {
  try {
    const saved = localStorage.getItem(`${TAB_STORAGE_KEY}:default`);
    return TABS.includes(saved) ? saved : TABS[0];
  } catch { return TABS[0]; }
}

const state = {
  tab: savedTab(),
  report: null, exposures: [], policy: null, draft: null, loadError: '',
  message: '', tone: '', busy: false, refreshing: false,
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
  return html`<div class="network-issue">
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

/** The answer to "can I open a port from here?", before any detail. */
function lanSummary(r) {
  if (!r) return html`<p class="cr-hint" data-network-loading>${t('settings.networkLoading')}</p>`;
  const automatic = !isWsl() || r.helper?.state === 'ready';
  return html`<p>
      <span class="network-badge" data-tone=${automatic ? 'success' : ''}>${t(automatic ? 'settings.networkLanAutomatic' : 'settings.networkLanManual')}</span>
    </p>
    <p class="cr-hint">${t(automatic ? 'settings.networkLanAutomaticHint' : 'settings.networkLanManualHint')}</p>
    <p class="network-meta">
      ${t('settings.networkLanHost')}: ${r.cretli?.lanHost || '—'} · ${t('settings.networkPlatform')}: ${r.platform} · ${t('settings.networkMode')}: ${r.networkingMode || '—'} · ${t('settings.networkCollected')}: ${new Date(r.collectedAt).toLocaleTimeString()}
    </p>
    ${r.partial ? html`<p class="cr-hint">${t('settings.networkPartial')}</p>` : nothing}`;
}

async function closeExposure(port) {
  if (state.busy) return;
  state.busy = true; paint();
  try {
    await api(`/api/port-exposures/${port}`, { method: 'DELETE' });
    await load();
  } catch (err) { setStatus(String(err?.message || t('settings.networkRepairFailed')), 'error'); }
  finally { state.busy = false; paint(); }
}

const openExposures = () => state.exposures.filter((e) => e.state !== 'closed');
const visibleIssues = () => (state.report?.issues || []).filter((i) => i.code !== 'loopback-only');

function exposuresCard() {
  const open = openExposures();
  return html`<div class="cr-card">
    ${open.length ? open.map((e) => html`<div class="network-rule">
        <code>:${e.port}</code>
        <span class="network-badge" data-tone=${e.state === 'active' ? 'success' : ''}>${t(`settings.networkExposureState_${e.state}`)}</span>
        <span class="network-meta">${e.reason || e.owner} · ${t('settings.networkExposureUntil')} ${new Date(e.expiresAt).toLocaleString()}</span>
        <cr-bar-button ?disabled=${state.busy} @click=${() => closeExposure(e.port)}>${t('settings.networkExposureClose')}</cr-bar-button>
      </div>`) : html`<p class="cr-hint">${t('settings.networkNoExposures')}</p>`}
    <div class="cr-row">
      <cr-bar-button @click=${() => navigateSpa({ panel: 'apps' }, { explicit: true })}>${t('settings.networkOpenApps')}</cr-bar-button>
    </div>
  </div>`;
}

/** One group per finding kind: ten ports without a rule are one thing to understand, not ten. */
function issueGroup(code, issues) {
  const repairable = state.report?.helper?.state === 'ready' && issues.some((i) => ledgerHas(ruleLedgerPort(i)));
  return html`<details class="network-group" ?open=${repairable}>
    <summary>
      <span class="network-badge" data-tone=${issues.some((i) => i.level === 'error') ? 'error' : ''}>${issues.length}</span>
      ${t(`settings.networkIssue_${code}`)}
    </summary>
    <p class="cr-hint">${t(`settings.networkIssueHint_${code}`)}</p>
    ${issues.map(issueRow)}
  </details>`;
}

function diagnosticsCard() {
  const r = state.report;
  if (!r) return nothing;
  const issues = visibleIssues();
  const groups = ISSUE_ORDER.map((code) => [code, issues.filter((i) => i.code === code)]).filter(([, list]) => list.length);
  return html`<div class="cr-card">
    ${groups.length ? groups.map(([code, list]) => issueGroup(code, list)) : html`<p class="cr-hint">${t('settings.networkNoIssues')}</p>`}
    ${(r.portproxy || []).length ? html`<details class="network-group">
      <summary><span class="network-badge">${r.portproxy.length}</span> ${t('settings.networkRules')}</summary>
      ${r.portproxy.map(ruleRow)}
    </details>` : nothing}
  </div>`;
}

const HELPER_KEYS = { ready: 'settings.networkHelperReady' };
function helperCard() {
  const r = state.report;
  if (!r || !isWsl()) return nothing;
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
  await load(true);
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
    <p class="cr-hint">${t('settings.networkPolicyHint')}</p>
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

function tabButton(tab, key, count) {
  return html`<button type="button" class="cr-tab" data-tab=${tab} role="tab" aria-selected=${String(state.tab === tab)}>${t(key)}${count ? ` (${count})` : ''}</button>`;
}

function tabBar() {
  return html`<cr-tabs class="cr-tabs network-tabs" storage-key=${TAB_STORAGE_KEY} aria-label=${t('settings.networkTabsAria')}
      @cr-tabs-change=${(e) => { state.tab = e.detail?.value || TABS[0]; paint(); }}>
    ${tabButton('status', 'settings.networkTabStatus')}
    ${tabButton('exposures', 'settings.networkTabExposures', openExposures().length)}
    ${tabButton('diagnostics', 'settings.networkTabDiagnostics', visibleIssues().length)}
    ${tabButton('policy', 'settings.networkTabPolicy')}
  </cr-tabs>`;
}

function statusTab() {
  return html`<div class="cr-card">
      <div class="network-head">
        <h3 class="cr-section-title">${t('settings.networkLanTitle')}</h3>
        <cr-bar-button ?disabled=${state.busy || state.refreshing} @click=${() => load(true)}>${t(state.refreshing ? 'settings.networkRefreshing' : 'settings.networkRefresh')}</cr-bar-button>
      </div>
      ${lanSummary(state.report)}
    </div>
    ${helperCard()}`;
}

function tabContent() {
  if (state.tab === 'exposures') return exposuresCard();
  if (state.tab === 'diagnostics') return state.report ? diagnosticsCard() : html`<p class="cr-hint">${t('settings.networkLoading')}</p>`;
  if (state.tab === 'policy') return policyCard();
  return statusTab();
}

function paint() {
  document.querySelectorAll('.network-settings-root').forEach((root) => {
    if (!(root instanceof HTMLElement)) return;
    render(html`
      ${tabBar()}
      <span class="cr-status" role="status" data-tone=${state.tone}>${state.message}</span>
      ${state.loadError ? html`<p class="cr-status" data-tone="error">${state.loadError}</p>` : nothing}
      <div class="network-tab-body">${tabContent()}</div>
      ${confirmDialog()}`, root);
  });
  // settingsFooters.js owns `hidden` per settings tab; Save only means something on the policy tab.
  const footer = document.querySelector('[data-settings-footer-for="connection-network"]');
  if (footer instanceof HTMLElement) footer.style.display = state.tab === 'policy' ? '' : 'none';
  const status = document.getElementById('network-save-status');
  if (status) { status.textContent = state.message; status.setAttribute('data-tone', state.tone); }
}

/** Each part paints as it arrives, so the policy and the exposures never wait for the diagnostics. */
async function load(refresh = false) {
  state.refreshing = refresh;
  paint();
  const parts = [
    api('/api/port-exposures').then((list) => { state.exposures = list.exposures || []; paint(); }).catch(() => {}),
    api('/api/port-exposures/policy').then((policy) => {
      state.policy = policy.policy;
      if (!state.draft) state.draft = toDraft(policy.policy);
      paint();
    }),
    api(`/api/net-env${refresh ? '?refresh=1' : ''}`).then((report) => {
      state.report = report; paint();
      const age = Date.now() - Date.parse(report.collectedAt);
      if (!refresh && age > REPORT_FRESH_MS) setTimeout(() => { void load(); }, REPORT_RENEW_DELAY_MS);
    }),
  ];
  const failed = (await Promise.allSettled(parts)).find((r) => r.status === 'rejected');
  state.loadError = failed ? String(/** @type {any} */ (failed).reason?.message || t('settings.networkLoadError')) : '';
  state.refreshing = false;
  paint();
}

let saveBound = false;
export function refreshNetworkSettings() {
  const btn = document.getElementById('network-save-btn');
  if (btn && !saveBound) { btn.addEventListener('click', saveNetworkSettings); saveBound = true; }
  return load();
}
