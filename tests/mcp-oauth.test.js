import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { createMcpServer } from '../lib/mcp/mcp-service.js';
import { loadMcpDocument } from '../lib/persist/mcp-persist.js';
import { normalizeMcpServers } from '../lib/mcp/mcp-config.js';
import { getMcpSecrets } from '../lib/mcp/mcp-secrets.js';
import {
  MCP_OAUTH_KEYS,
  McpOAuthLoginRequiredError,
  clearMcpOAuth,
  createMcpOAuthProvider,
  findMcpServerIdByOAuthState,
  finishMcpOAuth,
  hasMcpOAuthTokens,
  startMcpOAuth,
} from '../lib/mcp/mcp-oauth.js';

/** Minimal OAuth 2.1 authorization server + protected resource, like domq's /mcp. */
function startFakeAuthServer() {
  const calls = { register: [], token: [] };
  const server = http.createServer(async (req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const url = new URL(req.url, base);
    let body = '';
    for await (const chunk of req) body += chunk;
    const json = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      return json(200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['finance:read'] });
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json(200, {
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/oauth/token`,
        registration_endpoint: `${base}/oauth/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    }
    if (url.pathname === '/oauth/register' && req.method === 'POST') {
      const meta = JSON.parse(body);
      calls.register.push(meta);
      return json(201, { ...meta, client_id: `client-${calls.register.length}` });
    }
    if (url.pathname === '/oauth/token' && req.method === 'POST') {
      const form = Object.fromEntries(new URLSearchParams(body));
      calls.token.push(form);
      if (form.grant_type === 'authorization_code' && form.code === 'good-code' && form.code_verifier) {
        return json(200, { access_token: 'access-1', refresh_token: 'refresh-1', token_type: 'Bearer', expires_in: 3600 });
      }
      if (form.grant_type === 'refresh_token' && form.refresh_token === 'refresh-1') {
        return json(200, { access_token: 'access-2', refresh_token: 'refresh-2', token_type: 'Bearer', expires_in: 3600 });
      }
      return json(400, { error: 'invalid_grant' });
    }
    if (url.pathname === '/mcp') {
      res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` });
      return res.end();
    }
    return json(404, { error: 'not_found' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls })));
}

/** @param {string} id */
function rawServer(id) {
  return normalizeMcpServers(loadMcpDocument().servers).find((row) => row.id === id);
}

test('OAuth login: discovery, registration, PKCE login URL, code exchange, refresh, logout', async () => {
  const { server: fake, calls } = await startFakeAuthServer();
  try {
    const base = `http://127.0.0.1:${fake.address().port}`;
    const created = await createMcpServer({
      name: 'domq',
      transport: 'http',
      harnesses: ['claude'],
      connection: { url: `${base}/mcp` },
    }, loadMcpDocument().revision);
    const id = created.server.id;

    const started = await startMcpOAuth(rawServer(id), 'https://cretli.example:3011');
    assert.equal(started.authorized, false);
    const authorizeUrl = new URL(started.authorizeUrl);
    assert.equal(authorizeUrl.origin + authorizeUrl.pathname, `${base}/oauth/authorize`);
    assert.equal(authorizeUrl.searchParams.get('client_id'), 'client-1');
    assert.equal(authorizeUrl.searchParams.get('redirect_uri'), 'https://cretli.example:3011/api/mcp/oauth/callback');
    assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(authorizeUrl.searchParams.get('code_challenge'));
    assert.equal(authorizeUrl.searchParams.get('scope'), 'finance:read');
    assert.deepEqual(calls.register[0].redirect_uris, ['https://cretli.example:3011/api/mcp/oauth/callback']);
    assert.equal(calls.register[0].token_endpoint_auth_method, 'none');

    const state = authorizeUrl.searchParams.get('state');
    assert.equal(findMcpServerIdByOAuthState(state), id);
    assert.equal(findMcpServerIdByOAuthState('other-state'), null);
    assert.equal(hasMcpOAuthTokens(rawServer(id)), false);

    await finishMcpOAuth(rawServer(id), 'good-code');
    const secrets = getMcpSecrets(id);
    assert.equal(JSON.parse(secrets[MCP_OAUTH_KEYS.tokens]).access_token, 'access-1');
    assert.equal(secrets[MCP_OAUTH_KEYS.state], undefined, 'state is single-use');
    assert.equal(secrets[MCP_OAUTH_KEYS.verifier], undefined);
    assert.equal(findMcpServerIdByOAuthState(state), null);
    assert.equal(hasMcpOAuthTokens(rawServer(id)), true);
    // Tokens live only in the secret store, never in the server config.
    assert.doesNotMatch(JSON.stringify(loadMcpDocument()), /access-1|refresh-1/);

    // A second login with stored tokens refreshes silently instead of opening a browser.
    const again = await startMcpOAuth(rawServer(id), 'https://cretli.example:3011');
    assert.equal(again.authorized, true);
    assert.equal(JSON.parse(getMcpSecrets(id)[MCP_OAUTH_KEYS.tokens]).access_token, 'access-2');
    assert.equal(calls.register.length, 1, 'the registered client is reused');

    // Opening Cretli under another address registers a client for the new callback URL.
    await clearMcpOAuth(id);
    assert.deepEqual(Object.keys(getMcpSecrets(id)).filter((key) => key.startsWith('oauth_')), []);
    const moved = await startMcpOAuth(rawServer(id), 'http://localhost:3011');
    assert.equal(new URL(moved.authorizeUrl).searchParams.get('client_id'), 'client-2');
  } finally {
    fake.close();
  }
});

test('background connects never open a browser', async () => {
  const provider = createMcpOAuthProvider({ id: 'missing-server' });
  assert.throws(() => provider.redirectToAuthorization(new URL('https://example.com/authorize')), McpOAuthLoginRequiredError);
});

test('login is refused for stdio servers', async () => {
  await assert.rejects(
    startMcpOAuth({ id: 'x', transport: 'stdio', connection: { command: 'node' } }, 'https://cretli.example'),
    (err) => err.code === 'VALIDATION',
  );
});
