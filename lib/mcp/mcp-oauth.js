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
 */

import { randomBytes } from 'node:crypto';
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
});

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
 * @param {{ fetchFn?: typeof fetch }} [options]
 * @returns {Promise<{ authorized: true } | { authorized: false, authorizeUrl: string }>}
 */
export async function startMcpOAuth(server, origin, options = {}) {
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
 * @returns {Promise<void>}
 */
export async function clearMcpOAuth(serverId) {
  /** @type {Record<string, null>} */
  const patch = {};
  for (const key of Object.values(MCP_OAUTH_KEYS)) patch[key] = null;
  await patchMcpServerSecrets(serverId, patch);
}
