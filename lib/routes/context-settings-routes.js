import { resolveCursorContextScope } from '../context/context-scope.ts';
import { buildContextRegistry } from '../context/registry.ts';
import { ensureCursorShare } from '../sdk/cursor-share.ts';
import { getConfiguredAdditionalCursorContextDirs } from '../sdk/shared-cursor-context.ts';
import {
  AGENTS_MD_MATRIX,
  buildGlobScopeIndex,
  collectAgentsMdChain,
  getAgentsMdDeliveryStatus,
  indexNestedAgentsMd,
  readInstructionsForPath,
  resolveAgentsMdDelivery,
} from '../context/agents-md.ts';
import {
  findChatById,
  patchChatContextSettings,
  patchHostContextSettings,
  resolveContextSettingsForScope,
} from '../context/context-settings-runtime.ts';

/**
 * Context settings and instruction scope API. Scope comes from the authorized
 * chat / widget (`resolveCursorContextScope`); a client path can only narrow it.
 * Responses carry relative paths, ids, hashes and sizes: no absolute host
 * paths except the host-only shared dirs, which widgets never receive.
 *
 * @param {import('express').Express} app
 * @param {{ getCurrentCwd: () => string }} ctx
 */
export function registerContextSettingsRoutes(app, ctx) {
  /** @param {import('express').Request} req @param {import('express').Response} res */
  const authorize = (req, res) => {
    const scope = /** @type {any} */ (resolveCursorContextScope(req, { getCurrentCwd: ctx.getCurrentCwd }));
    if (!scope.ok) {
      res.status(scope.status).json({ ok: false, code: scope.code, error: scope.error });
      return null;
    }
    return scope;
  };

  app.get('/api/context-settings', (req, res) => {
    try {
      const scope = authorize(req, res);
      if (!scope) return undefined;
      const chat = scope.chatId ? findChatById(scope.chatId) : null;
      const resolved = resolveContextSettingsForScope({ projectRoot: scope.projectRoot, chat });
      const transport = String(chat?.agentTransport || chat?.harness || '').trim().toLowerCase();
      const delivery = resolveAgentsMdDelivery({ transport, mode: String(resolved.effective['agentsMd.mode']) });
      const chain = collectAgentsMdChain(scope.projectRoot, scope.workspaceDir);
      const nested = indexNestedAgentsMd(scope.projectRoot, scope.workspaceDir);
      const registry = buildContextRegistry(scope.workspaceDir, {
        projectRoot: scope.projectRoot,
        audience: scope.audience,
        additionalDirs: scope.audience === 'widget' ? [] : getConfiguredAdditionalCursorContextDirs(),
        bundledRoot: ensureCursorShare(),
      });
      const payload = {
        ...resolved,
        // Host-only material is never shown to widgets.
        ...(scope.audience === 'widget' ? { sharedDirs: { values: [], readOnly: true, storedAs: 'additionalCursorContextDirs' }, hostProfiles: [] } : {}),
      };
      return res.json({
        ok: true,
        audience: scope.audience,
        scope: { source: scope.source, chatId: scope.chatId || undefined },
        settings: payload,
        agentsMd: {
          transport,
          matrix: getAgentsMdDeliveryStatus(transport),
          delivery,
          chain: chain.entries.map((e) => ({ id: e.id, relPath: e.relPath, valid: e.valid, sizeBytes: e.sizeBytes, contentHash: e.contentHash })),
          nested: nested.scopes,
          nestedTruncated: nested.truncated,
          warnings: [...chain.warnings, ...(delivery.warning ? [delivery.warning] : [])],
        },
        globs: resolved.effective['globs.index'] === false ? [] : buildGlobScopeIndex(registry),
        globsNote: 'Rules with globs are indexed only. Cretli does not guarantee activation when a harness reads a file; use the explicit path read.',
        matrixKnownHarnesses: Object.keys(AGENTS_MD_MATRIX),
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.patch('/api/context-settings', (req, res) => {
    try {
      const scope = authorize(req, res);
      if (!scope) return undefined;
      if (scope.audience === 'widget') {
        return res.status(403).json({ ok: false, code: 'widget_forbidden', error: 'Widgets cannot change context settings' });
      }
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const level = body.level === 'host' ? 'host' : 'chat';
      let result;
      if (level === 'host') {
        result = patchHostContextSettings({ settings: body.settings, profiles: body.profiles });
      } else {
        if (!scope.chatId || !findChatById(scope.chatId)) {
          return res.status(400).json({ ok: false, code: 'chat_required', error: 'chatId is required for a chat override' });
        }
        result = patchChatContextSettings(scope.chatId, body.settings || {});
      }
      if (!result.ok) return res.status(400).json({ ok: false, code: 'invalid_settings', errors: result.errors });
      const chat = scope.chatId ? findChatById(scope.chatId) : null;
      return res.json({ ok: true, level, settings: resolveContextSettingsForScope({ projectRoot: scope.projectRoot, chat }) });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/context-instructions', (req, res) => {
    try {
      const scope = authorize(req, res);
      if (!scope) return undefined;
      const relPath = String(req.query?.path || '').trim();
      if (!relPath) return res.status(400).json({ ok: false, code: 'path_required', error: 'path is required' });
      const registry = buildContextRegistry(scope.workspaceDir, {
        projectRoot: scope.projectRoot,
        audience: scope.audience,
        additionalDirs: [],
      });
      const result = readInstructionsForPath({ projectRoot: scope.projectRoot, relPath, registry });
      if (!result.ok) return res.status(403).json(result);
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });
}
