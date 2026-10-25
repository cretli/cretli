/**
 * English UI strings specific to the Z.AI SDK harness. Merged into the dictionary by
 * app_front/i18n/en.js, so a harness ships its own translations
 * (docs/ts-migration-and-core-harnesses-plan.md, B2).
 */

export const zaiEn = {
  settings: {
    harnessZai: 'Z.AI SDK',
    harnessZaiApiTitle: 'Official Z.AI SDK',
    harnessZaiIndependentHint: 'These credentials and provider settings are separate from OpenCode.',
    harnessZaiProvider: 'Provider / plan',
    harnessZaiApiKey: 'Z.AI API key',
    harnessZaiProviderSaving: 'Saving provider…',
    harnessZaiInstallSdk: 'Install official Python SDK',
    harnessZaiSdkRestartHint: 'Restart the server after installation if the SDK status does not update.',
    harnessZaiModelsTitle: 'Z.AI — chat models',
    harnessZaiModelsHint: 'Choose which Z.AI models appear in the chat model picker.',
    harnessZaiModelsEmpty: 'No Z.AI models are available. Check the API key and SDK installation.',
    harnessZaiNotReadyNoKey: 'No Z.AI SDK API key. Configure it in Harness → Z.AI.',
    harnessZaiNotReady: 'Z.AI SDK is not ready. Check the SDK installation and API key.',
    harnessZaiReady: 'Z.AI SDK is ready.',
    harnessZaiInstallingSdk: 'Installing the official SDK…',
    harnessZaiSdkInstalled: 'SDK installed and available.',
    harnessZaiInstallFailed: 'Could not install the Z.AI SDK.',
    harnessStatusZaiMissing: 'The official zai-sdk Python package is missing',
  },
  firstRun: {
    hintZai: 'Z.AI API key from Z.AI Platform. The official Python SDK must be installed with npm run setup:zai-sdk.',
  },
  chat: {
    harnessErrorZai: 'Z.AI SDK is not ready — configure its API key in Settings → Harness → Z.AI and install the SDK with npm run setup:zai-sdk.',
    zaiSdkMissing: 'The official Z.ai Python SDK is missing. Run npm run setup:zai-sdk on the server.',
    zaiDisabled: 'Z.AI is unavailable. Check the API key and official SDK setup in Settings.',
    zaiStatusFailed: 'Failed to check Z.AI SDK status.',
  },
  usage: {
    harnessZai: 'Z.AI SDK',
  },
};
