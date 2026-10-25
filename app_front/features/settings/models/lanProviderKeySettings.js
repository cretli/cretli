import { configurationState } from '../../../state/index.js';
/**
 * OpenAI, Azure speech and Gemini key controls of the connection settings tab.
 */
import * as api from '../../../core/api/index.js';
import { t } from '../../../i18n/index.js';
import { applyOpenAiApiKeyHint, applyAzureSpeechHint, applyGeminiApiKeyHint } from './lanSnapshotHints.js';

export function initProviderKeySettings() {
  const openaiApiKeyInput = document.getElementById('openai-api-key-input');
  const openaiApiKeySaveBtn = document.getElementById('openai-api-key-save-btn');
  const openaiApiKeyClearBtn = document.getElementById('openai-api-key-clear-btn');
  const openaiApiKeyStatusEl = document.getElementById('openai-api-key-save-status');

  if (openaiApiKeySaveBtn && openaiApiKeyInput) {
    openaiApiKeySaveBtn.addEventListener('click', () => {
      const v = (openaiApiKeyInput.value || '').trim();
      if (!v) {
        if (openaiApiKeyStatusEl) openaiApiKeyStatusEl.textContent = t('lanSettings.pasteKeyFirst');
        return;
      }
      if (openaiApiKeyStatusEl) openaiApiKeyStatusEl.textContent = t('common.saving');
      api
        .patchSettings({ openaiApiKey: v })
        .then((data) => {
          if (!data?.ok) {
            if (openaiApiKeyStatusEl) openaiApiKeyStatusEl.textContent = data?.error || t('lanSettings.saveError');
            return;
          }
          applyOpenAiApiKeyHint(data);
          if (openaiApiKeyStatusEl) openaiApiKeyStatusEl.textContent = t('common.saved');
          configurationState.invalidateCredentials('openai');
        })
        .catch(() => {
          if (openaiApiKeyStatusEl) openaiApiKeyStatusEl.textContent = t('lanSettings.connectionError');
        });
    });
  }

  if (openaiApiKeyClearBtn) {
    openaiApiKeyClearBtn.addEventListener('click', () => {
      if (openaiApiKeyStatusEl) openaiApiKeyStatusEl.textContent = t('common.removing');
      api
        .patchSettings({ clearOpenaiApiKey: true })
        .then((data) => {
          if (!data?.ok) {
            if (openaiApiKeyStatusEl) openaiApiKeyStatusEl.textContent = data?.error || t('lanSettings.error');
            return;
          }
          applyOpenAiApiKeyHint(data);
          if (openaiApiKeyStatusEl) openaiApiKeyStatusEl.textContent = t('common.removed');
          configurationState.invalidateCredentials('openai');
        })
        .catch(() => {
          if (openaiApiKeyStatusEl) openaiApiKeyStatusEl.textContent = t('lanSettings.connectionError');
        });
    });
  }

  const azureSpeechKeyInput = document.getElementById('azure-speech-key-input');
  const azureSpeechRegionInput = document.getElementById('azure-speech-region-input');
  const azureSpeechSaveBtn = document.getElementById('azure-speech-save-btn');
  const azureSpeechClearBtn = document.getElementById('azure-speech-clear-btn');
  const azureSpeechStatusEl = document.getElementById('azure-speech-save-status');

  if (azureSpeechSaveBtn && azureSpeechKeyInput && azureSpeechRegionInput) {
    azureSpeechSaveBtn.addEventListener('click', () => {
      const key = (azureSpeechKeyInput.value || '').trim();
      const region = (azureSpeechRegionInput.value || '').trim();
      // Azure needs both: the region is part of the endpoint host.
      if (!key || !region) {
        if (azureSpeechStatusEl) azureSpeechStatusEl.textContent = t('lanSettings.azureSpeechNeedsBoth');
        return;
      }
      if (azureSpeechStatusEl) azureSpeechStatusEl.textContent = t('common.saving');
      api
        .patchSettings({ azureSpeechKey: key, azureSpeechRegion: region })
        .then((data) => {
          if (!data?.ok) {
            if (azureSpeechStatusEl) azureSpeechStatusEl.textContent = data?.error || t('lanSettings.saveError');
            return;
          }
          applyAzureSpeechHint(data);
          if (azureSpeechStatusEl) azureSpeechStatusEl.textContent = t('common.saved');
          configurationState.invalidateCredentials('azure');
        })
        .catch(() => {
          if (azureSpeechStatusEl) azureSpeechStatusEl.textContent = t('lanSettings.connectionError');
        });
    });
  }

  if (azureSpeechClearBtn) {
    azureSpeechClearBtn.addEventListener('click', () => {
      if (azureSpeechStatusEl) azureSpeechStatusEl.textContent = t('common.removing');
      api
        .patchSettings({ clearAzureSpeech: true })
        .then((data) => {
          if (!data?.ok) {
            if (azureSpeechStatusEl) azureSpeechStatusEl.textContent = data?.error || t('lanSettings.error');
            return;
          }
          applyAzureSpeechHint(data);
          if (azureSpeechStatusEl) azureSpeechStatusEl.textContent = t('common.removed');
          configurationState.invalidateCredentials('azure');
        })
        .catch(() => {
          if (azureSpeechStatusEl) azureSpeechStatusEl.textContent = t('lanSettings.connectionError');
        });
    });
  }

  const geminiApiKeyInput = document.getElementById('gemini-api-key-input');
  const geminiApiKeySaveBtn = document.getElementById('gemini-api-key-save-btn');
  const geminiApiKeyTestBtn = document.getElementById('gemini-api-key-test-btn');
  const geminiApiKeyClearBtn = document.getElementById('gemini-api-key-clear-btn');
  const geminiApiKeyStatusEl = document.getElementById('gemini-api-key-save-status');

  if (geminiApiKeySaveBtn && geminiApiKeyInput) {
    geminiApiKeySaveBtn.addEventListener('click', () => {
      const v = (geminiApiKeyInput.value || '').trim();
      if (!v) {
        if (geminiApiKeyStatusEl) geminiApiKeyStatusEl.textContent = t('lanSettings.pasteKeyFirst');
        return;
      }
      if (geminiApiKeyStatusEl) geminiApiKeyStatusEl.textContent = t('common.saving');
      api
        .patchSettings({ geminiApiKey: v })
        .then((data) => {
          if (!data?.ok) {
            if (geminiApiKeyStatusEl) geminiApiKeyStatusEl.textContent = data?.error || t('lanSettings.saveError');
            return;
          }
          applyGeminiApiKeyHint(data);
          if (geminiApiKeyStatusEl) geminiApiKeyStatusEl.textContent = t('common.saved');
          configurationState.invalidateCredentials('gemini');
        })
        .catch(() => {
          if (geminiApiKeyStatusEl) geminiApiKeyStatusEl.textContent = t('lanSettings.connectionError');
        });
    });
  }

  if (geminiApiKeyTestBtn) {
    geminiApiKeyTestBtn.addEventListener('click', () => {
      if (geminiApiKeyTestBtn.disabled) return;
      const pasted = (geminiApiKeyInput?.value || '').trim();
      geminiApiKeyTestBtn.disabled = true;
      if (geminiApiKeyStatusEl) geminiApiKeyStatusEl.textContent = t('common.testing');
      api
        .probeGeminiApiKey(pasted ? { geminiApiKey: pasted } : {})
        .then((data) => {
          if (!data?.ok) {
            if (geminiApiKeyStatusEl) {
              geminiApiKeyStatusEl.textContent = t('lanSettings.geminiKeyFailed', {
                error: data?.error || t('lanSettings.error'),
              });
            }
            return;
          }
          const model = data.model ? ` (${data.model})` : '';
          if (geminiApiKeyStatusEl) {
            geminiApiKeyStatusEl.textContent = t('lanSettings.geminiKeyWorks', { model });
          }
        })
        .catch(() => {
          if (geminiApiKeyStatusEl) geminiApiKeyStatusEl.textContent = t('lanSettings.connectionError');
        })
        .finally(() => {
          geminiApiKeyTestBtn.disabled = false;
        });
    });
  }

  if (geminiApiKeyClearBtn) {
    geminiApiKeyClearBtn.addEventListener('click', () => {
      if (geminiApiKeyStatusEl) geminiApiKeyStatusEl.textContent = t('common.removing');
      api
        .patchSettings({ clearGeminiApiKey: true })
        .then((data) => {
          if (!data?.ok) {
            if (geminiApiKeyStatusEl) geminiApiKeyStatusEl.textContent = data?.error || t('lanSettings.error');
            return;
          }
          applyGeminiApiKeyHint(data);
          if (geminiApiKeyStatusEl) geminiApiKeyStatusEl.textContent = t('common.removed');
          configurationState.invalidateCredentials('gemini');
        })
        .catch(() => {
          if (geminiApiKeyStatusEl) geminiApiKeyStatusEl.textContent = t('lanSettings.connectionError');
        });
    });
  }
}
