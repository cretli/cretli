/**
 * Settings → Usage: retention/alerts form and the auto-resume panel
 * (load, paint, save). Reads and writes its own endpoints, independent of the
 * ledger views.
 */

import {
  cancelUsageLimitResume,
  getUsageLimitResumeItems,
  getUsageLimitResumeSettings,
  getUsageSettings,
  saveUsageLimitResumeSettings,
  saveUsageSettings,
} from '../../../core/api/index.js';
import { getCurrentLang, t } from '../../../i18n/index.js';
import {
  LIMIT_RESUME_NUMBER_FIELDS,
  LIMIT_RESUME_TOGGLE_FIELDS,
  buildLimitResumePatch,
  renderLimitResumeRowsView,
} from '../usageLimitResumeView.js';
import { formatInteger } from '../usageCharts.js';
import { renderUsage } from '../usageDom.js';

/** @param {string} id @returns {any} */
const byId = (id) => document.getElementById(id);

/**
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let scaled = value / 1024;
  let index = 0;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  return `${scaled.toFixed(scaled >= 10 ? 0 : 1)} ${units[index]}`;
}

/**
 * @param {any} storage
 * @returns {string}
 */
function formatStorageText(storage) {
  if (!storage || storage.exists !== true) return t('usage.storageMissing');
  return t('usage.storageInfo', {
    size: formatBytes(storage.bytes),
    files: formatInteger(storage.files, getCurrentLang()),
    days: formatInteger(storage.dayFiles, getCurrentLang()),
    oldest: storage.oldestDay || '—',
    newest: storage.newestDay || '—',
  });
}

/**
 * Paint the retention/alerts form and the `data/usage/` size from the
 * `GET/POST /api/usage/settings` payload.
 *
 * @param {any} payload
 * @returns {void}
 */
function paintUsageSettingsForm(payload) {
  const settings = payload?.settings || {};
  const alerts = settings.alerts || {};
  const retentionEl = byId('usage-retention-days');
  if (retentionEl) retentionEl.value = String(settings.retentionDays ?? 90);
  const thresholdEl = byId('usage-alert-plan-threshold');
  if (thresholdEl) thresholdEl.value = String(alerts.planLimitThresholdPercent ?? 80);
  const dailyEl = byId('usage-budget-daily');
  if (dailyEl) dailyEl.value = alerts.dailyBudgetUsd == null ? '' : String(alerts.dailyBudgetUsd);
  const monthlyEl = byId('usage-budget-monthly');
  if (monthlyEl) monthlyEl.value = alerts.monthlyBudgetUsd == null ? '' : String(alerts.monthlyBudgetUsd);
  const toggles = [
    ['usage-alert-plan-limit', alerts.planLimit],
    ['usage-alert-lockout', alerts.lockout],
    ['usage-alert-budget', alerts.budget],
  ];
  for (const [id, value] of toggles) {
    const el = byId(id);
    if (el) el.checked = value === true;
  }
  const advice = settings.resumeAdvice || {};
  const adviceEnabledEl = byId('usage-resume-advice-enabled');
  if (adviceEnabledEl) adviceEnabledEl.checked = advice.enabled !== false;
  const adviceMinEl = byId('usage-resume-advice-min-tokens');
  if (adviceMinEl) adviceMinEl.value = String(advice.minContextTokens ?? 100000);
  const infoEl = byId('usage-storage-info');
  if (infoEl) infoEl.textContent = formatStorageText(payload?.storage);
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function parseOptionalUsd(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const numeric = Number(raw);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

/**
 * Integer form field: an empty/invalid value is omitted from the patch so the
 * server keeps the stored value instead of clamping an accidental 0.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function parseOptionalInt(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const numeric = Number(raw);
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : null;
}

/**
 * @returns {object}
 */
function collectUsageSettingsPatch() {
  const patch = {
    alerts: {
      planLimit: byId('usage-alert-plan-limit')?.checked === true,
      lockout: byId('usage-alert-lockout')?.checked === true,
      budget: byId('usage-alert-budget')?.checked === true,
      dailyBudgetUsd: parseOptionalUsd(byId('usage-budget-daily')?.value),
      monthlyBudgetUsd: parseOptionalUsd(byId('usage-budget-monthly')?.value),
    },
  };
  const retentionDays = parseOptionalInt(byId('usage-retention-days')?.value);
  if (retentionDays != null) patch.retentionDays = retentionDays;
  const threshold = parseOptionalInt(byId('usage-alert-plan-threshold')?.value);
  if (threshold != null) patch.alerts.planLimitThresholdPercent = threshold;
  patch.resumeAdvice = { enabled: byId('usage-resume-advice-enabled')?.checked !== false };
  const adviceMin = parseOptionalInt(byId('usage-resume-advice-min-tokens')?.value);
  if (adviceMin != null) patch.resumeAdvice.minContextTokens = adviceMin;
  return patch;
}

/**
 * @param {boolean} pruneNow
 * @returns {Promise<void>}
 */
export async function submitUsageSettings(pruneNow) {
  const statusEl = byId('usage-settings-status');
  if (statusEl) statusEl.textContent = t('usage.saving');
  try {
    const patch = collectUsageSettingsPatch();
    const result = await saveUsageSettings(pruneNow ? { ...patch, pruneNow: true } : patch);
    if (!result?.ok) throw new Error(result?.error || 'save failed');
    paintUsageSettingsForm(result);
    if (statusEl) statusEl.textContent = pruneNow ? t('usage.pruned') : t('usage.saved');
  } catch (error) {
    console.warn('[usage] settings save failed:', error);
    if (statusEl) statusEl.textContent = t('usage.saveFailed');
  }
}

/**
 * @param {any} settings `usageLimitResume` block from the API
 * @returns {void}
 */
function paintLimitResumeForm(settings) {
  for (const [id, key] of Object.entries(LIMIT_RESUME_TOGGLE_FIELDS)) {
    const el = byId(id);
    if (el) el.checked = settings?.[key] === true;
  }
  for (const [id, key] of Object.entries(LIMIT_RESUME_NUMBER_FIELDS)) {
    const el = byId(id);
    if (el) el.value = settings?.[key] == null ? '' : String(settings[key]);
  }
}

/**
 * @returns {Promise<void>}
 */
export async function refreshLimitResumeList() {
  const listEl = byId('usage-resume-list');
  if (!listEl) return;
  try {
    const result = await getUsageLimitResumeItems();
    if (!result?.ok) throw new Error(result?.error || 'load failed');
    renderUsage(listEl, renderLimitResumeRowsView(result.items, t, getCurrentLang()));
  } catch (error) {
    console.warn('[usage] auto-resume list failed:', error);
    listEl.textContent = t('usageLimitResume.loadFailed');
  }
}

/**
 * @returns {Promise<void>}
 */
async function refreshLimitResumePanel() {
  try {
    const payload = await getUsageLimitResumeSettings();
    if (payload?.ok) paintLimitResumeForm(payload.settings);
  } catch (error) {
    console.warn('[usage] auto-resume settings load failed:', error);
  }
  await refreshLimitResumeList();
}

/**
 * @returns {Promise<void>}
 */
export async function submitLimitResumeSettings() {
  const statusEl = byId('usage-resume-status');
  if (statusEl) statusEl.textContent = t('usageLimitResume.saving');
  try {
    const values = {};
    for (const id of Object.keys(LIMIT_RESUME_TOGGLE_FIELDS)) values[id] = byId(id)?.checked === true;
    for (const id of Object.keys(LIMIT_RESUME_NUMBER_FIELDS)) values[id] = byId(id)?.value;
    const result = await saveUsageLimitResumeSettings(buildLimitResumePatch(values));
    if (!result?.ok) throw new Error(result?.error || 'save failed');
    paintLimitResumeForm(result.settings);
    if (statusEl) statusEl.textContent = t('usageLimitResume.saved');
  } catch (error) {
    console.warn('[usage] auto-resume settings save failed:', error);
    if (statusEl) statusEl.textContent = t('usageLimitResume.saveFailed');
  }
}

/**
 * @param {string} id pause id
 * @returns {Promise<void>}
 */
export async function cancelLimitResumePause(id) {
  const statusEl = byId('usage-resume-status');
  try {
    const result = await cancelUsageLimitResume(id);
    if (!result?.ok) throw new Error(result?.error || 'cancel failed');
  } catch (error) {
    console.warn('[usage] auto-resume cancel failed:', error);
    if (statusEl) statusEl.textContent = t('usageLimitResume.cancelFailed');
  }
  await refreshLimitResumeList();
}

/**
 * Load the retention/alerts form and the directory size.
 *
 * @returns {Promise<void>}
 */
export async function refreshUsageSettingsPanel() {
  if (typeof document === 'undefined') return;
  try {
    const payload = await getUsageSettings();
    if (payload?.ok) paintUsageSettingsForm(payload);
  } catch (error) {
    console.warn('[usage] settings load failed:', error);
  }
  await refreshLimitResumePanel();
}
