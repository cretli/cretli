/**
 * English UI strings specific to the OpenRouter harness. Merged into the dictionary by
 * app_front/i18n/en.js, so a harness ships its own translations
 * (docs/ts-migration-and-core-harnesses-plan.md, B2).
 */

export const openrouterEn = {
  settings: {
    harnessOpenRouter: 'OpenRouter',
    harnessOpenRouterTitle: 'OpenRouter API',
    harnessOpenRouterHintPrefix: 'Key from',
    harnessOpenRouterHintSuffix: 'Required for OpenRouter harness chats. The OPENROUTER_API_KEY env variable takes precedence.',
    harnessOpenRouterModelsTitle: 'OpenRouter — chat models',
    harnessOpenRouterModelsHint: 'Models from your OpenRouter API key. Check entries that should appear in the chat model picker for OpenRouter harness chats.',
    harnessOpenRouterModelsEmpty: 'No OpenRouter models. Add an API key under Harness → OpenRouter.',
  },
  firstRun: {
    hintOpenRouter: 'Key from openrouter.ai/keys. Easiest path on a phone.',
  },
  chat: {
    contextDetailsTransportOpenrouter: 'OpenRouter',
    harnessErrorOpenrouter: 'OpenRouter chat requires a valid API key (Settings → Harness → OpenRouter). Key must start with sk-or-v1-.',
    openrouterStatusFailed: 'Failed to fetch OpenRouter status — chat creation unavailable.',
    openrouterDisabled: 'OpenRouter is unavailable (missing API key on the server). Settings → OpenRouter, or OPENROUTER_API_KEY, then refresh.',
  },
  lanSettings: {
    openrouterKeyFromEnv: 'Active key: OPENROUTER_API_KEY env variable (overrides settings file).',
    openrouterKeyInvalidFormat: 'Saved key has invalid format — OpenRouter keys must start with sk-or-v1-. Create one at openrouter.ai/keys.',
    openrouterKeyStored: 'Active key: stored in server settings (value is not shown).',
    openrouterKeyMissing: 'No active key — add one below or set OPENROUTER_API_KEY when starting Node.',
  },
  usage: {
    openrouter: 'OpenRouter',
    harnessOpenrouter: 'OpenRouter',
  },
  harnessModelStats: {
    priceSource: {
      openrouter_pricing: 'OpenRouter catalog',
    },
  },
};
