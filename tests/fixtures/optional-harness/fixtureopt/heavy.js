/** Test-only heavy entry: provider spec. */
export default {
  provider: {
    capabilities: { chat: true },
    handler: () => 'fixture-handled',
    registerRoutes: () => {},
    room: { getDiag: () => null, dispose: () => null, syncModel: null },
    checkCreateReady: async () => null,
  },
};
