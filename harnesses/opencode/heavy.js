/**
 * Heavy entry of the OpenCode plugin: the chat runtime provider spec. The loader
 * wraps it with `defineBuiltinProvider` (origin builtin-optional) and attaches the
 * `processLifecycle` hook from lifecycle.js.
 */

import {
  handleOpenCodeAgentWebSocket,
  disposeOpenCodeRoom,
  getOpenCodeRoomDiag,
  syncOpenCodeRoomModelFromChat,
} from './opencode-agent-ws.js';
import { registerOpenCodeRoutes } from './opencode-routes.js';
import { hasOpenCodeCredentials } from './opencode-api-key.js';
import { disposeAllOpenCodeInstances, getOpenCodeHealth } from './opencode-server-manager.js';

export default {
  provider: {
    handler: handleOpenCodeAgentWebSocket,
    handlerLabel: 'OpenCode agent handler',
    registerRoutes: (/** @type {any} */ app, /** @type {any} */ ctx) => registerOpenCodeRoutes(app, { workspaceDirForAgent: ctx.workspaceDirForAgent }),
    room: { getDiag: getOpenCodeRoomDiag, dispose: disposeOpenCodeRoom, syncModel: syncOpenCodeRoomModelFromChat },
    checkCreateReady: async (/** @type {any} */ ctx) => {
      if (!hasOpenCodeCredentials()) {
        return 'OpenCode chat requires an API key: set OPENCODE_API_KEY, ZAI_API_KEY / ZAI_CODING_API_KEY, or save a Zen or Z.AI key in Settings → Harness → OpenCode.';
      }
      const health = await getOpenCodeHealth(ctx.resolveWorkspaceFolder());
      if (!health.opencodeReady) {
        return health.error
          || 'OpenCode is not ready — install opencode and configure a Zen or Z.AI API key in Settings.';
      }
      return null;
    },
    chatTitlePrefix: 'OpenCode',
    resetRuntime: disposeAllOpenCodeInstances,
    historyStatusTail: false,
  },
};
