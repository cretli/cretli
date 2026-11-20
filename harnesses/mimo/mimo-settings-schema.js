/**
 * Declarative description of the MiMo fields of GET/PATCH /api/settings and of
 * their Settings screen. Pure data (no server imports) so the front end can
 * import it; `mimo-settings.js` re-exports it next to the field logic.
 */

/** @type {import('../../lib/agent-harness/harness-settings-patch.ts').HarnessSettingsSchema} */
export const settingsSchema = {
  harness: 'mimo',
  fields: [
    {
      name: 'mimoApiKey',
      kind: 'secret',
      get: false,
      clearFlag: 'clearMimoApiKey'
    },
    {
      name: 'mimoBaseUrl',
      kind: 'string'
    },
    {
      name: 'mimoChatEnabledModels',
      kind: 'models'
    }
  ],
  readOnly: [
    'mimoApiKeyEffective',
    'mimoApiKeyFromEnv',
    'mimoApiKeyStoredInSettings',
    'mimoBaseUrlEffective',
    'mimoBaseUrlFromEnv',
    'mimoBaseUrlStoredInSettings'
  ],
  ui: {
    keyChangedEvent: null,
    groups: [],
    secrets: [],
    texts: [],
    selects: []
  }
};
