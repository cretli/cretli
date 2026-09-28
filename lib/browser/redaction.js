/**
 * Browser diagnostic redaction.
 *
 * Everything that can leave the Node process (WebSocket frames, REST pulls,
 * logs and future agent exports) must pass through these helpers first.
 * The plan forbids raw Authorization/Cookie/Set-Cookie/token/secret query
 * values and full request/response bodies in the MVP.
 */

const REDACTED = '[redacted]';

/**
 * Header names whose values are always replaced.
 * Matched case-insensitively.
 */
export const SENSITIVE_HEADERS = Object.freeze([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-access-token',
  'x-csrf-token',
  'x-xsrf-token',
  'x-session-token',
  'api-key',
  'apikey',
  'auth',
  'token',
  'password',
  'secret',
  'private-token',
  'x-amz-security-token',
]);

const SENSITIVE_HEADER_SET = new Set(SENSITIVE_HEADERS);

/** Query parameter names whose values are replaced (case-insensitive). */
export const SENSITIVE_QUERY_PARAMS = Object.freeze([
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'auth',
  'authorization',
  'api_key',
  'apikey',
  'key',
  'secret',
  'client_secret',
  'password',
  'passwd',
  'pwd',
  'code',
  'session',
  'sessionid',
  'sid',
  'csrf',
  'csrf_token',
  'xsrf',
  'signature',
  'sig',
  'sas',
  'jwt',
  'bearer',
]);

const SENSITIVE_QUERY_SET = new Set(SENSITIVE_QUERY_PARAMS);

/** Ordered text redaction patterns. Each replaces the capture group in `groups`. */
const SENSITIVE_PATTERNS = [
  // URL userinfo: scheme://user:password@host -> scheme://[redacted]@host
  { re: /(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s@]+)@/gi, groups: 2 },
  // Authorization: Bearer <token> / Basic <token>
  { re: /\b(?:bearer|basic)\s+[A-Za-z0-9\-._~+/=]{6,}/gi, groups: 0 },
  // set-cookie: name=value; ... (whole value is sensitive)
  { re: /((?:set-)?cookie\s*:\s*)([^\r\n]+)/gi, groups: 2 },
  // key=value where key is sensitive
  { re: /([?&\s])((?:access_?token|refresh_?token|api_?key|apikey|client_secret|password|passwd|pwd|secret|signature|sig|session_?id|csrf(?:_token)?|xsrf|jwt|token)=)([^&\s"']+)/gi, groups: 3 },
  // JSON-ish "password": "value"
  { re: /("(?:password|passwd|secret|token|api_?key|authorization|cookie|client_secret)"\s*:\s*")([^"]*)(")/gi, groups: 2 },
  // Header-ish name: value / name=value fallback
  { re: /\b(authorization|x-api-key|x-auth-token|api[_-]?key|password|secret|token)\s*[:=]\s*([^\s,;"']+)/gi, groups: 2 },
];

/**
 * @param {unknown} name
 * @returns {boolean}
 */
export function isSensitiveHeaderName(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return false;
  if (SENSITIVE_HEADER_SET.has(key)) return true;
  // Prefix/suffix matching catches vendor headers such as x-my-token.
  return key.startsWith('x-') && (key.includes('token') || key.includes('secret') || key.includes('api-key'));
}

/**
 * @param {unknown} name
 * @returns {boolean}
 */
export function isSensitiveQueryParam(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return false;
  if (SENSITIVE_QUERY_SET.has(key)) return true;
  return key.includes('token') || key.includes('secret') || key.includes('password');
}

/**
 * Redacts a headers map/array without mutating the input.
 * @param {Record<string, unknown>|Array<{name: string, value: string}>|null|undefined} headers
 * @returns {Record<string, string>}
 */
export function redactHeaders(headers) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!headers) return out;
  if (Array.isArray(headers)) {
    for (const entry of headers) {
      const name = String(entry?.name ?? '');
      if (!name) continue;
      out[name] = isSensitiveHeaderName(name) ? REDACTED : String(entry?.value ?? '');
    }
    return out;
  }
  for (const [name, value] of Object.entries(headers)) {
    out[name] = isSensitiveHeaderName(name) ? REDACTED : String(value ?? '');
  }
  return out;
}

/**
 * Redacts sensitive query parameters while keeping the URL shape readable.
 * Falls back to the original string when parsing fails (never throws).
 * @param {unknown} rawUrl
 * @returns {string}
 */
export function redactUrl(rawUrl) {
  const value = String(rawUrl ?? '');
  if (!value) return value;
  try {
    const parsed = new URL(value);
    let changed = false;
    // `user:password@host` credentials must never leave the process.
    if (parsed.username || parsed.password) {
      parsed.username = REDACTED;
      parsed.password = '';
      changed = true;
    }
    for (const key of [...parsed.searchParams.keys()]) {
      if (!isSensitiveQueryParam(key)) continue;
      parsed.searchParams.set(key, REDACTED);
      changed = true;
    }
    // The fragment carries the same secrets as the query (OAuth implicit flow
    // puts `access_token`/`id_token` after `#`), so parse it like a query. A
    // plain anchor fragment has no sensitive keys and is left untouched.
    const fragment = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash;
    if (fragment) {
      const fragParams = new URLSearchParams(fragment);
      let fragChanged = false;
      for (const key of [...fragParams.keys()]) {
        if (!isSensitiveQueryParam(key)) continue;
        fragParams.set(key, REDACTED);
        fragChanged = true;
      }
      if (fragChanged) {
        parsed.hash = fragParams.toString();
        changed = true;
      }
    }
    if (!changed) return value;
    return parsed.toString();
  } catch {
    return redactText(value);
  }
}

/**
 * Generic text redaction for Console output and log messages.
 * @param {unknown} raw
 * @returns {string}
 */
export function redactText(raw) {
  let text = String(raw ?? '');
  if (!text) return text;
  for (const { re, groups } of SENSITIVE_PATTERNS) {
    text = text.replace(re, (...args) => {
      const match = args[0];
      // Replace the capture group that holds the secret value.
      const value = args[groups];
      if (typeof value !== 'string' || !value || value === REDACTED) return match;
      return match.replace(value, REDACTED);
    });
  }
  return text;
}

/**
 * Redacts arbitrary JSON-ish diagnostic values recursively.
 * Depth and breadth are capped so a hostile page cannot blow up the process.
 * @param {unknown} value
 * @param {{ maxDepth?: number, maxItems?: number }} [options]
 * @returns {unknown}
 */
export function redactValue(value, options = {}) {
  const maxDepth = Number.isFinite(options.maxDepth) ? Math.max(1, options.maxDepth) : 6;
  const maxItems = Number.isFinite(options.maxItems) ? Math.max(1, options.maxItems) : 100;
  return redactValueInner(value, maxDepth, maxItems, 0);
}

/**
 * @param {unknown} value
 * @param {number} maxDepth
 * @param {number} maxItems
 * @param {number} depth
 */
function redactValueInner(value, maxDepth, maxItems, depth) {
  if (value == null) return value;
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (depth >= maxDepth) return '[truncated]';
  if (Array.isArray(value)) {
    return value.slice(0, maxItems).map((entry) => redactValueInner(entry, maxDepth, maxItems, depth + 1));
  }
  if (typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    let count = 0;
    for (const [key, entry] of Object.entries(value)) {
      if (count >= maxItems) break;
      out[key] = isSensitiveHeaderName(key)
        ? REDACTED
        : redactValueInner(entry, maxDepth, maxItems, depth + 1);
      count += 1;
    }
    return out;
  }
  return String(value);
}

/**
 * Caps a redacted payload to a maximum UTF-8 byte size.
 * @param {unknown} value
 * @param {number} maxBytes
 * @returns {{ value: string, truncated: boolean }}
 */
export function redactTextCapped(value, maxBytes) {
  const text = redactText(value);
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 0;
  if (!limit || Buffer.byteLength(text, 'utf8') <= limit) {
    return { value: text, truncated: false };
  }
  const buf = Buffer.from(text, 'utf8').subarray(0, limit);
  // Avoid emitting a broken multi-byte sequence at the cut.
  let out = buf.toString('utf8');
  if (out.endsWith('\uFFFD')) out = out.slice(0, -1);
  return { value: out, truncated: true };
}
