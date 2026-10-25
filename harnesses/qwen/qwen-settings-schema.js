/**
 * Declarative description of the Qwen fields of GET/PATCH /api/settings and of
 * their Settings screen. Pure data (no server imports) so the front end can
 * import it; `qwen-settings.js` re-exports it next to the field logic.
 */

/** @type {import('../../lib/agent-harness/harness-settings-patch.ts').HarnessSettingsSchema} */
export const settingsSchema = {
  harness: 'qwen',
  fields: [
    {
      name: 'qwenApiKey',
      kind: 'secret',
      get: false,
      clearFlag: 'clearQwenApiKey'
    },
    {
      name: 'qwenBin',
      kind: 'string'
    },
    {
      name: 'qwenBaseUrl',
      kind: 'string'
    },
    {
      name: 'qwenEndpoint',
      kind: 'enum',
      values: [
        'payg',
        'token-plan',
        'coding-plan',
        'custom'
      ]
    },
    {
      name: 'qwenChatEnabledModels',
      kind: 'models'
    }
  ],
  readOnly: [
    'qwenApiKeyEffective',
    'qwenApiKeyFromEnv',
    'qwenApiKeyStoredInSettings',
    'qwenResolvedBaseUrl'
  ],
  ui: {
    keyChangedEvent: 'cretli-qwen-key-changed',
    groups: [
      {
        group: 'qwen',
        id: 'qwen-api-key-source-hint',
        rules: [
          {
            when: [
              'qwenApiKeyFromEnv'
            ],
            key: 'lanSettings.qwenKeyFromEnv'
          },
          {
            when: [
              'qwenApiKeyStoredInSettings',
              'qwenApiKeyEffective'
            ],
            key: 'lanSettings.qwenKeyStored'
          }
        ],
        fallbackKey: 'lanSettings.qwenKeyMissing'
      }
    ],
    secrets: [
      {
        prefix: 'qwen-api-key',
        field: 'qwenApiKey',
        clearFlag: 'clearQwenApiKey',
        group: 'qwen'
      }
    ],
    texts: [
      {
        inputId: 'qwen-base-url-input',
        saveBtnId: 'qwen-base-url-save-btn',
        statusId: 'qwen-base-url-save-status',
        field: 'qwenBaseUrl',
        group: 'qwen'
      }
    ],
    selects: [
      {
        id: 'qwen-endpoint-select',
        field: 'qwenEndpoint',
        options: [
          {
            value: 'payg',
            labelKey: 'settings.harnessQwenEndpointPayg'
          },
          {
            value: 'token-plan',
            labelKey: 'settings.harnessQwenEndpointTokenPlan'
          },
          {
            value: 'coding-plan',
            labelKey: 'settings.harnessQwenEndpointCodingPlan'
          },
          {
            value: 'custom',
            labelKey: 'settings.harnessQwenEndpointCustom'
          }
        ],
        fallback: 'payg',
        statusId: 'qwen-endpoint-save-status',
        group: 'qwen',
        event: 'cr-change'
      }
    ]
  }
};
