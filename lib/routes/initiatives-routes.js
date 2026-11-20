/**
 * HTTP API of development-plan initiatives (docs/development-plans.md). Thin wrappers over
 * lib/initiatives/initiatives-service.js. The workspace comes from the verified server-side resolver (workspaceId /
 * workspaceUuid / alias / workspaceFolder in query or body), never from the global UI cwd. Session UI requests
 * (auth + CSRF) act as `human`; MCP integration and widget requests act as `agent`.
 */
import { InitiativeError } from '../initiatives/constants.js';
import { getInitiativesService } from '../initiatives/initiatives-service.js';
import { isHumanDecisionRequest } from './decisions-routes.js';

const STATUS_BY_CODE = Object.freeze({
  validation: 400, forbidden: 403, not_found: 404, link_unavailable: 422,
});

/** @param {import('express').Request} req */
function scopeOf(req) {
  const pick = (key) => String(req.query?.[key] || req.body?.[key] || '').trim();
  return {
    workspaceUuid: pick('workspaceUuid'), workspaceId: pick('workspaceId'), workspaceFile: pick('workspaceFile'), workspaceFolder: pick('workspaceFolder'),
  };
}

/** @param {import('express').Request} req */
const actorOf = (req) => (isHumanDecisionRequest(req) ? 'human' : 'agent');

/** @param {import('express').Response} res @param {unknown} error */
function fail(res, error) {
  if (error instanceof InitiativeError) {
    const status = STATUS_BY_CODE[error.code] || 409;
    return res.status(status).json({ ok: false, code: error.code, error: error.message, details: error.details });
  }
  const code = /** @type {any} */ (error)?.code;
  console.error('[initiatives] request failed:', error);
  return res.status(code === 'storage_unavailable' ? 503 : 500).json({ ok: false, code: 'internal', error: 'Initiatives request failed' });
}

/** Wraps an async handler with uniform error mapping. */
const wrap = (fn) => async (req, res) => {
  try { return res.json({ ok: true, ...(await fn(req)) }); } catch (error) { return fail(res, error); }
};

/** @param {unknown} v */
const revisionOf = (v) => (v === undefined || v === '' ? undefined : Number(v));

/**
 * @param {import('express').Express} app
 * @param {{ dataDir: string }} ctx
 */
export function registerInitiativesRoutes(app, ctx) {
  const svc = () => getInitiativesService(ctx.dataDir);

  app.get('/api/initiatives', wrap(async (req) => svc().list(scopeOf(req), {
    cursor: req.query.cursor, limit: req.query.limit, status: req.query.status, horizon: req.query.horizon, includeArchived: req.query.includeArchived === '1',
  })));
  app.post('/api/initiatives', wrap(async (req) => svc().create(scopeOf(req), req.body?.initiative ?? req.body, {
    actor: actorOf(req), idempotencyKey: req.get('Idempotency-Key') || req.body?.idempotencyKey,
  })));
  app.get('/api/initiatives/graph-slice', wrap(async (req) => svc().graphSlice(scopeOf(req), { cursor: req.query.cursor, limit: req.query.limit })));
  app.get('/api/initiatives/:id', wrap(async (req) => ({ initiative: await svc().get(scopeOf(req), req.params.id) })));
  app.patch('/api/initiatives/:id', wrap(async (req) => svc().update(scopeOf(req), req.params.id, req.body?.patch ?? {}, {
    expectedRevision: revisionOf(req.body?.expectedRevision), actor: actorOf(req), reason: req.body?.reason,
  })));
  app.post('/api/initiatives/:id/archive', wrap(async (req) => svc().archive(scopeOf(req), req.params.id, {
    expectedRevision: revisionOf(req.body?.expectedRevision), archived: req.body?.archived !== false, actor: actorOf(req),
  })));
  app.get('/api/initiatives/:id/history', wrap(async (req) => svc().history(scopeOf(req), req.params.id, { cursor: req.query.cursor, limit: req.query.limit })));

  app.get('/api/initiatives/:id/relations', wrap(async (req) => ({
    ...(await svc().relations(scopeOf(req), req.params.id)), requiresSignal: await svc().requiresSignalOf(scopeOf(req), req.params.id),
  })));
  app.post('/api/initiatives/:id/relations', wrap(async (req) => {
    const { type, otherId, direction } = req.body || {};
    const [fromId, toId] = direction === 'incoming' ? [otherId, req.params.id] : [req.params.id, otherId];
    return svc().addRelation(scopeOf(req), { type, fromId, toId }, { actor: actorOf(req) });
  }));
  app.delete('/api/initiatives/:id/relations/:relationId', wrap(async (req) => svc().removeRelation(scopeOf(req), req.params.relationId, { actor: actorOf(req) })));

  app.get('/api/initiatives/:id/links', wrap(async (req) => svc().links(scopeOf(req), req.params.id)));
  app.post('/api/initiatives/:id/links', wrap(async (req) => svc().addLink(scopeOf(req), req.params.id, req.body || {}, { actor: actorOf(req) })));
  app.delete('/api/initiatives/:id/links/:linkId', wrap(async (req) => svc().removeLink(scopeOf(req), req.params.linkId, { actor: actorOf(req) })));

  app.get('/api/initiatives/:id/research', wrap(async (req) => svc().research(scopeOf(req), req.params.id)));
  app.post('/api/initiatives/:id/research', wrap(async (req) => svc().addResearch(scopeOf(req), req.params.id, req.body?.entry ?? req.body, {
    actor: actorOf(req), supersedesId: req.body?.supersedesId,
  })));

  app.post('/api/initiatives/:id/todos', wrap(async (req) => svc().createTodo(scopeOf(req), req.params.id, req.body || {}, { actor: actorOf(req) })));
}
