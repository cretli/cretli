/**
 * Settings → Harness → OpenCode: Approval Broker + optional external advisor.
 *
 * The server already exposes the contract through GET/PATCH /api/settings:
 *   approvalBroker: { mode, advisor?: { enabled, protocol, baseUrl, model, minProbability, timeoutMs, dailyQuota } }
 *   approvalAdvisorApiKey (write-only) / clearApprovalAdvisorApiKey
 *   approvalAdvisorEnabled / approvalAdvisorKeyFromEnv / approvalAdvisorKeyStoredInSettings
 *
 * This module is intentionally limited to OpenCode (the only integrated
 * permission flow) and never widens the backend policy: the UI cannot enable
 * auto-approval for writes, edits, network, secrets or git writes, and it only
 * ever sends the same redacted contract. The API key is write-only — it is
 * never read back into the DOM, logged or echoed in an error.
 *
 * The pure helpers (`normalizeApprovalBrokerFormState`, `buildApprovalAdvisorPatch`,
 * `buildApprovalBrokerModePatch`, `clampAdvisorTimeoutMs`, `clampAdvisorDailyQuota`,
 * `clampAdvisorMinProbability`, `normalizeAdvisorProtocol`, `validateAdvisorEndpointForUi`,
 * `getAdvisorKeySource`, `isAdvisorFieldsetEnabled`)
 * are exported for unit tests; the `init`/`refresh` functions only touch the DOM.
 */

import * as api from '../../api.js';
import { t } from '../../i18n/index.js';

export const APPROVAL_BROKER_MODES = Object.freeze(['off', 'shadow', 'local_reads']);
export const APPROVAL_BROKER_DEFAULT_MODE = 'off';

export const APPROVAL_ADVISOR_PROTOCOLS = Object.freeze(['openai_chat', 'systemone']);
export const ADVISOR_DEFAULT_PROTOCOL = 'openai_chat';

export const ADVISOR_DEFAULT_TIMEOUT_MS = 5000;
export const ADVISOR_MIN_TIMEOUT_MS = 3000;
export const ADVISOR_MAX_TIMEOUT_MS = 8000;
export const ADVISOR_DEFAULT_DAILY_QUOTA = 100;
export const ADVISOR_MAX_DAILY_QUOTA = 10000;
export const ADVISOR_DEFAULT_MIN_PROBABILITY = 0.9;
export const ADVISOR_MIN_MIN_PROBABILITY = 0.5;
export const ADVISOR_MAX_MIN_PROBABILITY = 0.99;

const MODE_SELECT_ID = 'approval-broker-mode-select';
const MODE_STATUS_ID = 'approval-broker-mode-status';
const ADVISOR_ENABLED_ID = 'approval-advisor-enabled-checkbox';
const ADVISOR_PROTOCOL_ID = 'approval-advisor-protocol-select';
const ADVISOR_ENDPOINT_ID = 'approval-advisor-endpoint-input';
const ADVISOR_ENDPOINT_FIELD_ID = 'approval-advisor-endpoint-field';
const ADVISOR_ENDPOINT_STATUS_ID = 'approval-advisor-endpoint-status';
const ADVISOR_MODEL_ID = 'approval-advisor-model-input';
const ADVISOR_MIN_PROBABILITY_ID = 'approval-advisor-min-probability-input';
const ADVISOR_TIMEOUT_ID = 'approval-advisor-timeout-input';
const ADVISOR_QUOTA_ID = 'approval-advisor-quota-input';
const ADVISOR_SAVE_ID = 'approval-advisor-save-btn';
const ADVISOR_SAVE_STATUS_ID = 'approval-advisor-save-status';
const ADVISOR_KEY_INPUT_ID = 'approval-advisor-api-key-input';
const ADVISOR_KEY_SAVE_ID = 'approval-advisor-api-key-save-btn';
const ADVISOR_KEY_CLEAR_ID = 'approval-advisor-api-key-clear-btn';
const ADVISOR_KEY_STATUS_ID = 'approval-advisor-api-key-status';
const ADVISOR_KEY_SOURCE_HINT_ID = 'approval-advisor-key-source-hint';

/** @type {object|null} */
let cachedSettings = null;
let initialized = false;

/**
 * Clamp an advisor timeout to the backend's safe 3000–8000 ms window.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function clampAdvisorTimeoutMs(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  const base = Number.isFinite(parsed) ? parsed : ADVISOR_DEFAULT_TIMEOUT_MS;
  return Math.min(ADVISOR_MAX_TIMEOUT_MS, Math.max(ADVISOR_MIN_TIMEOUT_MS, base));
}

/**
 * Clamp the daily quota to 0..10000. `0` disables network calls entirely.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function clampAdvisorDailyQuota(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  const base = Number.isFinite(parsed) ? parsed : ADVISOR_DEFAULT_DAILY_QUOTA;
  return Math.min(ADVISOR_MAX_DAILY_QUOTA, Math.max(0, base));
}

/**
 * Clamp the System One `noul` threshold to 0.5–0.99. A non-number falls back to
 * the safe 0.9 default.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function clampAdvisorMinProbability(value) {
  const parsed = Number.parseFloat(String(value ?? ''));
  const base = Number.isFinite(parsed) ? parsed : ADVISOR_DEFAULT_MIN_PROBABILITY;
  return Math.min(ADVISOR_MAX_MIN_PROBABILITY, Math.max(ADVISOR_MIN_MIN_PROBABILITY, base));
}

/**
 * @param {unknown} value
 * @returns {'openai_chat' | 'systemone'}
 */
export function normalizeAdvisorProtocol(value) {
  const protocol = String(value || '').trim().toLowerCase();
  return APPROVAL_ADVISOR_PROTOCOLS.includes(protocol) ? protocol : ADVISOR_DEFAULT_PROTOCOL;
}

/**
 * @param {unknown} value
 * @returns {'off' | 'shadow' | 'local_reads'}
 */
function normalizeMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return APPROVAL_BROKER_MODES.includes(mode) ? mode : APPROVAL_BROKER_DEFAULT_MODE;
}

/**
 * Reduce the GET/PATCH settings payload to the safe form state the panel edits.
 * Missing or unknown values fail closed to `off` / advisor disabled.
 *
 * @param {object|null|undefined} settings
 * @returns {{ mode: string, enabled: boolean, protocol: string, baseUrl: string, model: string, minProbability: number, timeoutMs: number, dailyQuota: number }}
 */
export function normalizeApprovalBrokerFormState(settings) {
  const broker = settings && typeof settings === 'object' && settings.approvalBroker && typeof settings.approvalBroker === 'object'
    ? settings.approvalBroker
    : {};
  const advisor = broker.advisor && typeof broker.advisor === 'object' ? broker.advisor : {};
  const mode = normalizeMode(broker.mode);
  return {
    mode,
    // The advisor can only ever be active in `local_reads`; otherwise the UI
    // shows it disabled and the payload builder forces `enabled: false`.
    enabled: mode === 'local_reads' && advisor.enabled === true,
    protocol: normalizeAdvisorProtocol(advisor.protocol),
    baseUrl: typeof advisor.baseUrl === 'string' ? advisor.baseUrl : '',
    model: typeof advisor.model === 'string' ? advisor.model : '',
    minProbability: clampAdvisorMinProbability(advisor.minProbability),
    timeoutMs: clampAdvisorTimeoutMs(advisor.timeoutMs),
    dailyQuota: clampAdvisorDailyQuota(advisor.dailyQuota),
  };
}

/**
 * Advisor fields are only interactive in `local_reads`; `off`/`shadow` never
 * call the endpoint.
 *
 * @param {unknown} mode
 * @returns {boolean}
 */
export function isAdvisorFieldsetEnabled(mode) {
  return normalizeMode(mode) === 'local_reads';
}

/**
 * Payload for the immediate mode switch (MVP step 1): mode only, never the key.
 *
 * @param {unknown} mode
 * @returns {{ approvalBroker: { mode: string } }}
 */
export function buildApprovalBrokerModePatch(mode) {
  return { approvalBroker: { mode: normalizeMode(mode) } };
}

/**
 * Payload for saving the advisor configuration (no key in this payload).
 * `enabled` is forced off outside `local_reads` even if the form was tampered
 * with, so the UI can never activate the advisor behind a disabled control.
 *
 * @param {{ mode?: unknown, enabled?: unknown, protocol?: unknown, baseUrl?: unknown, model?: unknown, minProbability?: unknown, timeoutMs?: unknown, dailyQuota?: unknown }} formState
 * @returns {{ approvalBroker: { mode: string, advisor: { enabled: boolean, protocol: string, baseUrl: string, model: string, minProbability: number, timeoutMs: number, dailyQuota: number } } }}
 */
export function buildApprovalAdvisorPatch(formState) {
  const mode = normalizeMode(formState?.mode);
  return {
    approvalBroker: {
      mode,
      advisor: {
        enabled: mode === 'local_reads' && formState?.enabled === true,
        protocol: normalizeAdvisorProtocol(formState?.protocol),
        baseUrl: String(formState?.baseUrl || '').trim().slice(0, 2048),
        model: String(formState?.model || '').trim().slice(0, 120),
        minProbability: clampAdvisorMinProbability(formState?.minProbability),
        timeoutMs: clampAdvisorTimeoutMs(formState?.timeoutMs),
        dailyQuota: clampAdvisorDailyQuota(formState?.dailyQuota),
      },
    },
  };
}

/**
 * Best-effort `localhost`/private/reserved host check used only for UX. The
 * backend still performs the real HTTPS/SSRF/DNS validation; this never
 * replaces it.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
export function isPrivateOrLocalHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  // IPv6 link-local (fe80::/10) and unique-local (fc00::/7).
  if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const first = Number(ipv4[1]);
    const second = Number(ipv4[2]);
    if (first === 0 || first === 10 || first === 127) return true;
    if (first === 169 && second === 254) return true;
    if (first === 172 && second >= 16 && second <= 31) return true;
    if (first === 192 && second === 168) return true;
    if (first === 100 && second >= 64 && second <= 127) return true; // CGNAT
    if (first >= 224) return true; // multicast/reserved
  }
  return false;
}

/**
 * Validate the advisor endpoint for the UI. Reasons: empty | invalid | not_https
 * | userinfo | private_host. A non-empty invalid value is marked inactive.
 *
 * @param {unknown} raw
 * @returns {{ ok: boolean, reason: string }}
 */
export function validateAdvisorEndpointForUi(raw) {
  const value = String(raw || '').trim();
  if (!value) return { ok: false, reason: 'empty' };
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'not_https' };
  if (parsed.username || parsed.password) return { ok: false, reason: 'userinfo' };
  if (isPrivateOrLocalHost(parsed.hostname)) return { ok: false, reason: 'private_host' };
  return { ok: true, reason: '' };
}

/**
 * Which key wins: the env variable always takes precedence over a stored key.
 *
 * @param {object|null|undefined} meta
 * @returns {'env' | 'stored' | 'missing'}
 */
export function getAdvisorKeySource(meta) {
  if (meta && meta.approvalAdvisorKeyFromEnv === true) return 'env';
  if (meta && meta.approvalAdvisorKeyStoredInSettings === true) return 'stored';
  return 'missing';
}

/**
 * @param {string} reason
 * @returns {string}
 */
function endpointReasonMessage(reason) {
  const keyByReason = {
    not_https: 'settings.approvalAdvisorEndpointNotHttps',
    private_host: 'settings.approvalAdvisorEndpointPrivate',
    userinfo: 'settings.approvalAdvisorEndpointUserinfo',
    invalid: 'settings.approvalAdvisorEndpointInvalid',
    empty: 'settings.approvalAdvisorEndpointRequired',
  };
  return t(keyByReason[reason] || 'settings.approvalAdvisorEndpointInvalid');
}

/**
 * @param {string} id
 * @returns {HTMLElement|null}
 */
function byId(id) {
  if (typeof document === 'undefined') return null;
  return document.getElementById(id);
}

/**
 * @param {HTMLElement|null} el
 * @param {string} text
 * @param {boolean} [isError]
 */
function setStatus(el, text, isError = false) {
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('is-error', Boolean(isError && text));
}

/**
 * @param {HTMLElement|null} el
 * @param {boolean} disabled
 */
function setDisabled(el, disabled) {
  if (el && 'disabled' in el) el.disabled = Boolean(disabled);
}

function modeLabelKey(mode) {
  return `settings.approvalBrokerMode_${mode}`;
}

/**
 * Fill the mode dropdown (options carry translated labels).
 *
 * @param {any} selectEl
 */
function fillModeOptions(selectEl) {
  if (!selectEl) return;
  selectEl.options = APPROVAL_BROKER_MODES.map((mode) => ({ value: mode, label: t(modeLabelKey(mode)) }));
}

/**
 * Fill the advisor protocol dropdown.
 *
 * @param {any} selectEl
 */
function fillProtocolOptions(selectEl) {
  if (!selectEl) return;
  selectEl.options = APPROVAL_ADVISOR_PROTOCOLS.map((protocol) => ({
    value: protocol,
    label: t(`settings.approvalAdvisorProtocol_${protocol}`),
  }));
}

/**
 * Toggle the advisor fieldset for the current mode. Key controls stay active so
 * the operator can configure the key before switching modes.
 *
 * @param {string} mode
 */
function updateAdvisorControls(mode) {
  const enabled = isAdvisorFieldsetEnabled(mode);
  setDisabled(byId(ADVISOR_ENABLED_ID), !enabled);
  setDisabled(byId(ADVISOR_PROTOCOL_ID), !enabled);
  setDisabled(byId(ADVISOR_ENDPOINT_ID), !enabled);
  setDisabled(byId(ADVISOR_MODEL_ID), !enabled);
  setDisabled(byId(ADVISOR_MIN_PROBABILITY_ID), !enabled);
  setDisabled(byId(ADVISOR_TIMEOUT_ID), !enabled);
  setDisabled(byId(ADVISOR_QUOTA_ID), !enabled);
  setDisabled(byId(ADVISOR_SAVE_ID), !enabled);
}

/**
 * Repaint the endpoint validity hint. Never sends anything.
 */
function refreshEndpointValidity() {
  const input = byId(ADVISOR_ENDPOINT_ID);
  const fieldEl = byId(ADVISOR_ENDPOINT_FIELD_ID);
  const statusEl = byId(ADVISOR_ENDPOINT_STATUS_ID);
  if (!statusEl) return;
  const value = input && 'value' in input ? String(input.value || '').trim() : '';
  if (!value) {
    setStatus(statusEl, '');
    fieldEl?.classList.remove('is-invalid');
    return;
  }
  const result = validateAdvisorEndpointForUi(value);
  fieldEl?.classList.toggle('is-invalid', !result.ok);
  if (result.ok) {
    setStatus(statusEl, t('settings.approvalAdvisorEndpointValid'));
    return;
  }
  setStatus(statusEl, endpointReasonMessage(result.reason), true);
}

/**
 * Key metadata hint (configured / fromEnv / stored); never the value.
 *
 * @param {object|null|undefined} meta
 */
function applyAdvisorKeyHint(meta) {
  const hint = byId(ADVISOR_KEY_SOURCE_HINT_ID);
  const input = byId(ADVISOR_KEY_INPUT_ID);
  const statusEl = byId(ADVISOR_KEY_STATUS_ID);
  if (input) input.value = '';
  if (statusEl) setStatus(statusEl, '');
  if (!hint) return;
  if (!meta || meta.ok === false) {
    hint.textContent = '';
    return;
  }
  const source = getAdvisorKeySource(meta);
  if (source === 'env') hint.textContent = t('settings.approvalAdvisorKeyFromEnv');
  else if (source === 'stored') hint.textContent = t('settings.approvalAdvisorKeyStored');
  else hint.textContent = t('settings.approvalAdvisorKeyMissing');
}

/**
 * @param {any} selectEl
 * @returns {string}
 */
function readMode(selectEl) {
  const value = selectEl && 'value' in selectEl ? selectEl.value : '';
  return normalizeMode(value);
}

/**
 * @param {any} selectEl
 * @returns {string}
 */
function readProtocol(selectEl) {
  const value = selectEl && 'value' in selectEl ? selectEl.value : '';
  return normalizeAdvisorProtocol(value);
}

/**
 * @returns {{ mode: string, enabled: boolean, protocol: string, baseUrl: string, model: string, minProbability: number, timeoutMs: number, dailyQuota: number }}
 */
function readForm() {
  const enabledEl = byId(ADVISOR_ENABLED_ID);
  const endpointEl = byId(ADVISOR_ENDPOINT_ID);
  const modelEl = byId(ADVISOR_MODEL_ID);
  const minProbabilityEl = byId(ADVISOR_MIN_PROBABILITY_ID);
  const timeoutEl = byId(ADVISOR_TIMEOUT_ID);
  const quotaEl = byId(ADVISOR_QUOTA_ID);
  return {
    mode: readMode(byId(MODE_SELECT_ID)),
    enabled: Boolean(enabledEl && 'checked' in enabledEl && enabledEl.checked),
    protocol: readProtocol(byId(ADVISOR_PROTOCOL_ID)),
    baseUrl: endpointEl && 'value' in endpointEl ? String(endpointEl.value || '') : '',
    model: modelEl && 'value' in modelEl ? String(modelEl.value || '') : '',
    minProbability: minProbabilityEl && 'value' in minProbabilityEl
      ? minProbabilityEl.value
      : ADVISOR_DEFAULT_MIN_PROBABILITY,
    timeoutMs: timeoutEl && 'value' in timeoutEl ? timeoutEl.value : ADVISOR_DEFAULT_TIMEOUT_MS,
    dailyQuota: quotaEl && 'value' in quotaEl ? quotaEl.value : ADVISOR_DEFAULT_DAILY_QUOTA,
  };
}

/**
 * Paint a settings snapshot into the panel.
 *
 * @param {object|null|undefined} settings
 */
function applySettingsSnapshot(settings) {
  const form = normalizeApprovalBrokerFormState(settings);
  const modeSelect = byId(MODE_SELECT_ID);
  fillModeOptions(modeSelect);
  if (modeSelect && 'value' in modeSelect) modeSelect.value = form.mode;
  const enabledEl = byId(ADVISOR_ENABLED_ID);
  if (enabledEl && 'checked' in enabledEl) enabledEl.checked = form.enabled;
  const protocolSelect = byId(ADVISOR_PROTOCOL_ID);
  fillProtocolOptions(protocolSelect);
  if (protocolSelect && 'value' in protocolSelect) protocolSelect.value = form.protocol;
  const endpointEl = byId(ADVISOR_ENDPOINT_ID);
  if (endpointEl && 'value' in endpointEl) endpointEl.value = form.baseUrl;
  const modelEl = byId(ADVISOR_MODEL_ID);
  if (modelEl && 'value' in modelEl) modelEl.value = form.model;
  const minProbabilityEl = byId(ADVISOR_MIN_PROBABILITY_ID);
  if (minProbabilityEl && 'value' in minProbabilityEl) minProbabilityEl.value = String(form.minProbability);
  const timeoutEl = byId(ADVISOR_TIMEOUT_ID);
  if (timeoutEl && 'value' in timeoutEl) timeoutEl.value = String(form.timeoutMs);
  const quotaEl = byId(ADVISOR_QUOTA_ID);
  if (quotaEl && 'value' in quotaEl) quotaEl.value = String(form.dailyQuota);
  updateAdvisorControls(form.mode);
  refreshEndpointValidity();
  applyAdvisorKeyHint(settings);
}

/**
 * Validate before saving the advisor config. Only UX; the backend validates
 * HTTPS/SSRF/DNS again. The model is required only for the OpenAI-compatible
 * chat protocol; System One endpoints have a server-side default model.
 *
 * @param {object} form
 * @returns {{ ok: boolean, message: string }}
 */
function validateAdvisorForm(form) {
  if (!isAdvisorFieldsetEnabled(form.mode)) {
    return { ok: false, message: t('settings.approvalAdvisorModeRequired') };
  }
  const endpoint = validateAdvisorEndpointForUi(form.baseUrl);
  if (form.enabled) {
    if (!String(form.baseUrl || '').trim()) {
      return { ok: false, message: t('settings.approvalAdvisorEndpointRequired') };
    }
    if (!endpoint.ok) {
      return { ok: false, message: endpointReasonMessage(endpoint.reason) };
    }
    if (normalizeAdvisorProtocol(form.protocol) === ADVISOR_DEFAULT_PROTOCOL && !String(form.model || '').trim()) {
      return { ok: false, message: t('settings.approvalAdvisorModelRequired') };
    }
  } else if (String(form.baseUrl || '').trim() && !endpoint.ok) {
    return { ok: false, message: t('settings.approvalAdvisorEndpointInvalid') };
  }
  return { ok: true, message: '' };
}

/**
 * Persist the mode immediately (no key, no advisor payload).
 *
 * @param {string} mode
 * @returns {Promise<void>}
 */
async function saveMode(mode) {
  const statusEl = byId(MODE_STATUS_ID);
  setStatus(statusEl, t('common.saving'));
  try {
    const data = await api.patchApprovalBrokerSettings(buildApprovalBrokerModePatch(mode));
    if (!data?.ok) {
      setStatus(statusEl, data?.error || t('settings.approvalBrokerSaveError'), true);
      revertModeSelect();
      return;
    }
    cachedSettings = data;
    applySettingsSnapshot(data);
    setStatus(statusEl, t('common.saved'));
  } catch {
    setStatus(statusEl, t('lanSettings.connectionError'), true);
    revertModeSelect();
  }
}

/**
 * Roll the broker-mode select back to the last confirmed mode after a failed
 * immediate save, so the control never shows an unsaved state.
 */
function revertModeSelect() {
  if (!cachedSettings) return;
  const confirmed = normalizeApprovalBrokerFormState(cachedSettings).mode;
  const select = byId(MODE_SELECT_ID);
  if (select && 'value' in select) select.value = confirmed;
  updateAdvisorControls(confirmed);
}

/**
 * Persist the advisor configuration (still no key in this request).
 *
 * @returns {Promise<void>}
 */
async function saveAdvisor() {
  const statusEl = byId(ADVISOR_SAVE_STATUS_ID);
  const form = readForm();
  const validation = validateAdvisorForm(form);
  if (!validation.ok) {
    setStatus(statusEl, validation.message, true);
    return;
  }
  setStatus(statusEl, t('common.saving'));
  try {
    const data = await api.patchApprovalBrokerSettings(buildApprovalAdvisorPatch(form));
    if (!data?.ok) {
      setStatus(statusEl, data?.error || t('settings.approvalBrokerSaveError'), true);
      return;
    }
    cachedSettings = data;
    applySettingsSnapshot(data);
    setStatus(statusEl, t('common.saved'));
  } catch {
    setStatus(statusEl, t('lanSettings.connectionError'), true);
  }
}

/**
 * Save a new write-only advisor key. The value is cleared from the DOM on
 * success and is never written to a status/hint/log.
 *
 * @returns {Promise<void>}
 */
async function saveAdvisorKey() {
  const input = byId(ADVISOR_KEY_INPUT_ID);
  const statusEl = byId(ADVISOR_KEY_STATUS_ID);
  const value = input && 'value' in input ? String(input.value || '').trim() : '';
  if (!value) {
    setStatus(statusEl, t('lanSettings.pasteKeyFirst'), true);
    return;
  }
  setStatus(statusEl, t('common.saving'));
  try {
    const data = await api.patchApprovalBrokerSettings({ approvalAdvisorApiKey: value });
    if (!data?.ok) {
      setStatus(statusEl, data?.error || t('lanSettings.saveError'), true);
      return;
    }
    cachedSettings = data;
    applyAdvisorKeyHint(data);
    setStatus(statusEl, t('common.saved'));
  } catch {
    setStatus(statusEl, t('lanSettings.connectionError'), true);
  }
}

/**
 * Remove only the stored key; an env key is never touched (env still wins).
 *
 * @returns {Promise<void>}
 */
async function clearAdvisorKey() {
  const statusEl = byId(ADVISOR_KEY_STATUS_ID);
  setStatus(statusEl, t('common.removing'));
  try {
    const data = await api.patchApprovalBrokerSettings({ clearApprovalAdvisorApiKey: true });
    if (!data?.ok) {
      setStatus(statusEl, data?.error || t('lanSettings.error'), true);
      return;
    }
    cachedSettings = data;
    applyAdvisorKeyHint(data);
    setStatus(statusEl, t('common.removed'));
  } catch {
    setStatus(statusEl, t('lanSettings.connectionError'), true);
  }
}

/**
 * Reload the panel from GET /api/settings. Safe to call on every tab open.
 *
 * @returns {Promise<void>}
 */
export async function refreshApprovalBrokerSettings() {
  if (typeof document === 'undefined') return;
  if (!byId(MODE_SELECT_ID)) return;
  try {
    const data = await api.getSettings();
    if (!data?.ok) return;
    cachedSettings = data;
    applySettingsSnapshot(data);
    setStatus(byId(MODE_STATUS_ID), '');
    setStatus(byId(ADVISOR_SAVE_STATUS_ID), '');
    setStatus(byId(ADVISOR_KEY_STATUS_ID), '');
  } catch {
    // Keep the last known state; the next tab open retries.
  }
}

/**
 * Wire the OpenCode Approval Broker panel once. First paint happens on tab open
 * through `refreshApprovalBrokerSettings`.
 *
 * @returns {void}
 */
export function initApprovalBrokerSettings() {
  if (typeof document === 'undefined' || initialized) return;
  const modeSelect = byId(MODE_SELECT_ID);
  if (!modeSelect) return;
  initialized = true;

  fillModeOptions(modeSelect);
  fillProtocolOptions(byId(ADVISOR_PROTOCOL_ID));
  updateAdvisorControls(readMode(modeSelect));

  modeSelect.addEventListener('cr-change', (event) => {
    const mode = normalizeMode(event?.detail?.value ?? readMode(modeSelect));
    updateAdvisorControls(mode);
    void saveMode(mode);
  });

  byId(ADVISOR_ENABLED_ID)?.addEventListener('change', () => {
    refreshEndpointValidity();
  });

  const endpointEl = byId(ADVISOR_ENDPOINT_ID);
  if (endpointEl) {
    endpointEl.addEventListener('input', refreshEndpointValidity);
    endpointEl.addEventListener('change', refreshEndpointValidity);
  }

  byId(ADVISOR_SAVE_ID)?.addEventListener('click', () => {
    void saveAdvisor();
  });
  byId(ADVISOR_KEY_SAVE_ID)?.addEventListener('click', () => {
    void saveAdvisorKey();
  });
  byId(ADVISOR_KEY_CLEAR_ID)?.addEventListener('click', () => {
    void clearAdvisorKey();
  });

  window.addEventListener('cr-lang-changed', () => {
    const select = byId(MODE_SELECT_ID);
    fillModeOptions(select);
    if (select && cachedSettings) select.value = normalizeApprovalBrokerFormState(cachedSettings).mode;
    fillProtocolOptions(byId(ADVISOR_PROTOCOL_ID));
    const protocolSelect = byId(ADVISOR_PROTOCOL_ID);
    if (protocolSelect && 'value' in protocolSelect) {
      protocolSelect.value = cachedSettings
        ? normalizeApprovalBrokerFormState(cachedSettings).protocol
        : readProtocol(protocolSelect);
    }
    refreshEndpointValidity();
    if (cachedSettings) applyAdvisorKeyHint(cachedSettings);
  });
}
