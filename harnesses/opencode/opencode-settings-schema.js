/**
 * Declarative description of the OpenCode fields of GET/PATCH /api/settings and of
 * their Settings screen. Pure data (no server imports) so the front end can
 * import it; `opencode-settings.js` re-exports it next to the field logic.
 */

/** @type {import('../../lib/agent-harness/harness-settings-patch.ts').HarnessSettingsSchema} */
export const settingsSchema = {
  harness: 'opencode',
  fields: [
    {
      name: 'opencodeApiKey',
      kind: 'secret',
      get: false,
      clearFlag: 'clearOpenCodeApiKey'
    },
    {
      name: 'opencodeZaiApiKey',
      kind: 'secret',
      get: false,
      clearFlag: 'clearOpenCodeZaiApiKey'
    },
    {
      name: 'opencodeMimoApiKey',
      kind: 'secret',
      get: false,
      clearFlag: 'clearOpenCodeMimoApiKey'
    },
    {
      name: 'opencodeMimoBaseUrl',
      kind: 'string'
    },
    {
      name: 'opencodeZaiProvider',
      kind: 'enum',
      values: [
        'zai-coding-plan',
        'zai'
      ]
    },
    {
      name: 'opencodeChatEnabledModels',
      kind: 'models'
    },
    {
      name: 'opencodeBin',
      kind: 'string'
    },
    {
      name: 'opencodePortBase',
      kind: 'int'
    },
    {
      name: 'opencodeMaxInstances',
      kind: 'int'
    },
    {
      name: 'opencodeDelegationIdleMs',
      kind: 'int'
    }
  ],
  readOnly: [
    'opencodeApiKeyEffective',
    'opencodeApiKeyInvalidFormat',
    'opencodeApiKeyFromEnv',
    'opencodeApiKeyStoredInSettings',
    'opencodeApiKeyMisfiledInOpenRouter',
    'opencodeCredentialsEffective',
    'opencodeZaiApiKeyEffective',
    'opencodeZaiApiKeyInvalidFormat',
    'opencodeZaiApiKeyFromEnv',
    'opencodeZaiApiKeyStoredInSettings',
    'opencodeMimoApiKeyEffective',
    'opencodeMimoApiKeyFromEnv',
    'opencodeMimoApiKeyStoredInSettings',
    'opencodeMimoBaseUrlEffective',
    'opencodeMimoBaseUrlFromEnv',
    'opencodeMimoBaseUrlStoredInSettings'
  ],
  ui: {
    keyChangedEvent: 'cretli-opencode-key-changed',
    groups: [
      {
        group: 'opencode',
        id: 'opencode-api-key-source-hint',
        rules: [
          {
            when: [
              'opencodeApiKeyFromEnv'
            ],
            key: 'lanSettings.opencodeKeyFromEnv'
          },
          {
            when: [
              'opencodeApiKeyInvalidFormat'
            ],
            key: 'lanSettings.opencodeKeyInvalidFormat'
          },
          {
            when: [
              'opencodeApiKeyMisfiledInOpenRouter'
            ],
            key: 'lanSettings.opencodeKeyMisfiledInOpenRouter'
          },
          {
            when: [
              'opencodeApiKeyStoredInSettings',
              'opencodeApiKeyEffective'
            ],
            key: 'lanSettings.opencodeKeyStored'
          }
        ],
        fallbackKey: 'lanSettings.opencodeKeyMissing'
      },
      {
        group: 'opencode-zai',
        id: 'opencode-zai-api-key-source-hint',
        rules: [
          {
            when: [
              'opencodeZaiApiKeyFromEnv'
            ],
            key: 'lanSettings.opencodeZaiKeyFromEnv'
          },
          {
            when: [
              'opencodeZaiApiKeyInvalidFormat'
            ],
            key: 'lanSettings.opencodeZaiKeyInvalidFormat'
          },
          {
            when: [
              'opencodeZaiApiKeyStoredInSettings',
              'opencodeZaiApiKeyEffective'
            ],
            key: 'lanSettings.opencodeZaiKeyStored'
          }
        ],
        fallbackKey: 'lanSettings.opencodeZaiKeyMissing'
      },
      {
        group: 'opencode-mimo',
        id: 'opencode-mimo-api-key-source-hint',
        rules: [
          {
            when: [
              'opencodeMimoApiKeyFromEnv'
            ],
            key: 'lanSettings.opencodeMimoKeyFromEnv'
          },
          {
            when: [
              'opencodeMimoApiKeyStoredInSettings',
              'opencodeMimoApiKeyEffective'
            ],
            key: 'lanSettings.opencodeMimoKeyStored'
          }
        ],
        fallbackKey: 'lanSettings.opencodeMimoKeyMissing'
      }
    ],
    secrets: [
      {
        prefix: 'opencode-api-key',
        field: 'opencodeApiKey',
        clearFlag: 'clearOpenCodeApiKey',
        group: 'opencode'
      },
      {
        prefix: 'opencode-zai-api-key',
        field: 'opencodeZaiApiKey',
        clearFlag: 'clearOpenCodeZaiApiKey',
        group: 'opencode-zai'
      },
      {
        prefix: 'opencode-mimo-api-key',
        field: 'opencodeMimoApiKey',
        clearFlag: 'clearOpenCodeMimoApiKey',
        group: 'opencode-mimo'
      }
    ],
    texts: [
      {
        inputId: 'opencode-mimo-base-url-input',
        saveBtnId: 'opencode-mimo-base-url-save-btn',
        statusId: 'opencode-mimo-base-url-save-status',
        field: 'opencodeMimoBaseUrl',
        group: 'opencode-mimo',
        hint: {
          id: 'opencode-mimo-base-url-hint',
          rules: [
            {
              when: [
                'opencodeMimoBaseUrlFromEnv'
              ],
              key: 'lanSettings.opencodeMimoBaseUrlFromEnv'
            },
            {
              when: [
                'opencodeMimoBaseUrlStoredInSettings'
              ],
              key: 'lanSettings.opencodeMimoBaseUrlSetting'
            }
          ],
          fallbackKey: 'lanSettings.opencodeMimoBaseUrlDefault'
        }
      }
    ],
    selects: [
      {
        id: 'opencode-zai-provider-select',
        field: 'opencodeZaiProvider',
        options: [
          {
            value: 'zai-coding-plan',
            labelKey: 'settings.harnessOpenCodeZaiProviderCodingPlan'
          },
          {
            value: 'zai',
            labelKey: 'settings.harnessOpenCodeZaiProviderApi'
          }
        ],
        fallback: 'zai-coding-plan',
        statusId: 'opencode-zai-provider-save-status',
        group: 'opencode-zai',
        event: 'cr-change',
        applyOnlyWhenSet: true,
        relabelOnLangChange: true
      }
    ]
  }
};
