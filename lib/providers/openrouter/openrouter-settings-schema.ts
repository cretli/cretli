/**
 * Declarative description of the OpenRouter client fields of GET/PATCH /api/settings
 * (API key, site URL, app title) and of their Settings key row. Core, not part of
 * the chat plugin: the key feeds chat titles, model-pick and the cost proxy, so it
 * stays editable when the plugin is disabled. Pure data (no server imports) so the
 * front end can import it; `openrouter-settings.ts` re-exports it next to the field logic.
 */

import type { HarnessSettingsSchema } from '../../agent-harness/harness-settings-patch.ts';

export const settingsSchema: HarnessSettingsSchema = {
  harness: 'openrouter',
  fields: [
    {
      name: 'openrouterApiKey',
      kind: 'secret',
      get: false,
      clearFlag: 'clearOpenrouterApiKey'
    },
    {
      name: 'openrouterSiteUrl',
      kind: 'string',
      get: false
    },
    {
      name: 'openrouterAppTitle',
      kind: 'string',
      get: false
    }
  ],
  readOnly: [
    'openrouterApiKeyEffective',
    'openrouterApiKeyInvalidFormat',
    'openrouterApiKeyFromEnv',
    'openrouterApiKeyStoredInSettings'
  ],
  ui: {
    keyChangedEvent: null,
    groups: [
      {
        group: 'openrouter',
        id: 'openrouter-api-key-source-hint',
        rules: [
          {
            when: [
              'openrouterApiKeyFromEnv'
            ],
            key: 'lanSettings.openrouterKeyFromEnv'
          },
          {
            when: [
              'openrouterApiKeyInvalidFormat'
            ],
            key: 'lanSettings.openrouterKeyInvalidFormat'
          },
          {
            when: [
              'openrouterApiKeyStoredInSettings',
              'openrouterApiKeyEffective'
            ],
            key: 'lanSettings.openrouterKeyStored'
          }
        ],
        fallbackKey: 'lanSettings.openrouterKeyMissing'
      }
    ],
    secrets: [
      {
        prefix: 'openrouter-api-key',
        field: 'openrouterApiKey',
        clearFlag: 'clearOpenrouterApiKey',
        group: 'openrouter'
      }
    ],
    texts: [],
    selects: []
  }
};
