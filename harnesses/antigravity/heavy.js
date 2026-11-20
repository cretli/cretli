import { antigravityLogin, registerAntigravityLoginRoutes } from './antigravity-login.js';
import { handleAntigravityAgentWebSocket, disposeAntigravityRoom, getAntigravityRoomDiag, syncAntigravityRoomModelFromChat } from './antigravity-agent-ws.js';
import { isAntigravityCliFound, fallbackCatalog, listAntigravityModels } from './antigravity-config.js';
import { loadSettings } from '../../lib/persist/settings.js';

export default {
  provider: {
    handler: handleAntigravityAgentWebSocket, handlerLabel: 'Antigravity agent handler',
    room: { dispose: disposeAntigravityRoom, getDiag: getAntigravityRoomDiag, syncModel: syncAntigravityRoomModelFromChat },
    checkCreateReady: async () => isAntigravityCliFound() ? null : 'Install Antigravity CLI (agy), then sign in in Settings → Harness → Antigravity. Configure ANTIGRAVITY_BIN if needed.',
    chatTitlePrefix: 'Antigravity', historyStatusTail: true,
    processLifecycle: { id: 'antigravity', label: 'Antigravity login', beginStop: () => antigravityLogin.cancel(antigravityLogin.state().attemptId) },
    registerRoutes(app) {
      registerAntigravityLoginRoutes(app);
      app.get('/api/antigravity/status', (_req, res) => {
        const cliFound = isAntigravityCliFound();
        res.json({ ok: true, ready: cliFound, cliFound, authentication: 'checked_on_session_start' });
      });
      app.get('/api/antigravity/models', async (_req, res) => {
        try {
          res.json({ ok: true, ...await listAntigravityModels(), chatEnabledModels: loadSettings().antigravityChatEnabledModels || [] });
        } catch {
          const catalog = fallbackCatalog();
          res.json({ ok: true, models: catalog.map((row) => ({ id: row.value, name: row.label })), catalog, modelsSource: 'fallback', chatEnabledModels: loadSettings().antigravityChatEnabledModels || [] });
        }
      });
    },
  },
};
