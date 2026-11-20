/**
 * English UI strings specific to the DeepSeek harness. Merged into the dictionary by
 * app_front/i18n/en.js, so a harness ships its own translations
 * (docs/ts-migration-and-core-harnesses-plan.md, B2).
 */

export const deepseekEn = {
  settings: {
    harnessDeepSeek: 'DeepSeek',
    harnessStatusDeepSeekMissing: 'Optional packages @deepseek-ai/dsh-sdk-client or @deepseek-ai/dsh are missing',
    harnessDeepSeekApiTitle: 'DeepSeek API',
    harnessDeepSeekHintPrefix: 'Key from',
    harnessDeepSeekHintSuffix: 'Required for DeepSeek Harness chats. The DEEPSEEK_API_KEY env variable takes precedence. Optional packages @deepseek-ai/dsh-sdk-client and @deepseek-ai/dsh must also be installed.',
    harnessDeepSeekApiKeyLabel: 'New API key',
    harnessDeepSeekApiKeyPlaceholder: 'Paste your DeepSeek API key and click Save',
    harnessDeepSeekApiKeySave: 'Save key',
    harnessDeepSeekApiKeyClear: 'Remove from settings',
    harnessDeepSeekNotReadyNoKey: 'No DeepSeek API key — paste a key above or set DEEPSEEK_API_KEY on the server.',
    harnessDeepSeekNotReady: 'DeepSeek Harness is not ready. Install @deepseek-ai/dsh-sdk-client and @deepseek-ai/dsh, then add an API key.',
    harnessDeepSeekReady: 'DeepSeek Harness ready — live official catalog (V4.1 Flash / V4 Pro).',
    harnessDeepSeekModelsTitle: 'DeepSeek — chat models',
    harnessDeepSeekModelsHint: 'Models from GET /models when an API key is set (fallback: deepseek-flash / deepseek-v4-pro). Check entries for the chat picker.',
    harnessDeepSeekModelsEmpty: 'No DeepSeek models. Add an API key under Harness → DeepSeek and install the optional packages.',
  },
  firstRun: {
    hintDeepSeek: 'Key from platform.deepseek.com/api_keys. Install optional @deepseek-ai/dsh-sdk-client and @deepseek-ai/dsh.',
  },
  chat: {
    contextDetailsTransportDeepSeek: 'DeepSeek',
    harnessErrorDeepSeek: 'DeepSeek Harness is not ready — add an API key in Settings → Harness → DeepSeek and install @deepseek-ai/dsh-sdk-client plus @deepseek-ai/dsh.',
    deepseekDisabled: 'DeepSeek Harness is unavailable. Add DEEPSEEK_API_KEY in Settings → Harness → DeepSeek, install the optional packages, then refresh.',
    deepseekSdkMissing: 'Optional package @deepseek-ai/dsh-sdk-client is not installed.',
    deepseekCliMissing: 'DeepSeek Harness CLI not found. Install @deepseek-ai/dsh or set DSH_BIN.',
    deepseekStatusFailed: 'Failed to check DeepSeek Harness status.',
  },
  lanSettings: {
    deepseekKeyFromEnv: 'Active key: DEEPSEEK_API_KEY env variable (overrides settings file).',
    deepseekKeyStored: 'Active key: stored in server settings (value is not shown).',
    deepseekKeyMissing: 'No active key — paste your DeepSeek key below or set DEEPSEEK_API_KEY when starting Node.',
  },
  usage: {
    harnessDeepseek: 'DeepSeek',
  },
};
