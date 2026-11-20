/** Test-only light entry: a backend with no runtime imports. */
export default {
  backend: {
    id: 'defaultopt',
    enabledModelsKey: 'defaultoptChatEnabledModels',
    credentialsReadySync: () => true,
    settings: null,
    offlineCatalog: null,
    status: async () => ({ available: true, configured: true }),
    refreshModels: null,
    refreshIsNetworkInference: false,
  },
};
