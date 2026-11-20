/**
 * English UI strings specific to the Mistral harness. Merged into the dictionary by
 * app_front/i18n/en.js, so a harness ships its own translations
 * (docs/ts-migration-and-core-harnesses-plan.md, B2).
 */

export const mistralEn = {
  settings: {
    harnessMistral: 'Mistral',
    harnessStatusMistralMissing: 'The @mistralai/mistralai package is missing',
    harnessMistralApiTitle: 'Mistral Vibe Code',
    harnessMistralHintPrefix: 'Create a Vibe key in',
    harnessMistralHintSuffix: 'Store both keys and choose which one new chats use. Vibe CLI plan keys count against Vibe Code; Studio keys count against API usage. The @mistralai/mistralai package must also be installed.',
    harnessMistralApiKeyLabel: 'Studio API key',
    harnessMistralApiKeyPlaceholder: 'Paste your Studio API key and click Save',
    harnessMistralVibeKeyLabel: 'Vibe Code key',
    harnessMistralVibeKeyPlaceholder: 'Paste your Vibe Code key and click Save',
    harnessMistralBillingModeLabel: 'Key used by new chats',
    harnessMistralBillingAuto: 'Vibe Code when available',
    harnessMistralBillingVibe: 'Vibe Code allowance',
    harnessMistralBillingApi: 'Studio API allowance',
    harnessMistralApiKeySave: 'Save key',
    harnessMistralApiKeyClear: 'Remove from settings',
    harnessMistralNotReadyNoKey: 'No Mistral key — paste a Vibe Code key above or set MISTRAL_VIBE_API_KEY on the server.',
    harnessMistralNotReady: 'Mistral is not ready. Install @mistralai/mistralai, then add an API key.',
    harnessMistralReady: 'Mistral ready — live model catalog.',
    harnessMistralModelsTitle: 'Mistral — chat models',
    harnessMistralModelsHint: 'Models from the Mistral API when a key is set (fallback: a built-in list). Check entries for the chat picker.',
    harnessMistralModelsEmpty: 'No Mistral models. Add an API key under Harness → Mistral and install @mistralai/mistralai.',
  },
  firstRun: {
    hintMistral: 'Key from console.mistral.ai/api-keys. Install the @mistralai/mistralai package.',
  },
  chat: {
    contextDetailsTransportMistral: 'Mistral',
    harnessErrorMistral: 'Mistral is not ready — add an API key in Settings → Harness → Mistral and install @mistralai/mistralai.',
    mistralDisabled: 'Mistral is unavailable. Add MISTRAL_API_KEY in Settings → Harness → Mistral, install @mistralai/mistralai, then refresh.',
    mistralSdkMissing: 'The @mistralai/mistralai package is not installed.',
    mistralStatusFailed: 'Failed to check Mistral status.',
    mistralAuthError: 'Mistral rejected the API key. Check it in Settings → Harness → Mistral.',
    mistralRateLimitError: 'Mistral rate limit reached. Wait a moment and try again.',
  },
  lanSettings: {
    mistralKeyFromEnv: 'Active key: MISTRAL_API_KEY env variable (overrides settings file).',
    mistralKeyStored: 'Active key: stored in server settings (value is not shown).',
    mistralKeyMissing: 'No active key — paste your Mistral key below or set MISTRAL_API_KEY when starting Node.',
    mistralVibeKeyFromEnv: 'Active key: MISTRAL_VIBE_API_KEY (Vibe Code allowance).',
    mistralVibeKeyStored: 'Active key: Vibe Code key stored in server settings (value is not shown).',
  },
  usage: {
    harnessMistral: 'Mistral',
  },
  harnessVersion: {
    installMistral: 'Install Mistral',
  },
};
