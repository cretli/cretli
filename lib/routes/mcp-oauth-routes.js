/**
 * OAuth 2.1 for the external `/mcp` endpoint, so MCP clients (Claude Code,
 * Codex, Cursor) log in through the browser and renew access themselves
 * instead of carrying a static `cmx1` token that expires.
 *
 * Cretli is both the authorization server and the protected resource:
 *
 * - discovery: `/.well-known/oauth-protected-resource[/mcp]` (RFC 9728) and
 *   `/.well-known/oauth-authorization-server` (RFC 8414), built per request
 *   from the origin the client used (Cretli is reached by LAN IP, hostname or
 *   localhost); `/mcp` answers 401 with `WWW-Authenticate: Bearer
 *   resource_metadata=…` so clients find them;
 * - `/oauth/register` (RFC 7591), `/oauth/authorize` (PKCE S256 only),
 *   `/oauth/token` (authorization_code, refresh_token), `/oauth/revoke`
 *   (RFC 7009) — the request handling comes from the MCP SDK, the decisions
 *   from the provider below;
 * - the consent page needs a Cretli login session. The user picks the
 *   workspace folder and mode (default `plan`); approving creates an `oauth`
 *   client row next to the Settings tokens (same revoke, mode change, audit).
 *   When that browser is on another device, the server calls the client's
 *   loopback callback itself (the MCP client runs next to Cretli), so a login
 *   can be approved from a phone.
 *
 * Guards: the Settings switch `externalMcpEnabled` for everything; the
 * machine-to-machine endpoints (metadata, register, token, revoke) also
 * refuse browser `Origin` headers and non-loopback peers unless
 * `externalMcpAllowLan`, like `/mcp`.
 */

import express from 'express';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { revocationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js';
import {
  AccessDeniedError,
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTargetError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import {
  getCsrfTokenForRequest,
  getSessionIdFromRequest,
  isAuthConfigured,
  isAuthenticated,
  isBrowserOwnerSessionActive,
} from '../auth.js';
import { isLoopbackAddress } from '../local-login.js';
import { msg } from '../messages.js';
import { loadSettings } from '../persist/settings.js';
import {
  createExternalMcpOAuthGrant,
  EXTERNAL_MCP_MODES,
  ExternalMcpClientError,
  issueExternalMcpOAuthTokens,
  listExternalMcpClients,
  refreshExternalMcpOAuthTokens,
  revokeExternalMcpClient,
  revokeExternalMcpOAuthToken,
  verifyExternalMcpToken,
} from '../mcp/mcp-external-clients.js';
import {
  consumeAuthorizationCode,
  createAuthorizationCode,
  createPendingAuthorization,
  getRegisteredOAuthClient,
  OAuthRegistryError,
  peekAuthorizationCode,
  registerOAuthClient,
  takePendingAuthorization,
} from '../mcp/mcp-oauth-registry.js';

export const OAUTH_BASE_PATH = '/oauth';
export const OAUTH_AUTHORIZE_PATH = `${OAUTH_BASE_PATH}/authorize`;
const OAUTH_CONSENT_PATH = `${OAUTH_BASE_PATH}/consent`;
const MCP_PATH = '/mcp';
const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';
const AUTH_SERVER_METADATA_PATH = '/.well-known/oauth-authorization-server';

/**
 * Origin the client used to reach Cretli (scheme + host[:port]).
 *
 * @param {import('express').Request} req
 */
export function requestOrigin(req) {
  return `${req.protocol}://${req.get('host') || 'localhost'}`;
}

/** @param {import('express').Request} req */
export function protectedResourceMetadataUrl(req) {
  return `${requestOrigin(req)}${PROTECTED_RESOURCE_PATH}${MCP_PATH}`;
}

/** @param {import('express').Request} req */
function authorizationServerMetadata(req) {
  const origin = requestOrigin(req);
  return {
    issuer: origin,
    authorization_endpoint: `${origin}${OAUTH_AUTHORIZE_PATH}`,
    token_endpoint: `${origin}${OAUTH_BASE_PATH}/token`,
    registration_endpoint: `${origin}${OAUTH_BASE_PATH}/register`,
    revocation_endpoint: `${origin}${OAUTH_BASE_PATH}/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
  };
}

/** @param {import('express').Request} req */
function protectedResourceMetadata(req) {
  const origin = requestOrigin(req);
  return {
    resource: `${origin}${MCP_PATH}`,
    authorization_servers: [origin],
    bearer_methods_supported: ['header'],
    resource_name: 'Cretli',
  };
}

/**
 * Consent needs a human login: sessions of agents and of the agent-driven
 * Browser panel must never grant themselves a token.
 *
 * @param {import('express').Request} req
 */
function humanSessionId(req) {
  const sessionId = getSessionIdFromRequest(req) || '';
  return sessionId && isBrowserOwnerSessionActive(sessionId) ? sessionId : '';
}

/**
 * A `resource` parameter (RFC 8707) must name this server's `/mcp`.
 *
 * @param {URL | undefined} resource
 */
function assertResource(resource) {
  if (resource && resource.pathname.replace(/\/$/, '') !== MCP_PATH) {
    throw new InvalidTargetError('resource must be the Cretli /mcp endpoint');
  }
}

/**
 * @param {unknown} err
 * @returns {never}
 */
function toInvalidGrant(err) {
  if (err instanceof ExternalMcpClientError) throw new InvalidGrantError(err.message);
  throw err;
}

/** @type {import('@modelcontextprotocol/sdk/server/auth/provider.js').OAuthServerProvider} */
export const cretliOAuthProvider = {
  clientsStore: {
    getClient: (clientId) => /** @type {any} */ (getRegisteredOAuthClient(clientId)),
    registerClient: (client) => {
      try {
        return /** @type {any} */ (registerOAuthClient(client));
      } catch (err) {
        if (err instanceof OAuthRegistryError) throw new InvalidClientMetadataError(err.message);
        throw err;
      }
    },
  },

  async authorize(client, params, res) {
    assertResource(params.resource);
    const req = /** @type {import('express').Request} */ (res.req);
    if (!isAuthConfigured() || !isAuthenticated(req)) {
      res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl || OAUTH_AUTHORIZE_PATH)}`);
      return;
    }
    const sessionId = humanSessionId(req);
    if (!sessionId) throw new AccessDeniedError('Consent requires a human Cretli login session');
    const requestId = createPendingAuthorization({
      oauthClientId: client.client_id,
      clientName: String(client.client_name || ''),
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      resource: params.resource?.href,
      sessionId,
    });
    sendConsentPage(req, res, {
      requestId,
      csrf: getCsrfTokenForRequest(req) || '',
      clientName: String(client.client_name || ''),
      redirectUri: params.redirectUri,
    });
  },

  async challengeForAuthorizationCode(client, authorizationCode) {
    const row = peekAuthorizationCode(authorizationCode);
    if (!row || row.oauthClientId !== client.client_id) throw new InvalidGrantError('Invalid or expired authorization code');
    return row.codeChallenge;
  },

  async exchangeAuthorizationCode(client, authorizationCode, _codeVerifier, redirectUri, resource) {
    const row = consumeAuthorizationCode(authorizationCode);
    if (!row || row.oauthClientId !== client.client_id) throw new InvalidGrantError('Invalid or expired authorization code');
    if (redirectUri !== undefined && redirectUri !== row.redirectUri) throw new InvalidGrantError('redirect_uri does not match the authorization request');
    assertResource(resource);
    try {
      return issueExternalMcpOAuthTokens(row.grantId, client.client_id);
    } catch (err) {
      return toInvalidGrant(err);
    }
  },

  async exchangeRefreshToken(client, refreshToken, _scopes, resource) {
    assertResource(resource);
    try {
      return refreshExternalMcpOAuthTokens(refreshToken, client.client_id);
    } catch (err) {
      return toInvalidGrant(err);
    }
  },

  async verifyAccessToken(token) {
    const info = verifyExternalMcpToken(token);
    return { token, clientId: String(info.oauthClientId || info.id), scopes: [], extra: { externalClientId: info.id } };
  },

  async revokeToken(client, request) {
    revokeExternalMcpOAuthToken(request.token, client.client_id);
  },
};

/**
 * @param {string} value
 */
function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Folder suggested on the consent page: the one of the most recently created
 * external client, if any.
 */
function suggestedWorkspaceFolder() {
  return listExternalMcpClients().find((client) => client.workspaceFolder)?.workspaceFolder || '';
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{ requestId: string, csrf: string, clientName: string, redirectUri: string, error?: string, folder?: string, mode?: string, name?: string }} view
 */
function sendConsentPage(req, res, view) {
  /** @type {(key: string, vars?: Record<string, string>) => string} */
  const t = (key, vars) => escapeHtml(msg(req, `mcpOauth.${key}`, vars || null));
  let redirectHost = '';
  try {
    redirectHost = new URL(view.redirectUri).host;
  } catch {
    redirectHost = view.redirectUri;
  }
  const displayName = view.clientName || msg(req, 'mcpOauth.unnamedClient');
  const selectedMode = EXTERNAL_MCP_MODES.includes(/** @type {any} */ (view.mode)) ? view.mode : 'plan';
  const modeOptions = EXTERNAL_MCP_MODES
    .map((mode) => `<option value="${mode}"${mode === selectedMode ? ' selected' : ''}>${t(`mode_${mode}`)}</option>`)
    .join('');
  const html = `<!doctype html>
<html lang="${escapeHtml(msg(req, 'mcpOauth.lang'))}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${t('title')}</title>
<style>
  :root { --bg: #f6f6f4; --card: #fff; --text: #1f1f1d; --muted: #66665f; --border: #d9d9d3; --accent: #2f6fde; --danger: #b3261e; }
  @media (prefers-color-scheme: dark) { :root { --bg: #18181a; --card: #222225; --text: #ececea; --muted: #a2a29c; --border: #3a3a3e; --accent: #7aa7ff; --danger: #ff8a80; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 480px; margin: 48px auto; padding: 0 16px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { margin: 0 0 12px; }
  .muted { color: var(--muted); font-size: 13px; }
  label { display: block; font-weight: 600; margin: 16px 0 6px; }
  input, select { width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text); font: inherit; }
  .row { display: flex; gap: 8px; margin-top: 24px; }
  button { flex: 1; padding: 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--card); color: var(--text); font: inherit; cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .error { color: var(--danger); }
  code { font-size: 13px; word-break: break-all; }
</style>
</head>
<body>
<main>
  <form class="card" method="post" action="${OAUTH_CONSENT_PATH}">
    <h1>${t('heading', { client: displayName })}</h1>
    <p>${t('intro')}</p>
    <p class="muted">${t('redirect')} <code>${escapeHtml(redirectHost)}</code></p>
    ${view.error ? `<p class="error" role="alert">${escapeHtml(view.error)}</p>` : ''}
    <input type="hidden" name="request" value="${escapeHtml(view.requestId)}">
    <input type="hidden" name="csrf" value="${escapeHtml(view.csrf)}">
    <label for="name">${t('name')}</label>
    <input id="name" name="name" maxlength="64" required value="${escapeHtml(view.name || displayName)}">
    <label for="folder">${t('folder')}</label>
    <input id="folder" name="folder" list="folders" required autocomplete="off" value="${escapeHtml(view.folder ?? suggestedWorkspaceFolder())}">
    <datalist id="folders"></datalist>
    <p class="muted">${t('folderHint')}</p>
    <label for="mode">${t('mode')}</label>
    <select id="mode" name="mode">${modeOptions}</select>
    <p class="muted">${t('modeHint')}</p>
    <div class="row">
      <button type="submit" name="decision" value="deny">${t('deny')}</button>
      <button type="submit" name="decision" value="approve" class="primary">${t('approve')}</button>
    </div>
  </form>
</main>
<script>
(function () {
  fetch('/api/workspaces', { credentials: 'same-origin' }).then(function (res) { return res.json(); }).then(function (body) {
    var list = document.getElementById('folders');
    var seen = {};
    (body && Array.isArray(body.workspaces) ? body.workspaces : []).forEach(function (ws) {
      var paths = [ws && ws.workspaceDir].concat((ws && Array.isArray(ws.folders) ? ws.folders : []).filter(function (f) { return f && f.enabled !== false; }).map(function (f) { return f.resolvedPath; }));
      paths.forEach(function (p) {
        var value = String(p || '').replace(/\\\\/g, '/').replace(/\\/$/, '');
        if (!value || seen[value]) return;
        seen[value] = true;
        var option = document.createElement('option');
        option.value = value;
        list.appendChild(option);
      });
    });
  }).catch(function () {});
})();
</script>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; form-action 'self'");
  res.status(view.error ? 400 : 200).send(html);
}

/**
 * @param {string} redirectUri
 * @param {Record<string, string | undefined>} params
 */
function redirectWith(redirectUri, params) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
  return url.href;
}

const LOOPBACK_REDIRECT_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const CALLBACK_DELIVERY_TIMEOUT_MS = 5000;

/**
 * Loopback callback the Cretli server itself can call: plain `http` on a
 * loopback host and not Cretli's own port.
 *
 * @param {string} redirectUri
 * @param {number | undefined} ownPort
 */
function serverDeliverableCallback(redirectUri, ownPort) {
  let url;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' || !LOOPBACK_REDIRECT_HOSTS.has(url.hostname)) return false;
  return Number(url.port || 80) !== Number(ownPort);
}

/**
 * Calls the client's loopback callback from the Cretli server. Used when the
 * consent was given in a browser on another device (a phone, or a Windows
 * browser in front of WSL): `localhost` in that browser is not the machine the
 * MCP client waits on, while the Cretli server usually is. No cookies, no
 * redirects followed.
 *
 * @param {string} url
 * @returns {Promise<boolean>} true when the callback answered without an error status
 */
async function deliverCallback(url) {
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(CALLBACK_DELIVERY_TIMEOUT_MS) });
    await res.body?.cancel().catch(() => {});
    return res.status < 400;
  } catch {
    return false;
  }
}

/**
 * Finishes the authorization: the server delivers the callback itself when
 * the browser is not on this machine, otherwise (or when delivery fails) the
 * browser is redirected as usual.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string} location
 * @param {'approved' | 'denied'} outcome
 * @param {(req: import('express').Request) => boolean} browserIsLocal
 */
async function finishAuthorization(req, res, location, outcome, browserIsLocal) {
  if (!browserIsLocal(req) && serverDeliverableCallback(location, req.socket?.localPort) && await deliverCallback(location)) {
    return sendDonePage(req, res, outcome);
  }
  return res.redirect(302, location);
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {'approved' | 'denied'} outcome
 */
function sendDonePage(req, res, outcome) {
  /** @type {(key: string) => string} */
  const t = (key) => escapeHtml(msg(req, `mcpOauth.${key}`, null));
  const html = `<!doctype html>
<html lang="${t('lang')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${t('title')}</title>
<style>
  :root { --bg: #f6f6f4; --card: #fff; --text: #1f1f1d; --border: #d9d9d3; }
  @media (prefers-color-scheme: dark) { :root { --bg: #18181a; --card: #222225; --text: #ececea; --border: #3a3a3e; } }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 480px; margin: 48px auto; padding: 0 16px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { margin: 0; }
</style>
</head>
<body>
<main>
  <div class="card" role="status">
    <h1>${t(outcome === 'approved' ? 'deliveredHeading' : 'deniedHeading')}</h1>
    <p>${t(outcome === 'approved' ? 'deliveredBody' : 'deniedBody')}</p>
  </div>
</main>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.status(200).send(html);
}

/** @param {import('express').Request} req */
function defaultBrowserIsLocal(req) {
  return isLoopbackAddress(req.socket?.remoteAddress);
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {(req: import('express').Request) => boolean} browserIsLocal
 */
async function handleConsent(req, res, browserIsLocal) {
  if (loadSettings().externalMcpEnabled !== true) return res.status(403).send(escapeHtml(msg(req, 'mcpOauth.disabled')));
  if (!isAuthConfigured() || !isAuthenticated(req)) return res.status(401).send(escapeHtml(msg(req, 'auth.loginRequired')));
  const body = req.body || {};
  const expectedCsrf = getCsrfTokenForRequest(req) || '';
  if (!expectedCsrf || String(body.csrf || '') !== expectedCsrf) {
    return res.status(403).send(escapeHtml(msg(req, 'auth.invalidCsrf')));
  }
  const sessionId = humanSessionId(req);
  if (!sessionId) return res.status(403).send(escapeHtml(msg(req, 'mcpOauth.humanOnly')));
  const pending = takePendingAuthorization(String(body.request || ''), sessionId);
  if (!pending) return res.status(400).send(escapeHtml(msg(req, 'mcpOauth.expired')));

  if (body.decision !== 'approve') {
    const denied = new AccessDeniedError('The user denied access');
    return finishAuthorization(req, res, redirectWith(pending.redirectUri, {
      error: denied.errorCode,
      error_description: denied.message,
      state: pending.state,
    }), 'denied', browserIsLocal);
  }
  let grant;
  try {
    grant = createExternalMcpOAuthGrant({
      name: body.name,
      workspaceFolder: body.folder,
      mode: body.mode,
      oauthClientId: pending.oauthClientId,
    });
  } catch (err) {
    if (!(err instanceof ExternalMcpClientError)) throw err;
    // Keep the request alive so the user can correct the form.
    const requestId = createPendingAuthorization({ ...pending, sessionId });
    return sendConsentPage(req, res, {
      requestId,
      csrf: expectedCsrf,
      clientName: pending.clientName,
      redirectUri: pending.redirectUri,
      error: err.message,
      folder: String(body.folder || ''),
      mode: String(body.mode || ''),
      name: String(body.name || ''),
    });
  }
  let code;
  try {
    code = createAuthorizationCode({
      oauthClientId: pending.oauthClientId,
      grantId: grant.id,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      resource: pending.resource,
    });
  } catch (err) {
    revokeExternalMcpClient(grant.id);
    throw err;
  }
  return finishAuthorization(req, res, redirectWith(pending.redirectUri, { code, state: pending.state }), 'approved', browserIsLocal);
}

/**
 * Machine-to-machine guard shared with `/mcp`.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function machineEndpointGuard(req, res, next) {
  const settings = loadSettings();
  if (settings.externalMcpEnabled !== true) {
    return res.status(404).json({ error: 'not_found', error_description: 'External MCP access is disabled (Settings → MCP)' });
  }
  if (req.headers.origin) {
    return res.status(403).json({ error: 'access_denied', error_description: 'Browser requests are not accepted on MCP OAuth endpoints' });
  }
  if (!isLoopbackAddress(req.socket?.remoteAddress) && settings.externalMcpAllowLan !== true) {
    return res.status(403).json({ error: 'access_denied', error_description: 'External MCP access is limited to localhost (Settings → MCP)' });
  }
  return next();
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function enabledGuard(req, res, next) {
  if (loadSettings().externalMcpEnabled !== true) {
    return res.status(403).type('text/plain').send(msg(req, 'mcpOauth.disabled'));
  }
  return next();
}

/**
 * @param {import('express').Express} app
 * @param {{ rateLimit?: false, browserIsLocal?: (req: import('express').Request) => boolean }} [options]
 *   `rateLimit: false` disables the SDK limits (tests); `browserIsLocal`
 *   overrides the check that decides whether the consenting browser runs on
 *   this machine (tests).
 */
export function registerMcpOAuthRoutes(app, options = {}) {
  const browserIsLocal = options.browserIsLocal || defaultBrowserIsLocal;
  const rateLimit = options.rateLimit === false ? { rateLimit: /** @type {const} */ (false) } : {};
  const sendJson = (/** @type {(req: import('express').Request) => object} */ build) => (
    /** @type {import('express').Request} */ req,
    /** @type {import('express').Response} */ res,
  ) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(build(req));
  };
  app.get([PROTECTED_RESOURCE_PATH, `${PROTECTED_RESOURCE_PATH}${MCP_PATH}`], machineEndpointGuard, sendJson(protectedResourceMetadata));
  app.get([AUTH_SERVER_METADATA_PATH, `${AUTH_SERVER_METADATA_PATH}${MCP_PATH}`], machineEndpointGuard, sendJson(authorizationServerMetadata));

  app.use(`${OAUTH_BASE_PATH}/register`, machineEndpointGuard, clientRegistrationHandler({
    clientsStore: cretliOAuthProvider.clientsStore,
    // Grants are bound to the client id; an expiring client secret would end them early.
    clientSecretExpirySeconds: 0,
    ...rateLimit,
  }));
  app.use(`${OAUTH_BASE_PATH}/token`, machineEndpointGuard, tokenHandler({ provider: cretliOAuthProvider, ...rateLimit }));
  app.use(`${OAUTH_BASE_PATH}/revoke`, machineEndpointGuard, revocationHandler({ provider: cretliOAuthProvider, ...rateLimit }));
  app.use(OAUTH_AUTHORIZE_PATH, enabledGuard, authorizationHandler({ provider: cretliOAuthProvider, ...rateLimit }));
  app.post(OAUTH_CONSENT_PATH, enabledGuard, express.urlencoded({ extended: false, limit: '16kb' }), (req, res, next) => {
    handleConsent(req, res, browserIsLocal).catch(next);
  });
}
