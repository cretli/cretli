/**
 * Heavy entry of the OpenRouter chat plugin: the chat runtime provider spec. The
 * loader wraps it with `defineBuiltinProvider` (origin builtin-optional).
 */

import {
  handleOpenRouterAgentWebSocket,
  disposeOpenRouterRoom,
  getOpenRouterRoomDiag,
} from './openrouter-agent-ws.js';
import { registerOpenRouterRoutes } from './openrouter-routes.js';
import { getEffectiveOpenRouterApiKey } from '../../lib/providers/openrouter/openrouter-api-key.ts';

export default {
  provider: {
    handler: handleOpenRouterAgentWebSocket,
    handlerLabel: 'OpenRouter agent handler',
    registerRoutes: (/** @type {any} */ app) => registerOpenRouterRoutes(app),
    room: { getDiag: getOpenRouterRoomDiag, dispose: disposeOpenRouterRoom, syncModel: null },
    checkCreateReady: async () => {
      if (!getEffectiveOpenRouterApiKey()) {
        return 'OpenRouter chat requires an API key: set OPENROUTER_API_KEY or save it in Settings.';
      }
      return null;
    },
    chatTitlePrefix: 'OpenRouter',
    historyStatusTail: false,
  },
};
