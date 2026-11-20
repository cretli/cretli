/**
 * English UI strings specific to the MiMo harness. Merged into the dictionary by
 * app_front/i18n/en.js, so a harness ships its own translations
 * (docs/ts-migration-and-core-harnesses-plan.md, B2).
 */

export const mimoEn = {
  settings: {
    harnessMimo: 'MiMo',
    harnessMimoApiTitle: 'Xiaomi MiMo API',
    harnessMimoIndependentHint: 'These credentials are separate from the OpenCode custom provider.',
    harnessMimoApiKey: 'MiMo API key',
    harnessMimoBaseUrl: 'MiMo API base URL',
    harnessMimoBaseUrlHint: 'Defaults to https://api.xiaomimimo.com/v1 — change it only for a proxy or a private gateway.',
    harnessMimoModelsTitle: 'MiMo — chat models',
    harnessMimoModelsHint: 'Choose which MiMo models appear in the chat model picker.',
    harnessMimoModelsEmpty: 'No MiMo models are available. Check the API key.',
    harnessMimoNotReadyNoKey: 'No MiMo API key. Configure it in Harness → MiMo.',
    harnessMimoReady: 'MiMo API is ready.',
    harnessStatusMimoMissing: 'MiMo API key is not configured',
  },
  firstRun: {
    hintMimo: 'MiMo API key from platform.xiaomimimo.com (OpenAI-compatible REST API, no extra SDK needed).',
  },
  chat: {
    mimoDisabled: 'MiMo is unavailable. Check the API key in Settings → Harness → MiMo.',
    harnessErrorMimo: 'MiMo is not ready — configure its API key in Settings → Harness → MiMo.',
    mimoStatusFailed: 'Failed to check MiMo status.',
  },
  usage: {
    harnessMimo: 'MiMo',
  },
};
