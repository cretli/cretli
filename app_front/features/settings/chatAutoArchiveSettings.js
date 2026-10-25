/**
 * Settings → Chat and agents → General → automatic archiving of idle chats.
 *
 * The actual sweep runs on the server; this module only edits the
 * `chatAutoArchive` setting through `PATCH /api/settings`. The idle window is
 * a number plus a unit (minutes / hours / days) so short windows work too.
 */

import { t } from '../../i18n/index.js';
import { getSettings, patchSettings } from '../../core/api/index.js';
import { setChatAutoArchiveConfig } from '../chat/chatAutoArchiveConfig.js';

/** Keep these in sync with `CHAT_AUTO_ARCHIVE_UNIT_MS`/`_MAX_MS` in persist/settings.js. */
const UNITS = ['minutes', 'hours', 'days'];
const UNIT_MAX = { minutes: 525_600, hours: 8_760, days: 365 };
const DEFAULT_VALUE = 30;
const DEFAULT_UNIT = 'days';

/**
 * @param {unknown} value
 * @param {string} unit
 * @returns {number | null} Whole value inside the unit's range, or null.
 */
function normalizeValue(value, unit) {
  if (!UNITS.includes(unit)) return null;
  const rounded = Math.round(Number(value));
  if (!Number.isFinite(rounded)) return null;
  if (rounded < 1 || rounded > UNIT_MAX[unit]) return null;
  return rounded;
}

/** Wires the section once; no-op when the markup is absent. */
export function initChatAutoArchiveSettings() {
  const checkbox = /** @type {any} */ (document.getElementById('chat-auto-archive-checkbox'));
  const valueInput = /** @type {any} */ (document.getElementById('chat-auto-archive-value'));
  const unitSelect = /** @type {any} */ (document.getElementById('chat-auto-archive-unit'));
  const statusEl = /** @type {any} */ (document.getElementById('chat-auto-archive-status'));
  const skipFavoritesInput = /** @type {any} */ (document.getElementById('chat-auto-archive-skip-favorites-checkbox'));
  if (!checkbox || !valueInput || !unitSelect) return;

  unitSelect.options = [
    { value: 'minutes', label: t('settings.autoArchiveChatsUnitMinutes') },
    { value: 'hours', label: t('settings.autoArchiveChatsUnitHours') },
    { value: 'days', label: t('settings.autoArchiveChatsUnitDays') },
  ];

  let savedValue = DEFAULT_VALUE;
  let savedUnit = DEFAULT_UNIT;
  let savedSkipFavorites = true;

  /** @returns {boolean} */
  function readSkipFavorites() {
    return skipFavoritesInput ? skipFavoritesInput.checked : savedSkipFavorites;
  }

  /**
   * @param {string} [text]
   * @param {boolean} [isError]
   */
  function setStatus(text = '', isError = false) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.classList.toggle('is-error', isError);
  }

  /** Keep the browser bounds in step with the selected unit. */
  function syncInputBounds() {
    const unit = UNITS.includes(unitSelect.value) ? unitSelect.value : DEFAULT_UNIT;
    valueInput.max = String(UNIT_MAX[unit]);
    valueInput.disabled = !checkbox.checked;
    unitSelect.disabled = !checkbox.checked;
    if (skipFavoritesInput) skipFavoritesInput.disabled = !checkbox.checked;
  }

  /** @param {{ enabled?: unknown, idleValue?: unknown, idleUnit?: unknown, skipFavorites?: unknown } | null | undefined} cfg */
  function applyConfig(cfg) {
    const config = cfg && typeof cfg === 'object' ? cfg : {};
    checkbox.checked = config.enabled === true;
    savedUnit = UNITS.includes(config.idleUnit) ? config.idleUnit : DEFAULT_UNIT;
    savedValue = normalizeValue(config.idleValue, savedUnit) ?? DEFAULT_VALUE;
    savedSkipFavorites = config.skipFavorites !== false;
    if (skipFavoritesInput) skipFavoritesInput.checked = savedSkipFavorites;
    valueInput.value = String(savedValue);
    unitSelect.value = savedUnit;
    syncInputBounds();
  }

  /**
   * Push the confirmed setting to the synchronous cache the sidebar countdown
   * reads. Only call this for server-confirmed state, never for an optimistic or
   * rolled-back UI edit.
   */
  function publishConfig() {
    setChatAutoArchiveConfig({
      enabled: checkbox.checked,
      idleValue: savedValue,
      idleUnit: savedUnit,
      skipFavorites: savedSkipFavorites,
    });
  }

  async function save() {
    const unit = UNITS.includes(unitSelect.value) ? unitSelect.value : DEFAULT_UNIT;
    const value = normalizeValue(valueInput.value, unit);
    if (value === null) {
      valueInput.value = String(savedValue);
      unitSelect.value = savedUnit;
      syncInputBounds();
      setStatus(t('settings.autoArchiveChatsInvalid'), true);
      return;
    }
    const skipFavorites = readSkipFavorites();
    setStatus(t('settings.autoArchiveChatsSaving'));
    try {
      const json = await patchSettings({
        chatAutoArchive: {
          enabled: checkbox.checked,
          idleValue: value,
          idleUnit: unit,
          skipFavorites: skipFavorites,
        },
      });
      if (json && json.ok === false) throw new Error(json.error || 'save_failed');
      savedValue = value;
      savedUnit = unit;
      applyConfig({ enabled: checkbox.checked, idleValue: value, idleUnit: unit, skipFavorites });
      publishConfig();
      setStatus(t('settings.autoArchiveChatsSaved'));
    } catch (err) {
      applyConfig({
        enabled: checkbox.checked,
        idleValue: savedValue,
        idleUnit: savedUnit,
        skipFavorites: savedSkipFavorites,
      });
      setStatus(err?.message || t('settings.autoArchiveChatsSaveFailed'), true);
    }
  }

  checkbox.addEventListener('change', () => {
    syncInputBounds();
    void save();
  });
  // A native `change` does not cross the cr-bar-input shadow root, so commit on
  // blur and Enter, and only when the number actually differs from the saved one.
  const commitValue = () => {
    if (String(valueInput.value) === String(savedValue)) return;
    void save();
  };
  valueInput.addEventListener('blur', commitValue);
  valueInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') commitValue();
  });
  unitSelect.addEventListener('change', () => {
    syncInputBounds();
    void save();
  });
  skipFavoritesInput?.addEventListener('change', () => {
    void save();
  });

  getSettings()
    .then((json) => {
      applyConfig(json?.chatAutoArchive);
      publishConfig();
    })
    .catch(() => {
      // Keep the defaults when settings cannot be loaded; saving still works.
      applyConfig({ enabled: false, idleValue: DEFAULT_VALUE, idleUnit: DEFAULT_UNIT });
      publishConfig();
    });
}
