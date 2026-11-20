/**
 * Workspace Watcher routes — named entry point.
 *
 * The implementation lives in `workspace-watcher-routes.js` (the name already
 * referenced by `docs/ARCHITECTURE.md` and the review-verify catalog). This
 * module keeps the shorter `watcher-routes.js` import path used by the stage-7
 * plan working, without a second copy of the handlers.
 *
 * Endpoints: `GET/PATCH/DELETE /api/workspace-watcher`,
 * `GET/PATCH /api/workspace-watcher/runtime-control`,
 * `GET /api/workspace-watcher/decisions`,
 * `POST /api/workspace-watcher/{pause,resume,clear-stop,tick,run-cycle,claim-next,reset-plan-requests,findings,report,save-plan}`.
 */

export { registerWorkspaceWatcherRoutes } from './workspace-watcher-routes.js';
