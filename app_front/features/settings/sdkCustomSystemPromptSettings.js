/**
 * Settings → Harness → Cursor API: custom system prompt gate + default text.
 */
import * as api from '../../core/api/index.js';
import { t } from '../../i18n/index.js';

/**
 * @param {Record<string, unknown> | null | undefined} data
 */
export function applySdkCustomSystemPromptSettings(data) {
  const checkbox = document.getElementById('sdk-custom-system-prompt-enabled');
  const textarea = document.getElementById('sdk-custom-system-prompt-text');
  const statusEl = document.getElementById('sdk-custom-system-prompt-save-status');
  if (!checkbox || !textarea) return;
  const cfg = data?.sdkCustomSystemPrompt;
  const enabled = cfg && typeof cfg === 'object' && cfg.enabled === true;
  const text = cfg && typeof cfg === 'object' && typeof cfg.text === 'string' ? cfg.text : '';
  checkbox.checked = enabled;
  textarea.value = text;
  textarea.disabled = !enabled;
  if (statusEl) statusEl.textContent = '';
}

/**
 * Binds save handlers (call once from Connection / harness SDK settings init).
 */
export function initSdkCustomSystemPromptSettings() {
  const checkbox = document.getElementById('sdk-custom-system-prompt-enabled');
  const textarea = document.getElementById('sdk-custom-system-prompt-text');
  const saveBtn = document.getElementById('sdk-custom-system-prompt-save-btn');
  const statusEl = document.getElementById('sdk-custom-system-prompt-save-status');
  if (!checkbox || !textarea || !saveBtn) return;
  checkbox.addEventListener('change', () => {
    textarea.disabled = !checkbox.checked;
  });
  saveBtn.addEventListener('click', () => {
    if (statusEl) statusEl.textContent = t('common.saving');
    const payload = {
      sdkCustomSystemPrompt: {
        enabled: checkbox.checked === true,
        text: textarea.value || '',
      },
    };
    api.patchSettings(payload).then((data) => {
      if (!data?.ok) {
        if (statusEl) statusEl.textContent = data?.error || t('lanSettings.saveError');
        return;
      }
      applySdkCustomSystemPromptSettings(data);
      if (statusEl) statusEl.textContent = t('common.saved');
    }).catch(() => {
      if (statusEl) statusEl.textContent = t('lanSettings.connectionError');
    });
  });
}
