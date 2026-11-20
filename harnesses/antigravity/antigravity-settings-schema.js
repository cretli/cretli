/** @type {import('../../lib/agent-harness/harness-settings-patch.ts').HarnessSettingsSchema} */
export const settingsSchema = {
  harness: 'antigravity',
  fields: [
    { name: 'antigravityBin', kind: 'string' },
    { name: 'antigravityChatEnabledModels', kind: 'models' },
  ],
  readOnly: [],
  ui: {
    keyChangedEvent: 'cretli-antigravity-config-changed',
    groups: [], secrets: [], selects: [],
    texts: [{
      inputId: 'antigravity-bin', saveBtnId: 'antigravity-bin-save',
      statusId: 'antigravity-bin-status', field: 'antigravityBin', group: 'antigravity',
    }],
  },
};
