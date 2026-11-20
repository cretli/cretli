/**
 * Presets and normalization for the "secret" OAuth login of stdio MCP servers.
 *
 * Some stdio servers (Gmail, Google Sheets, Google Ads, ...) do not speak MCP OAuth: they
 * read a long-lived refresh token from an environment variable. The `oauth` block of a
 * server tells Cretli how to obtain that token with a standard OAuth 2.0 authorization-code
 * flow and which secret to store it in; the server's `connection.env` already maps the
 * secret to the variable the server reads.
 */

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** `openid email` lets Cretli show (and check) which account was authorized. */
const GOOGLE_IDENTITY_SCOPES = ['openid', 'email'];

const GOOGLE_BASE = Object.freeze({
  authorizationUrl: GOOGLE_AUTH_URL,
  tokenUrl: GOOGLE_TOKEN_URL,
  clientIdKey: 'GOOGLE_CLIENT_ID',
  clientSecretKey: 'GOOGLE_CLIENT_SECRET',
  refreshTokenKey: 'GOOGLE_REFRESH_TOKEN',
  pkce: true,
  // offline + consent make Google issue a refresh token on every login, not only the first.
  extraAuthParams: Object.freeze({ access_type: 'offline', prompt: 'consent' }),
});

/** @type {Readonly<Record<string, Readonly<Record<string, any>>>>} */
export const MCP_OAUTH_PRESETS = Object.freeze({
  'google-gmail': Object.freeze({
    ...GOOGLE_BASE,
    label: 'Google — Gmail',
    scopes: [
      ...GOOGLE_IDENTITY_SCOPES,
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.labels',
      'https://www.googleapis.com/auth/gmail.settings.basic',
    ],
  }),
  'google-sheets': Object.freeze({
    ...GOOGLE_BASE,
    label: 'Google — Sheets',
    scopes: [...GOOGLE_IDENTITY_SCOPES, 'https://www.googleapis.com/auth/spreadsheets'],
  }),
  'google-ads': Object.freeze({
    ...GOOGLE_BASE,
    label: 'Google — Ads',
    clientIdKey: 'GOOGLE_ADS_CLIENT_ID',
    clientSecretKey: 'GOOGLE_ADS_CLIENT_SECRET',
    refreshTokenKey: 'GOOGLE_ADS_REFRESH_TOKEN',
    scopes: [...GOOGLE_IDENTITY_SCOPES, 'https://www.googleapis.com/auth/adwords'],
  }),
  'google-analytics': Object.freeze({
    ...GOOGLE_BASE,
    label: 'Google — Analytics (read-only)',
    scopes: [...GOOGLE_IDENTITY_SCOPES, 'https://www.googleapis.com/auth/analytics.readonly'],
  }),
  'google-search-console': Object.freeze({
    ...GOOGLE_BASE,
    label: 'Google — Search Console',
    scopes: [...GOOGLE_IDENTITY_SCOPES, 'https://www.googleapis.com/auth/webmasters'],
  }),
});

/**
 * Presets for the Settings form: which secrets hold the OAuth client credentials.
 *
 * @returns {{ id: string, label: string, clientIdKey: string, clientSecretKey: string }[]}
 */
export function listMcpOAuthPresets() {
  return Object.entries(MCP_OAUTH_PRESETS).map(([id, preset]) => ({
    id,
    label: String(preset.label),
    clientIdKey: String(preset.clientIdKey),
    clientSecretKey: String(preset.clientSecretKey),
  }));
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function httpsUrl(value) {
  const raw = text(value);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    // Loopback http is allowed so a local authorization server can be used in development.
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return url.protocol === 'https:' || (url.protocol === 'http:' && loopback) ? url.toString() : '';
  } catch {
    return '';
  }
}

/**
 * Resolves the stored `oauth` block of a server: preset defaults, then explicit fields.
 * Returns null when the block is absent or incomplete, so the server is treated as one
 * without secret OAuth.
 *
 * @param {unknown} raw
 * @returns {{
 *   preset: string,
 *   authorizationUrl: string,
 *   tokenUrl: string,
 *   scopes: string[],
 *   loginHint: string,
 *   clientIdKey: string,
 *   clientSecretKey: string,
 *   refreshTokenKey: string,
 *   pkce: boolean,
 *   extraAuthParams: Record<string, string>,
 * } | null}
 */
export function normalizeMcpOAuth(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = /** @type {Record<string, any>} */ (raw);
  const presetId = text(source.preset);
  const preset = MCP_OAUTH_PRESETS[presetId] || {};
  const pick = (key) => (source[key] !== undefined && source[key] !== '' ? source[key] : preset[key]);

  const authorizationUrl = httpsUrl(pick('authorizationUrl'));
  const tokenUrl = httpsUrl(pick('tokenUrl'));
  const clientIdKey = text(pick('clientIdKey'));
  const clientSecretKey = text(pick('clientSecretKey'));
  const refreshTokenKey = text(pick('refreshTokenKey'));
  if (!authorizationUrl || !tokenUrl || !clientIdKey || !refreshTokenKey) return null;

  const scopesRaw = pick('scopes');
  const scopes = [...new Set(
    (Array.isArray(scopesRaw) ? scopesRaw : String(scopesRaw || '').split(/[\s,]+/))
      .map((scope) => text(scope))
      .filter(Boolean),
  )];

  /** @type {Record<string, string>} */
  const extraAuthParams = {};
  const extra = pick('extraAuthParams');
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    for (const [key, value] of Object.entries(extra)) {
      if (text(key) && typeof value === 'string') extraAuthParams[key.trim()] = value;
    }
  }

  return {
    preset: MCP_OAUTH_PRESETS[presetId] ? presetId : '',
    authorizationUrl,
    tokenUrl,
    scopes,
    loginHint: text(source.loginHint),
    clientIdKey,
    clientSecretKey,
    refreshTokenKey,
    pkce: pick('pkce') !== false,
    extraAuthParams,
  };
}
