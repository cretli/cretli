/** Test-only light entry: backend + MCP adapter, no runtime imports. */
export default {
  backend: {
    id: 'fixtureopt',
    enabledModelsKey: 'fixtureoptChatEnabledModels',
    credentialsReadySync: () => true,
    settings: null,
    offlineCatalog: null,
    status: async () => ({ available: true, configured: true }),
    refreshModels: null,
    refreshIsNetworkInference: false,
  },
  mcpAdapter: {
    harness: 'fixtureopt',
    transports: ['fixtureopt'],
    liveUpdate: false,
    callControl: 'bridge',
    unsupportedFeature: '',
  },
};
