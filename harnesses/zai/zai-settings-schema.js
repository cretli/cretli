/**
 * Declarative description of the Z.AI SDK fields of GET/PATCH /api/settings and of
 * their Settings screen. Pure data (no server imports) so the front end can
 * import it; `zai-settings.js` re-exports it next to the field logic.
 */

/** @type {import('../../lib/agent-harness/harness-settings-patch.ts').HarnessSettingsSchema} */
export const settingsSchema = {
  harness: 'zai',
  fields: [
    {
      name: 'zaiApiKey',
      kind: 'secret',
      get: false,
      clearFlag: 'clearZaiApiKey'
    },
    {
      name: 'zaiProvider',
      kind: 'enum',
      values: [
        'zai-coding-plan',
        'zai'
      ]
    },
    {
      name: 'zaiChatEnabledModels',
      kind: 'models'
    }
  ],
  readOnly: [
    'zaiApiKeyEffective',
    'zaiApiKeyInvalidFormat',
    'zaiApiKeyFromEnv',
    'zaiApiKeyStoredInSettings'
  ],
  ui: {
    keyChangedEvent: null,
    groups: [],
    secrets: [],
    texts: [],
    selects: []
  }
};
