/**
 * LAN + front HMR settings:
 * - LAN host (PATCH /api/settings)
 * - Front HMR toggle (PATCH /api/settings + server restart)
 */
import * as api from './core/api/index.js';
import { restartServer } from './app/serverRestartCoordinator.js';
import { t } from './i18n/index.js';

/**
 * Initializes the LAN settings block: loads settings, wires the Save button (PATCH) and, when the
 * URL carries a session, refreshes the sync link and QR code after saving.
 */
export function initLanSettings() {
  const lanInput = document.getElementById('lan-host-input');
  const lanStatusEl = document.getElementById('lan-save-status');
  const frontHmrCheckbox = document.getElementById('front-hmr-enabled-checkbox');
  const frontHmrSaveBtn = document.getElementById('front-hmr-save-btn');
  const frontHmrStatusEl = document.getElementById('front-hmr-save-status');
  const sdkIdleTimeoutInput = document.getElementById('sdk-idle-timeout-seconds-input');
  const sdkIdleTimeoutSaveBtn = document.getElementById('sdk-idle-timeout-save-btn');
  const sdkIdleTimeoutStatusEl = document.getElementById('sdk-idle-timeout-save-status');
  const sdkAutoRecoveryCheckbox = document.getElementById('sdk-auto-recovery-checkbox');
  const sdkAutoRecoveryStatusEl = document.getElementById('sdk-auto-recovery-save-status');
  const additionalCursorDirsInput = document.getElementById('additional-cursor-context-dirs-input');
  const additionalCursorDirsSaveBtn = document.getElementById('additional-cursor-context-dirs-save');
  const additionalCursorDirsStatusEl = document.getElementById('additional-cursor-context-dirs-status');

  function setFrontHmrStatus(text) {
    if (!frontHmrStatusEl) return;
    frontHmrStatusEl.textContent = text || '';
  }

  function applyCursorApiKeyHint(data) {
    const hint = document.getElementById('cursor-api-key-source-hint');
    const keyInput = document.getElementById('cursor-api-key-input');
    const keyStatus = document.getElementById('cursor-api-key-save-status');
    if (keyInput) keyInput.value = '';
    if (keyStatus) keyStatus.textContent = '';
    if (!hint) return;
    if (!data?.ok) {
      hint.textContent = '';
      return;
    }
    if (data.cursorApiKeyFromEnv) {
      hint.textContent = t('lanSettings.cursorKeyFromEnv');
      return;
    }
    if (data.cursorApiKeyStoredInSettings && data.cursorApiKeyEffective) {
      hint.textContent = t('lanSettings.cursorKeyStored');
      return;
    }
    hint.textContent = t('lanSettings.cursorKeyMissing');
  }

  function applyOpenRouterApiKeyHint(data) {
    const hint = document.getElementById('openrouter-api-key-source-hint');
    const keyInput = document.getElementById('openrouter-api-key-input');
    const keyStatus = document.getElementById('openrouter-api-key-save-status');
    if (keyInput) keyInput.value = '';
    if (keyStatus) keyStatus.textContent = '';
    if (!hint) return;
    if (!data?.ok) {
      hint.textContent = '';
      return;
    }
    if (data.openrouterApiKeyFromEnv) {
      hint.textContent = t('lanSettings.openrouterKeyFromEnv');
      return;
    }
    if (data.openrouterApiKeyInvalidFormat) {
      hint.textContent = t('lanSettings.openrouterKeyInvalidFormat');
      return;
    }
    if (data.openrouterApiKeyStoredInSettings && data.openrouterApiKeyEffective) {
      hint.textContent = t('lanSettings.openrouterKeyStored');
      return;
    }
    hint.textContent = t('lanSettings.openrouterKeyMissing');
  }

  function applyOpenCodeApiKeyHint(data) {
    const hint = document.getElementById('opencode-api-key-source-hint');
    const keyInput = document.getElementById('opencode-api-key-input');
    const keyStatus = document.getElementById('opencode-api-key-save-status');
    if (keyInput) keyInput.value = '';
    if (keyStatus) keyStatus.textContent = '';
    if (!hint) return;
    if (!data?.ok) {
      hint.textContent = '';
      return;
    }
    if (data.opencodeApiKeyFromEnv) {
      hint.textContent = t('lanSettings.opencodeKeyFromEnv');
      return;
    }
    if (data.opencodeApiKeyInvalidFormat) {
      hint.textContent = t('lanSettings.opencodeKeyInvalidFormat');
      return;
    }
    if (data.opencodeApiKeyMisfiledInOpenRouter) {
      hint.textContent = t('lanSettings.opencodeKeyMisfiledInOpenRouter');
      return;
    }
    if (data.opencodeApiKeyStoredInSettings && data.opencodeApiKeyEffective) {
      hint.textContent = t('lanSettings.opencodeKeyStored');
      return;
    }
    hint.textContent = t('lanSettings.opencodeKeyMissing');
  }

  function applyOpenAiApiKeyHint(data) {
    const hint = document.getElementById('openai-api-key-source-hint');
    const keyInput = document.getElementById('openai-api-key-input');
    const keyStatus = document.getElementById('openai-api-key-save-status');
    if (keyInput) keyInput.value = '';
    if (keyStatus) keyStatus.textContent = '';
    if (!hint) return;
    if (!data?.ok) {
      hint.textContent = '';
      return;
    }
    if (data.openaiApiKeyFromEnv) {
      hint.textContent = t('lanSettings.openaiKeyFromEnv');
      return;
    }
    if (data.openaiApiKeyInvalidFormat) {
      hint.textContent = t('lanSettings.openaiKeyInvalidFormat');
      return;
    }
    if (data.openaiApiKeyStoredInSettings && data.openaiApiKeyEffective) {
      hint.textContent = t('lanSettings.openaiKeyStored');
      return;
    }
    hint.textContent = t('lanSettings.openaiKeyMissing');
  }

  function applyAzureSpeechHint(data) {
    const hint = document.getElementById('azure-speech-source-hint');
    const keyInput = document.getElementById('azure-speech-key-input');
    const regionInput = document.getElementById('azure-speech-region-input');
    const keyStatus = document.getElementById('azure-speech-save-status');
    if (keyInput) keyInput.value = '';
    if (keyStatus) keyStatus.textContent = '';
    if (!hint) return;
    if (!data?.ok) {
      hint.textContent = '';
      return;
    }
    // The region is not a secret, so showing it back confirms which account is used.
    if (regionInput) regionInput.value = data.azureSpeechRegion || '';
    if (data.azureSpeechFromEnv) {
      hint.textContent = t('lanSettings.azureSpeechFromEnv');
      return;
    }
    if (data.azureSpeechInvalidFormat) {
      hint.textContent = t('lanSettings.azureSpeechInvalid');
      return;
    }
    if (data.azureSpeechStoredInSettings && data.azureSpeechEffective) {
      hint.textContent = t('lanSettings.azureSpeechStored');
      return;
    }
    hint.textContent = t('lanSettings.azureSpeechMissing');
  }

  function applyGeminiApiKeyHint(data) {
    const hint = document.getElementById('gemini-api-key-source-hint');
    const keyInput = document.getElementById('gemini-api-key-input');
    const keyStatus = document.getElementById('gemini-api-key-save-status');
    if (keyInput) keyInput.value = '';
    if (keyStatus) keyStatus.textContent = '';
    if (!hint) return;
    if (!data?.ok) {
      hint.textContent = '';
      return;
    }
    if (data.geminiApiKeyFromEnv) {
      hint.textContent = t('lanSettings.geminiKeyFromEnv');
      return;
    }
    if (data.geminiApiKeyInvalidFormat) {
      hint.textContent = t('lanSettings.geminiKeyInvalid');
      return;
    }
    if (data.geminiApiKeyStoredInSettings && data.geminiApiKeyEffective) {
      hint.textContent = t('lanSettings.geminiKeyStored');
      return;
    }
    hint.textContent = t('lanSettings.geminiKeyMissing');
  }

  function applySettingsSnapshot(data) {
    if (!data?.ok) return;
    if (lanInput && typeof data.lanHost !== 'undefined') {
      lanInput.value = data.lanHost || '';
    }
    applyCursorApiKeyHint(data);
    applyOpenRouterApiKeyHint(data);
    applyOpenCodeApiKeyHint(data);
    applyOpenAiApiKeyHint(data);
    applyAzureSpeechHint(data);
    applyGeminiApiKeyHint(data);
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
    if (additionalCursorDirsInput && Array.isArray(data.additionalCursorContextDirs)) {
      additionalCursorDirsInput.value = data.additionalCursorContextDirs.join('\n');
    }
    if (!frontHmrCheckbox) return;
    frontHmrCheckbox.checked = data.frontHmrConfigEnabled !== false;
    const forcedByEnv = !!data.frontHmrForcedByEnv;
    frontHmrCheckbox.disabled = forcedByEnv;
    if (frontHmrSaveBtn) frontHmrSaveBtn.disabled = forcedByEnv;
    if (forcedByEnv) {
      setFrontHmrStatus(t('lanSettings.frontHmrForcedByEnv'));
      return;
    }
    setFrontHmrStatus('');
  }

  api
    .getSettings()
    .then((data) => {
      applySettingsSnapshot(data);
    })
    .catch(() => {});

  const btn = document.getElementById('lan-save-btn');
  if (btn) {
    btn.addEventListener('click', () => {
      if (!lanInput) return;
      if (lanStatusEl) lanStatusEl.textContent = '';
      const lanHost = (lanInput.value || '').trim();
      api.patchSettingsLanHost(lanHost).then((data) => {
        if (!data.ok) {
          if (lanStatusEl) lanStatusEl.textContent = data.error || t('lanSettings.error');
          return;
        }
        if (lanStatusEl) lanStatusEl.textContent = t('common.saved');
        const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
        const session = params.get('session');
        if (!session) return;
        api.getLanUrl().then((d) => {
          const base = d.ok && d.url ? d.url : (typeof location !== 'undefined' ? location.origin : '');
          const pathname = typeof location !== 'undefined' ? location.pathname : '/';
          const syncUrl = base + pathname + '?session=' + session;
          const link = document.getElementById('terminal-sync-link');
          const qr = document.getElementById('terminal-sync-qr');
          if (link) {
            link.href = syncUrl;
            link.textContent = syncUrl;
          }
          if (qr) qr.src = 'https://api.qrserver.com/v1/create-qr-code/?size=80x80&data=' + encodeURIComponent(syncUrl);
        }).catch(() => {});
      }).catch(() => {
        if (lanStatusEl) lanStatusEl.textContent = t('lanSettings.saveError');
      });
    });
  }

  const cursorApiKeyInput = document.getElementById('cursor-api-key-input');
  const cursorApiKeySaveBtn = document.getElementById('cursor-api-key-save-btn');
  const cursorApiKeyClearBtn = document.getElementById('cursor-api-key-clear-btn');
  const cursorApiKeyStatusEl = document.getElementById('cursor-api-key-save-status');

  if (cursorApiKeySaveBtn && cursorApiKeyInput) {
    cursorApiKeySaveBtn.addEventListener('click', () => {
      const v = (cursorApiKeyInput.value || '').trim();
      if (!v) {
        if (cursorApiKeyStatusEl) cursorApiKeyStatusEl.textContent = t('lanSettings.pasteKeyFirst');
        return;
      }
      if (cursorApiKeyStatusEl) cursorApiKeyStatusEl.textContent = t('common.saving');
      api
        .patchSettings({ cursorApiKey: v })
        .then((data) => {
          if (!data?.ok) {
            if (cursorApiKeyStatusEl) cursorApiKeyStatusEl.textContent = data?.error || t('lanSettings.saveError');
            return;
          }
          applyCursorApiKeyHint(data);
          if (cursorApiKeyStatusEl) cursorApiKeyStatusEl.textContent = t('common.saved');
        })
        .catch(() => {
          if (cursorApiKeyStatusEl) cursorApiKeyStatusEl.textContent = t('lanSettings.connectionError');
        });
    });
  }

  if (cursorApiKeyClearBtn) {
    cursorApiKeyClearBtn.addEventListener('click', () => {
      if (cursorApiKeyStatusEl) cursorApiKeyStatusEl.textContent = t('common.removing');
      api
        .patchSettings({ clearCursorApiKey: true })
        .then((data) => {
          if (!data?.ok) {
            if (cursorApiKeyStatusEl) cursorApiKeyStatusEl.textContent = data?.error || t('lanSettings.error');
            return;
          }
          applyCursorApiKeyHint(data);
          if (cursorApiKeyStatusEl) cursorApiKeyStatusEl.textContent = t('common.removed');
        })
        .catch(() => {
          if (cursorApiKeyStatusEl) cursorApiKeyStatusEl.textContent = t('lanSettings.connectionError');
        });
    });
  }

  const openrouterApiKeyInput = document.getElementById('openrouter-api-key-input');
  const openrouterApiKeySaveBtn = document.getElementById('openrouter-api-key-save-btn');
  const openrouterApiKeyClearBtn = document.getElementById('openrouter-api-key-clear-btn');
  const openrouterApiKeyStatusEl = document.getElementById('openrouter-api-key-save-status');

  if (openrouterApiKeySaveBtn && openrouterApiKeyInput) {
    openrouterApiKeySaveBtn.addEventListener('click', () => {
      const v = (openrouterApiKeyInput.value || '').trim();
      if (!v) {
        if (openrouterApiKeyStatusEl) openrouterApiKeyStatusEl.textContent = t('lanSettings.pasteKeyFirst');
        return;
      }
      if (openrouterApiKeyStatusEl) openrouterApiKeyStatusEl.textContent = t('common.saving');
      api
        .patchSettings({ openrouterApiKey: v })
        .then((data) => {
          if (!data?.ok) {
            if (openrouterApiKeyStatusEl) openrouterApiKeyStatusEl.textContent = data?.error || t('lanSettings.saveError');
            return;
          }
          applyOpenRouterApiKeyHint(data);
          if (openrouterApiKeyStatusEl) openrouterApiKeyStatusEl.textContent = t('common.saved');
        })
        .catch(() => {
          if (openrouterApiKeyStatusEl) openrouterApiKeyStatusEl.textContent = t('lanSettings.connectionError');
        });
    });
  }

  if (openrouterApiKeyClearBtn) {
    openrouterApiKeyClearBtn.addEventListener('click', () => {
      if (openrouterApiKeyStatusEl) openrouterApiKeyStatusEl.textContent = t('common.removing');
      api
        .patchSettings({ clearOpenrouterApiKey: true })
        .then((data) => {
          if (!data?.ok) {
            if (openrouterApiKeyStatusEl) openrouterApiKeyStatusEl.textContent = data?.error || t('lanSettings.error');
            return;
          }
          applyOpenRouterApiKeyHint(data);
          if (openrouterApiKeyStatusEl) openrouterApiKeyStatusEl.textContent = t('common.removed');
        })
        .catch(() => {
          if (openrouterApiKeyStatusEl) openrouterApiKeyStatusEl.textContent = t('lanSettings.connectionError');
        });
    });
  }

  const opencodeApiKeyInput = document.getElementById('opencode-api-key-input');
  const opencodeApiKeySaveBtn = document.getElementById('opencode-api-key-save-btn');
  const opencodeApiKeyClearBtn = document.getElementById('opencode-api-key-clear-btn');
  const opencodeApiKeyStatusEl = document.getElementById('opencode-api-key-save-status');

  if (opencodeApiKeySaveBtn && opencodeApiKeyInput) {
    opencodeApiKeySaveBtn.addEventListener('click', () => {
      const v = (opencodeApiKeyInput.value || '').trim();
      if (!v) {
        if (opencodeApiKeyStatusEl) opencodeApiKeyStatusEl.textContent = t('lanSettings.pasteKeyFirst');
        return;
      }
      if (opencodeApiKeyStatusEl) opencodeApiKeyStatusEl.textContent = t('common.saving');
      api
        .patchSettings({ opencodeApiKey: v })
        .then((data) => {
          if (!data?.ok) {
            if (opencodeApiKeyStatusEl) opencodeApiKeyStatusEl.textContent = data?.error || t('lanSettings.saveError');
            return;
          }
          applyOpenCodeApiKeyHint(data);
          if (opencodeApiKeyStatusEl) opencodeApiKeyStatusEl.textContent = t('common.saved');
          window.dispatchEvent(new CustomEvent('cretli-opencode-key-changed'));
        })
        .catch(() => {
          if (opencodeApiKeyStatusEl) opencodeApiKeyStatusEl.textContent = t('lanSettings.connectionError');
        });
    });
  }

  if (opencodeApiKeyClearBtn) {
    opencodeApiKeyClearBtn.addEventListener('click', () => {
      if (opencodeApiKeyStatusEl) opencodeApiKeyStatusEl.textContent = t('common.removing');
      api
        .patchSettings({ clearOpenCodeApiKey: true })
        .then((data) => {
          if (!data?.ok) {
            if (opencodeApiKeyStatusEl) opencodeApiKeyStatusEl.textContent = data?.error || t('lanSettings.error');
            return;
          }
          applyOpenCodeApiKeyHint(data);
          if (opencodeApiKeyStatusEl) opencodeApiKeyStatusEl.textContent = t('common.removed');
          window.dispatchEvent(new CustomEvent('cretli-opencode-key-changed'));
        })
        .catch(() => {
          if (opencodeApiKeyStatusEl) opencodeApiKeyStatusEl.textContent = t('lanSettings.connectionError');
        });
    });
  }

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
          window.dispatchEvent(new CustomEvent('cretli-openai-key-changed'));
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
          window.dispatchEvent(new CustomEvent('cretli-openai-key-changed'));
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
          window.dispatchEvent(new CustomEvent('cretli-azure-speech-changed'));
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
          window.dispatchEvent(new CustomEvent('cretli-azure-speech-changed'));
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
          window.dispatchEvent(new CustomEvent('cretli-gemini-key-changed'));
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
          window.dispatchEvent(new CustomEvent('cretli-gemini-key-changed'));
        })
        .catch(() => {
          if (geminiApiKeyStatusEl) geminiApiKeyStatusEl.textContent = t('lanSettings.connectionError');
        });
    });
  }

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

  if (!frontHmrSaveBtn || !frontHmrCheckbox) return;
  frontHmrSaveBtn.addEventListener('click', () => {
    const enabled = !!frontHmrCheckbox.checked;
    setFrontHmrStatus(t('common.saving'));
    api.patchSettings({ frontHmrEnabled: enabled }).then((data) => {
      if (!data?.ok) {
        setFrontHmrStatus(data?.error || t('lanSettings.saveError'));
        return;
      }
      applySettingsSnapshot(data);
      if (data.frontHmrForcedByEnv) return;
      if (data.canRestartServer === false) {
        setFrontHmrStatus(t('common.saved'));
        return;
      }
      setFrontHmrStatus(t('lanSettings.savedRestartingServer'));
      restartServer({ source: 'front-hmr-settings' }).then((result) => {
        if (!result?.ok) {
          setFrontHmrStatus(result?.error || t('lanSettings.savedRestartFailed'));
          return;
        }
        setFrontHmrStatus(t('lanSettings.savedServerRestarting'));
      });
    }).catch(() => {
      setFrontHmrStatus(t('lanSettings.saveError'));
    });
  });
}
