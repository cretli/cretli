/**
 * English UI strings specific to the Qwen harness. Merged into the dictionary by
 * app_front/i18n/en.js, so a harness ships its own translations
 * (docs/ts-migration-and-core-harnesses-plan.md, B2).
 */

export const qwenEn = {
  settings: {
    harnessQwen: 'Qwen',
    harnessStatusQwenMissing: 'Optional package @qwen-code/sdk is not installed',
    harnessQwenApiTitle: 'Qwen Cloud API',
    harnessQwenHintPrefix: 'Key from',
    harnessQwenHintSuffix: ' (API Keys). QWEN_API_KEY takes precedence. Optional package @qwen-code/sdk must also be installed.',
    harnessQwenEndpointLabel: 'Qwen Cloud plan',
    harnessQwenEndpointPayg: 'Pay-as-you-go',
    harnessQwenEndpointTokenPlan: 'Token Plan',
    harnessQwenEndpointCodingPlan: 'Coding Plan',
    harnessQwenEndpointCustom: 'Custom URL',
    harnessQwenBaseUrlLabel: 'Custom base URL',
    harnessQwenBaseUrlPlaceholder: 'https://…',
    harnessQwenApiKeyLabel: 'New API key',
    harnessQwenApiKeyPlaceholder: 'Paste your Qwen Cloud API key and click Save',
    harnessQwenApiKeySave: 'Save key',
    harnessQwenApiKeyClear: 'Remove from settings',
    harnessQwenNotReadyNoKey: 'No Qwen Cloud API key — paste a key above or set QWEN_API_KEY on the server.',
    harnessQwenNotReadySdkMissing: 'Qwen Code SDK is not installed. Run npm install @qwen-code/sdk and restart the server. The API key is already saved.',
    harnessQwenNotReady: 'Qwen Code is not ready. Install @qwen-code/sdk, then add an API key.',
    harnessQwenResolvedUrl: 'API URL for this plan:',
    harnessQwenReady: 'Qwen Code ready — Qwen Cloud OpenAI-compatible API.',
    harnessQwenModelsTitle: 'Qwen — chat models',
    harnessQwenModelsHint: 'Live Qwen Cloud /models list when an API key is set; otherwise the plan fallback (3.8 Max / Plus / Coder). Check entries for the chat picker.',
    harnessQwenModelsEmpty: 'No Qwen models. Add an API key under Harness → Qwen and install @qwen-code/sdk.',
  },
  firstRun: {
    hintQwen: 'Key from home.qwencloud.com (API Keys). Install optional @qwen-code/sdk.',
  },
  chat: {
    contextDetailsTransportQwen: 'Qwen',
    qwenQuotaError: 'Qwen Cloud quota or rate limit: {detail}',
    qwenAuthError: 'Qwen Cloud authentication failed: {detail}. Check the API key in Settings → Harness → Qwen.',
    harnessErrorQwen: 'Qwen Code is not ready — add an API key in Settings → Harness → Qwen and install @qwen-code/sdk.',
    qwenDisabled: 'Qwen Code is unavailable. Add QWEN_API_KEY in Settings → Harness → Qwen, install @qwen-code/sdk, then refresh.',
    qwenSdkMissing: 'Optional package @qwen-code/sdk is not installed.',
    qwenStatusFailed: 'Failed to check Qwen Code status.',
  },
  lanSettings: {
    qwenKeyFromEnv: 'Active key: QWEN_API_KEY env variable (overrides settings file).',
    qwenKeyStored: 'Active key: stored in server settings (value is not shown).',
    qwenKeyMissing: 'No active key — paste your Qwen Cloud key below or set QWEN_API_KEY when starting Node.',
  },
  usage: {
    harnessQwen: 'Qwen',
  },
};
