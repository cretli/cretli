/**
 * Heavy entry of the MiMo plugin: the chat runtime provider spec. The loader
 * wraps it with `defineBuiltinProvider` (origin builtin-optional).
 */

import {
  handleMimoAgentWebSocket,
  disposeMimoRoom,
  getMimoRoomDiag,
  syncMimoRoomModelFromChat,
} from './mimo-agent-ws.js';
import { registerMimoRoutes } from './mimo-routes.js';
import { getEffectiveMimoApiKey } from './mimo-api-key.js';

export default {
  provider: {
    handler: handleMimoAgentWebSocket,
    handlerLabel: 'MiMo agent handler',
    registerRoutes: (/** @type {any} */ app) => registerMimoRoutes(app),
    room: { getDiag: getMimoRoomDiag, dispose: disposeMimoRoom, syncModel: syncMimoRoomModelFromChat },
    checkCreateReady: async () => {
      if (!getEffectiveMimoApiKey()) {
        return 'MiMo chat requires its API key configured in Settings → Harness → MiMo.';
      }
      return null;
    },
    chatTitlePrefix: 'MiMo',
    historyStatusTail: true,
  },
};
