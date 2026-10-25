/**
 * Declarative description of the CodeBuddy fields of GET/PATCH /api/settings and of
 * their Settings screen. Pure data (no server imports) so the front end can
 * import it; `codebuddy-settings.js` re-exports it next to the field logic.
 */

/** @type {import('../../lib/agent-harness/harness-settings-patch.ts').HarnessSettingsSchema} */
export const settingsSchema = {
  harness: 'codebuddy',
  fields: [
    {
      name: 'codebuddyApiKey',
      kind: 'secret',
      get: false,
      clearFlag: 'clearCodeBuddyApiKey'
    },
    {
      name: 'codebuddyBin',
      kind: 'string'
    },
    {
      name: 'codebuddyChatEnabledModels',
      kind: 'models'
    }
  ],
  readOnly: [
    'codebuddyApiKeyEffective',
    'codebuddyApiKeyFromEnv',
    'codebuddyApiKeyStoredInSettings'
  ],
  ui: {
    keyChangedEvent: 'cretli-codebuddy-key-changed',
    groups: [
      {
        group: 'codebuddy',
        id: 'codebuddy-api-key-source-hint',
        rules: [
          {
            when: [
              'codebuddyApiKeyFromEnv'
            ],
            key: 'lanSettings.codebuddyKeyFromEnv'
          },
          {
            when: [
              'codebuddyApiKeyStoredInSettings',
              'codebuddyApiKeyEffective'
            ],
            key: 'lanSettings.codebuddyKeyStored'
          }
        ],
        fallbackKey: 'lanSettings.codebuddyKeyMissing'
      }
    ],
    secrets: [
      {
        prefix: 'codebuddy-api-key',
        field: 'codebuddyApiKey',
        clearFlag: 'clearCodeBuddyApiKey',
        group: 'codebuddy'
      }
    ],
    texts: [],
    selects: []
  }
};
