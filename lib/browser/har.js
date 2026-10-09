/**
 * Browser HAR recorder (P2b).
 *
 * The built-in Browser can write a HAR archive of a tab's requests, but only
 * when the operator explicitly opts in per session/workspace. This module is
 * the only place that builds or writes a HAR document:
 *
 * - `enabled` defaults to `false`; a disabled recorder records nothing and
 *   `flush()` returns an explicit `disabled` status without touching disk;
 * - every value is redacted at ingest through the shared `redaction.js`
 *   helpers (`redactUrl`, `redactHeaders`, `redactText`, `isSensitiveTokenName`)
 *   and the whole document is redacted again on output, so Cookie,
 *   Set-Cookie, Authorization, Proxy-Authorization and detectable
 *   query/body tokens never reach a file, a chat payload or an agent;
 * - response bodies are never captured (only status/headers/metadata), so no
 *   raw body can leak even with the opt-in on;
 * - the persisted document is bounded: `maxEntries` drops the oldest rows and
 *   `flush()` refuses to write a payload above `maxBytes` instead of writing a
 *   partial/raw file.
 *
 * Nothing in this module is wired into an agent tool: the file is the only
 * artifact, and `status()` exposes metadata/counters only.
 */

import path from 'path';
import { writeJsonAtomic } from '../persist/atomic-write.js';
import {
  isSensitiveHeaderName,
  isSensitiveQueryParam,
  isSensitiveTokenName,
  redactHeaders,
  redactText,
  redactUrl,
} from './redaction.js';

const REDACTED = '[redacted]';

/** HAR directory (inside `dataDir`) that holds one file per Browser session. */
export const HAR_DIR = 'browser-har';
/** Maximum persisted HAR size per session (2 MiB). */
export const DEFAULT_HAR_MAX_BYTES = 2 * 1024 * 1024;
/** Maximum HAR entries kept per session; the oldest rows are dropped first. */
export const DEFAULT_HAR_MAX_ENTRIES = 200;
/** Per-request body capture cap (64 KiB) so one upload cannot grow memory. */
export const DEFAULT_HAR_MAX_BODY_BYTES = 64 * 1024;
/** HAR spec version emitted by this recorder. */
export const HAR_VERSION = '1.2';
/** HAR `log.creator` block. */
export const HAR_CREATOR = Object.freeze({ name: 'cretli-browser', version: '1' });

/**
 * @param {unknown} id
 * @returns {string} a filesystem-safe session id (never trusted as a path)
 */
function safeHarId(id) {
  const safe = String(id || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  return safe || 'session';
}

/**
 * Absolute path of one session's HAR file. Kept out of the status payload so a
 * raw filesystem path is never handed to a chat/agent.
 * @param {string} dataDir
 * @param {unknown} id
 * @returns {string}
 */
export function harFilePath(dataDir, id) {
  return path.join(String(dataDir || ''), HAR_DIR, `${safeHarId(id)}.har`);
}

/**
 * Redacts a HAR headers map/array (or any headers object). Shared by the HAR
 * recorder and the Network/Console pull path.
 * @param {Record<string, unknown>|Array<{name: string, value: string}>|null|undefined} headers
 * @returns {Record<string, string>}
 */
export function redactHarHeaders(headers) {
  return redactHeaders(headers);
}

/**
 * Redacts headers and preserves the HAR header-array shape. HAR
 * `request.headers` / `response.headers` are arrays, so this is what
 * `redactHarEntry` uses; `redactHarHeaders` stays the map-shaped helper.
 * @param {Record<string, unknown>|Array<{name: string, value: string}>|null|undefined} headers
 * @returns {Array<{ name: string, value: string }>}
 */
export function redactHarHeaderList(headers) {
  if (Array.isArray(headers)) {
    return headers.map((entry) => ({
      name: String(entry?.name ?? ''),
      value: isSensitiveHeaderName(entry?.name) ? REDACTED : String(entry?.value ?? ''),
    }));
  }
  return toHarHeaderArray(redactHeaders(headers));
}

/**
 * HAR cookies are secret values regardless of the cookie name, so every
 * `value` is replaced. Names/expiry stay readable for debugging.
 * @param {unknown} cookies
 * @returns {Array<Record<string, unknown>>}
 */
export function redactHarCookies(cookies) {
  if (!Array.isArray(cookies)) return [];
  return cookies.map((cookie) => {
    if (!cookie || typeof cookie !== 'object') return { name: String(cookie ?? ''), value: REDACTED };
    return { ...cookie, value: REDACTED };
  });
}

/**
 * Redacts a HAR `queryString` array (or a raw query string).
 * @param {unknown} query
 * @returns {unknown}
 */
export function redactHarQuery(query) {
  if (Array.isArray(query)) {
    return query.map((param) => ({
      name: String(param?.name ?? ''),
      value: isSensitiveQueryParam(param?.name) ? REDACTED : redactText(param?.value ?? ''),
    }));
  }
  if (typeof query === 'string' && query) {
    const params = new URLSearchParams(query);
    let changed = false;
    for (const key of [...params.keys()]) {
      if (!isSensitiveQueryParam(key)) continue;
      params.set(key, REDACTED);
      changed = true;
    }
    return changed ? params.toString() : redactText(query);
  }
  return query;
}

/**
 * Redacts a HAR `postData.params` array (form-encoded bodies).
 * @param {unknown} params
 * @returns {Array<{name: string, value: string}>}
 */
export function redactHarParams(params) {
  if (!Array.isArray(params)) return [];
  return params.map((param) => ({
    name: String(param?.name ?? ''),
    value: isSensitiveQueryParam(param?.name) ? REDACTED : redactText(param?.value ?? ''),
  }));
}

/**
 * Recursively redacts a parsed request body by key name, capped in depth so a
 * hostile page cannot blow up the process.
 * @param {unknown} value
 * @param {number} [depth]
 * @param {number} [maxDepth]
 * @returns {unknown}
 */
export function redactBodyValue(value, depth = 0, maxDepth = 8) {
  if (value == null) return value;
  if (typeof value === 'string') return redactText(value);
  if (typeof value !== 'object') return value;
  if (depth >= maxDepth) return '[truncated]';
  if (Array.isArray(value)) {
    return value.map((entry) => redactBodyValue(entry, depth + 1, maxDepth));
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = isSensitiveTokenName(key) ? REDACTED : redactBodyValue(entry, depth + 1, maxDepth);
  }
  return out;
}

/**
 * Redacts one body string. A JSON payload is parsed and walked by key so
 * `signature`/`sig`/`key` are caught too; anything else falls back to the
 * generic text patterns.
 * @param {unknown} raw
 * @returns {string}
 */
export function redactBodyString(raw) {
  const text = String(raw ?? '');
  const trimmed = text.trim();
  if (trimmed && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
    try {
      return JSON.stringify(redactBodyValue(JSON.parse(trimmed)));
    } catch {
      // Not valid JSON: fall through to text redaction.
    }
  }
  return redactText(text);
}

/**
 * Redacts a HAR `postData` (string or `{ mimeType, text, params, json }`).
 * @param {unknown} postData
 * @returns {unknown}
 */
export function redactHarBody(postData) {
  if (postData == null) return postData;
  if (typeof postData === 'string') return redactBodyString(postData);
  if (typeof postData === 'object') {
    const out = { ...postData };
    if (typeof out.text === 'string') out.text = redactBodyString(out.text);
    if (out.params !== undefined) out.params = redactHarParams(out.params);
    if (out.json !== undefined) out.json = redactBodyValue(out.json);
    return out;
  }
  return postData;
}

/**
 * Redacts a complete HAR entry. Idempotent, so it is safe to run both at ingest
 * and again before the document is returned or written.
 * @param {unknown} entry
 * @returns {unknown}
 */
export function redactHarEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const out = { ...entry };
  if (out.request && typeof out.request === 'object') {
    const request = { ...out.request };
    request.url = redactUrl(request.url);
    request.headers = redactHarHeaderList(request.headers);
    request.cookies = redactHarCookies(request.cookies);
    if (request.queryString !== undefined) request.queryString = redactHarQuery(request.queryString);
    if (request.postData !== undefined) request.postData = redactHarBody(request.postData);
    out.request = request;
  }
  if (out.response && typeof out.response === 'object') {
    const response = { ...out.response };
    response.headers = redactHarHeaderList(response.headers);
    response.cookies = redactHarCookies(response.cookies);
    if (response.content && typeof response.content === 'object') {
      const content = { ...response.content };
      if (typeof content.text === 'string') content.text = redactBodyString(content.text);
      response.content = content;
    }
    out.response = response;
  }
  return out;
}

/**
 * Redacts every entry of a HAR document (defense in depth on the way out).
 * @param {unknown} document
 * @returns {unknown}
 */
export function redactHarDocument(document) {
  if (!document || typeof document !== 'object') return document;
  const log = document.log && typeof document.log === 'object' ? { ...document.log } : {};
  if (Array.isArray(log.entries)) log.entries = log.entries.map((entry) => redactHarEntry(entry));
  return { ...document, log };
}

/**
 * @param {unknown} headers
 * @returns {Array<{ name: string, value: string }>}
 */
function toHarHeaderArray(headers) {
  if (!headers) return [];
  if (Array.isArray(headers)) {
    return headers.map((entry) => ({ name: String(entry?.name ?? ''), value: String(entry?.value ?? '') }));
  }
  return Object.entries(headers).map(([name, value]) => ({ name, value: String(value ?? '') }));
}

/**
 * @param {unknown} url
 * @returns {Array<{ name: string, value: string }>}
 */
function toHarQueryArray(url) {
  try {
    const parsed = new URL(String(url || ''));
    const out = [];
    for (const [name, value] of parsed.searchParams.entries()) out.push({ name, value });
    return out;
  } catch {
    return [];
  }
}

/**
 * Caps a UTF-8 string at `maxBytes` without cutting a multi-byte character.
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
function capUtf8(text, maxBytes) {
  if (typeof text !== 'string') return text;
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : DEFAULT_HAR_MAX_BODY_BYTES;
  if (Buffer.byteLength(text, 'utf8') <= limit) return text;
  const buf = Buffer.from(text, 'utf8').subarray(0, limit);
  let out = buf.toString('utf8');
  if (out.endsWith('\uFFFD')) out = out.slice(0, -1);
  return `${out}…[truncated]`;
}

/**
 * Bounded, opt-in HAR recorder for one Browser session.
 *
 * @example
 * const har = new HarRecorder({ enabled: true, dataDir: '/tmp/x', id: 'session-1' });
 * har.recordRequest({ requestId: 'r1', url: 'https://example.com/?token=secret' });
 * har.snapshot(); // log.entries[0].request.url has token=%5Bredacted%5D
 */
export class HarRecorder {
  /**
   * @param {{
   *   enabled?: boolean,
   *   dataDir?: string,
   *   id?: string,
   *   workspaceKey?: string,
   *   maxBytes?: number,
   *   maxEntries?: number,
   *   maxBodyBytes?: number,
   *   now?: () => number,
   * }} [options]
   */
  constructor(options = {}) {
    this.enabled = options.enabled === true;
    this.dataDir = String(options.dataDir || '');
    this.id = String(options.id || '');
    this.workspaceKey = String(options.workspaceKey || '');
    const maxBytes = Number(options.maxBytes);
    this.maxBytes = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : DEFAULT_HAR_MAX_BYTES;
    const maxEntries = Number(options.maxEntries);
    this.maxEntries = Number.isFinite(maxEntries) && maxEntries > 0
      ? Math.floor(maxEntries)
      : DEFAULT_HAR_MAX_ENTRIES;
    const maxBodyBytes = Number(options.maxBodyBytes);
    this.maxBodyBytes = Number.isFinite(maxBodyBytes) && maxBodyBytes > 0
      ? Math.floor(maxBodyBytes)
      : DEFAULT_HAR_MAX_BODY_BYTES;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    /** @type {Map<string, Record<string, any>>} requestId -> in-flight entry */
    this.entries = new Map();
    /** @type {string[]} insertion order, so the oldest row can be dropped */
    this.order = [];
    this.dropped = 0;
    this.written = false;
    /** @type {{ reason: string, byteLength: number, at: number }|null} */
    this.lastWrite = null;
    this.startedAt = this.now();
  }

  /**
   * Records a request. The URL, headers, cookies and body are redacted here, so
   * the recorder never holds a raw secret even in memory.
   * @param {{
   *   requestId?: string,
   *   method?: string,
   *   url?: string,
   *   httpVersion?: string,
   *   headers?: Record<string, unknown>|Array<{name: string, value: string}>,
   *   cookies?: unknown,
   *   postData?: unknown,
   *   mimeType?: string,
   *   resourceType?: string,
   *   at?: number,
   * }} [input]
   * @returns {string|null} the stored request id, or null when disabled
   */
  recordRequest(input = {}) {
    if (!this.enabled) return null;
    const requestId = String(input.requestId || `req-${this.order.length + 1}`);
    const at = Number.isFinite(input.at) ? Number(input.at) : this.now();
    const url = redactUrl(input.url ?? '');
    const entry = {
      requestId,
      startedAt: at,
      finishedAt: null,
      resourceType: String(input.resourceType || 'other'),
      request: {
        method: String(input.method || 'GET').toUpperCase(),
        url,
        httpVersion: String(input.httpVersion || 'HTTP/1.1'),
        headers: redactHarHeaders(input.headers),
        cookies: redactHarCookies(input.cookies),
        queryString: redactHarQuery(toHarQueryArray(url)),
        postData: this.capBody(input.postData),
        mimeType: String(input.mimeType || ''),
      },
      response: null,
      failure: '',
    };
    if (!this.entries.has(requestId)) this.order.push(requestId);
    this.entries.set(requestId, entry);
    this.trim();
    return requestId;
  }

  /**
   * Redacts a request body and caps it at `maxBodyBytes`. Bounding the capture
   * here (not only at flush) keeps a single large upload from growing memory.
   * @param {unknown} postData
   * @returns {unknown}
   */
  capBody(postData) {
    if (postData == null) return null;
    const redacted = redactHarBody(postData);
    if (typeof redacted === 'string') return capUtf8(redacted, this.maxBodyBytes);
    if (redacted && typeof redacted === 'object' && typeof redacted.text === 'string') {
      return { ...redacted, text: capUtf8(redacted.text, this.maxBodyBytes) };
    }
    return redacted;
  }

  /**
   * Attaches the response metadata to an existing request. Response bodies are
   * intentionally never accepted.
   * @param {string} requestId
   * @param {{
   *   status?: number,
   *   statusText?: string,
   *   httpVersion?: string,
   *   headers?: Record<string, unknown>|Array<{name: string, value: string}>,
   *   cookies?: unknown,
   *   mimeType?: string,
   *   at?: number,
   * }} [input]
   * @returns {Record<string, any>|null}
   */
  recordResponse(requestId, input = {}) {
    if (!this.enabled) return null;
    const entry = this.entries.get(String(requestId || ''));
    if (!entry) return null;
    entry.response = {
      status: Number.isFinite(input.status) ? input.status : 0,
      statusText: String(input.statusText || ''),
      httpVersion: String(input.httpVersion || 'HTTP/1.1'),
      headers: redactHarHeaders(input.headers),
      cookies: redactHarCookies(input.cookies),
      mimeType: String(input.mimeType || ''),
    };
    entry.finishedAt = Number.isFinite(input.at) ? Number(input.at) : this.now();
    return entry;
  }

  /**
   * Marks a request as failed (no response).
   * @param {string} requestId
   * @param {{ errorText?: string, at?: number }} [input]
   * @returns {Record<string, any>|null}
   */
  recordFailure(requestId, input = {}) {
    if (!this.enabled) return null;
    const entry = this.entries.get(String(requestId || ''));
    if (!entry) return null;
    entry.failure = redactText(input.errorText ?? 'request failed');
    entry.finishedAt = Number.isFinite(input.at) ? Number(input.at) : this.now();
    return entry;
  }

  /** Drops the oldest entries beyond `maxEntries`. */
  trim() {
    while (this.order.length > this.maxEntries) {
      const oldest = this.order.shift();
      this.entries.delete(oldest);
      this.dropped += 1;
    }
  }

  /**
   * @param {Record<string, any>} entry
   * @returns {Record<string, any>|null}
   */
  toHarEntry(entry) {
    if (!entry) return null;
    const request = entry.request || {};
    const response = entry.response;
    const started = Number(entry.startedAt) || this.startedAt;
    const finished = Number(entry.finishedAt) || started;
    const elapsed = Math.max(0, finished - started);
    // The manager passes Playwright's string `postData()`; a direct caller may
    // pass `{ mimeType, text }`, so normalize both to one text for the HAR body.
    const postText = request.postData == null
      ? null
      : (typeof request.postData === 'string'
        ? request.postData
        : (typeof request.postData.text === 'string'
          ? request.postData.text
          : JSON.stringify(request.postData)));
    const harRequest = {
      method: request.method || 'GET',
      url: request.url || '',
      httpVersion: request.httpVersion || 'HTTP/1.1',
      cookies: request.cookies || [],
      headers: toHarHeaderArray(request.headers),
      queryString: Array.isArray(request.queryString) ? request.queryString : [],
      headersSize: -1,
      bodySize: postText == null ? 0 : Buffer.byteLength(postText, 'utf8'),
    };
    if (postText != null) {
      harRequest.postData = {
        mimeType: request.mimeType || request.postData?.mimeType || 'application/octet-stream',
        text: postText,
      };
    }
    const har = {
      startedDateTime: new Date(started).toISOString(),
      time: elapsed,
      request: harRequest,
      response: response
        ? {
          status: Number(response.status) || 0,
          statusText: response.statusText || '',
          httpVersion: response.httpVersion || 'HTTP/1.1',
          cookies: response.cookies || [],
          headers: toHarHeaderArray(response.headers),
          content: { size: 0, mimeType: response.mimeType || '' },
          redirectURL: '',
          headersSize: -1,
          bodySize: -1,
        }
        : {
          status: 0,
          statusText: '',
          httpVersion: '',
          cookies: [],
          headers: [],
          content: { size: 0, mimeType: '' },
          redirectURL: '',
          headersSize: -1,
          bodySize: -1,
        },
      cache: {},
      timings: { send: 0, wait: elapsed, receive: 0 },
    };
    if (entry.resourceType) har._resourceType = entry.resourceType;
    if (entry.failure) har._error = entry.failure;
    return har;
  }

  /**
   * A redacted HAR 1.2 document for the recorded entries. Cookies and
   * credentials are masked and request bodies are redacted; response bodies are
   * never captured.
   * @returns {{ log: Record<string, any> }}
   */
  toHar() {
    const document = {
      log: {
        version: HAR_VERSION,
        creator: { ...HAR_CREATOR },
        pages: [{
          startedDateTime: new Date(this.startedAt).toISOString(),
          id: this.id || 'page',
          title: '',
          pageTimings: {},
        }],
        entries: this.order.map((requestId) => this.toHarEntry(this.entries.get(requestId))).filter(Boolean),
      },
    };
    return /** @type {{ log: Record<string, any> }} */ (redactHarDocument(document));
  }

  /** Alias kept explicit for callers that only want a read-only view. */
  snapshot() {
    return this.toHar();
  }

  /**
   * Metadata-only status (no entries, no headers, no path). Safe for the status
   * API and the session summary.
   * @returns {{ enabled: boolean, entryCount: number, dropped: number, written: boolean, lastWrite: object|null }}
   */
  status() {
    return {
      enabled: this.enabled,
      entryCount: this.entries.size,
      dropped: this.dropped,
      written: this.written,
      lastWrite: this.lastWrite ? { ...this.lastWrite } : null,
    };
  }

  /**
   * Serializes and persists the redacted document.
   *
   * Refuses with `{ written: false, reason: 'size-limit' }` when the payload
   * exceeds `maxBytes`; the recorder never writes a partial or raw file. A
   * disabled recorder reports `disabled` and touches no file.
   * @returns {{ written: boolean, reason?: string, byteLength?: number, limit?: number, entryCount?: number }}
   */
  flush() {
    if (!this.enabled) return { written: false, reason: 'disabled' };
    if (!this.dataDir) return { written: false, reason: 'no-data-dir' };
    const document = this.toHar();
    let text;
    try {
      text = JSON.stringify(document, null, 2);
    } catch {
      return { written: false, reason: 'serialize-failed' };
    }
    const byteLength = Buffer.byteLength(text, 'utf8');
    if (byteLength > this.maxBytes) {
      this.written = false;
      this.lastWrite = { reason: 'size-limit', byteLength, at: this.now() };
      return { written: false, reason: 'size-limit', byteLength, limit: this.maxBytes };
    }
    try {
      writeJsonAtomic(harFilePath(this.dataDir, this.id), document, 'utf8');
      this.written = true;
      this.lastWrite = { reason: 'written', byteLength, at: this.now() };
      return { written: true, byteLength, entryCount: this.entries.size };
    } catch {
      this.written = false;
      this.lastWrite = { reason: 'write-failed', byteLength, at: this.now() };
      return { written: false, reason: 'write-failed', byteLength };
    }
  }

  clear() {
    this.entries.clear();
    this.order = [];
    this.dropped = 0;
  }
}

/**
 * @param {ConstructorParameters<typeof HarRecorder>[0]} [options]
 * @returns {HarRecorder}
 */
export function createHarRecorder(options = {}) {
  return new HarRecorder(options);
}
