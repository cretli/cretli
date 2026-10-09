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
  'x-cretli-local-login',
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

/** Variable / property names treated like sensitive headers in debugger scope payloads. */
const SENSITIVE_VARIABLE_NAMES = Object.freeze([
  'apikey',
  'api_key',
  'credential',
  'credentials',
  'pin',
  'sessionid',
  'session_id',
  'auth',
  'authorization',
]);

/**
 * Whether a JavaScript property name (e.g. CDP Runtime.getProperties `name`) is sensitive.
 * @param {unknown} name
 * @returns {boolean}
 */
export function isSensitiveVariableName(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return false;
  if (isSensitiveHeaderName(key)) return true;
  if (SENSITIVE_VARIABLE_NAMES.includes(key)) return true;
  if (key.includes('password') || key.includes('secret') || key.includes('token')) return true;
  if (key.includes('apikey') || key.includes('api_key')) return true;
  return false;
}

/**
 * Whether a plain object key should be redacted (headers + debugger variable names).
 * @param {unknown} name
 * @returns {boolean}
 */
function isSensitivePropertyKey(name) {
  return isSensitiveHeaderName(name) || isSensitiveVariableName(name);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isCdpRemoteObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return typeof /** @type {Record<string, unknown>} */ (value).type === 'string';
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
const CDP_DESCRIPTOR_ACCESSOR_KEYS = Object.freeze(['get', 'set', 'symbol']);

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isCdpPropertyDescriptor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = /** @type {Record<string, unknown>} */ (value);
  if (typeof record.name !== 'string') return false;
  if (record.value !== undefined) {
    return isCdpRemoteObject(record.value) || typeof record.value === 'string';
  }
  for (const key of CDP_DESCRIPTOR_ACCESSOR_KEYS) {
    if (record[key] !== undefined && isCdpRemoteObject(record[key])) return true;
  }
  return false;
}

/**
 * Redacts a CDP RemoteObject value while preserving shape (`type`, previews, etc.).
 * @param {unknown} remoteValue
 * @returns {unknown}
 */
function redactCdpRemoteObjectValue(remoteValue) {
  if (remoteValue == null) return remoteValue;
  if (typeof remoteValue === 'string') return REDACTED;
  if (!isCdpRemoteObject(remoteValue)) return REDACTED;
  const obj = /** @type {Record<string, unknown>} */ ({ ...remoteValue });
  if ('value' in obj) obj.value = REDACTED;
  if ('unserializableValue' in obj) obj.unserializableValue = REDACTED;
  if ('description' in obj) obj.description = REDACTED;
  if ('preview' in obj && obj.preview != null) obj.preview = REDACTED;
  return obj;
}

/**
 * Redacts one element inside a returnByValue array at any nesting depth.
 * @param {unknown} el
 * @param {number} maxItems
 * @param {number} [depth]
 * @param {number} [maxDepth]
 * @returns {unknown}
 */
function redactReturnByValueArrayElement(el, maxItems, depth = 0, maxDepth = 8) {
  if (el == null) return el;
  if (typeof el === 'string') return redactText(el);
  if (typeof el === 'number' || typeof el === 'boolean' || typeof el === 'bigint') return el;
  if (isCdpRemoteObject(el)) return preserveCdpRemoteObjectValue(el, maxItems, depth, maxDepth);
  if (Array.isArray(el)) {
    if (depth >= maxDepth) return '[truncated]';
    return el.slice(0, maxItems).map((item) => redactReturnByValueArrayElement(item, maxItems, depth + 1, maxDepth));
  }
  if (typeof el === 'object') return redactPlainObjectByVariableName(el, maxItems, depth, maxDepth);
  return el;
}

/**
 * Redacts a plain object embedded in a CDP RemoteObject `value` (Runtime.evaluate returnByValue).
 * Keys are masked by JavaScript variable name, not by value shape.
 * @param {unknown} value
 * @param {number} maxItems
 * @param {number} [depth]
 * @param {number} [maxDepth]
 * @returns {unknown}
 */
function redactPlainObjectByVariableName(value, maxItems, depth = 0, maxDepth = 8) {
  if (value == null) return value;
  if (Array.isArray(value)) {
    if (depth >= maxDepth) return '[truncated]';
    return value.slice(0, maxItems).map((el) => redactReturnByValueArrayElement(el, maxItems, depth + 1, maxDepth));
  }
  if (typeof value !== 'object') return value;
  if (depth >= maxDepth) return '[truncated]';
  /** @type {Record<string, unknown>} */
  const out = {};
  let count = 0;
  for (const [key, entry] of Object.entries(value)) {
    if (count >= maxItems) break;
    if (isSensitiveVariableName(key)) {
      out[key] = REDACTED;
    } else if (entry != null && typeof entry === 'object' && !Array.isArray(entry) && !isCdpRemoteObject(entry)) {
      out[key] = redactPlainObjectByVariableName(entry, maxItems, depth + 1, maxDepth);
    } else if (isCdpRemoteObject(entry)) {
      out[key] = preserveCdpRemoteObjectValue(entry, maxItems, depth + 1, maxDepth);
    } else {
      out[key] = redactValueInner(entry, maxDepth, maxItems, depth + 1);
    }
    count += 1;
  }
  return out;
}

/**
 * Preserves a non-sensitive CDP RemoteObject; nested RemoteObject chains respect depth budget.
 * @param {unknown} remoteValue
 * @param {number} maxItems
 * @param {number} [depth]
 * @param {number} [maxDepth]
 * @returns {unknown}
 */
function preserveCdpRemoteObjectValue(remoteValue, maxItems, depth = 0, maxDepth = 8) {
  if (remoteValue == null) return remoteValue;
  if (depth >= maxDepth) return '[truncated]';
  if (typeof remoteValue === 'string') return redactText(remoteValue);
  if (!isCdpRemoteObject(remoteValue)) return remoteValue;
  const obj = /** @type {Record<string, unknown>} */ ({ ...remoteValue });
  if ('description' in obj && typeof obj.description === 'string') {
    obj.description = redactText(obj.description);
  }
  if ('value' in obj && obj.value != null) {
    const inner = obj.value;
    if (Array.isArray(inner)) {
      obj.value = inner.slice(0, maxItems).map((el) => redactReturnByValueArrayElement(el, maxItems, depth + 1, maxDepth));
    } else if (typeof inner === 'object' && !isCdpRemoteObject(inner)) {
      obj.value = redactPlainObjectByVariableName(inner, maxItems, depth + 1, maxDepth);
    } else if (isCdpRemoteObject(inner)) {
      obj.value = preserveCdpRemoteObjectValue(inner, maxItems, depth + 1, maxDepth);
    } else if (typeof inner === 'string') {
      obj.value = redactText(inner);
    }
  }
  if ('properties' in obj && Array.isArray(obj.properties)) {
    obj.properties = redactCdpScopeProperties(obj.properties, maxItems, depth + 1, maxDepth);
  }
  if ('preview' in obj && obj.preview != null && typeof obj.preview === 'object') {
    obj.preview = isCdpRemoteObject(obj.preview)
      ? preserveCdpRemoteObjectValue(obj.preview, maxItems, depth + 1, maxDepth)
      : redactValueInner(obj.preview, 4, maxItems, depth + 1);
  }
  const reservedRemoteObjectKeys = new Set(['type', 'value', 'properties', 'description', 'preview']);
  for (const key of Object.keys(obj)) {
    if (reservedRemoteObjectKeys.has(key)) continue;
    if (!isSensitiveVariableName(key) && !isSensitivePropertyKey(key)) continue;
    obj[key] = REDACTED;
  }
  return obj;
}

/**
 * Redacts one CDP Runtime.getProperties descriptor without the global depth budget
 * (scope payloads nest RemoteObjects deeper than DEBUGGER_REDACT_MAX_DEPTH).
 * @param {unknown} descriptor
 * @param {number} [maxItems]
 * @returns {unknown}
 */
export function redactCdpPropertyDescriptor(descriptor, maxItems = 100, depth = 0, maxDepth = 8) {
  if (!isCdpPropertyDescriptor(descriptor)) {
    return redactValueInner(descriptor, maxDepth, maxItems, depth);
  }
  const descriptorName = String(/** @type {Record<string, unknown>} */ (descriptor).name);
  /** @type {Record<string, unknown>} */
  const out = {};
  let count = 0;
  for (const [key, entry] of Object.entries(/** @type {Record<string, unknown>} */ (descriptor))) {
    if (count >= maxItems) break;
    if (key === 'value' && isSensitiveVariableName(descriptorName)) {
      out[key] = redactCdpRemoteObjectValue(entry);
    } else if (key === 'value') {
      out[key] = preserveCdpRemoteObjectValue(entry, maxItems, depth, maxDepth);
    } else if (CDP_DESCRIPTOR_ACCESSOR_KEYS.includes(key) && isCdpRemoteObject(entry)) {
      out[key] = preserveCdpRemoteObjectValue(entry, maxItems, depth + 1, maxDepth);
    } else {
      out[key] = isSensitivePropertyKey(key)
        ? REDACTED
        : redactValueInner(entry, maxDepth, maxItems, depth + 1);
    }
    count += 1;
  }
  return out;
}

/**
 * @param {unknown} properties
 * @param {number} [maxItems]
 * @returns {unknown[]}
 */
export function redactCdpScopeProperties(properties, maxItems = 100, depth = 0, maxDepth = 8) {
  if (!Array.isArray(properties)) return [];
  return properties.slice(0, maxItems).map((entry) => redactCdpPropertyDescriptor(entry, maxItems, depth, maxDepth));
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
 * Union of every sensitive name family (header / query / debugger variable).
 * HAR bodies and query strings use keys that are neither always headers nor
 * always variables (`sig`, `signature`, `key`), so one predicate has to cover
 * all three before a value is allowed to leave the process.
 * @param {unknown} name
 * @returns {boolean}
 */
export function isSensitiveTokenName(name) {
  return isSensitiveHeaderName(name) || isSensitiveVariableName(name) || isSensitiveQueryParam(name);
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
    if (isCdpRemoteObject(value)) {
      return preserveCdpRemoteObjectValue(value, maxItems, depth, maxDepth);
    }
    if (isCdpPropertyDescriptor(value)) {
      return redactCdpPropertyDescriptor(value, maxItems, depth, maxDepth);
    }
    /** @type {Record<string, unknown>} */
    const out = {};
    let count = 0;
    for (const [key, entry] of Object.entries(value)) {
      if (count >= maxItems) break;
      out[key] = isSensitivePropertyKey(key)
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
