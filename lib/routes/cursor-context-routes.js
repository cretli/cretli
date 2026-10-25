import { getCursorContext } from '../sdk/cursor-context.ts';
import { resolveCursorContextScope } from '../context/context-scope.ts';
import { loadValidatedProjectContextConfig } from '../context/project-context-config.ts';

/**
 * @typedef {Object} CursorContextRoutesContext
 * @property {() => string} getCurrentCwd
 */

/**
 * @param {import('express').Express} app
 * @param {CursorContextRoutesContext} ctx
 */
export function registerCursorContextRoutes(app, ctx) {
  app.get('/api/cursor-context', (req, res) => {
    try {
      const scope = /** @type {any} */ (resolveCursorContextScope(req, { getCurrentCwd: ctx.getCurrentCwd }));
      if (!scope.ok) {
        return res.status(scope.status).json({ ok: false, code: scope.code, error: scope.error });
      }
      const projectConfig = /** @type {any} */ (loadValidatedProjectContextConfig(scope.projectRoot));
      if (!projectConfig.ok) {
        return res.status(400).json({ ok: false, code: projectConfig.code, error: projectConfig.error });
      }
      const context = getCursorContext(scope.workspaceDir, {
        projectRoot: scope.projectRoot,
        audience: scope.audience,
      });
      /** @type {Record<string, any>} */
      const payload = {
        ok: true,
        scope: {
          source: scope.source,
          audience: scope.audience,
          workspaceDir: scope.workspaceDir,
          projectRoot: scope.projectRoot,
          chatId: scope.chatId || undefined,
        },
        projectContextConfig: projectConfig.config
          ? { active: true, path: projectConfig.path }
          : { active: false },
        ...context,
      };
      if (scope.compareLegacy) {
        payload.scopeCompare = {
          legacyWorkspaceDir: scope.legacyWorkspaceDir,
          authorizedWorkspaceDir: scope.workspaceDir,
          legacyWouldUse: scope.legacyWorkspaceDir,
          gateApplied: scope.legacyWorkspaceDir !== scope.workspaceDir
            || scope.audience === 'widget',
        };
      }
      return res.json(payload);
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });
}
