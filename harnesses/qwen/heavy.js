/**
 * Heavy entry of the Qwen plugin: the chat runtime provider spec. The loader
 * wraps it with `defineBuiltinProvider` (origin builtin-optional).
 */

import {
  handleQwenAgentWebSocket,
  disposeQwenRoom,
  getQwenRoomDiag,
  syncQwenRoomModelFromChat,
} from './qwen-agent-ws.js';
import { registerQwenRoutes } from './qwen-routes.js';
import { getEffectiveQwenApiKey } from './qwen-api-key.js';
import { isQwenSdkAvailable } from './qwen-sdk.js';

export default {
  provider: {
    handler: handleQwenAgentWebSocket,
    handlerLabel: 'Qwen agent handler',
    registerRoutes: (/** @type {any} */ app) => registerQwenRoutes(app),
    room: { getDiag: getQwenRoomDiag, dispose: disposeQwenRoom, syncModel: syncQwenRoomModelFromChat },
    checkCreateReady: async () => {
      if (!getEffectiveQwenApiKey()) {
        return 'Qwen chat requires an API key: set QWEN_API_KEY or save it in Settings → Harness → Qwen.';
      }
      if (!(await isQwenSdkAvailable())) {
        return 'Qwen Code SDK is not installed. Run npm install @qwen-code/sdk.';
      }
      return null;
    },
    chatTitlePrefix: 'Qwen',
    historyStatusTail: true,
  },
};
