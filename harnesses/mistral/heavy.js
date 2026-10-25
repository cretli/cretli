/**
 * Heavy entry of the Mistral plugin: the chat runtime provider spec. The loader
 * wraps it with `defineBuiltinProvider` (origin builtin-optional).
 */

import {
  handleMistralAgentWebSocket,
  disposeMistralRoom,
  getMistralRoomDiag,
  syncMistralRoomModelFromChat,
} from './mistral-agent-ws.js';
import { registerMistralRoutes } from './mistral-routes.js';
import { getEffectiveMistralApiKey } from './mistral-api-key.js';
import { isMistralSdkAvailable } from './mistral-sdk.js';

export default {
  provider: {
    handler: handleMistralAgentWebSocket,
    handlerLabel: 'Mistral agent handler',
    registerRoutes: (/** @type {any} */ app) => registerMistralRoutes(app),
    room: { getDiag: getMistralRoomDiag, dispose: disposeMistralRoom, syncModel: syncMistralRoomModelFromChat },
    checkCreateReady: async () => {
      if (!getEffectiveMistralApiKey()) {
        return 'Mistral chat requires an API key: set MISTRAL_API_KEY or save it in Settings → Harness → Mistral.';
      }
      if (!(await isMistralSdkAvailable())) {
        return 'Mistral SDK is not installed. Run npm install @mistralai/mistralai.';
      }
      return null;
    },
    chatTitlePrefix: 'Mistral',
    historyStatusTail: true,
  },
};
