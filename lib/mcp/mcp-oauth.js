/**
 * OAuth 2.1 login for remote (HTTP) MCP integrations, on top of the MCP SDK client
 * (`@modelcontextprotocol/sdk/client/auth.js`): discovery (RFC 9728 / 8414), dynamic
 * client registration (RFC 7591), PKCE and token refresh are done by the SDK. This module
 * only stores the SDK's state in the server's secret bag (data/mcp-secrets.json), so
 * tokens never appear in data/mcp.json or in API responses.
 *
 * Flow: the Settings panel calls startMcpOAuth() -> the user authorizes in a browser
 * window -> the authorization server redirects to /api/mcp/oauth/callback ->
 * finishMcpOAuth() exchanges the code. Later connects pass createMcpOAuthProvider() to the
 * HTTP transport, which sends the access token and refreshes it on 401.
 *
 * Stdio servers that read a refresh token from the environment (Gmail, Sheets, ...) use the
 * second flavour in this file, selected by the server's `oauth` block: a plain OAuth 2.0
 * authorization-code flow (with PKCE) whose refresh token is written into the secret the
 * server's `connection.env` already points at. See mcp-oauth-presets.js.
 */

import { createHash, randomBytes } from 'node:crypto';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import {
  McpRevisionConflictError,
  loadMcpDocument,
  loadMcpSecretsDocument,
  mutateMcpConfiguration,
} from '../persist/mcp-persist.js';
import { applySecretPatchToMap, getMcpSecrets } from './mcp-secrets.js';

export const MCP_OAUTH_CALLBACK_PATH = '/api/mcp/oauth/callback';

/** Secret-bag keys owned by this module. */
export const MCP_OAUTH_KEYS = Object.freeze({
  client: 'oauth_client',
  tokens: 'oauth_tokens',
  verifier: 'oauth_code_verifier',
  state: 'oauth_state',
  redirect: 'oauth_redirect_uri',
  discovery: 'oauth_discovery',
  /** Account (e-mail) the secret-OAuth login was granted for; display and sanity check only. */
  account: 'oauth_account',
});

/**
 * Redirect URI of the manual flow: a loopback address nothing listens on. The browser ends
 * on a "cannot connect" page whose address bar holds the code; the user pastes that URL back.
 * Google accepts any loopback redirect for desktop clients, so this works from any device.
 */
export const MCP_OAUTH_MANUAL_REDIRECT_URI = 'http://localhost:49321/oauth2callback';

const TOKEN_REQUEST_TIMEOUT_MS = 15_000;

/** A pending browser authorization expires after this long. */
const STATE_TTL_MS = 15 * 60 * 1000;

export class McpOAuthLoginRequiredError extends Error {
  constructor() {
    super('OAuth login required: open Settings → MCP and use "Log in" for this server.');
    this.name = 'McpOAuthLoginRequiredError';
    this.code = 'OAUTH_LOGIN_REQUIRED';
  }
}

/**
 * @param {string} raw
 * @returns {any}
 */
function parseJson(raw) {
  if (typeof raw !== 'string' || !raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Writes secret keys of one server outside the revision-checked UI flow (token refresh
 * happens in the background). Retries when another writer bumped the revision.
 *
 * @param {string} serverId
 * @param {Record<string, string | null>} patch
 * @returns {Promise<void>}
 */
export async function patchMcpServerSecrets(serverId, patch) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const revision = loadMcpDocument().revision;
    try {
      await mutateMcpConfiguration(revision, (state) => ({
        servers: state.servers,
        secrets: applySecretPatchToMap(state.secrets, serverId, patch),
      }));
      return;
    } catch (err) {
      if (!(err instanceof McpRevisionConflictError)) throw err;
    }
  }
  throw new Error('Could not store MCP OAuth state: configuration kept changing');
}

/**
 * @param {Record<string, any>} server
 * @returns {boolean}
 */
export function hasMcpOAuthTokens(server) {
  return Boolean(getMcpSecrets(server?.id)[MCP_OAUTH_KEYS.tokens]);
}

/**
 * Login state of a server with a secret-OAuth block (refresh token for a stdio server).
 *
 * @param {Record<string, any>} server
 * @returns {{ connected: boolean, account: string }}
 */
export function getMcpSecretOAuthState(server) {
  const cfg = server?.oauth;
  if (!cfg) return { connected: false, account: '' };
  const secrets = getMcpSecrets(server.id);
  return {
    connected: Boolean(secrets[cfg.refreshTokenKey]),
    account: String(secrets[MCP_OAUTH_KEYS.account] || ''),
  };
}

/**
 * OAuthClientProvider backed by the server's secret bag.
 *
 * @param {Record<string, any>} server
 * @param {{ redirectUrl?: string, state?: string, onAuthorizationUrl?: (url: URL) => void }} [options]
 * @returns {import('@modelcontextprotocol/sdk/client/auth.js').OAuthClientProvider}
 */
export function createMcpOAuthProvider(server, options = {}) {
  const id = String(server?.id || '');
  const secret = (key) => getMcpSecrets(id)[key] || '';
  const redirectUrl = () => options.redirectUrl || secret(MCP_OAUTH_KEYS.redirect) || undefined;
  return {
    get redirectUrl() {
      return redirectUrl();
    },
    get clientMetadata() {
      const uri = redirectUrl();
      return {
        client_name: 'Cretli',
        redirect_uris: uri ? [uri] : [],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      };
    },
    state() {
      return options.state || secret(MCP_OAUTH_KEYS.state).split(':')[0] || '';
    },
    clientInformation() {
      return parseJson(secret(MCP_OAUTH_KEYS.client));
    },
    async saveClientInformation(info) {
      await patchMcpServerSecrets(id, { [MCP_OAUTH_KEYS.client]: JSON.stringify(info) });
    },
    tokens() {
      return parseJson(secret(MCP_OAUTH_KEYS.tokens));
    },
    async saveTokens(tokens) {
      await patchMcpServerSecrets(id, { [MCP_OAUTH_KEYS.tokens]: JSON.stringify(tokens) });
    },
    redirectToAuthorization(authorizationUrl) {
      // Background connects cannot open a browser; only the Settings flow may.
      if (!options.onAuthorizationUrl) throw new McpOAuthLoginRequiredError();
      options.onAuthorizationUrl(authorizationUrl);
    },
    async saveCodeVerifier(codeVerifier) {
      await patchMcpServerSecrets(id, { [MCP_OAUTH_KEYS.verifier]: codeVerifier });
    },
    codeVerifier() {
      const value = secret(MCP_OAUTH_KEYS.verifier);
      if (!value) throw new Error('OAuth code verifier is missing; start the login again');
      return value;
    },
    discoveryState() {
      return parseJson(secret(MCP_OAUTH_KEYS.discovery));
    },
    async saveDiscoveryState(state) {
      await patchMcpServerSecrets(id, { [MCP_OAUTH_KEYS.discovery]: JSON.stringify(state) });
    },
    async invalidateCredentials(scope) {
      /** @type {Record<string, null>} */
      const patch = {};
      if (scope === 'all' || scope === 'client') patch[MCP_OAUTH_KEYS.client] = null;
      if (scope === 'all' || scope === 'tokens') patch[MCP_OAUTH_KEYS.tokens] = null;
      if (scope === 'all' || scope === 'verifier') patch[MCP_OAUTH_KEYS.verifier] = null;
      if (scope === 'all' || scope === 'discovery') patch[MCP_OAUTH_KEYS.discovery] = null;
      if (Object.keys(patch).length) await patchMcpServerSecrets(id, patch);
    },
  };
}

/**
 * @param {Record<string, any>} server
 */
function requireHttpServer(server) {
  if (!server || server.transport !== 'http' || !String(server.connection?.url || '').trim()) {
    const err = new Error('OAuth login is available only for HTTP MCP servers with a URL');
    /** @type {any} */ (err).code = 'VALIDATION';
    throw err;
  }
}

/**
 * Starts (or silently completes) the login. Returns the URL to open in the browser, or
 * `{ authorized: true }` when stored tokens are still usable.
 *
 * @param {Record<string, any>} server
 * @param {string} origin  Cretli origin as the browser sees it, e.g. https://cretli.example:3011
 * @param {{ fetchFn?: typeof fetch, manual?: boolean }} [options]  `manual` forces the paste-the-URL flow
 * @returns {Promise<{ authorized: true } | { authorized: false, authorizeUrl: string, manual?: boolean }>}
 */
export async function startMcpOAuth(server, origin, options = {}) {
  if (server?.oauth) return startMcpSecretOAuth(server, origin, options);
  requireHttpServer(server);
  const redirectUri = new URL(MCP_OAUTH_CALLBACK_PATH, origin).toString();
  const stored = getMcpSecrets(server.id);
  const state = randomBytes(24).toString('base64url');
  /** @type {Record<string, string | null>} */
  const patch = {
    [MCP_OAUTH_KEYS.redirect]: redirectUri,
    [MCP_OAUTH_KEYS.state]: `${state}:${Date.now() + STATE_TTL_MS}`,
  };
  // A client registered for another callback URL (Cretli opened under another address)
  // cannot use this one; the SDK registers a new client.
  if (stored[MCP_OAUTH_KEYS.redirect] && stored[MCP_OAUTH_KEYS.redirect] !== redirectUri) {
    patch[MCP_OAUTH_KEYS.client] = null;
  }
  await patchMcpServerSecrets(server.id, patch);

  /** @type {URL | null} */
  let authorizationUrl = null;
  const provider = createMcpOAuthProvider(server, {
    redirectUrl: redirectUri,
    state,
    onAuthorizationUrl: (url) => {
      authorizationUrl = url;
    },
  });
  const result = await auth(provider, {
    serverUrl: String(server.connection.url),
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
  });
  if (result === 'AUTHORIZED') {
    await patchMcpServerSecrets(server.id, { [MCP_OAUTH_KEYS.state]: null });
    return { authorized: true };
  }
  if (!authorizationUrl) throw new Error('The authorization server did not return a login URL');
  return { authorized: false, authorizeUrl: String(authorizationUrl) };
}

/**
 * Finds the server waiting for this `state` (unexpired).
 *
 * @param {string} state
 * @returns {string | null} server id
 */
export function findMcpServerIdByOAuthState(state) {
  return findMcpOAuthState(state)?.serverId ?? null;
}

/**
 * Like {@link findMcpServerIdByOAuthState}, but also reports a login that already finished
 * with this state, so a reloaded callback page shows "connected" instead of an error.
 *
 * @param {string} state
 * @returns {{ serverId: string, done: boolean } | null}
 */
export function findMcpOAuthState(state) {
  const wanted = String(state || '');
  if (!wanted) return null;
  for (const [serverId, bag] of Object.entries(loadMcpSecretsDocument().secrets)) {
    const [value, expires, mark] = String(bag?.[MCP_OAUTH_KEYS.state] || '').split(':');
    if (value && value === wanted && Number(expires) > Date.now()) return { serverId, done: mark === 'done' };
  }
  return null;
}

/**
 * Exchanges the authorization code from the browser redirect for tokens.
 *
 * @param {Record<string, any>} server
 * @param {string} code
 * @param {{ fetchFn?: typeof fetch }} [options]
 * @returns {Promise<void>}
 */
export async function finishMcpOAuth(server, code, options = {}) {
  if (server?.oauth) return finishMcpSecretOAuth(server, code, options);
  requireHttpServer(server);
  const pending = String(getMcpSecrets(server.id)[MCP_OAUTH_KEYS.state] || '');
  const provider = createMcpOAuthProvider(server);
  const result = await auth(provider, {
    serverUrl: String(server.connection.url),
    authorizationCode: String(code || ''),
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
  });
  // The state cannot be used again, but stays recognisable (marked done) until it expires,
  // so a reloaded callback page reports success instead of "unknown request".
  const [stateValue, stateExpires] = pending.split(':');
  await patchMcpServerSecrets(server.id, {
    [MCP_OAUTH_KEYS.state]: stateValue && stateExpires ? `${stateValue}:${stateExpires}:done` : null,
    [MCP_OAUTH_KEYS.verifier]: null,
  });
  if (result !== 'AUTHORIZED') throw new Error('The authorization server did not issue tokens');
}

/**
 * Forgets tokens and the registered client (log out on the Cretli side).
 *
 * @param {string} serverId
 * @param {Record<string, any>} [server]  When it has an `oauth` block, its refresh token is forgotten too.
 * @returns {Promise<void>}
 */
export async function clearMcpOAuth(serverId, server) {
  /** @type {Record<string, null>} */
  const patch = {};
  for (const key of Object.values(MCP_OAUTH_KEYS)) patch[key] = null;
  if (server?.oauth?.refreshTokenKey) patch[server.oauth.refreshTokenKey] = null;
  await patchMcpServerSecrets(serverId, patch);
}

/**
 * @param {string} message
 * @param {string} [code]
 * @returns {Error}
 */
function oauthError(message, code = 'VALIDATION') {
  const err = new Error(message);
  /** @type {any} */ (err).code = code;
  return err;
}

/** Host suffixes that are never public domains; Google rejects redirects to them. */
const PRIVATE_HOST_SUFFIXES = ['.local', '.lan', '.internal', '.home', '.localdomain', '.intranet', '.corp'];

/**
 * Whether the provider may redirect the browser to this Cretli origin: loopback, or https
 * on a public-looking domain name. Providers (Google) refuse IP addresses, private
 * networks and unqualified names as redirect hosts even over https.
 *
 * @param {string} origin
 * @returns {boolean}
 */
function originAllowsCallback(origin) {
  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();
    if (url.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(host);
    if (url.protocol !== 'https:') return false;
    if (host.startsWith('[') || /^\d+(\.\d+){3}$/.test(host)) return false;
    return host.includes('.') && !PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  } catch {
    return false;
  }
}

/**
 * Starts the OAuth 2.0 authorization-code login of a stdio server with an `oauth` block.
 * Uses Cretli's own callback when the provider can reach it (https or loopback origin),
 * otherwise the manual flow (see {@link MCP_OAUTH_MANUAL_REDIRECT_URI}).
 *
 * @param {Record<string, any>} server
 * @param {string} origin
 * @param {{ manual?: boolean }} [options]
 * @returns {Promise<{ authorized: false, authorizeUrl: string, manual: boolean }>}
 */
export async function startMcpSecretOAuth(server, origin, options = {}) {
  const cfg = server?.oauth;
  if (!cfg) throw oauthError('This server has no OAuth configuration');
  const secrets = getMcpSecrets(server.id);
  const clientId = String(secrets[cfg.clientIdKey] || '').trim();
  if (!clientId) {
    throw oauthError(`Set the "${cfg.clientIdKey}" secret (OAuth client ID) before logging in`);
  }
  const manual = options.manual === true || !originAllowsCallback(origin);
  const redirectUri = manual ? MCP_OAUTH_MANUAL_REDIRECT_URI : new URL(MCP_OAUTH_CALLBACK_PATH, origin).toString();
  const state = randomBytes(24).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');

  const url = new URL(cfg.authorizationUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  if (cfg.scopes.length) url.searchParams.set('scope', cfg.scopes.join(' '));
  url.searchParams.set('state', state);
  if (cfg.pkce) {
    url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
    url.searchParams.set('code_challenge_method', 'S256');
  }
  if (cfg.loginHint) url.searchParams.set('login_hint', cfg.loginHint);
  for (const [key, value] of Object.entries(cfg.extraAuthParams || {})) url.searchParams.set(key, value);

  await patchMcpServerSecrets(server.id, {
    [MCP_OAUTH_KEYS.redirect]: redirectUri,
    [MCP_OAUTH_KEYS.state]: `${state}:${Date.now() + STATE_TTL_MS}`,
    [MCP_OAUTH_KEYS.verifier]: verifier,
  });
  return { authorized: false, authorizeUrl: url.toString(), manual };
}

/**
 * E-mail claim of an OpenID Connect ID token. The token came straight from the token
 * endpoint over TLS, so the payload is read without verifying the signature.
 *
 * @param {unknown} idToken
 * @returns {string}
 */
function emailFromIdToken(idToken) {
  const payload = String(idToken || '').split('.')[1];
  if (!payload) return '';
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof claims?.email === 'string' ? claims.email.trim() : '';
  } catch {
    return '';
  }
}

/** Scopes the provider adds on its own or that only identify the account. */
const IDENTITY_SCOPES = new Set(['openid', 'email', 'profile']);

/**
 * Exchanges the authorization code for tokens and stores the refresh token in the secret
 * named by `oauth.refreshTokenKey`. Nothing is stored when the login is unusable (wrong
 * account, missing refresh token, partial consent), so a working token is never replaced
 * by a broken one.
 *
 * @param {Record<string, any>} server
 * @param {string} code
 * @param {{ fetchFn?: typeof fetch }} [options]
 * @returns {Promise<{ account: string }>}
 */
export async function finishMcpSecretOAuth(server, code, options = {}) {
  const cfg = server?.oauth;
  if (!cfg) throw oauthError('This server has no OAuth configuration');
  const secrets = getMcpSecrets(server.id);
  const pending = String(secrets[MCP_OAUTH_KEYS.state] || '');
  const verifier = String(secrets[MCP_OAUTH_KEYS.verifier] || '');
  const redirectUri = String(secrets[MCP_OAUTH_KEYS.redirect] || '');
  if (!String(code || '').trim()) throw oauthError('The authorization response contains no code');
  if (!redirectUri || (cfg.pkce && !verifier)) throw oauthError('The login was not started or has expired; start it again');

  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: String(code),
    redirect_uri: redirectUri,
    client_id: String(secrets[cfg.clientIdKey] || ''),
  });
  const clientSecret = String(secrets[cfg.clientSecretKey] || '');
  if (clientSecret) form.set('client_secret', clientSecret);
  if (cfg.pkce) form.set('code_verifier', verifier);

  const doFetch = options.fetchFn || fetch;
  const response = await doFetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form,
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
  });
  /** @type {any} */
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body?.access_token) {
    const reason = body?.error_description || body?.error || `HTTP ${response.status}`;
    throw oauthError(`The token endpoint refused the code: ${reason}`, 'OAUTH_TOKEN_ERROR');
  }
  if (!body.refresh_token) {
    throw oauthError(
      'The provider issued no refresh token. Revoke Cretli\'s access in the account\'s security settings '
      + '(Google: myaccount.google.com/permissions) and log in again.',
      'OAUTH_NO_REFRESH_TOKEN',
    );
  }

  const granted = new Set(String(body.scope || '').split(/\s+/).filter(Boolean));
  const missing = body.scope
    ? cfg.scopes.filter((scope) => !IDENTITY_SCOPES.has(scope) && !granted.has(scope))
    : [];
  if (missing.length) {
    throw oauthError(`Not every permission was granted (missing: ${missing.join(', ')}). Log in again and keep all boxes ticked.`, 'OAUTH_SCOPE_MISSING');
  }

  const account = emailFromIdToken(body.id_token);
  const hint = String(cfg.loginHint || '');
  if (hint.includes('@') && account && account.toLowerCase() !== hint.toLowerCase()) {
    throw oauthError(`Logged in as ${account}, but this server expects ${hint}. Log in again with the right account.`, 'OAUTH_WRONG_ACCOUNT');
  }

  const [stateValue, stateExpires] = pending.split(':');
  await patchMcpServerSecrets(server.id, {
    [cfg.refreshTokenKey]: String(body.refresh_token),
    [MCP_OAUTH_KEYS.account]: account || null,
    // Single-use, but still recognisable until it expires (a reloaded callback shows "connected").
    [MCP_OAUTH_KEYS.state]: stateValue && stateExpires ? `${stateValue}:${stateExpires}:done` : null,
    [MCP_OAUTH_KEYS.verifier]: null,
  });
  return { account };
}

/**
 * Completes the manual flow from the URL the browser ended on after the redirect (or its
 * query string). The `state` in it must match the pending login.
 *
 * @param {Record<string, any>} server
 * @param {string} redirected
 * @param {{ fetchFn?: typeof fetch }} [options]
 * @returns {Promise<{ account: string }>}
 */
export async function completeMcpOAuthFromRedirect(server, redirected, options = {}) {
  if (!server?.oauth) throw oauthError('This server has no OAuth configuration');
  const raw = String(redirected || '').trim();
  let params;
  try {
    params = raw.includes('://') ? new URL(raw).searchParams : new URLSearchParams(raw.replace(/^[^?]*\?/, ''));
  } catch {
    throw oauthError('That is not a valid address');
  }
  const pending = findMcpOAuthState(params.get('state') || '');
  if (!pending || pending.serverId !== server.id) {
    throw oauthError('Unknown or expired login request. Start the login again.');
  }
  if (params.get('error')) {
    throw oauthError(`Authorization was not granted: ${params.get('error_description') || params.get('error')}`);
  }
  if (pending.done) return { account: getMcpSecretOAuthState(server).account };
  return finishMcpSecretOAuth(server, params.get('code') || '', options);
}
