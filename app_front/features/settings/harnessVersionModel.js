/**
 * Pure helpers for Settings → Harness version cards (read-only inventory + model refresh).
 */

import { escapeHtml } from '../usage/usageCharts.js';

/** @type {readonly string[]} */
export const HARNESS_VERSION_CARD_IDS = Object.freeze([
  'sdk',
  'openrouter',
  'opencode',
  'codebuddy',
  'deepseek',
  'qwen',
  'claude',
  'codex',
]);

/** Harnesses without POST /api/harness/models/refresh support. */
export const MODEL_REFRESH_EXCLUDED = Object.freeze(['opencode']);

/**
 * @param {unknown} payload
 * @param {string} harnessId
 * @returns {object|null}
 */
export function findHarnessEntry(payload, harnessId) {
  const id = String(harnessId || '').trim().toLowerCase();
  const rows = Array.isArray(payload?.harnesses) ? payload.harnesses : [];
  return rows.find((row) => String(row?.harness || '').trim().toLowerCase() === id) || null;
}

/**
 * True when registry/check state indicates a newer package version (not merely managed in manifest).
 *
 * @param {object|null|undefined} pkg
 * @returns {boolean}
 */
export function packageHasNewerVersion(pkg) {
  if (!pkg || typeof pkg !== 'object') return false;
  const mode = String(pkg.mode || '').trim();
  if (pkg.behind === true) return true;
  if (mode === 'npm-update' || mode === 'manifest-bump') return true;
  return false;
}

/**
 * @param {object|null|undefined} entry
 * @returns {boolean}
 */
export function harnessHasUpdatesAvailable(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const packages = Array.isArray(entry.packages) ? entry.packages : [];
  return packages.some((pkg) => packageHasNewerVersion(pkg));
}

/**
 * @param {unknown} payload
 * @returns {number}
 */
export function countUpdatableHarnesses(payload) {
  const rows = Array.isArray(payload?.harnesses) ? payload.harnesses : [];
  return rows.filter((row) => harnessHasUpdatesAvailable(row)).length;
}

/**
 * @param {string|null|undefined} iso
 * @param {string} [lang]
 * @returns {string}
 */
export function formatVersionTimestamp(iso, lang = 'en') {
  const text = String(iso || '').trim();
  if (!text) return '';
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(lang === 'pl' ? 'pl-PL' : 'en-US', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}

/**
 * @param {object|null|undefined} pkg
 * @param {(key: string, vars?: object) => string} t
 * @returns {string}
 */
export function packageUpdateHint(pkg, t) {
  if (pkg?.updateError) return t('harnessVersion.packageUpdateError', { error: String(pkg.updateError) });
  if (!packageHasNewerVersion(pkg)) return '';
  const mode = String(pkg?.mode || '').trim();
  if (mode === 'manifest-bump') return t('harnessVersion.packageManifestBump');
  if (mode === 'npm-update') return t('harnessVersion.packageUpdateAvailable');
  if (pkg?.behind) return t('harnessVersion.packageBehind', { latest: String(pkg.latest || '—') });
  return '';
}

/**
 * @param {object|null|undefined} entry
 * @param {(key: string, vars?: object) => string} t
 * @returns {string}
 */
export function harnessSummaryText(entry, t) {
  if (!entry) return t('harnessVersion.harnessMissing');
  if (entry.hasUpdates || harnessHasUpdatesAvailable(entry)) return t('harnessVersion.harnessUpdatesAvailable');
  if (entry.status === 'error') return t('harnessVersion.harnessStatusError');
  return t('harnessVersion.harnessUpToDate');
}

/**
 * @param {object|null|undefined} payload
 * @param {object|null|undefined} updateEnvironment
 * @param {(key: string, vars?: object) => string} t
 * @returns {string}
 */
export function dockerEnvironmentNote(payload, updateEnvironment, t) {
  const env = updateEnvironment && typeof updateEnvironment === 'object'
    ? updateEnvironment
    : payload?.updateEnvironment;
  if (!env || typeof env !== 'object') return '';
  const notes = [];
  if (env.docker) notes.push(t('harnessVersion.dockerDetected'));
  if (env.termux) notes.push(t('harnessVersion.termuxDetected'));
  if (Array.isArray(env.notes)) {
    for (const row of env.notes) {
      const text = String(row || '').trim();
      if (text) notes.push(text);
    }
  }
  return notes.join(' · ');
}

/**
 * @param {object|null|undefined} payload
 * @param {string} harnessId
 * @param {{ lang?: string }} [options]
 * @returns {object}
 */
export function buildHarnessVersionCardModel(payload, harnessId, options = {}) {
  const lang = options.lang || 'en';
  const entry = findHarnessEntry(payload, harnessId);
  const packages = Array.isArray(entry?.packages) ? entry.packages : [];
  const updateEnvironment = payload?.updateEnvironment;
  return {
    kind: 'single',
    harnessId: String(harnessId || '').trim().toLowerCase(),
    label: String(entry?.label || harnessId || '').trim(),
    channel: String(entry?.channel || '').trim(),
    status: String(entry?.status || '').trim(),
    canUpdate: Boolean(entry?.canUpdate),
    hasUpdates: harnessHasUpdatesAvailable(entry),
    updateEnvironment: updateEnvironment && typeof updateEnvironment === 'object' ? updateEnvironment : null,
    packages: packages.map((pkg) => ({
      name: String(pkg?.name || '').trim(),
      role: String(pkg?.role || '').trim(),
      installed: String(pkg?.installed || '—').trim() || '—',
      latest: String(pkg?.latest || '—').trim() || '—',
      source: String(pkg?.source || '').trim(),
      status: String(pkg?.status || '').trim(),
      mode: String(pkg?.mode || '').trim(),
      channel: String(pkg?.channel || '').trim(),
      behind: Boolean(pkg?.behind),
      canUpdate: Boolean(pkg?.canUpdate),
      declaredSpec: pkg?.declaredSpec != null ? String(pkg.declaredSpec) : '',
      updateError: pkg?.updateError != null ? String(pkg.updateError) : '',
    })),
    updateCheckedAt: String(payload?.updateCheckedAt || '').trim(),
    updateFromCache: Boolean(payload?.updateFromCache),
    updateCacheExpiresAt: String(payload?.updateCacheExpiresAt || '').trim(),
    checkedAt: String(payload?.checkedAt || '').trim(),
    lang,
  };
}

/**
 * @param {object|null|undefined} payload
 * @param {{ lang?: string }} [options]
 * @returns {object}
 */
export function buildOverviewVersionModel(payload, options = {}) {
  const lang = options.lang || 'en';
  const rows = Array.isArray(payload?.harnesses) ? payload.harnesses : [];
  return {
    kind: 'overview',
    harnessId: 'overview',
    updatableCount: countUpdatableHarnesses(payload),
    harnesses: rows.map((entry) => ({
      harnessId: String(entry?.harness || '').trim().toLowerCase(),
      label: String(entry?.label || entry?.harness || '').trim(),
      canUpdate: Boolean(entry?.canUpdate),
      hasUpdates: harnessHasUpdatesAvailable(entry),
      status: String(entry?.status || '').trim(),
      packageCount: Array.isArray(entry?.packages) ? entry.packages.length : 0,
    })),
    updateCheckedAt: String(payload?.updateCheckedAt || '').trim(),
    updateFromCache: Boolean(payload?.updateFromCache),
    updateEnvironment: payload?.updateEnvironment && typeof payload.updateEnvironment === 'object'
      ? payload.updateEnvironment
      : null,
    checkedAt: String(payload?.checkedAt || '').trim(),
    lang,
  };
}

/**
 * @param {object} model
 * @param {{ t: (key: string, vars?: object) => string, harnessLabel?: string, modelsRefreshNote?: string, modelsRefreshResult?: object|null, busy?: string, error?: string }} options
 * @returns {string}
 */
export function renderHarnessVersionCardHtml(model, options) {
  const t = options.t;
  const busy = String(options.busy || '').trim();
  const error = String(options.error || '').trim();
  const refreshResult = options.modelsRefreshResult && typeof options.modelsRefreshResult === 'object'
    ? options.modelsRefreshResult
    : null;
  const parts = ['<div class="harness-version-panel" data-harness-version-panel="', escapeHtml(model.harnessId), '">'];
  parts.push('<div class="harness-version-head">');
  parts.push(`<h4 class="harness-version-title">${escapeHtml(t('harnessVersion.title'))}</h4>`);
  if (model.kind === 'single' && options.harnessLabel) {
    parts.push(`<span class="harness-version-subtitle">${escapeHtml(options.harnessLabel)}</span>`);
  }
  if (model.kind === 'overview' && model.updatableCount > 0) {
    parts.push(`<span class="harness-version-badge">${escapeHtml(t('harnessVersion.overviewBadge', { count: model.updatableCount }))}</span>`);
  }
  parts.push('</div>');
  if (model.kind === 'overview') {
    parts.push('<ul class="harness-version-overview-list">');
    for (const row of model.harnesses) {
      const hint = row.hasUpdates ? t('harnessVersion.rowHasUpdates') : t('harnessVersion.rowUpToDate');
      parts.push('<li class="harness-version-overview-row">');
      parts.push(`<span class="harness-version-overview-label">${escapeHtml(row.label || row.harnessId)}</span>`);
      parts.push(`<span class="harness-version-overview-status${row.hasUpdates ? ' is-behind' : ''}">${escapeHtml(hint)}</span>`);
      parts.push('</li>');
    }
    parts.push('</ul>');
  } else {
    parts.push(`<p class="harness-version-summary">${escapeHtml(harnessSummaryText({ hasUpdates: model.hasUpdates, status: model.status }, t))}</p>`);
    if (model.canUpdate && !model.hasUpdates) {
      parts.push(`<p class="harness-version-info">${escapeHtml(t('harnessVersion.releaseBumpInfo'))}</p>`);
    }
    const dockerNote = dockerEnvironmentNote(null, model.updateEnvironment, t);
    if (dockerNote) {
      parts.push(`<p class="harness-version-docker">${escapeHtml(dockerNote)}</p>`);
    }
    if (model.packages.length > 0) {
      parts.push('<table class="harness-version-packages"><thead><tr>');
      parts.push(`<th>${escapeHtml(t('harnessVersion.colPackage'))}</th>`);
      parts.push(`<th>${escapeHtml(t('harnessVersion.colInstalled'))}</th>`);
      parts.push(`<th>${escapeHtml(t('harnessVersion.colLatest'))}</th>`);
      parts.push(`<th>${escapeHtml(t('harnessVersion.colMode'))}</th>`);
      parts.push(`<th>${escapeHtml(t('harnessVersion.colChannel'))}</th>`);
      parts.push(`<th>${escapeHtml(t('harnessVersion.colNotes'))}</th>`);
      parts.push('</tr></thead><tbody>');
      for (const pkg of model.packages) {
        parts.push('<tr>');
        parts.push(`<td>${escapeHtml(pkg.name || '—')}</td>`);
        parts.push(`<td>${escapeHtml(pkg.installed)}</td>`);
        parts.push(`<td>${escapeHtml(pkg.latest)}</td>`);
        parts.push(`<td>${escapeHtml(pkg.mode || '—')}</td>`);
        parts.push(`<td>${escapeHtml(pkg.channel || '—')}</td>`);
        const hint = packageUpdateHint(pkg, t);
        parts.push(`<td class="harness-version-notes${pkg.updateError ? ' is-error' : ''}">${escapeHtml(hint || '—')}</td>`);
        parts.push('</tr>');
      }
      parts.push('</tbody></table>');
    } else {
      parts.push(`<p class="harness-version-empty">${escapeHtml(t('harnessVersion.noPackages'))}</p>`);
    }
  }
  const metaParts = [];
  if (model.updateCheckedAt) {
    metaParts.push(t('harnessVersion.updateCheckedAt', {
      time: formatVersionTimestamp(model.updateCheckedAt, model.lang),
    }));
  }
  if (model.updateFromCache) metaParts.push(t('harnessVersion.updateFromCache'));
  if (metaParts.length) {
    parts.push(`<p class="harness-version-meta">${escapeHtml(metaParts.join(' · '))}</p>`);
  }
  parts.push('<div class="harness-version-actions">');
  parts.push(`<button type="button" class="harness-version-check-btn" data-action="check-updates"${busy === 'check' ? ' disabled' : ''}>${escapeHtml(t('harnessVersion.checkForUpdates'))}</button>`);
  const refreshDisabled = busy === 'refresh'
    || model.kind === 'overview'
    || (model.kind === 'single' && MODEL_REFRESH_EXCLUDED.includes(model.harnessId));
  parts.push(`<button type="button" class="harness-version-refresh-models-btn" data-action="refresh-models"${refreshDisabled ? ' disabled' : ''}>${escapeHtml(t('harnessVersion.refreshModels'))}</button>`);
  parts.push('</div>');
  if (model.kind === 'single' && MODEL_REFRESH_EXCLUDED.includes(model.harnessId)) {
    parts.push(`<p class="harness-version-hint">${escapeHtml(t('harnessVersion.modelsRefreshUnavailable'))}</p>`);
  }
  if (model.kind === 'single' && model.harnessId === 'codex') {
    parts.push(`<p class="harness-version-hint">${escapeHtml(t('harnessVersion.codexRefreshNetwork'))}</p>`);
  }
  if (options.modelsRefreshNote) {
    parts.push(`<p class="harness-version-hint">${escapeHtml(options.modelsRefreshNote)}</p>`);
  }
  if (refreshResult) {
    const source = String(refreshResult.source || '').trim();
    const stale = Boolean(refreshResult.stale);
    const warning = String(refreshResult.warning || '').trim();
    const line = t('harnessVersion.modelsRefreshResult', {
      source: source || '—',
      stale: stale ? t('harnessVersion.modelsStale') : t('harnessVersion.modelsFresh'),
      count: Number(refreshResult.itemCount) || 0,
    });
    parts.push(`<p class="harness-version-refresh-result">${escapeHtml(line)}</p>`);
    if (warning) {
      parts.push(`<p class="harness-version-warning">${escapeHtml(warning)}</p>`);
    }
  }
  if (busy === 'load') {
    parts.push(`<p class="harness-version-loading">${escapeHtml(t('harnessVersion.loading'))}</p>`);
  }
  if (error) {
    parts.push(`<p class="harness-version-error">${escapeHtml(error)}</p>`);
  }
  parts.push('</div>');
  return parts.join('');
}

/**
 * DOM contract for unit tests (no forbidden update actions).
 *
 * @param {string} html
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function verifyHarnessVersionCardDomContract(html) {
  const text = String(html || '');
  /** @type {string[]} */
  const errors = [];
  if (!text.includes('data-action="check-updates"')) errors.push('missing check-updates action');
  if (!text.includes('data-action="refresh-models"')) errors.push('missing refresh-models action');
  if (/data-action="update"/i.test(text) || /Update CLI/i.test(text) || /Update SDK/i.test(text)) {
    errors.push('forbidden update install action');
  }
  if (text.includes('harness-version-check-btn') === false) errors.push('missing check button class');
  if (text.includes('harness-version-refresh-models-btn') === false) errors.push('missing refresh models button class');
  return { ok: errors.length === 0, errors };
}
