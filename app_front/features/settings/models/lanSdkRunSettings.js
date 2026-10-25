/**
 * SDK run idle timeout / auto-recovery and additional Cursor context directories controls
 * of the connection settings tab.
 */
import * as api from '../../../core/api/index.js';
import { t } from '../../../i18n/index.js';
import { openFsPicker } from '../../../components/ui/cr-fs-picker.js';

/**
 * Applies the SDK run idle timeout and auto-recovery fields of a settings snapshot.
 * @param {any} data
 */
export function applySdkRunSettings(data) {
  const sdkIdleTimeoutInput = document.getElementById('sdk-idle-timeout-seconds-input');
  const sdkIdleTimeoutSaveBtn = document.getElementById('sdk-idle-timeout-save-btn');
  const sdkIdleTimeoutStatusEl = document.getElementById('sdk-idle-timeout-save-status');
  const sdkAutoRecoveryCheckbox = document.getElementById('sdk-auto-recovery-checkbox');
  const sdkAutoRecoveryStatusEl = document.getElementById('sdk-auto-recovery-save-status');
  if (sdkIdleTimeoutInput && Number.isFinite(data.sdkRunIdleTimeoutSeconds)) {
    sdkIdleTimeoutInput.value = String(data.sdkRunIdleTimeoutSeconds);
    sdkIdleTimeoutInput.disabled = !!data.sdkRunIdleTimeoutFromEnv;
  }
  if (sdkIdleTimeoutSaveBtn) {
    sdkIdleTimeoutSaveBtn.disabled = !!data.sdkRunIdleTimeoutFromEnv;
  }
  if (sdkIdleTimeoutStatusEl) {
    sdkIdleTimeoutStatusEl.textContent = data.sdkRunIdleTimeoutFromEnv
      ? t('lanSettings.sdkIdleTimeoutForcedByEnv')
      : '';
  }
  if (sdkAutoRecoveryCheckbox) {
    sdkAutoRecoveryCheckbox.checked = data.sdkRunAutoRecovery !== false;
    sdkAutoRecoveryCheckbox.disabled = !!data.sdkRunAutoRecoveryFromEnv;
  }
  if (sdkAutoRecoveryStatusEl) {
    sdkAutoRecoveryStatusEl.textContent = data.sdkRunAutoRecoveryFromEnv
      ? t('lanSettings.sdkAutoRecoveryForcedByEnv')
      : '';
  }
}

/**
 * Applies the additional Cursor context directories field of a settings snapshot.
 * @param {any} data
 */
export function applyAdditionalCursorDirs(data) {
  const additionalCursorDirsInput = document.getElementById('additional-cursor-context-dirs-input');
  if (additionalCursorDirsInput && Array.isArray(data.additionalCursorContextDirs)) {
    additionalCursorDirsInput.value = data.additionalCursorContextDirs.join('\n');
  }
}

/**
 * Wires the SDK run and additional-directories save / browse buttons.
 * @param {(data: any) => void} applySettingsSnapshot
 */
export function initSdkRunSettings(applySettingsSnapshot) {
  const sdkIdleTimeoutInput = document.getElementById('sdk-idle-timeout-seconds-input');
  const sdkIdleTimeoutSaveBtn = document.getElementById('sdk-idle-timeout-save-btn');
  const sdkIdleTimeoutStatusEl = document.getElementById('sdk-idle-timeout-save-status');
  const sdkAutoRecoveryCheckbox = document.getElementById('sdk-auto-recovery-checkbox');
  const sdkAutoRecoveryStatusEl = document.getElementById('sdk-auto-recovery-save-status');
  const additionalCursorDirsInput = document.getElementById('additional-cursor-context-dirs-input');
  const additionalCursorDirsBrowseBtn = document.getElementById('additional-cursor-context-dirs-browse');
  const additionalCursorDirsSaveBtn = document.getElementById('additional-cursor-context-dirs-save');
  const additionalCursorDirsStatusEl = document.getElementById('additional-cursor-context-dirs-status');

  if (sdkIdleTimeoutSaveBtn && sdkIdleTimeoutInput) {
    sdkIdleTimeoutSaveBtn.addEventListener('click', () => {
      const seconds = Number(sdkIdleTimeoutInput.value);
      if (!Number.isInteger(seconds) || seconds < 15 || seconds > 86400) {
        if (sdkIdleTimeoutStatusEl) {
          sdkIdleTimeoutStatusEl.textContent = t('lanSettings.sdkIdleTimeoutInvalid');
        }
        return;
      }
      if (sdkIdleTimeoutStatusEl) sdkIdleTimeoutStatusEl.textContent = t('common.saving');
      api.patchSettings({ sdkRunIdleTimeoutSeconds: seconds }).then((data) => {
        if (!data?.ok) {
          if (sdkIdleTimeoutStatusEl) sdkIdleTimeoutStatusEl.textContent = data?.error || t('lanSettings.saveError');
          return;
        }
        applySettingsSnapshot(data);
        if (sdkIdleTimeoutStatusEl && !data.sdkRunIdleTimeoutFromEnv) {
          sdkIdleTimeoutStatusEl.textContent = t('lanSettings.sdkIdleTimeoutSaved');
        }
      }).catch(() => {
        if (sdkIdleTimeoutStatusEl) sdkIdleTimeoutStatusEl.textContent = t('lanSettings.connectionError');
      });
    });
  }

  if (sdkAutoRecoveryCheckbox) {
    sdkAutoRecoveryCheckbox.addEventListener('change', () => {
      if (sdkAutoRecoveryCheckbox.disabled) return;
      if (sdkAutoRecoveryStatusEl) sdkAutoRecoveryStatusEl.textContent = t('common.saving');
      api.patchSettings({ sdkRunAutoRecovery: sdkAutoRecoveryCheckbox.checked }).then((data) => {
        if (!data?.ok) {
          if (sdkAutoRecoveryStatusEl) sdkAutoRecoveryStatusEl.textContent = data?.error || t('lanSettings.saveError');
          return;
        }
        applySettingsSnapshot(data);
        if (sdkAutoRecoveryStatusEl && !data.sdkRunAutoRecoveryFromEnv) {
          sdkAutoRecoveryStatusEl.textContent = t('common.saved');
        }
      }).catch(() => {
        if (sdkAutoRecoveryStatusEl) sdkAutoRecoveryStatusEl.textContent = t('lanSettings.connectionError');
      });
    });
  }

  if (additionalCursorDirsSaveBtn && additionalCursorDirsInput) {
    additionalCursorDirsSaveBtn.addEventListener('click', () => {
      const lines = String(additionalCursorDirsInput.value || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (additionalCursorDirsStatusEl) {
        additionalCursorDirsStatusEl.textContent = t('common.saving');
      }
      api
        .patchSettings({ additionalCursorContextDirs: lines })
        .then((data) => {
          if (!data?.ok) {
            if (additionalCursorDirsStatusEl) {
              additionalCursorDirsStatusEl.textContent = data?.error || t('lanSettings.saveError');
            }
            return;
          }
          applySettingsSnapshot(data);
          if (additionalCursorDirsStatusEl) {
            const count = Array.isArray(data.additionalCursorContextDirs)
              ? data.additionalCursorContextDirs.length
              : 0;
            additionalCursorDirsStatusEl.textContent =
              count > 0
                ? t('lanSettings.additionalDirsSaved', { count })
                : t('lanSettings.additionalDirsCleared');
          }
        })
        .catch(() => {
          if (additionalCursorDirsStatusEl) {
            additionalCursorDirsStatusEl.textContent = t('lanSettings.connectionError');
          }
        });
    });
  }

  if (additionalCursorDirsBrowseBtn && additionalCursorDirsInput) {
    additionalCursorDirsBrowseBtn.addEventListener('click', () => {
      void openFsPicker({ mode: 'folder', title: t('settings.browseFolder') }).then((picked) => {
        if (!picked) return;
        const lines = String(additionalCursorDirsInput.value || '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        if (!lines.includes(picked)) lines.push(picked);
        additionalCursorDirsInput.value = lines.join('\n');
      });
    });
  }
}
