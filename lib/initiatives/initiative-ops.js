/**
 * Operation table shared by the agent-facing clients: the in-process client runs an op against the service, the
 * remote client maps the same op onto the HTTP API. MCP callers always act as `agent`.
 */

/**
 * @type {Record<string, {
 *   run: (svc: any, scope: Record<string, any>, a: Record<string, any>) => Promise<any>,
 *   http: (a: Record<string, any>) => { method: string, path: string, query?: Record<string, any>, body?: Record<string, any> },
 * }>}
 */
export const INITIATIVE_OPS = Object.freeze({
  list: {
    run: (svc, scope, a) => svc.list(scope, { cursor: a.cursor, limit: a.limit, status: a.status, horizon: a.horizon, includeArchived: a.includeArchived }),
    http: (a) => ({ method: 'GET', path: '/api/initiatives', query: { cursor: a.cursor, limit: a.limit, status: a.status, horizon: a.horizon, includeArchived: a.includeArchived ? '1' : undefined } }),
  },
  get: {
    run: async (svc, scope, a) => ({ initiative: await svc.get(scope, a.id) }),
    http: (a) => ({ method: 'GET', path: `/api/initiatives/${encodeURIComponent(a.id)}` }),
  },
  create: {
    run: (svc, scope, a) => svc.create(scope, a.initiative, { actor: 'agent', idempotencyKey: a.idempotencyKey }),
    http: (a) => ({ method: 'POST', path: '/api/initiatives', body: { initiative: a.initiative, idempotencyKey: a.idempotencyKey } }),
  },
  update: {
    run: (svc, scope, a) => svc.update(scope, a.id, a.patch, { expectedRevision: a.expectedRevision, actor: 'agent', reason: a.reason }),
    http: (a) => ({ method: 'PATCH', path: `/api/initiatives/${encodeURIComponent(a.id)}`, body: { patch: a.patch, expectedRevision: a.expectedRevision, reason: a.reason } }),
  },
  history: {
    run: (svc, scope, a) => svc.history(scope, a.id, { cursor: a.cursor, limit: a.limit }),
    http: (a) => ({ method: 'GET', path: `/api/initiatives/${encodeURIComponent(a.id)}/history`, query: { cursor: a.cursor, limit: a.limit } }),
  },
  graph: {
    run: (svc, scope, a) => svc.graphSlice(scope, { cursor: a.cursor, limit: a.limit }),
    http: (a) => ({ method: 'GET', path: '/api/initiatives/graph-slice', query: { cursor: a.cursor, limit: a.limit } }),
  },
  relate: {
    run: (svc, scope, a) => svc.addRelation(scope, { type: a.type, fromId: a.fromId, toId: a.toId }, { actor: 'agent' }),
    http: (a) => ({ method: 'POST', path: `/api/initiatives/${encodeURIComponent(a.fromId)}/relations`, body: { type: a.type, otherId: a.toId } }),
  },
  link: {
    run: (svc, scope, a) => svc.addLink(scope, a.id, { kind: a.kind, targetId: a.targetId }, { actor: 'agent' }),
    http: (a) => ({ method: 'POST', path: `/api/initiatives/${encodeURIComponent(a.id)}/links`, body: { kind: a.kind, targetId: a.targetId } }),
  },
  research: {
    run: (svc, scope, a) => svc.addResearch(scope, a.id, a.entry, { actor: 'agent', supersedesId: a.supersedesId }),
    http: (a) => ({ method: 'POST', path: `/api/initiatives/${encodeURIComponent(a.id)}/research`, body: { entry: a.entry, supersedesId: a.supersedesId } }),
  },
});
