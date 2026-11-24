import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import express from 'express';
import { saveSettings } from '../lib/persist/settings.js';
import { resolveDataPath } from '../lib/runtime-paths.js';
import {
  createExternalMcpClient,
  createExternalMcpOAuthGrant,
  issueExternalMcpOAuthTokens,
  listExternalMcpClients,
  refreshExternalMcpOAuthTokens,
  rotateExternalMcpClientToken,
  verifyExternalMcpToken,
} from '../lib/mcp/mcp-external-clients.js';
import { resetOAuthRegistryMemory } from '../lib/mcp/mcp-oauth-registry.js';
import { registerExternalMcpRoutes } from '../lib/routes/mcp-external-routes.js';

const auth = await import('../lib/auth.js');

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-oauth-ws-'));
const REDIRECT = 'http://127.0.0.1:53682/callback';
/** @type {http.Server} */
let server;
let baseUrl = '';
let humanCookie = '';
/** Whether the consenting browser counts as running on the server machine. */
let browserLocal = true;

before(async () => {
  assert.ok(ISOLATED_DATA_DIR);
  assert.equal(auth.setPassword('test-password-for-oauth').ok, true);
  humanCookie = `cr_session=${encodeURIComponent(auth.createSession())}`;
  const app = express();
  app.use((req, res, next) => (req.method === 'GET' || req.method === 'HEAD' ? next() : express.json()(req, res, next)));
  registerExternalMcpRoutes(app, { oauth: { rateLimit: false, browserIsLocal: () => browserLocal } });
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  fs.rmSync(workspace, { recursive: true, force: true });
});

beforeEach(() => {
  browserLocal = true;
  saveSettings({ externalMcpEnabled: true });
  fs.rmSync(resolveDataPath('mcp-external-clients.json'), { force: true });
  fs.rmSync(resolveDataPath('mcp-oauth-clients.json'), { force: true });
  resetOAuthRegistryMemory();
});

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** @param {string} cookie */
function csrfFor(cookie) {
  const token = decodeURIComponent(cookie.split('=')[1]);
  return auth.getCsrfTokenForSessionToken(token) || '';
}

async function register(body = {}) {
  const res = await fetch(`${baseUrl}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude Code', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', ...body }),
  });
  return { status: res.status, json: await res.json() };
}

/**
 * @param {string} clientId
 * @param {string} challenge
 * @param {string} [cookie]
 */
async function openConsent(clientId, challenge, cookie = humanCookie) {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
  });
  const res = await fetch(`${baseUrl}/oauth/authorize?${query}`, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
  const html = await res.text();
  const requestId = html.match(/name="request" value="([^"]+)"/)?.[1] || '';
  return { res, html, requestId };
}

/**
 * @param {Record<string, string>} fields
 * @param {string} [cookie]
 */
async function submitConsent(fields, cookie = humanCookie) {
  return fetch(`${baseUrl}/oauth/consent`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ csrf: csrfFor(cookie), decision: 'approve', name: 'Claude Code', folder: workspace, mode: 'operator', ...fields }),
    redirect: 'manual',
  });
}

/** @param {Record<string, string>} fields */
async function token(fields) {
  const res = await fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
  return { status: res.status, json: await res.json() };
}

/** @param {string} accessToken */
async function listTools(accessToken) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  return { status: res.status, header: res.headers.get('www-authenticate') || '', json: await res.json() };
}

async function authorizeFully() {
  const registered = await register();
  assert.equal(registered.status, 201, JSON.stringify(registered.json));
  const { verifier, challenge } = pkce();
  const consent = await openConsent(registered.json.client_id, challenge);
  assert.equal(consent.res.status, 200);
  const approved = await submitConsent({ request: consent.requestId });
  assert.equal(approved.status, 302);
  const location = new URL(approved.headers.get('location') || '');
  assert.equal(`${location.origin}${location.pathname}`, REDIRECT);
  assert.equal(location.searchParams.get('state'), 'xyz');
  const code = location.searchParams.get('code') || '';
  const tokens = await token({ grant_type: 'authorization_code', client_id: registered.json.client_id, code, code_verifier: verifier, redirect_uri: REDIRECT });
  assert.equal(tokens.status, 200, JSON.stringify(tokens.json));
  return { clientId: registered.json.client_id, code, verifier, tokens: tokens.json };
}

test('/mcp 401 points at the protected resource metadata and discovery documents', async () => {
  const unauthorized = await listTools('nope');
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.header, new RegExp(`resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp"`));

  const prm = await (await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(prm.resource, `${baseUrl}/mcp`);
  assert.deepEqual(prm.authorization_servers, [baseUrl]);

  const asm = await (await fetch(`${baseUrl}/.well-known/oauth-authorization-server`)).json();
  assert.equal(asm.issuer, baseUrl);
  assert.equal(asm.authorization_endpoint, `${baseUrl}/oauth/authorize`);
  assert.equal(asm.token_endpoint, `${baseUrl}/oauth/token`);
  assert.equal(asm.registration_endpoint, `${baseUrl}/oauth/register`);
  assert.deepEqual(asm.code_challenge_methods_supported, ['S256']);
});

test('discovery and registration are off while external MCP is disabled and refuse browser origins', async () => {
  saveSettings({ externalMcpEnabled: false });
  assert.equal((await fetch(`${baseUrl}/.well-known/oauth-authorization-server`)).status, 404);
  assert.equal((await register()).status, 404);
  saveSettings({ externalMcpEnabled: true });
  const fromBrowser = await fetch(`${baseUrl}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ redirect_uris: [REDIRECT] }),
  });
  assert.equal(fromBrowser.status, 403);
});

test('registration accepts only loopback http or https redirect URIs', async () => {
  assert.equal((await register({ redirect_uris: ['http://evil.example/cb'] })).status, 400);
  assert.equal((await register({ redirect_uris: ['myapp://cb'] })).status, 400);
  assert.equal((await register({ redirect_uris: ['https://client.example/cb'] })).status, 201);
});

test('full flow: consent, code exchange, /mcp with the access token, refresh rotation and revoke', async () => {
  const { clientId, code, verifier, tokens } = await authorizeFully();
  assert.match(tokens.access_token, /^cmo1\./);
  assert.match(tokens.refresh_token, /^cmr1\./);
  assert.equal(tokens.expires_in, 3600);

  const tools = await listTools(tokens.access_token);
  assert.equal(tools.status, 200);
  assert.ok(tools.json.result.tools.some((/** @type {any} */ tool) => tool.name.startsWith('operator_')), 'operator mode was granted');

  const [row] = listExternalMcpClients();
  assert.equal(row.kind, 'oauth');
  assert.equal(row.mode, 'operator');
  assert.equal(row.workspaceFolder, path.resolve(workspace));
  for (const field of ['secretHash', 'accessTokens', 'refreshHash', 'previousRefreshHashes']) assert.equal(field in row, false, field);

  // The code is single use.
  const replay = await token({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT });
  assert.equal(replay.json.error, 'invalid_grant');

  const refreshed = await token({ grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.json));
  assert.notEqual(refreshed.json.refresh_token, tokens.refresh_token);
  assert.equal((await listTools(refreshed.json.access_token)).status, 200);

  // A just-rotated token used again (concurrent refresh) is refused but the grant survives.
  const concurrent = await token({ grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token });
  assert.equal(concurrent.json.error, 'invalid_grant');
  assert.equal((await listTools(refreshed.json.access_token)).status, 200);

  // Another registered client cannot use this grant's refresh token.
  const other = await register();
  const foreign = await token({ grant_type: 'refresh_token', client_id: other.json.client_id, refresh_token: refreshed.json.refresh_token });
  assert.equal(foreign.json.error, 'invalid_grant');

  const revoked = await fetch(`${baseUrl}/oauth/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, token: refreshed.json.refresh_token }),
  });
  assert.equal(revoked.status, 200);
  const afterRevoke = await listTools(refreshed.json.access_token);
  assert.equal(afterRevoke.status, 401);
  assert.match(afterRevoke.json.error.message, /revoked/);
});

test('PKCE verifier and redirect_uri must match the authorization request', async () => {
  const registered = await register();
  const { challenge } = pkce();
  const consent = await openConsent(registered.json.client_id, challenge);
  const approved = await submitConsent({ request: consent.requestId });
  const code = new URL(approved.headers.get('location') || '').searchParams.get('code') || '';
  const wrong = await token({ grant_type: 'authorization_code', client_id: registered.json.client_id, code, code_verifier: pkce().verifier, redirect_uri: REDIRECT });
  assert.equal(wrong.json.error, 'invalid_grant');
});

test('authorize without a login redirects to the login page with the request as next', async () => {
  const registered = await register();
  const { res } = await openConsent(registered.json.client_id, pkce().challenge, '');
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get('location') || '', baseUrl);
  assert.equal(location.pathname, '/login');
  assert.match(location.searchParams.get('next') || '', /^\/oauth\/authorize\?/);
});

test('consent page is not frameable and needs the session CSRF token', async () => {
  const registered = await register();
  const consent = await openConsent(registered.json.client_id, pkce().challenge);
  assert.equal(consent.res.headers.get('x-frame-options'), 'DENY');
  assert.match(consent.res.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  assert.match(consent.html, /Claude Code/);
  const forged = await fetch(`${baseUrl}/oauth/consent`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: humanCookie },
    body: new URLSearchParams({ request: consent.requestId, csrf: 'wrong', decision: 'approve', name: 'x', folder: workspace, mode: 'operator' }),
    redirect: 'manual',
  });
  assert.equal(forged.status, 403);
  assert.equal(listExternalMcpClients().length, 0);
});

test('a pending request belongs to the session that opened it', async () => {
  const registered = await register();
  const consent = await openConsent(registered.json.client_id, pkce().challenge);
  const otherCookie = `cr_session=${encodeURIComponent(auth.createSession())}`;
  const res = await submitConsent({ request: consent.requestId }, otherCookie);
  assert.equal(res.status, 400);
  assert.equal(listExternalMcpClients().length, 0);
});

test('agent sessions cannot approve an MCP client', async () => {
  const registered = await register();
  const agentCookie = `cr_session=${encodeURIComponent(auth.createSession({ agentSession: true }))}`;
  const consent = await openConsent(registered.json.client_id, pkce().challenge, agentCookie);
  assert.equal(consent.res.status, 302);
  assert.equal(new URL(consent.res.headers.get('location') || '').searchParams.get('error'), 'access_denied');
  assert.equal(listExternalMcpClients().length, 0);
});

test('deny redirects with access_denied; an invalid folder re-renders the form', async () => {
  const registered = await register();
  const first = await openConsent(registered.json.client_id, pkce().challenge);
  const denied = await submitConsent({ request: first.requestId, decision: 'deny' });
  const location = new URL(denied.headers.get('location') || '');
  assert.equal(location.searchParams.get('error'), 'access_denied');
  assert.equal(location.searchParams.get('state'), 'xyz');

  const second = await openConsent(registered.json.client_id, pkce().challenge);
  const invalid = await submitConsent({ request: second.requestId, folder: '/definitely/missing/folder' });
  assert.equal(invalid.status, 400);
  const html = await invalid.text();
  assert.match(html, /existing directory/);
  const retryId = html.match(/name="request" value="([^"]+)"/)?.[1] || '';
  const retried = await submitConsent({ request: retryId });
  assert.equal(retried.status, 302);
  assert.ok(new URL(retried.headers.get('location') || '').searchParams.get('code'));
});

test('grant expiry slides on refresh, stays capped, and reuse after the grace window revokes it', () => {
  const start = Date.UTC(2026, 0, 1);
  const grant = createExternalMcpOAuthGrant({ name: 'c', workspaceFolder: workspace, mode: 'plan', oauthClientId: 'dcr-1' }, { now: start });
  const first = issueExternalMcpOAuthTokens(grant.id, 'dcr-1', { now: start });
  const day = 24 * 60 * 60 * 1000;
  assert.throws(() => verifyExternalMcpToken(first.access_token, { now: start + 2 * 60 * 60 * 1000 }), /access token expired/);
  const later = start + 25 * day;
  const second = refreshExternalMcpOAuthTokens(first.refresh_token, 'dcr-1', { now: later });
  const row = listExternalMcpClients().find((client) => client.id === grant.id);
  assert.equal(row?.expiresAt, new Date(later + 30 * day).toISOString());

  // Expired access tokens are dropped on the next refresh; the new one works.
  assert.throws(() => verifyExternalMcpToken(first.access_token, { now: later }), /Invalid/);
  assert.equal(verifyExternalMcpToken(second.access_token, { now: later }).id, grant.id);

  assert.throws(() => refreshExternalMcpOAuthTokens(first.refresh_token, 'dcr-1', { now: later + 5 * 60 * 1000 }), /reuse detected/);
  assert.throws(() => refreshExternalMcpOAuthTokens(second.refresh_token, 'dcr-1', { now: later + 6 * 60 * 1000 }), /revoked/);
});

test('an idle grant expires and a grant never outlives its absolute cap', () => {
  const start = Date.UTC(2026, 0, 1);
  const day = 24 * 60 * 60 * 1000;
  const grant = createExternalMcpOAuthGrant({ name: 'c', workspaceFolder: workspace, mode: 'plan', oauthClientId: 'dcr-2' }, { now: start });
  let pair = issueExternalMcpOAuthTokens(grant.id, 'dcr-2', { now: start });
  assert.throws(() => refreshExternalMcpOAuthTokens(pair.refresh_token, 'dcr-2', { now: start + 31 * day }), /expired/);

  const capped = createExternalMcpOAuthGrant({ name: 'c', workspaceFolder: workspace, mode: 'plan', oauthClientId: 'dcr-3' }, { now: start });
  pair = issueExternalMcpOAuthTokens(capped.id, 'dcr-3', { now: start });
  for (let at = start + 20 * day; at < start + 365 * day; at += 20 * day) {
    pair = refreshExternalMcpOAuthTokens(pair.refresh_token, 'dcr-3', { now: at });
  }
  const row = listExternalMcpClients().find((client) => client.id === capped.id);
  assert.equal(row?.expiresAt, new Date(start + 365 * day).toISOString());
});

test('static tokens keep working and the two token kinds do not cross', () => {
  const created = createExternalMcpClient({ name: 'static', workspaceFolder: workspace, mode: 'plan' });
  assert.equal(verifyExternalMcpToken(created.token).kind, 'token');
  const forgedAccess = created.token.replace(/^cmx1\./, 'cmo1.');
  assert.throws(() => verifyExternalMcpToken(forgedAccess), /Invalid/);

  const grant = createExternalMcpOAuthGrant({ name: 'o', workspaceFolder: workspace, mode: 'plan', oauthClientId: 'dcr-4' });
  const pair = issueExternalMcpOAuthTokens(grant.id, 'dcr-4');
  assert.throws(() => verifyExternalMcpToken(pair.access_token.replace(/^cmo1\./, 'cmx1.')), /Invalid/);
  assert.throws(() => verifyExternalMcpToken(pair.refresh_token), /Invalid/);
  assert.throws(() => rotateExternalMcpClientToken(grant.id), /OAuth clients/);
});

/**
 * Loopback HTTP server standing in for the MCP client's OAuth callback.
 *
 * @param {number} status
 */
async function startCallbackServer(status = 200) {
  /** @type {URL[]} */
  const hits = [];
  const callback = http.createServer((req, res) => {
    hits.push(new URL(req.url || '/', 'http://127.0.0.1'));
    res.writeHead(status, { 'content-type': 'text/plain' }).end('ok');
  });
  await new Promise((resolve) => callback.listen(0, '127.0.0.1', () => resolve(undefined)));
  const port = /** @type {import('node:net').AddressInfo} */ (callback.address()).port;
  return {
    hits,
    redirectUri: `http://127.0.0.1:${port}/callback`,
    close: () => new Promise((resolve) => callback.close(() => resolve(undefined))),
  };
}

/**
 * @param {string} redirectUri
 * @param {string} challenge
 */
async function openConsentFor(redirectUri, challenge) {
  const registered = await register({ redirect_uris: [redirectUri] });
  assert.equal(registered.status, 201, JSON.stringify(registered.json));
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: registered.json.client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
  });
  const res = await fetch(`${baseUrl}/oauth/authorize?${query}`, { headers: { cookie: humanCookie }, redirect: 'manual' });
  const html = await res.text();
  return { clientId: registered.json.client_id, requestId: html.match(/name="request" value="([^"]+)"/)?.[1] || '' };
}

test('consent from another device: the server delivers the code to the loopback callback', async () => {
  browserLocal = false;
  const callback = await startCallbackServer();
  try {
    const { verifier, challenge } = pkce();
    const consent = await openConsentFor(callback.redirectUri, challenge);
    const approved = await submitConsent({ request: consent.requestId });
    assert.equal(approved.status, 200);
    assert.match(await approved.text(), /MCP client connected/);
    assert.equal(callback.hits.length, 1);
    const hit = callback.hits[0];
    assert.equal(hit.pathname, '/callback');
    assert.equal(hit.searchParams.get('state'), 'xyz');
    const tokens = await token({
      grant_type: 'authorization_code',
      client_id: consent.clientId,
      code: hit.searchParams.get('code') || '',
      code_verifier: verifier,
      redirect_uri: callback.redirectUri,
    });
    assert.equal(tokens.status, 200, JSON.stringify(tokens.json));
  } finally {
    await callback.close();
  }
});

test('consent from another device: a denial is delivered to the callback too', async () => {
  browserLocal = false;
  const callback = await startCallbackServer();
  try {
    const consent = await openConsentFor(callback.redirectUri, pkce().challenge);
    const denied = await submitConsent({ request: consent.requestId, decision: 'deny' });
    assert.equal(denied.status, 200);
    assert.match(await denied.text(), /Access denied/);
    assert.equal(callback.hits[0]?.searchParams.get('error'), 'access_denied');
  } finally {
    await callback.close();
  }
});

test('the browser redirect stays when delivery fails or the browser is on the server machine', async () => {
  // Nothing listens on REDIRECT: delivery fails and the browser is redirected.
  browserLocal = false;
  const unreachable = await authorizeFully();
  assert.ok(unreachable.code);

  // Callback answers with an error status: fall back to the redirect.
  const failing = await startCallbackServer(500);
  try {
    const consent = await openConsentFor(failing.redirectUri, pkce().challenge);
    const res = await submitConsent({ request: consent.requestId });
    assert.equal(res.status, 302);
    assert.ok(new URL(res.headers.get('location') || '').searchParams.get('code'));
  } finally {
    await failing.close();
  }

  // A local browser is redirected without a server-side call.
  browserLocal = true;
  const local = await startCallbackServer();
  try {
    const consent = await openConsentFor(local.redirectUri, pkce().challenge);
    const res = await submitConsent({ request: consent.requestId });
    assert.equal(res.status, 302);
    assert.equal(local.hits.length, 0);
  } finally {
    await local.close();
  }
});

test('the server never delivers to its own port or to a non-loopback redirect', async () => {
  browserLocal = false;
  const ownPort = new URL(baseUrl).port;
  const ownRedirect = `http://127.0.0.1:${ownPort}/api/settings`;
  const consent = await openConsentFor(ownRedirect, pkce().challenge);
  const res = await submitConsent({ request: consent.requestId });
  assert.equal(res.status, 302);
  assert.ok((res.headers.get('location') || '').startsWith(ownRedirect));

  const httpsConsent = await openConsentFor('https://client.example/cb', pkce().challenge);
  const httpsRes = await submitConsent({ request: httpsConsent.requestId });
  assert.equal(httpsRes.status, 302);
  assert.ok((httpsRes.headers.get('location') || '').startsWith('https://client.example/cb'));
});
