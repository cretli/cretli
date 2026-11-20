import { cretliApiFetch } from '../../lib/cretliApiRequest.js';
import { collectRelations, scopeQuery } from './initiativeLogic.js';

/**
 * Thin client of /api/initiatives. Every call carries the workspace scope; a non-2xx answer becomes an Error with
 * `status`, `code` and `details` (see classifyError), a lost connection stays a plain TypeError (status 0).
 *
 * @param {{ workspaceUuid: string, viewQuery: string }} scope
 */
export function createInitiativesApi(scope) {
  const q = () => scopeQuery(scope.workspaceUuid, scope.viewQuery);
  const url = (path, params = {}) => {
    const parts = [q()];
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '' && value !== null) parts.push(`${key}=${encodeURIComponent(value)}`);
    const query = parts.filter(Boolean).join('&');
    return `/api/initiatives${path}${query ? `?${query}` : ''}`;
  };

  async function call(path, { method = 'GET', params, body, headers } = /** @type {Record<string, any>} */ ({})) {
    const response = await cretliApiFetch(url(path, params), {
      method, cache: 'no-store',
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(body ? { body: JSON.stringify(withScope(body)) } : {}),
    });
    let data = null;
    try { data = await response.json(); } catch { /* non-JSON error page */ }
    if (!response.ok || !data || data.ok === false) {
      const error = /** @type {any} */ (new Error(data?.error || `HTTP ${response.status}`));
      error.status = response.status;
      error.code = data?.code || '';
      error.details = data?.details || {};
      throw error;
    }
    return data;
  }

  // The scope also travels in the body of writes so a proxy that drops the query cannot re-point the request.
  const withScope = (body) => (scope.workspaceUuid ? { ...body, workspaceUuid: scope.workspaceUuid } : body);

  return {
    /** Follows keyset cursors; a `cursor_stale` answer restarts the whole read once. */
    async listAll({ includeArchived = false, maxPages = 10 } = {}) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const items = [];
          let cursor = '';
          let revision = 0;
          for (let page = 0; page < maxPages; page += 1) {
            const data = await call('', { params: { limit: 100, cursor, includeArchived: includeArchived ? '1' : '' } });
            items.push(...data.items);
            revision = data.revision;
            if (!data.hasMore || !data.nextCursor) return { items, revision, truncated: false };
            cursor = data.nextCursor;
          }
          return { items, revision, truncated: true };
        } catch (error) {
          if (/** @type {any} */ (error)?.code !== 'cursor_stale' || attempt) throw error;
        }
      }
      return { items: [], revision: 0, truncated: false };
    },
    /** Complete relations of the given records (the map's visible subset), read per record from the relations API. */
    relationsOfAll: (ids) => collectRelations(ids, (id) => call(`/${encodeURIComponent(id)}/relations`)),
    get: (id) => call(`/${encodeURIComponent(id)}`),
    create: (initiative, idempotencyKey) => call('', { method: 'POST', body: { initiative }, headers: { 'Idempotency-Key': idempotencyKey } }),
    update: (id, patch, expectedRevision) => call(`/${encodeURIComponent(id)}`, { method: 'PATCH', body: { patch, expectedRevision } }),
    archive: (id, expectedRevision, archived) => call(`/${encodeURIComponent(id)}/archive`, { method: 'POST', body: { expectedRevision, archived } }),
    history: (id, cursor) => call(`/${encodeURIComponent(id)}/history`, { params: { limit: 30, cursor } }),
    links: (id) => call(`/${encodeURIComponent(id)}/links`),
    addLink: (id, link) => call(`/${encodeURIComponent(id)}/links`, { method: 'POST', body: link }),
    removeLink: (id, linkId) => call(`/${encodeURIComponent(id)}/links/${encodeURIComponent(linkId)}`, { method: 'DELETE' }),
    research: (id) => call(`/${encodeURIComponent(id)}/research`),
    addResearch: (id, entry, supersedesId) => call(`/${encodeURIComponent(id)}/research`, { method: 'POST', body: { entry, supersedesId } }),
    relations: (id) => call(`/${encodeURIComponent(id)}/relations`),
    createTodo: (id, payload) => call(`/${encodeURIComponent(id)}/todos`, { method: 'POST', body: payload }),
    /** Todos of the same scope for the link picker and the live state of linked Todos. */
    async todos() {
      const parts = [scope.viewQuery.replace(/^\?/, ''), 'slim=1'].filter(Boolean);
      const response = await cretliApiFetch(`/api/todos?${parts.join('&')}`, { cache: 'no-store' });
      if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
      return (await response.json()).items || [];
    },
  };
}
