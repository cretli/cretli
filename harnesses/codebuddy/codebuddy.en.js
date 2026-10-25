/**
 * English UI strings specific to the CodeBuddy harness. Merged into the dictionary by
 * app_front/i18n/en.js, so a harness ships its own translations
 * (docs/ts-migration-and-core-harnesses-plan.md, B2).
 */

export const codebuddyEn = {
  settings: {
    harnessCodeBuddy: 'CodeBuddy',
    harnessStatusCodeBuddyMissing: 'Optional package @tencent-ai/agent-sdk or the codebuddy CLI is missing',
    harnessCodeBuddyApiTitle: 'CodeBuddy API',
    harnessCodeBuddyHintPrefix: 'Key from',
    harnessCodeBuddyHintSuffix: 'Required for CodeBuddy harness chats. The CODEBUDDY_API_KEY env variable takes precedence. The codebuddy CLI must also be installed.',
    harnessCodeBuddyApiKeyLabel: 'New API key',
    harnessCodeBuddyApiKeyPlaceholder: 'Paste your CodeBuddy API key and click Save',
    harnessCodeBuddyApiKeySave: 'Save key',
    harnessCodeBuddyApiKeyClear: 'Remove from settings',
    harnessCodeBuddyNotReadyNoKey: 'No CodeBuddy API key — paste a key above or set CODEBUDDY_API_KEY on the server.',
    harnessCodeBuddyNotReady: 'CodeBuddy is not ready. Install the CLI and optional @tencent-ai/agent-sdk, then add an API key.',
    harnessCodeBuddyReady: 'CodeBuddy ready — models come from your Tencent account.',
    harnessCodeBuddyModelsTitle: 'CodeBuddy — chat models',
    harnessCodeBuddyModelsHint: 'Models from your Tencent CodeBuddy account (CLI catalog). Check entries for the chat model picker when harness is CodeBuddy.',
    harnessCodeBuddyModelsEmpty: 'No CodeBuddy models. Add an API key under Harness → CodeBuddy and install the CLI.',
  },
  firstRun: {
    hintCodeBuddy: 'Key from codebuddy.ai/profile/keys. The codebuddy CLI must be installed.',
  },
  chat: {
    contextDetailsTransportCodeBuddy: 'CodeBuddy',
    harnessErrorCodeBuddy: 'CodeBuddy is not ready — add an API key in Settings → Harness → CodeBuddy, install the codebuddy CLI, and optional @tencent-ai/agent-sdk.',
    codebuddyDisabled: 'CodeBuddy is unavailable. Add CODEBUDDY_API_KEY in Settings → Harness → CodeBuddy, install the CLI, then refresh.',
    codebuddySdkMissing: 'Optional package @tencent-ai/agent-sdk is not installed.',
    codebuddyCliMissing: 'CodeBuddy CLI not found. Install `codebuddy` or set CODEBUDDY_CODE_PATH.',
    codebuddyStatusFailed: 'Failed to check CodeBuddy status.',
  },
  lanSettings: {
    codebuddyKeyFromEnv: 'Active key: CODEBUDDY_API_KEY env variable (overrides settings file).',
    codebuddyKeyStored: 'Active key: stored in server settings (value is not shown).',
    codebuddyKeyMissing: 'No active key — paste your CodeBuddy key below or set CODEBUDDY_API_KEY when starting Node.',
  },
  usage: {
    harnessCodebuddy: 'CodeBuddy',
  },
};
