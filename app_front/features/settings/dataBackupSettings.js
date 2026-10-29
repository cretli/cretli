/**
 * Settings -> Data and backups.
 *
 * Named settings versions, secret-free JSON export, and import with
 * preview -> section selection / workspace mapping -> apply. A "saved" message
 * is shown only after the server confirms a durable, verified write; every
 * failure is shown with its code. Imported executable and endpoint definitions
 * are listed as pending and activated by a separate, explicit action.
 * All server text is rendered through `textContent`, never as HTML.
 */

import { t, getCurrentLang, setLang } from '../../i18n/index.js';
import { cretliApiFetch } from '../../lib/cretliApiRequest.js';
import { getTheme, setTheme } from '../../core/theme/theme.js';
import './data-backup-settings.scss';

const API = '/api/settings-backup';
const PREF_THEME = 'cretli-theme';
const PREF_LANG = 'cretli-lang';
/** Server error codes that have a translated message (settings.backups.err_*). */
const KNOWN_ERROR_CODES = new Set([
  'VALIDATION', 'INVALID_DOCUMENT', 'UNSUPPORTED_PROFILE', 'SNAPSHOT_WRITE_FAILED', 'PRE_IMPORT_BACKUP_FAILED',
  'APPLY_FAILED', 'PREVIEW_STALE', 'PREVIEW_EXPIRED', 'PREVIEW_NOT_FOUND', 'CONFIG_CORRUPT', 'LOCKED',
  'CONFIRM_REQUIRED', 'NOT_FOUND', 'SNAPSHOT_CORRUPT', 'LIMIT', 'FORBIDDEN',
]);

/** @type {{ bound: boolean, snapshots: any[], corrupt: any[], pending: any[], preview: any, sourceDocument: any, caps: any, lastSave: any, result: any }} */
const state = { bound: false, snapshots: [], corrupt: [], pending: [], preview: null, sourceDocument: null, caps: null, lastSave: null, result: null };

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown }} [options]
 * @returns {Promise<{ status: number, json: any }>}
 */
async function api(path, options = {}) {
  const headers = { Accept: 'application/json', 'Accept-Language': getCurrentLang() };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await cretliApiFetch(`${API}${path}`, {
    method: options.method || 'GET',
    headers,
    credentials: 'include',
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

/**
 * @param {string} tag
 * @param {Record<string, string> | null} [attrs]
 * @param {Array<Node | string | null>} [children]
 * @returns {HTMLElement}
 */
function el(tag, attrs = null, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    if (child == null) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/** @returns {HTMLElement | null} */
const getRoot = () => document.getElementById('settings-backups-root');

/**
 * @param {string} text
 * @param {'error' | 'success' | ''} [tone]
 */
function setStatus(text, tone = '') {
  const node = getRoot()?.querySelector('[data-backup-status]');
  if (!node) return;
  node.textContent = text;
  node.setAttribute('data-tone', tone);
}

/**
 * Human-readable error with the server code, e.g. "Snapshot was not saved … (SNAPSHOT_WRITE_FAILED)".
 *
 * @param {{ status: number, json: any }} res
 * @returns {string}
 */
function errorText(res) {
  const code = res.json?.code ? ` (${res.json.code})` : '';
  const known = KNOWN_ERROR_CODES.has(res.json?.code) ? t(`settings.backups.err_${res.json.code}`) : '';
  const message = known || res.json?.error || t('settings.backups.errGeneric');
  return `${message}${code}`;
}

/**
 * @param {any} durability
 * @returns {string}
 */
function durabilityText(durability) {
  if (!durability) return '';
  const parts = [t('settings.backups.durFile'), t('settings.backups.durRename')];
  parts.push(durability.directoryFsync ? t('settings.backups.durDir') : t('settings.backups.durDirMissing'));
  const note = Array.isArray(durability.limitations) && durability.limitations.length
    ? ` ${t('settings.backups.durLimits', { details: durability.limitations.join('; ') })}`
    : '';
  return `${parts.join(' · ')} (${durability.platform})${note}`;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function short(value) {
  if (value === null || value === undefined) return '–';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

/**
 * @param {string} label
 * @param {string} action
 * @param {Record<string, string>} [extra]
 * @returns {HTMLElement}
 */
function button(label, action, extra = {}) {
  return el('cr-bar-button', { 'data-backup-action': action, ...extra }, [label]);
}

/**
 * @param {string} label
 * @param {string} name
 * @param {boolean} [checked]
 * @param {Record<string, string>} [extra]
 * @returns {HTMLElement}
 */
function check(label, name, checked = false, extra = {}) {
  const input = el('input', { type: 'checkbox', 'data-backup-check': name, ...extra });
  if (checked) input.setAttribute('checked', '');
  return el('label', { class: 'cr-check' }, [input, el('span', null, [label])]);
}

/** @returns {HTMLElement} */
function renderSnapshotsCard() {
  const card = el('div', { class: 'cr-card cr-backup-card' }, [
    el('h4', { class: 'cr-section-title' }, [t('settings.backups.snapshotsTitle')]),
    el('p', { class: 'cr-hint' }, [t('settings.backups.snapshotsHint')]),
    el('div', { class: 'cr-row' }, [
      el('cr-bar-input', { 'data-backup-name': '1', placeholder: t('settings.backups.namePlaceholder'), maxlength: '80', 'aria-label': t('settings.backups.nameLabel') }),
      button(t('settings.backups.save'), 'save', { variant: 'primary' }),
    ]),
    check(t('settings.backups.includeWorkspaces'), 'machine'),
    check(t('settings.backups.includeBrowser'), 'device'),
    el('p', { class: 'cr-hint' }, [t('settings.backups.browserHint')]),
  ]);
  if (state.lastSave) {
    card.append(el('p', { class: 'cr-status', 'data-tone': 'success' }, [
      `${t('settings.backups.savedConfirmed', { name: state.lastSave.snapshot.name })} ${durabilityText(state.lastSave.durability)}`,
    ]));
  }
  const list = el('div', { class: 'cr-backup-list' });
  if (!state.snapshots.length) list.append(el('p', { class: 'cr-hint' }, [t('settings.backups.noSnapshots')]));
  for (const snap of state.snapshots) {
    const counts = Object.entries(snap.sections || {}).map(([id, n]) => `${t(`settings.backups.section_${id}`)}: ${n}`).join(' · ');
    list.append(el('div', { class: 'cr-backup-row', 'data-snapshot-id': snap.id }, [
      el('div', { class: 'cr-backup-row-main' }, [
        el('strong', null, [snap.name]),
        el('span', { class: 'cr-hint' }, [`${new Date(snap.createdAt).toLocaleString()} · ${snap.kind === 'pre-import' ? t('settings.backups.kindPreImport') : t('settings.backups.kindManual')} · ${snap.bytes} B`]),
        el('span', { class: 'cr-hint' }, [counts]),
      ]),
      el('div', { class: 'cr-backup-row-actions' }, [
        button(t('settings.backups.restore'), 'snapshot-preview', { 'data-id': snap.id }),
        button(t('settings.backups.download'), 'snapshot-download', { 'data-id': snap.id }),
        button(t('settings.backups.delete'), 'snapshot-delete', { 'data-id': snap.id }),
      ]),
    ]));
  }
  for (const bad of state.corrupt) {
    list.append(el('p', { class: 'cr-status', 'data-tone': 'error' }, [t('settings.backups.corruptSnapshot', { file: bad.file, error: bad.error })]));
  }
  card.append(list);
  return card;
}

/** @returns {HTMLElement} */
function renderTransferCard() {
  return el('div', { class: 'cr-card cr-backup-card' }, [
    el('h4', { class: 'cr-section-title' }, [t('settings.backups.transferTitle')]),
    el('p', { class: 'cr-hint' }, [t('settings.backups.transferHint')]),
    el('div', { class: 'cr-row' }, [button(t('settings.backups.export'), 'export')]),
    el('div', { class: 'cr-field' }, [
      el('label', { class: 'cr-field-label', for: 'settings-backup-file' }, [t('settings.backups.importFile')]),
      el('input', { type: 'file', id: 'settings-backup-file', accept: 'application/json,.json', 'data-backup-file': '1' }),
    ]),
  ]);
}

/**
 * @param {any} entry
 * @param {string} sectionId
 * @returns {HTMLElement}
 */
function renderEntry(entry, sectionId) {
  const badges = [el('span', { class: 'cr-backup-badge', 'data-kind': entry.status }, [t(`settings.backups.status_${entry.status}`)])];
  if (entry.requiresActivation) badges.push(el('span', { class: 'cr-backup-badge', 'data-kind': 'disabled' }, [t('settings.backups.startsDisabled')]));
  const row = el('div', { class: 'cr-backup-entry' }, [
    el('div', { class: 'cr-backup-entry-head' }, [el('code', null, [entry.key]), ...badges]),
  ]);
  if (sectionId === 'mcp') {
    const conn = entry.after.connection || {};
    const def = entry.after.transport === 'http'
      ? `${t('settings.backups.url')}: ${conn.url || '–'}`
      : `${t('settings.backups.command')}: ${[conn.command, ...(conn.args || [])].join(' ')}${conn.cwd ? ` (cwd ${conn.cwd})` : ''}`;
    row.append(el('div', { class: 'cr-backup-def' }, [def]));
    const keys = [...(conn.envKeys || []), ...(conn.headerKeys || [])];
    if (keys.length) row.append(el('div', { class: 'cr-hint' }, [t('settings.backups.secretsNotImported', { keys: keys.join(', ') })]));
  } else if (sectionId === 'workspaces') {
    row.append(el('div', { class: 'cr-backup-def' }, [short(entry.after)]));
  } else if (entry.status !== 'unchanged') {
    row.append(el('div', { class: 'cr-backup-diff' }, [
      el('div', null, [`${t('settings.backups.before')}: ${short(entry.before)}`]),
      el('div', null, [`${t('settings.backups.after')}: ${short(entry.after)}`]),
    ]));
  }
  return row;
}

/** @returns {HTMLElement | null} */
function renderPreviewCard() {
  const preview = state.preview;
  if (!preview) return null;
  const card = el('div', { class: 'cr-card cr-backup-card', 'data-backup-preview': preview.previewId }, [
    el('h4', { class: 'cr-section-title' }, [t('settings.backups.previewTitle')]),
    el('p', { class: 'cr-hint' }, [t('settings.backups.previewMeta', { date: new Date(preview.createdAt).toLocaleString(), version: preview.cretliVersion })]),
    el('p', { class: 'cr-hint' }, [t('settings.backups.disabledNotice')]),
  ]);
  for (const section of preview.sections) {
    const changed = section.counts.added + section.counts.changed + section.counts['needs-mapping'];
    const box = el('div', { class: 'cr-backup-section' }, [
      check(`${t(`settings.backups.section_${section.id}`)} — ${t('settings.backups.sectionCounts', { changed, unchanged: section.counts.unchanged })}`, 'section', changed > 0 && !section.machine, { 'data-section': section.id }),
    ]);
    if (section.machine) box.append(el('p', { class: 'cr-hint' }, [t('settings.backups.machineHint')]));
    for (const entry of section.entries) {
      box.append(renderEntry(entry, section.id));
      if (section.id === 'workspaces') {
        box.append(el('cr-bar-input', { 'data-backup-map': entry.key, placeholder: t('settings.backups.mapPlaceholder'), 'aria-label': t('settings.backups.mapLabel', { id: entry.key }) }));
      }
    }
    for (const rej of section.rejected || []) {
      box.append(el('p', { class: 'cr-hint' }, [t('settings.backups.rejected', { path: rej.path, reason: rej.reason })]));
    }
    card.append(box);
  }
  if (preview.ignoredSections?.length) card.append(el('p', { class: 'cr-hint' }, [t('settings.backups.ignored', { sections: preview.ignoredSections.join(', ') })]));
  if (preview.devicePreferences) {
    card.append(check(t('settings.backups.applyBrowser', { values: short(preview.devicePreferences) }), 'apply-device'));
  }
  card.append(el('div', { class: 'cr-row' }, [
    button(t('settings.backups.apply'), 'apply', { variant: 'primary' }),
    button(t('settings.backups.cancel'), 'cancel-preview'),
  ]));
  return card;
}

/** @returns {HTMLElement | null} */
function renderResultCard() {
  const res = state.result;
  if (!res) return null;
  const ok = res.ok === true;
  const card = el('div', { class: 'cr-card cr-backup-card' }, [
    el('p', { class: 'cr-status', 'data-tone': ok ? 'success' : 'error' }, [ok ? t('settings.backups.importDone') : t('settings.backups.importFailed')]),
  ]);
  for (const row of res.results || []) {
    card.append(el('div', { class: 'cr-hint' }, [`${t(`settings.backups.section_${row.section}`)}: ${row.status}${row.error ? ` — ${row.error}` : ''}`]));
  }
  if (res.backups?.snapshotId) card.append(el('div', { class: 'cr-hint' }, [t('settings.backups.preImportBackup', { id: res.backups.snapshotId })]));
  if (res.durability) card.append(el('div', { class: 'cr-hint' }, [durabilityText(res.durability)]));
  if (res.pendingActivation?.length) card.append(el('div', { class: 'cr-hint' }, [t('settings.backups.pendingStaged')]));
  return card;
}

/** @returns {HTMLElement} */
function renderPendingCard() {
  const card = el('div', { class: 'cr-card cr-backup-card' }, [
    el('h4', { class: 'cr-section-title' }, [t('settings.backups.pendingTitle')]),
    el('p', { class: 'cr-hint' }, [t('settings.backups.pendingHint')]),
  ]);
  if (!state.pending.length) card.append(el('p', { class: 'cr-hint' }, [t('settings.backups.pendingNone')]));
  for (const item of state.pending) {
    card.append(el('div', { class: 'cr-backup-row' }, [
      el('div', { class: 'cr-backup-row-main' }, [el('code', null, [item.key]), el('span', { class: 'cr-backup-def' }, [short(item.value)])]),
      el('div', { class: 'cr-backup-row-actions' }, [button(t('settings.backups.activate'), 'activate', { 'data-key': item.key })]),
    ]));
  }
  card.append(el('p', { class: 'cr-hint' }, [t('settings.backups.mcpActivationHint')]));
  return card;
}

function render() {
  const root = getRoot();
  if (!root) return;
  const keepName = /** @type {HTMLInputElement | null} */ (root.querySelector('[data-backup-name]'))?.value || '';
  root.replaceChildren(
    el('div', { class: 'cr-page-body cr-backup-body' }, [
      el('h3', { class: 'settings-section-title' }, [t('settings.backups.title')]),
      el('p', { class: 'cr-hint' }, [t('settings.backups.intro')]),
      el('span', { class: 'cr-status', 'data-backup-status': '1', 'aria-live': 'polite' }),
      renderSnapshotsCard(),
      renderTransferCard(),
      renderPreviewCard(),
      renderResultCard(),
      renderPendingCard(),
    ]),
  );
  const nameInput = /** @type {HTMLInputElement | null} */ (root.querySelector('[data-backup-name]'));
  if (nameInput && keepName) nameInput.value = keepName;
}

/** @returns {Record<string, string> | undefined} */
function collectDevicePreferences() {
  try {
    return {
      [PREF_THEME]: getTheme(),
      'cretli-theme-dark': localStorage.getItem('cretli-theme-dark') || 'cretli-dark',
      'cretli-theme-light': localStorage.getItem('cretli-theme-light') || 'cretli-light',
      [PREF_LANG]: getCurrentLang(),
    };
  } catch {
    return undefined;
  }
}

/** @param {HTMLElement} root @param {string} name */
function isChecked(root, name) {
  return Boolean(/** @type {HTMLInputElement | null} */ (root.querySelector(`[data-backup-check="${name}"]`))?.checked);
}

export async function refreshDataBackupSettings() {
  const root = getRoot();
  if (!root) return;
  const [snaps, pending, caps] = await Promise.all([api('/snapshots'), api('/pending'), state.caps ? Promise.resolve(null) : api('/capabilities')]);
  if (caps?.json?.ok) state.caps = caps.json;
  if (snaps.json?.ok) {
    state.snapshots = snaps.json.snapshots;
    state.corrupt = snaps.json.corrupt;
  }
  if (pending.json?.ok) state.pending = pending.json.items;
  render();
  if (!snaps.json?.ok) setStatus(errorText(snaps), 'error');
}

/**
 * @param {string} filename
 * @param {unknown} data
 */
function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * @param {any} document_
 * @param {Record<string, unknown>} [body]
 */
async function startPreview(document_, body = { document: document_ }) {
  setStatus(t('settings.backups.working'));
  const res = await api('/preview', { method: 'POST', body });
  if (!res.json?.ok) {
    state.preview = null;
    render();
    setStatus(errorText(res), 'error');
    return;
  }
  state.sourceDocument = body;
  state.preview = res.json.preview;
  state.result = null;
  render();
  setStatus(t('settings.backups.previewReady'), 'success');
  getRoot()?.querySelector('[data-backup-preview]')?.scrollIntoView?.({ block: 'nearest' });
}

/** @param {HTMLElement} root */
async function applyPreview(root) {
  const preview = state.preview;
  if (!preview) return;
  const sections = [.../** @type {NodeListOf<HTMLInputElement>} */ (root.querySelectorAll('[data-backup-check="section"]'))]
    .filter((box) => box.checked).map((box) => box.getAttribute('data-section'));
  if (!sections.length) {
    setStatus(t('settings.backups.selectSection'), 'error');
    return;
  }
  const workspaceMapping = {};
  for (const input of /** @type {NodeListOf<HTMLInputElement>} */ (root.querySelectorAll('[data-backup-map]'))) {
    const value = String(input.value || '').trim();
    workspaceMapping[input.getAttribute('data-backup-map')] = value || null;
  }
  setStatus(t('settings.backups.working'));
  const res = await api('/apply', { method: 'POST', body: { previewId: preview.previewId, sections, workspaceMapping } });
  if (res.status === 409 || res.status === 410) {
    // The state moved on: a fresh preview is required, so rebuild it from the same source.
    setStatus(`${errorText(res)} ${t('settings.backups.refreshing')}`, 'error');
    if (state.sourceDocument) await startPreview(null, state.sourceDocument);
    return;
  }
  state.result = res.json;
  if (res.json?.ok) {
    if (isChecked(root, 'apply-device') && preview.devicePreferences) await applyDevicePreferences(preview.devicePreferences);
    state.preview = null;
    await refreshDataBackupSettings();
    setStatus(t('settings.backups.importDone'), 'success');
  } else {
    render();
    setStatus(errorText(res), 'error');
  }
}

/** @param {Record<string, string>} prefs */
async function applyDevicePreferences(prefs) {
  for (const key of ['cretli-theme-dark', 'cretli-theme-light']) {
    if (prefs[key]) localStorage.setItem(key, prefs[key]);
  }
  if (prefs[PREF_THEME]) setTheme(prefs[PREF_THEME]);
  if (prefs[PREF_LANG]) await setLang(prefs[PREF_LANG]);
}

export function initDataBackupSettings() {
  if (state.bound) return;
  const root = getRoot();
  if (!root) return;
  state.bound = true;
  render();
  root.addEventListener('change', async (event) => {
    const input = event.target instanceof HTMLInputElement && event.target.matches('[data-backup-file]') ? event.target : null;
    const file = input?.files?.[0];
    if (!file) return;
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      setStatus(t('settings.backups.err_INVALID_JSON'), 'error');
      return;
    }
    await startPreview(parsed);
    input.value = '';
  });
  root.addEventListener('click', async (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-backup-action]') : null;
    if (!target) return;
    const action = target.getAttribute('data-backup-action');
    const id = target.getAttribute('data-id') || '';
    try {
      if (action === 'save') {
        const name = String(/** @type {HTMLInputElement | null} */ (root.querySelector('[data-backup-name]'))?.value || '').trim();
        if (!name) { setStatus(t('settings.backups.err_VALIDATION'), 'error'); return; }
        setStatus(t('settings.backups.working'));
        const res = await api('/snapshots', { method: 'POST', body: {
          name,
          includeMachine: isChecked(root, 'machine'),
          devicePreferences: isChecked(root, 'device') ? collectDevicePreferences() : undefined,
        } });
        if (!res.json?.ok) { state.lastSave = null; setStatus(errorText(res), 'error'); return; }
        state.lastSave = res.json;
        await refreshDataBackupSettings();
        setStatus(t('settings.backups.savedConfirmed', { name }), 'success');
      } else if (action === 'snapshot-preview') {
        await startPreview(null, { snapshotId: id });
      } else if (action === 'snapshot-download') {
        const res = await api(`/snapshots/${encodeURIComponent(id)}`);
        if (res.status !== 200) { setStatus(errorText(res), 'error'); return; }
        downloadJson(`cretli-settings-${id}.json`, res.json);
      } else if (action === 'snapshot-delete') {
        if (!window.confirm(t('settings.backups.confirmDelete'))) return;
        const res = await api(`/snapshots/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (!res.json?.ok) { setStatus(errorText(res), 'error'); return; }
        await refreshDataBackupSettings();
      } else if (action === 'export') {
        const res = await api('/export', { method: 'POST', body: {
          includeMachine: isChecked(root, 'machine'),
          devicePreferences: isChecked(root, 'device') ? collectDevicePreferences() : undefined,
        } });
        if (!res.json?.ok) { setStatus(errorText(res), 'error'); return; }
        downloadJson(`cretli-settings-${new Date().toISOString().slice(0, 10)}.json`, res.json.document);
        setStatus(t('settings.backups.exported'), 'success');
      } else if (action === 'apply') {
        await applyPreview(root);
      } else if (action === 'cancel-preview') {
        state.preview = null;
        render();
      } else if (action === 'activate') {
        const key = target.getAttribute('data-key') || '';
        const item = state.pending.find((row) => row.key === key);
        if (!window.confirm(t('settings.backups.confirmActivate', { key, value: short(item?.value) }))) return;
        const res = await api('/pending/activate', { method: 'POST', body: { keys: [key], confirm: true } });
        if (!res.json?.ok) { setStatus(errorText(res), 'error'); return; }
        await refreshDataBackupSettings();
        setStatus(t('settings.backups.activated', { key }), 'success');
      }
    } catch (err) {
      setStatus(`${t('settings.backups.errGeneric')} ${err instanceof Error ? err.message : ''}`.trim(), 'error');
    }
  });
}
