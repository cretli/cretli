/**
 * Heavy entry of the Z.AI SDK plugin: the chat runtime provider spec. The loader
 * wraps it with `defineBuiltinProvider` (origin builtin-optional).
 */

import {
  handleZaiAgentWebSocket,
  disposeZaiRoom,
  getZaiRoomDiag,
  syncZaiRoomModelFromChat,
} from './zai-agent-ws.js';
import { registerZaiRoutes } from './zai-routes.js';
import { getEffectiveZaiSdkApiKey } from './zai-api-key.js';
import { isZaiSdkAvailable } from './zai-sdk-runtime.js';

export default {
  provider: {
    handler: handleZaiAgentWebSocket,
    handlerLabel: 'Z.AI SDK agent handler',
    registerRoutes: (/** @type {any} */ app) => registerZaiRoutes(app),
    room: { getDiag: getZaiRoomDiag, dispose: disposeZaiRoom, syncModel: syncZaiRoomModelFromChat },
    checkCreateReady: async () => {
      if (!getEffectiveZaiSdkApiKey()) {
        return 'Z.AI SDK chat requires its API key configured in Settings → Harness → Z.AI.';
      }
      if (!isZaiSdkAvailable()) {
        return 'Z.AI SDK harness requires Python and the official zai-sdk package. Run npm run setup:zai-sdk.';
      }
      return null;
    },
    chatTitlePrefix: 'Z.AI SDK',
    historyStatusTail: true,
  },
};
