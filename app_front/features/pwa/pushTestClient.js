/**
 * Test-push client: sends ONE test notification to the device's own endpoint via
 * the server route `POST /api/push/test`.
 *
 * Pure request building plus an injectable fetch make this unit-testable in
 * Node; the browser caller uses the shared `cretliApiFetch` (CSRF + credentials).
 */
import { cretliApiFetch } from '../../lib/cretliApiRequest.js';

export const PUSH_TEST_PATH = '/api/push/test';

/**
 * Build the exact request the settings test button must send.
 *
 * @param {unknown} endpoint
 * @returns {{ url: string, init: { method: string, headers: Record<string, string>, body: string } }}
 */
export function buildPushTestRequest(endpoint) {
  const value = typeof endpoint === 'string' ? endpoint.trim() : '';
  return {
    url: PUSH_TEST_PATH,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: value }),
    },
  };
}

/**
 * @param {unknown} endpoint
 * @param {{ fetchImpl?: (url: string, init: object) => Promise<Response> }} [options]
 * @returns {Promise<{ ok: boolean, status: number, error: string, body: unknown }>}
 */
export async function sendPushTest(endpoint, options = {}) {
  const value = typeof endpoint === 'string' ? endpoint.trim() : '';
  if (!value) return { ok: false, status: 0, error: 'missing_endpoint', body: null };
  const { url, init } = buildPushTestRequest(value);
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : cretliApiFetch;
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch (err) {
    return { ok: false, status: 0, error: 'network', detail: err?.message || String(err), body: null };
  }
  let body = null;
  try {
    body = await response.json();
  } catch (_) {
    body = null;
  }
  const ok = !!response.ok && body?.ok !== false;
  return {
    ok,
    status: response.status,
    error: ok ? '' : (body?.error || 'send_failed'),
    body,
  };
}
