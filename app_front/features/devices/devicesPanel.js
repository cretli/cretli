import { html, render, nothing } from 'lit';
import { t } from '../../i18n/index.js';
import { readCurrentWorkspaceScope } from '../tasks/state/workspaceScope.js';
import { createDevicesApi } from '../../core/api/devices.js';
import '../../components/ui/index.js';
import './devices-panel.scss';
import { startRunsOnTargets } from './deviceRunActions.js';
import {
  statusBadge, runBadge, canRun, comparisonRows, crossDeviceRows, groupRunsByScript, latestPerDevice, shortHash, scriptChoices,
} from './deviceViewModel.js';

const POLL_MS = 5000;
const STATUS_EVERY_TICKS = 3;
const PLATFORMS = Object.freeze(['android', 'macos', 'windows', 'ios']);
const KINDS = Object.freeze(['adb-wifi', 'chrome-cdp']);
const emptyForm = () => ({ name: '', platform: 'android', kind: 'adb-wifi', host: '', port: '', cdpPort: '', serial: '', notes: '', separateProfile: false });

const state = {
  folder: '', devices: [], statuses: {}, runs: [], consents: [], tab: 'devices', dialog: null, help: null,
  busy: new Set(), message: '', tone: '', error: '', loaded: false,
  run: { dir: '', entries: [], scriptPath: '', target: 'all', errors: [] },
  compare: { before: '', after: '', result: null, error: '' },
};
let api = createDevicesApi();
let timer = null;
let ticks = 0;
let loadSeq = 0;
/** Bumped on every workspace switch; operations compare it after each await and drop stale results. */
let scopeEpoch = 0;

/** Re-reads the header workspace; on a change rebuilds the API client and clears workspace-bound state. */
function syncScope() {
  const folder = currentFolder();
  if (folder === state.folder && scopeEpoch > 0) return;
  const first = scopeEpoch === 0;
  scopeEpoch += 1; loadSeq += 1;
  state.folder = folder; api = createDevicesApi({ workspaceFolder: folder });
  if (first) return;
  Object.assign(state, { devices: [], statuses: {}, runs: [], consents: [], dialog: null, help: null, error: '', message: '', tone: '', loaded: false });
  state.run = { dir: '', entries: [], scriptPath: '', target: 'all', errors: [] };
  state.compare = { before: '', after: '', result: null, error: '' };
  paint();
}

function currentFolder() {
  try { return String(readCurrentWorkspaceScope()?.workspaceFolder || ''); } catch { return ''; }
}
function setMessage(message, tone = '') { state.message = message; state.tone = tone; paint(); }
const errText = (err) => (err?.code ? t('devices.error.generic', { code: err.code }) : t('devices.error.request'));
const isBusy = (key) => state.busy.has(key);
async function guarded(key, fn) {
  if (state.busy.has(key)) return;
  state.busy.add(key); paint();
  try { await fn(); } finally { state.busy.delete(key); paint(); }
}

async function loadStatuses(seq) {
  await Promise.all(state.devices.map(async (d) => {
    try {
      const r = await api.status(d.id);
      if (seq === loadSeq) state.statuses[d.id] = { status: r.status, detail: r.detail, checkedAt: r.checkedAt };
    } catch (err) { if (seq === loadSeq) state.statuses[d.id] = { status: 'unknown', detail: errText(err) }; }
  }));
  if (seq === loadSeq) paint();
}

async function loadRuns(seq) {
  const [runs, consents] = await Promise.all([api.runs(), api.consents()]);
  if (seq !== loadSeq) return;
  state.runs = [...(runs.runs || [])].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  state.consents = consents.prompts || [];
}

/** Reloads everything; a response from a previous workspace is dropped. */
async function load({ statuses = true } = {}) {
  syncScope();
  const seq = ++loadSeq;
  try {
    const list = await api.list();
    if (seq !== loadSeq) return;
    state.devices = list.devices || [];
    await loadRuns(seq);
    state.error = ''; state.loaded = true;
    paint();
    if (statuses) await loadStatuses(seq);
  } catch (err) { if (seq === loadSeq) { state.error = errText(err); state.loaded = true; paint(); } }
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); setMessage(t('devices.copied'), 'success'); }
  catch { setMessage(t('devices.copyFailed'), 'error'); }
}

/* ---------- dialog: add / edit ---------- */
function openDialog(device) {
  state.help = null;
  state.dialog = { id: device?.id || '', error: '', form: device ? { ...emptyForm(), ...device, port: device.port || '', cdpPort: device.cdpPort ?? '' } : emptyForm() };
  paint();
}
function closeDialog() { state.dialog = null; state.help = null; paint(); }
const payload = (f) => ({ ...f, port: f.port === '' ? 0 : Number(f.port), cdpPort: f.cdpPort === '' ? null : Number(f.cdpPort) });

async function saveDialog() {
  const d = state.dialog, epoch = scopeEpoch;
  await guarded('save', async () => {
    try {
      if (d.id) await api.update(d.id, payload(d.form)); else await api.create(payload(d.form));
      if (epoch !== scopeEpoch) return;
      state.dialog = null; state.help = null;
      setMessage(t('devices.saved'), 'success');
      await load();
    } catch (err) { d.error = err.status === 400 ? t('devices.error.invalid') : errText(err); }
  });
}
async function showHelp() {
  const f = state.dialog.form;
  await guarded('help', async () => {
    try { state.help = (await api.draftConnectHelp({ platform: f.platform, host: f.host, port: f.port === '' ? undefined : Number(f.port), cdpPort: f.cdpPort === '' ? undefined : Number(f.cdpPort) })).help; }
    catch (err) { state.dialog.error = errText(err); }
  });
}
async function removeDevice(d) {
  await guarded(`remove:${d.id}`, async () => {
    try { await api.remove(d.id); state.dialog = null; setMessage(t('devices.removed'), 'success'); await load(); }
    catch (err) { setMessage(errText(err), 'error'); }
  });
}
async function launchChrome(d) {
  await guarded(`launch:${d.id}`, async () => {
    try { await api.launchChrome(d.id); setMessage(t('devices.launchSent'), 'success'); await loadStatuses(loadSeq); }
    catch (err) { setMessage(errText(err), 'error'); }
  });
}

function field(labelKey, control) {
  return html`<div class="cr-field"><label class="cr-field-label">${t(labelKey)}</label>${control}</div>`;
}
const textField = (labelKey, form, key, type = 'text') => field(labelKey,
  html`<cr-bar-input type=${type} .value=${String(form[key] ?? '')} @input=${(e) => { form[key] = e.target.value; }}></cr-bar-input>`);

function helpBlock(help) {
  if (!help) return nothing;
  const block = (titleKey, text) => html`<div class="devices-help-block">
    <div class="devices-help-head"><strong>${t(titleKey)}</strong>
      <cr-bar-button data-copy=${titleKey} @click=${() => copy(text)}>${t('devices.copy')}</cr-bar-button></div>
    <pre class="devices-command" tabindex="0">${text}</pre></div>`;
  return html`<div class="devices-help" data-devices-help>
    ${block('devices.help.connect', help.connect)}
    ${block('devices.help.cleanup', help.cleanup)}
    ${(help.hints || []).map((h) => html`<p class="cr-hint">${h}</p>`)}</div>`;
}

function deviceDialog() {
  const d = state.dialog;
  if (!d) return nothing;
  const f = d.form;
  return html`<cr-dialog open .heading=${d.id ? t('devices.editTitle') : t('devices.addTitle')} @cr-dialog-close=${closeDialog}>
    <div class="cr-form devices-form">
      ${textField('devices.field.name', f, 'name')}
      ${field('devices.field.platform', html`<select aria-label=${t('devices.field.platform')} @change=${(e) => { f.platform = e.target.value; }}>
        ${PLATFORMS.map((p) => html`<option value=${p} ?selected=${f.platform === p}>${t(`devices.platform.${p}`)}</option>`)}</select>`)}
      ${field('devices.field.kind', html`<select aria-label=${t('devices.field.kind')} @change=${(e) => { f.kind = e.target.value; }}>
        ${KINDS.map((k) => html`<option value=${k} ?selected=${f.kind === k}>${t(`devices.kind.${k}`)}</option>`)}</select>`)}
      ${textField('devices.field.host', f, 'host')}
      ${textField('devices.field.port', f, 'port', 'number')}
      ${textField('devices.field.cdpPort', f, 'cdpPort', 'number')}
      ${textField('devices.field.serial', f, 'serial')}
      ${textField('devices.field.notes', f, 'notes')}
      <label class="cr-check"><input type="checkbox" .checked=${f.separateProfile} @change=${(e) => { f.separateProfile = e.target.checked; }}> ${t('devices.field.separateProfile')}</label>
      <p class="cr-hint">${t('devices.pairingHint')}</p>
    </div>
    <cr-bar-button data-show-help ?disabled=${isBusy('help')} @click=${showHelp}>${t('devices.help.show')}</cr-bar-button>
    ${helpBlock(state.help)}
    ${d.error ? html`<p class="cr-status" role="alert" data-tone="error">${d.error}</p>` : nothing}
    <div slot="actions">
      ${d.id ? html`<cr-bar-button ?disabled=${isBusy(`remove:${d.id}`)} @click=${() => removeDevice({ id: d.id })}>${t('devices.remove')}</cr-bar-button>` : nothing}
      <cr-bar-button @click=${closeDialog}>${t('devices.cancel')}</cr-bar-button>
      <cr-bar-button variant="primary" data-save ?disabled=${isBusy('save')} @click=${saveDialog}>${t('devices.save')}</cr-bar-button>
    </div>
  </cr-dialog>`;
}

/* ---------- devices tab ---------- */
function badge(b, detail) {
  return html`<span class="devices-badge" data-tone=${b.tone} title=${detail || ''}>${t(b.key)}</span>`;
}
function deviceCard(d) {
  const s = state.statuses[d.id];
  return html`<li class="cr-card devices-card" data-device-id=${d.id}>
    <div class="devices-card-head">
      <span class="devices-card-name">${d.name}</span>
      ${badge(statusBadge(s?.status), s?.detail)}
      <span class="devices-meta">${t(`devices.platform.${d.platform}`)} · ${d.host || t('devices.noHost')}${d.port ? `:${d.port}` : ''}</span>
    </div>
    <div class="devices-actions">
      ${s?.status === 'chrome-down' || s?.status === 'unreachable' ? html`<cr-bar-button data-launch ?disabled=${isBusy(`launch:${d.id}`)} @click=${() => launchChrome(d)}>${t('devices.launchChrome')}</cr-bar-button>` : nothing}
      <cr-bar-button @click=${() => openDialog(d)}>${t('devices.edit')}</cr-bar-button>
    </div>
  </li>`;
}
function devicesTab() {
  if (!state.devices.length) return html`<p class="cr-hint" data-devices-empty>${t('devices.empty')}</p>`;
  return html`<ul class="devices-list">${state.devices.map(deviceCard)}</ul>`;
}

/* ---------- runs tab ---------- */
async function listScripts(dir = '') {
  const epoch = scopeEpoch;
  try {
    const r = await api.scriptEntries(dir);
    if (epoch !== scopeEpoch) return;
    state.run.dir = dir; state.run.entries = scriptChoices(r.entries); paint();
  } catch (err) { setMessage(errText(err), 'error'); }
}
async function startRuns() {
  const r = state.run;
  if (!r.scriptPath.trim()) { setMessage(t('devices.run.needScript'), 'error'); return; }
  const targets = r.target === 'all' ? state.devices.filter((d) => canRun(state.statuses[d.id]?.status)) : state.devices.filter((d) => d.id === r.target);
  if (!targets.length) { setMessage(t('devices.run.noTargets'), 'error'); return; }
  const scriptPath = r.scriptPath.trim(), epoch = scopeEpoch, scopedApi = api;
  await guarded('start', async () => {
    const out = await startRunsOnTargets({ api: scopedApi, targets, scriptPath, getEpoch: () => scopeEpoch, epoch });
    if (out.aborted) return;
    r.errors = out.errors.map((e) => ({ device: e.device, text: e.code ? t('devices.error.generic', { code: e.code }) : t('devices.error.request') }));
    state.tab = 'runs';
    await load({ statuses: false });
  });
}
async function decide(prompt, decision) {
  await guarded(`decide:${prompt.id}`, async () => {
    const epoch = scopeEpoch;
    try { await api.decide(prompt.id, decision); if (epoch !== scopeEpoch) return; await load({ statuses: false }); }
    catch (err) { setMessage(errText(err), 'error'); await load({ statuses: false }); }
  });
}
function consentCard(p) {
  return html`<div class="cr-card devices-consent" role="group" data-device-consent>
    <p><strong>${t('devices.consent.title', { device: p.deviceName })}</strong></p>
    <p>${t('devices.consent.script')} <code>${p.scriptPath}</code></p>
    <p>${t('devices.consent.hash')} <code title=${p.hash}>${p.hash}</code></p>
    <p class="cr-hint" data-tone="warn">${t('devices.consent.unsandboxed')}</p>
    <div class="devices-actions">
      <cr-bar-button variant="primary" data-consent-once ?disabled=${isBusy(`decide:${p.id}`)} @click=${() => decide(p, 'once')}>${t('devices.consent.once')}</cr-bar-button>
      <cr-bar-button data-consent-deny ?disabled=${isBusy(`decide:${p.id}`)} @click=${() => decide(p, 'deny')}>${t('devices.consent.deny')}</cr-bar-button>
    </div></div>`;
}
function runForm() {
  const r = state.run;
  return html`<div class="cr-card devices-run-form cr-form">
    <div class="cr-field"><label class="cr-field-label">${t('devices.run.dir')}</label>
      <div class="cr-row"><cr-bar-input .value=${r.dir} @input=${(e) => { r.dir = e.target.value; }}></cr-bar-input>
        <cr-bar-button data-list-scripts @click=${() => listScripts(r.dir)}>${t('devices.run.list')}</cr-bar-button></div></div>
    ${r.entries.length ? html`<ul class="devices-scripts">${r.entries.map((e) => html`<li>
      <button type="button" class="devices-script" @click=${() => (e.isDir ? listScripts(e.path) : (state.run.scriptPath = e.path, paint()))}>
        <span class="mdi ${e.isDir ? 'mdi-folder-outline' : 'mdi-file-code-outline'}"></span>${e.name}</button></li>`)}</ul>` : nothing}
    ${field('devices.run.scriptPath', html`<cr-bar-input data-script-path .value=${r.scriptPath} @input=${(e) => { r.scriptPath = e.target.value; }}></cr-bar-input>`)}
    ${field('devices.run.target', html`<select data-target aria-label=${t('devices.run.target')} @change=${(e) => { r.target = e.target.value; }}>
      <option value="all" ?selected=${r.target === 'all'}>${t('devices.run.allDevices')}</option>
      ${state.devices.map((d) => html`<option value=${d.id} ?selected=${r.target === d.id}>${d.name}</option>`)}</select>`)}
    <cr-bar-button variant="primary" data-start-run ?disabled=${isBusy('start')} @click=${startRuns}>${t('devices.run.start')}</cr-bar-button>
    ${r.errors.map((e) => html`<p class="cr-status" role="alert" data-tone="error">${e.device}: ${e.text}</p>`)}
  </div>`;
}
const fmt = (v) => (v === null || v === undefined ? t('devices.missing') : String(v));
function runRow(run) {
  const b = runBadge(run.status);
  return html`<tr data-run-id=${run.id}>
    <td>${run.deviceName}</td><td><code>${run.scriptPath}</code></td>
    <td>${badge(b, run.error || '')}${run.error ? html` <span class="devices-meta">${run.error}</span>` : nothing}</td>
    <td><code title=${run.hash}>${shortHash(run.hash)}</code></td>
    <td>${run.metrics ? Object.entries(run.metrics).map(([k, v]) => html`<div>${k}: ${fmt(v)}</div>`) : t('devices.missing')}</td>
    <td>${(run.screenshots || []).map((n) => html`<a href=${api.screenshotUrl(run.id, n)} target="_blank" rel="noopener">${t('devices.screenshot')}</a> `)}</td>
  </tr>`;
}
function runsTable() {
  if (!state.runs.length) return html`<p class="cr-hint" data-runs-empty>${t('devices.run.empty')}</p>`;
  return html`<div class="devices-table-wrap"><table class="devices-table" data-runs>
    <thead><tr>${['device', 'script', 'status', 'hash', 'metrics', 'screenshots'].map((k) => html`<th scope="col">${t(`devices.run.col.${k}`)}</th>`)}</tr></thead>
    <tbody>${state.runs.map(runRow)}</tbody></table></div>`;
}

/* ---------- comparison ---------- */
async function runCompare() {
  const c = state.compare;
  if (!c.before || !c.after) return;
  const epoch = scopeEpoch;
  await guarded('compare', async () => {
    try { const result = await api.compare(c.before, c.after); if (epoch === scopeEpoch) { c.result = result; c.error = ''; } }
    catch (err) { if (epoch !== scopeEpoch) return; c.result = null; c.error = err.code === 'script-mismatch' ? t('devices.compare.mismatch') : errText(err); }
  });
}
function runSelect(labelKey, key, runs) {
  const c = state.compare;
  return field(labelKey, html`<select data-compare=${key} aria-label=${t(labelKey)} @change=${(e) => { c[key] = e.target.value; c.result = null; paint(); }}>
    <option value="">${t('devices.compare.choose')}</option>
    ${runs.map((r) => html`<option value=${r.id} ?selected=${c[key] === r.id}>${r.deviceName} · ${r.startedAt}</option>`)}</select>`);
}
function comparison() {
  const done = state.runs.filter((r) => r.status === 'success');
  const c = state.compare;
  const rows = comparisonRows(c.result);
  const groups = groupRunsByScript(done).filter((g) => new Set(g.runs.map((r) => r.deviceId)).size > 1);
  return html`<section class="devices-compare" data-devices-compare>
    <h3 class="cr-section-title">${t('devices.compare.title')}</h3>
    ${done.length < 2 ? html`<p class="cr-hint">${t('devices.compare.needTwo')}</p>` : html`<div class="cr-form devices-compare-form">
      ${runSelect('devices.compare.before', 'before', done)}${runSelect('devices.compare.after', 'after', done)}
      <cr-bar-button data-run-compare ?disabled=${isBusy('compare') || !c.before || !c.after} @click=${runCompare}>${t('devices.compare.action')}</cr-bar-button></div>`}
    ${c.error ? html`<p class="cr-status" role="alert" data-tone="error">${c.error}</p>` : nothing}
    ${c.result ? html`<table class="devices-table" data-compare-table>
      <thead><tr>${['metric', 'before', 'after', 'delta'].map((k) => html`<th scope="col">${t(`devices.compare.col.${k}`)}</th>`)}</tr></thead>
      <tbody>${rows.map((r) => html`<tr data-metric=${r.metric}><td>${r.metric}</td><td>${fmt(r.before)}</td><td>${fmt(r.after)}</td><td>${fmt(r.delta)}</td></tr>`)}</tbody></table>` : nothing}
    ${groups.map((g) => {
      const latest = latestPerDevice(g.runs);
      const x = crossDeviceRows(latest);
      return html`<h4 class="cr-section-title">${t('devices.compare.crossDevice', { script: g.scriptPath })}</h4>
        <table class="devices-table" data-cross-table><thead><tr><th scope="col">${t('devices.compare.col.metric')}</th>${x.columns.map((col) => html`<th scope="col">${col.name}</th>`)}</tr></thead>
        <tbody>${x.rows.map((row) => html`<tr><td>${row.metric}</td>${row.values.map((v) => html`<td>${fmt(v)}</td>`)}</tr>`)}</tbody></table>`;
    })}
  </section>`;
}
function runsTab() {
  return html`${runForm()}
    ${state.consents.map(consentCard)}
    ${runsTable()}${comparison()}`;
}

/* ---------- shell ---------- */
function selectTab(tab) { state.tab = tab; paint(); }
function tabButton(tab, key) {
  return html`<button type="button" class="cr-tab" role="tab" data-tab=${tab} aria-selected=${state.tab === tab ? 'true' : 'false'} @click=${() => selectTab(tab)}>${t(key)}</button>`;
}

function paint() {
  const root = document.getElementById('devices-root');
  if (!root) return;
  render(html`<div class="devices-root cr-page-body">
    <div class="devices-header">
      <span class="cr-status" role="status" data-tone=${state.tone}>${state.message}</span>
      <span class="devices-spacer"></span>
      <cr-bar-button data-refresh ?disabled=${isBusy('refresh')} @click=${() => guarded('refresh', () => load())}>${t('devices.refresh')}</cr-bar-button>
      <cr-bar-button variant="primary" data-add @click=${() => openDialog(null)}>${t('devices.add')}</cr-bar-button>
    </div>
    ${state.error ? html`<p class="cr-status" role="alert" data-tone="error">${state.error}</p>` : nothing}
    ${!state.loaded ? html`<p class="cr-hint">${t('devices.loading')}</p>` : nothing}
    <div class="cr-tabs devices-tabs" role="tablist" aria-label=${t('devices.tabsAria')}>${tabButton('devices', 'devices.tabDevices')}${tabButton('runs', 'devices.tabRuns')}</div>
    <div class="devices-tab-body">${state.tab === 'runs' ? runsTab() : devicesTab()}</div>
    ${deviceDialog()}
  </div>`, root);
}

const panelVisible = () => !document.hidden && document.getElementById('devices-panel')?.classList.contains('active');

export function refreshDevicesPanel() { return load(); }

export function initDevicesPanel() {
  paint();
  window.addEventListener('cretli:workspace-changed', () => { syncScope(); if (panelVisible()) void load(); });
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    if (!panelVisible() || state.dialog || state.busy.size) return;
    ticks += 1;
    void load({ statuses: ticks % STATUS_EVERY_TICKS === 0 });
  }, POLL_MS);
}
