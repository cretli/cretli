import { cretliApiFetch } from '../../lib/cretliApiRequest.js';

/** Capture scope per instance so in-flight writes never change workspace. */
export function createDocsApi(scope = {}, request = cretliApiFetch) {
  scope = { ...scope };
  async function call(path, method = 'GET', values = {}) {
    const query = new URLSearchParams(scope);
    if (method === 'GET') for (const [key, value] of Object.entries(values)) query.set(key, value);
    const response = await request(`/api/docs${path}?${query}`, {
      method, cache: 'no-store',
      ...(method !== 'GET' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...values, ...scope }) } : {}),
    });
    // A non-JSON body (e.g. 404 from a server that predates the routes) still carries the HTTP status.
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { status: response.status, code: data.code, details: data.details });
    return data;
  }
  return {
    proposals: () => call('/proposals'),
    async resolveProposal(card, optionId) {
      const response = await request(`/api/decisions/${encodeURIComponent(card.id)}?${new URLSearchParams(scope)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...scope, optionId, expectedRevision: card.revision, detailsOpened: true }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw Object.assign(new Error(data.error || 'Decision failed'), { status: response.status });
      return data;
    },
    config: () => call('/config'),
    setConfig: (root, create = false) => call('/config', 'PUT', { root, create }),
    consent: (agentRead) => call('/consent', 'POST', { agentRead }),
    revoke: () => call('/consent', 'DELETE'),
    tree: () => call('/tree'),
    note: (path) => call('/note', 'GET', { path }),
    search: (q) => call('/search', 'GET', { q }),
    links: (note) => call('/links', 'GET', { note }),
    targetLinks: (kind, targetId) => call('/links', 'GET', { target: `${kind}:${targetId}` }),
    addLink: (note, kind, targetId) => call('/links', 'POST', { note, kind, targetId }),
    removeLink: (id) => call(`/links/${encodeURIComponent(id)}`, 'DELETE'),
    create: (path, text) => call('/note', 'POST', { path, text }),
    save: (path, text, expectedSha256) => call('/note', 'PUT', { path, text, expectedSha256 }),
    rename: (path, newPath, expectedSha256) => call('/note/rename', 'POST', { path, newPath, expectedSha256 }),
    trash: (path, expectedSha256) => call('/note', 'DELETE', { path, expectedSha256 }),
  };
}
