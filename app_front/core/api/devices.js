import { cretliApiFetch } from '../../lib/cretliApiRequest.js';

/**
 * Devices REST client. The workspace is captured per instance so an in-flight
 * request never changes scope when the header workspace switches.
 * @param {{ workspaceFolder?: string }} [scope]
 * @param {typeof cretliApiFetch} [request]
 */
export function createDevicesApi(scope = {}, request = cretliApiFetch) {
  const folder = String(scope.workspaceFolder || '');
  const withScope = (path) => (folder ? `${path}${path.includes('?') ? '&' : '?'}workspaceFolder=${encodeURIComponent(folder)}` : path);
  const enc = encodeURIComponent;
  async function call(path, method = 'GET', body) {
    const response = await request(withScope(path), {
      method,
      cache: 'no-store',
      ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw Object.assign(new Error(data.message || data.error || `HTTP ${response.status}`), { status: response.status, code: data.error });
    }
    return data;
  }
  return {
    list: () => call('/api/devices'),
    create: (device) => call('/api/devices', 'POST', { device }),
    update: (id, device) => call(`/api/devices/${enc(id)}`, 'PUT', { device }),
    remove: (id) => call(`/api/devices/${enc(id)}`, 'DELETE'),
    status: (id) => call(`/api/devices/${enc(id)}/status`),
    connectHelp: (id) => call(`/api/devices/${enc(id)}/connect-help`),
    draftConnectHelp: (draft) => call('/api/devices/connect-help', 'POST', draft),
    launchChrome: (id) => call(`/api/devices/${enc(id)}/launch-chrome`, 'POST', {}),
    startRun: (id, input) => call(`/api/devices/${enc(id)}/runs`, 'POST', input),
    runs: () => call('/api/devices/runs'),
    compare: (before, after) => call(`/api/devices/runs/compare?before=${enc(before)}&after=${enc(after)}`),
    consents: () => call('/api/devices/run-consents'),
    decide: (consentId, decision) => call(`/api/devices/run-consents/${enc(consentId)}`, 'POST', { decision }),
    screenshotUrl: (runId, name) => withScope(`/api/devices/runs/${enc(runId)}/screenshots/${enc(name)}`),
    scriptEntries: (dir = '') => call(`/api/files/entries?dir=${enc(dir)}`),
  };
}
