/**
 * Declarative description of the DeepSeek fields of GET/PATCH /api/settings and of
 * their Settings screen. Pure data (no server imports) so the front end can
 * import it; `deepseek-settings.js` re-exports it next to the field logic.
 */

/** @type {import('../../lib/agent-harness/harness-settings-patch.ts').HarnessSettingsSchema} */
export const settingsSchema = {
  harness: 'deepseek',
  fields: [
    {
      name: 'deepseekApiKey',
      kind: 'secret',
      get: false,
      clearFlag: 'clearDeepSeekApiKey'
    },
    {
      name: 'deepseekBin',
      kind: 'string'
    },
    {
      name: 'deepseekChatEnabledModels',
      kind: 'models'
    }
  ],
  readOnly: [
    'deepseekApiKeyEffective',
    'deepseekApiKeyFromEnv',
    'deepseekApiKeyStoredInSettings'
  ],
  ui: {
    keyChangedEvent: 'cretli-deepseek-key-changed',
    groups: [
      {
        group: 'deepseek',
        id: 'deepseek-api-key-source-hint',
        rules: [
          {
            when: [
              'deepseekApiKeyFromEnv'
            ],
            key: 'lanSettings.deepseekKeyFromEnv'
          },
          {
            when: [
              'deepseekApiKeyStoredInSettings',
              'deepseekApiKeyEffective'
            ],
            key: 'lanSettings.deepseekKeyStored'
          }
        ],
        fallbackKey: 'lanSettings.deepseekKeyMissing'
      }
    ],
    secrets: [
      {
        prefix: 'deepseek-api-key',
        field: 'deepseekApiKey',
        clearFlag: 'clearDeepSeekApiKey',
        group: 'deepseek'
      }
    ],
    texts: [],
    selects: []
  }
};
