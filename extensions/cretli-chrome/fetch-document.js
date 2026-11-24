// Fetches one document with the user's cookies. Kept free of chrome.* APIs so it
// can be tested in Node with an injected fetch.
import { domainOfUrl } from './domains.js';

export const MAX_FILE = 20 * 1024 * 1024;
const ALLOWED_MIME = new Set(['application/pdf', 'text/csv']);

const fail = (code, message, extra = {}) => ({ ok: false, error: { code, message, ...extra } });

function fileNameFor(response, url) {
  const disposition = response.headers.get('content-disposition') || '';
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  let raw = '';
  try { raw = m ? decodeURIComponent(m[1]) : new URL(url).pathname.split('/').pop(); } catch { raw = ''; }
  return (raw || 'document').slice(0, 120);
}

/**
 * Redirects are never followed: a service-worker `redirect: 'manual'` response is
 * opaque, so the next hop cannot be checked against the approved list. The agent
 * has to use the final link instead.
 *
 * @param {string} href
 * @param {{ fetchFn?: typeof fetch, signal?: AbortSignal, isHostAllowed: (host: string) => Promise<boolean> }} options
 */
export async function fetchDocument(href, { fetchFn = fetch, signal, isHostAllowed }) {
  const host = domainOfUrl(href);
  if (!host || !(await isHostAllowed(host))) return fail('E_DOMAIN_NOT_ALLOWED', 'Host is not approved.');
  // Own controller: every exit path ends the request, so no cookie-bearing stream outlives this call.
  const request = new AbortController();
  const relay = () => request.abort();
  if (signal?.aborted) request.abort();
  signal?.addEventListener?.('abort', relay, { once: true });
  try {
    const response = await fetchFn(href, { credentials: 'include', redirect: 'manual', signal: request.signal });
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      return fail('E_DOMAIN_NOT_ALLOWED', 'Redirects are not followed; use the final link.');
    }
    // Defence in depth: the response must come from the host that was checked.
    const finalHost = response.url ? domainOfUrl(response.url) : host;
    if (finalHost !== host && !(finalHost && await isHostAllowed(finalHost))) {
      return fail('E_DOMAIN_NOT_ALLOWED', 'Response came from a host that is not approved.');
    }
    if (!response.ok) return fail('E_HTTP', 'HTTP error', { status: response.status });
    // The declared type is reported as is; the server also checks the content.
    const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_MIME.has(mime)) return fail('E_TYPE', 'Only PDF and CSV documents are supported.');
    if (Number(response.headers.get('content-length') || 0) > MAX_FILE) return fail('E_LIMIT', 'File is larger than 20 MiB.');
    const chunks = [];
    let size = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_FILE) { await reader.cancel(); return fail('E_LIMIT', 'File is larger than 20 MiB.'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return { ok: true, bytes, mime, finalHost: host, name: fileNameFor(response, href) };
  } catch (err) {
    if (signal?.aborted) return fail('E_CANCELLED', 'Cancelled.');
    return fail('E_INTERNAL', 'Fetch failed.');
  } finally {
    signal?.removeEventListener?.('abort', relay);
    // Harmless after a complete read; stops any still-streaming body on early exits.
    request.abort();
  }
}
