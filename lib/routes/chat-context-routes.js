import { resolveCursorContextScope } from '../context/context-scope.ts';
import { loadChats } from '../persist/chats-persist.js';
import { listContextSendManifests } from '../persist/context-send-manifests-persist.js';
import { previewNextSend } from '../context/context-send-manifest.ts';

/**
 * Read-only "context of this chat" API. Scope always comes from the
 * authorized chat (or widget session); a client path can only narrow it, see
 * `resolveCursorContextScope`. Responses carry ids, relative paths, hashes and
 * sizes only: no prompt text, block text, absolute paths or foreign-project data.
 *
 * @typedef {Object} ChatContextRoutesContext
 * @property {() => string} getCurrentCwd
 */

/**
 * @param {Record<string, any>} manifest
 * @returns {Record<string, any>}
 */
function summarizeManifest(manifest) {
  if (manifest.kind === 'steer') {
    return {
      sendId: manifest.sendId,
      kind: 'steer',
      recordedAt: manifest.recordedAt,
      transport: manifest.transport,
      textLength: manifest.textLength,
      deliveryStatus: manifest.delivery?.status ?? null,
    };
  }
  return {
    kind: 'send',
    sendId: manifest.sendId,
    recordedAt: manifest.recordedAt,
    adapter: manifest.adapter,
    mode: manifest.mode,
    revision: manifest.revision,
    payloadLength: manifest.payloadLength,
    counts: manifest.counts,
    matchesAssembler: manifest.delivery?.matchesAssembler ?? null,
    changedSincePreview: manifest.preview?.changedSincePreview ?? null,
  };
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {ChatContextRoutesContext} ctx
 * @returns {{ scope: any, chat: any } | null}
 */
function authorize(req, res, ctx) {
  if (!String(req.query?.chatId || '').trim()) {
    res.status(400).json({ ok: false, code: 'chat_required', error: 'chatId is required' });
    return null;
  }
  const scope = /** @type {any} */ (resolveCursorContextScope(req, { getCurrentCwd: ctx.getCurrentCwd }));
  if (!scope.ok) {
    res.status(scope.status).json({ ok: false, code: scope.code, error: scope.error });
    return null;
  }
  const chat = (loadChats() || []).find((row) => String(row?.id || '') === scope.chatId) || null;
  return { scope, chat };
}

/**
 * @param {import('express').Express} app
 * @param {ChatContextRoutesContext} ctx
 */
export function registerChatContextRoutes(app, ctx) {
  app.get('/api/chat-context/snapshot', (req, res) => {
    try {
      const auth = authorize(req, res, ctx);
      if (!auth) return undefined;
      const all = listContextSendManifests(auth.scope.chatId);
      // The panel shows the last real send; raw steers are listed in the history only.
      const sends = all.filter((row) => row?.kind !== 'steer');
      return res.json({
        ok: true,
        persistenceScope: 'local',
        chatId: auth.scope.chatId,
        latest: sends.length ? sends[sends.length - 1] : null,
        history: all.slice().reverse().map(summarizeManifest),
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/chat-context/preview', (req, res) => {
    try {
      const auth = authorize(req, res, ctx);
      if (!auth) return undefined;
      const { scope, chat } = auth;
      const adapterId = String(chat?.agentTransport || 'sdk') === 'sdk' ? 'sdk' : 'harness';
      const mode = String(req.query?.mode || chat?.sdkMode || '');
      const preview = previewNextSend({
        cwd: scope.workspaceDir,
        projectRoot: scope.projectRoot,
        audience: scope.audience,
        chatId: scope.chatId,
        mode,
        transport: String(chat?.agentTransport || 'sdk'),
        prompt: '',
      }, adapterId, { chatId: scope.chatId });
      return res.json({ ok: true, persistenceScope: 'local', chatId: scope.chatId, preview });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });
}
