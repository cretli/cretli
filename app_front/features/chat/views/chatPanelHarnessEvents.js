import { configurationState, subscribe } from '../../../state/index.js';
/**
 * Signals that keep harness and model pickers in sync with settings.
 */
import { applyEnabledHarnesses, applyHarnessOrder, getEnabledHarnessIds } from '../../settings/models/harnessSettings.js';
import { listHarnessUiMeta } from '../../../core/harness/harnessUiRegistry.js';
import { chatPresetsStore } from '../chatPresets.js';
import { loadWorkspaces } from '../services/chatSelection.js';
import { applyEnabledModelsForHarness } from '../services/chatWorkspaceContext.js';
import {
  newChatCatalogCache,
  newChatHarnessStatusTracker,
  syncNewChatAgentModelPicker,
  syncSdkModeBarPicker,
} from '../services/newChatHarnessState.js';
import {
  applyLateDefaultNewChatHarness,
  reloadOpenCodeModelsCatalog,
  runNewChatHarnessStatusCheck,
} from '../services/newChatHarnessStatus.js';
import { chatRuntime, chats } from '../state/chatRuntimeState.js';

/** Subscribe to harness/model configuration changes. */
export function bindChatPanelHarnessEvents() {
  if (typeof window !== 'undefined') {
    chatPresetsStore.onChange(() => {
      syncNewChatAgentModelPicker();
    });
    subscribe(configurationState.enabledHarnesses, (detail) => {
      if (detail?.harnessOrder) applyHarnessOrder(detail.harnessOrder);
      applyEnabledHarnesses(detail?.enabledHarnesses);
      if (chatRuntime.sharedSdkModeBar) chatRuntime.sharedSdkModeBar.enabledHarnesses = getEnabledHarnessIds();
    });
    for (const meta of listHarnessUiMeta()) {
      configurationState.onModelsChanged(meta.id, (detail) => {
        const enabledKeys = detail[meta.enabledModelsSettingsKey];
        // Some Settings panels publish models without the enabled list; keep the current one then.
        if (!meta.modelsChangedCarriesCatalog || enabledKeys) {
          applyEnabledModelsForHarness(meta.id, enabledKeys || []);
        }
        if (meta.resyncPickersOnModelsChanged) {
          // The combined picker caches per-row `settingsDisabled`; rebuild it so a just-saved model shows up without a reload.
          syncNewChatAgentModelPicker();
          syncSdkModeBarPicker(chatRuntime.sharedSdkModeBar, chats.find((c) => c.id === chatRuntime.activeChatId) || null);
        }
        if (meta.refreshStatusOnModelsChanged) {
          newChatCatalogCache.clear(meta.id);
          newChatHarnessStatusTracker.invalidate(meta.id);
          void runNewChatHarnessStatusCheck(meta.id);
        }
        if (meta.modelsChangedCarriesCatalog && (detail.catalog || detail.models)) {
          chatRuntime.chatModelSelectApi.applyAvailableModels(meta.id, {
            ok: true,
            catalog: detail.catalog,
            models: detail.models,
          });
          chatRuntime.chatModelSelectApi.refreshModelSelectLabels();
        }
      });
    }
    configurationState.onCredentialsChanged('opencode', () => {
      newChatCatalogCache.clear('opencode');
      newChatHarnessStatusTracker.invalidate('opencode');
      void reloadOpenCodeModelsCatalog();
      // Route through the tracker so the check gets a token and can never be overwritten by
      // an older, tokenless response.
      void runNewChatHarnessStatusCheck('opencode');
    });
    configurationState.onCredentialsChanged('zai', () => {
      newChatCatalogCache.clear('zai');
      newChatHarnessStatusTracker.invalidate('zai');
      void runNewChatHarnessStatusCheck('zai');
    });
    configurationState.onCredentialsChanged('mimo', () => {
      newChatCatalogCache.clear('mimo');
      newChatHarnessStatusTracker.invalidate('mimo');
      void runNewChatHarnessStatusCheck('mimo');
    });
    configurationState.onCredentialsChanged('codebuddy', () => {
      newChatCatalogCache.clear('codebuddy');
      newChatHarnessStatusTracker.invalidate('codebuddy');
      void runNewChatHarnessStatusCheck('codebuddy');
    });
    configurationState.onCredentialsChanged('deepseek', () => {
      newChatCatalogCache.clear('deepseek');
      newChatHarnessStatusTracker.invalidate('deepseek');
      void runNewChatHarnessStatusCheck('deepseek');
    });
    configurationState.onCredentialsChanged('mistral', () => {
      newChatCatalogCache.clear('mistral');
      newChatHarnessStatusTracker.invalidate('mistral');
      void runNewChatHarnessStatusCheck('mistral');
    });
    configurationState.onCredentialsChanged('qwen', () => {
      newChatCatalogCache.clear('qwen');
      newChatHarnessStatusTracker.invalidate('qwen');
      void runNewChatHarnessStatusCheck('qwen');
    });
    configurationState.onCredentialsChanged('claude', () => {
      newChatCatalogCache.clear('claude');
      newChatHarnessStatusTracker.invalidate('claude');
      void runNewChatHarnessStatusCheck('claude');
    });
    configurationState.onCredentialsChanged('codex', () => {
      newChatCatalogCache.clear('codex');
      newChatHarnessStatusTracker.invalidate('codex');
      void runNewChatHarnessStatusCheck('codex');
    });
    subscribe(configurationState.defaultHarness, () => {
      applyLateDefaultNewChatHarness();
    });
    window.addEventListener('cretli-workspace-updated', () => {
      void loadWorkspaces();
    });
  }
}
