/**
 * Heavy entry of the CodeBuddy plugin: the chat runtime provider spec. The
 * loader wraps it with `defineBuiltinProvider` (origin builtin-optional).
 */

import {
  handleCodeBuddyAgentWebSocket,
  disposeCodeBuddyRoom,
  getCodeBuddyRoomDiag,
  syncCodeBuddyRoomModelFromChat,
} from './codebuddy-agent-ws.js';
import { registerCodeBuddyRoutes } from './codebuddy-routes.js';
import { getEffectiveCodeBuddyApiKey } from './codebuddy-api-key.js';
import { isCodeBuddyCliFound } from './codebuddy-cli.js';
import { isCodeBuddySdkAvailable } from './codebuddy-sdk.js';

export default {
  provider: {
    handler: handleCodeBuddyAgentWebSocket,
    handlerLabel: 'CodeBuddy agent handler',
    registerRoutes: (/** @type {any} */ app) => registerCodeBuddyRoutes(app),
    room: { getDiag: getCodeBuddyRoomDiag, dispose: disposeCodeBuddyRoom, syncModel: syncCodeBuddyRoomModelFromChat },
    checkCreateReady: async () => {
      if (!getEffectiveCodeBuddyApiKey()) {
        return 'CodeBuddy chat requires an API key: set CODEBUDDY_API_KEY or save it in Settings → Harness → CodeBuddy.';
      }
      if (!(await isCodeBuddySdkAvailable())) {
        return 'CodeBuddy SDK is not installed. Run npm install @tencent-ai/agent-sdk.';
      }
      if (!isCodeBuddyCliFound()) {
        return 'CodeBuddy CLI not found. Install `codebuddy` or set CODEBUDDY_CODE_PATH.';
      }
      return null;
    },
    chatTitlePrefix: 'CodeBuddy',
    historyStatusTail: true,
  },
};
