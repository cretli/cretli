/**
 * Heavy entry of the DeepSeek plugin: the chat runtime provider spec and the
 * daily balance scheduler (a process lifecycle). The loader wraps it with
 * `defineBuiltinProvider` (origin builtin-optional).
 */

import {
  handleDeepSeekAgentWebSocket,
  disposeDeepSeekRoom,
  getDeepSeekRoomDiag,
  syncDeepSeekRoomModelFromChat,
} from './deepseek-agent-ws.js';
import { registerDeepSeekRoutes } from './deepseek-routes.js';
import { getEffectiveDeepSeekApiKey } from './deepseek-api-key.js';
import { startDeepSeekBalanceScheduler } from './deepseek-balance.js';
import { isDeepSeekCliFound } from './deepseek-cli.js';
import { isDeepSeekSdkAvailable } from './deepseek-sdk.js';
import { resolveDataPath } from '../../lib/runtime-paths.js';

/** @type {(() => void) | null} */
let stopBalanceScheduler = null;

export default {
  provider: {
    handler: handleDeepSeekAgentWebSocket,
    handlerLabel: 'DeepSeek agent handler',
    registerRoutes: (/** @type {any} */ app) => registerDeepSeekRoutes(app),
    room: { getDiag: getDeepSeekRoomDiag, dispose: disposeDeepSeekRoom, syncModel: syncDeepSeekRoomModelFromChat },
    checkCreateReady: async () => {
      if (!getEffectiveDeepSeekApiKey()) {
        return 'DeepSeek chat requires an API key: set DEEPSEEK_API_KEY or save it in Settings → Harness → DeepSeek.';
      }
      if (!(await isDeepSeekSdkAvailable())) {
        return 'DeepSeek Harness SDK is not installed. Run npm install @deepseek-ai/dsh-sdk-client @deepseek-ai/dsh.';
      }
      if (!isDeepSeekCliFound()) {
        return 'DeepSeek Harness CLI not found. Install `@deepseek-ai/dsh` or set DSH_BIN.';
      }
      return null;
    },
    chatTitlePrefix: 'DeepSeek',
    historyStatusTail: true,
    // Daily DeepSeek balance reading (one current snapshot, no backfill).
    processLifecycle: {
      id: 'deepseek',
      label: 'DeepSeek',
      async start() {
        stopBalanceScheduler?.();
        stopBalanceScheduler = startDeepSeekBalanceScheduler({ dataDir: resolveDataPath() });
        return null;
      },
      beginStop() {
        stopBalanceScheduler?.();
        stopBalanceScheduler = null;
        return null;
      },
    },
  },
};
