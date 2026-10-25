/**
 * LAN host settings (PATCH /api/settings).
 */
import * as api from '../../../core/api/index.js';
import { t } from '../../../i18n/index.js';
import {
  applySdkCustomSystemPromptSettings,
  initSdkCustomSystemPromptSettings,
} from '../sdkCustomSystemPromptSettings.js';
import { initHarnessSettingsScreens } from '../harnessSettingsRenderer.js';
import {
  applyAzureSpeechHint,
  applyClaudeApiKeyHint,
  applyClaudeAuthModeSelect,
  applyClaudeCacheSettings,
  applyCodexApiKeyHint,
  applyCodexAuthModeSelect,
  applyCodexChatGptHint,
  applyCursorApiKeyHint,
  applyGeminiApiKeyHint,
  applyOpenAiApiKeyHint,
} from './lanSnapshotHints.js';
import { initCursorClaudeSettings } from './lanCursorClaudeSettings.js';
import { initCodexSettings } from './lanCodexSettings.js';
import { initProviderKeySettings } from './lanProviderKeySettings.js';
import { applyAdditionalCursorDirs, applySdkRunSettings, initSdkRunSettings } from './lanSdkRunSettings.js';

/**
 * Initializes the LAN settings block: loads settings, wires the Save button (PATCH) and, when the
 * URL carries a session, refreshes the sync link and QR code after saving.
 */
export function initLanSettings() {
  initSdkCustomSystemPromptSettings();
  const harnessScreens = initHarnessSettingsScreens();
  const lanInput = document.getElementById('lan-host-input');
  const lanStatusEl = document.getElementById('lan-save-status');

  function applySettingsSnapshot(data) {
    if (!data?.ok) return;
    if (lanInput && typeof data.lanHost !== 'undefined') {
      lanInput.value = data.lanHost || '';
    }
    applyCursorApiKeyHint(data);
    harnessScreens.applySnapshot(data);
    applyClaudeAuthModeSelect(data);
    applyClaudeApiKeyHint(data);
    applyClaudeCacheSettings(data);
    applyCodexApiKeyHint(data);
    applyCodexChatGptHint(data);
    applyCodexAuthModeSelect(data);
    applyOpenAiApiKeyHint(data);
    applyAzureSpeechHint(data);
    applyGeminiApiKeyHint(data);
    applySdkRunSettings(data);
    applySdkCustomSystemPromptSettings(data);
    applyAdditionalCursorDirs(data);
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

  initCursorClaudeSettings();
  initCodexSettings();
  initProviderKeySettings();
  initSdkRunSettings(applySettingsSnapshot);
}
