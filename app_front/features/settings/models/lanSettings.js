import * as api from '../../../core/api/index.js';
import {
  applySdkCustomSystemPromptSettings,
  initSdkCustomSystemPromptSettings,
} from '../sdkCustomSystemPromptSettings.js';
import { initLanHostSettings } from './lanHostSettings.js';
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
 * Settings-screen bootstrap (not LAN-only): wires every settings section, loads GET /api/settings
 * once and fans the snapshot out to the per-section `apply*` functions.
 */
export function initLanSettings() {
  initSdkCustomSystemPromptSettings();
  const harnessScreens = initHarnessSettingsScreens();
  const applyLanHost = initLanHostSettings();

  // Order matters: appliers run in this sequence for every snapshot.
  const snapshotAppliers = [
    applyLanHost,
    applyCursorApiKeyHint,
    (data) => harnessScreens.applySnapshot(data),
    applyClaudeAuthModeSelect,
    applyClaudeApiKeyHint,
    applyClaudeCacheSettings,
    applyCodexApiKeyHint,
    applyCodexChatGptHint,
    applyCodexAuthModeSelect,
    applyOpenAiApiKeyHint,
    applyAzureSpeechHint,
    applyGeminiApiKeyHint,
    applySdkRunSettings,
    applySdkCustomSystemPromptSettings,
    applyAdditionalCursorDirs,
  ];

  function applySettingsSnapshot(data) {
    if (!data?.ok) return;
    for (const apply of snapshotAppliers) apply(data);
  }

  api
    .getSettings()
    .then((data) => {
      applySettingsSnapshot(data);
    })
    .catch(() => {});

  initCursorClaudeSettings();
  initCodexSettings();
  initProviderKeySettings();
  initSdkRunSettings(applySettingsSnapshot);
}
