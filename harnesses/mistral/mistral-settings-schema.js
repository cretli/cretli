/**
 * Declarative description of the Mistral fields of GET/PATCH /api/settings and of
 * their Settings screen. Pure data (no server imports) so the front end can
 * import it; `mistral-settings.js` re-exports it next to the field logic.
 */

/** @type {import('../../lib/agent-harness/harness-settings-patch.ts').HarnessSettingsSchema} */
export const settingsSchema = {
  harness: 'mistral',
  fields: [
    {
      name: 'mistralApiKey',
      kind: 'secret',
      get: false,
      clearFlag: 'clearMistralApiKey'
    },
    {
      name: 'mistralVibeApiKey',
      kind: 'secret',
      get: false,
      clearFlag: 'clearMistralVibeApiKey'
    },
    {
      name: 'mistralBillingMode',
      kind: 'enum',
      values: [
        'auto',
        'vibe_code',
        'api'
      ]
    },
    {
      name: 'mistralBaseUrl',
      kind: 'string'
    },
    {
      name: 'mistralChatEnabledModels',
      kind: 'models'
    }
  ],
  readOnly: [
    'mistralApiKeyEffective',
    'mistralApiKeyInvalidFormat',
    'mistralApiKeyFromEnv',
    'mistralApiKeyStoredInSettings',
    'mistralVibeApiKeyFromEnv',
    'mistralVibeApiKeyStoredInSettings',
    'mistralVibeApiKeySelected',
    'mistralStudioApiKeySelected'
  ],
  ui: {
    keyChangedEvent: 'cretli-mistral-key-changed',
    groups: [
      {
        group: 'mistral',
        id: 'mistral-api-key-source-hint',
        rules: [
          {
            when: [
              'mistralVibeApiKeySelected',
              'mistralVibeApiKeyFromEnv'
            ],
            key: 'lanSettings.mistralVibeKeyFromEnv'
          },
          {
            when: [
              'mistralVibeApiKeySelected',
              'mistralVibeApiKeyStoredInSettings',
              'mistralApiKeyEffective'
            ],
            key: 'lanSettings.mistralVibeKeyStored'
          },
          {
            when: [
              'mistralStudioApiKeySelected',
              'mistralApiKeyFromEnv'
            ],
            key: 'lanSettings.mistralKeyFromEnv'
          },
          {
            when: [
              'mistralStudioApiKeySelected',
              'mistralApiKeyStoredInSettings',
              'mistralApiKeyEffective'
            ],
            key: 'lanSettings.mistralKeyStored'
          }
        ],
        fallbackKey: 'lanSettings.mistralKeyMissing'
      }
    ],
    secrets: [
      {
        prefix: 'mistral-vibe-key',
        field: 'mistralVibeApiKey',
        clearFlag: 'clearMistralVibeApiKey',
        group: 'mistral'
      },
      {
        prefix: 'mistral-api-key',
        field: 'mistralApiKey',
        clearFlag: 'clearMistralApiKey',
        group: 'mistral'
      }
    ],
    texts: [],
    selects: [
      {
        id: 'mistral-billing-mode',
        field: 'mistralBillingMode',
        options: [
          {
            value: 'auto',
            labelKey: 'settings.harnessMistralBillingAuto'
          },
          {
            value: 'vibe_code',
            labelKey: 'settings.harnessMistralBillingVibe'
          },
          {
            value: 'api',
            labelKey: 'settings.harnessMistralBillingApi'
          }
        ],
        fallback: 'auto',
        statusId: null,
        group: 'mistral',
        event: 'change'
      }
    ]
  }
};
