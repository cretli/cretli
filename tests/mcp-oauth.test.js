import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { createMcpServer, publicMcpServer, updateMcpServer } from '../lib/mcp/mcp-service.js';
import { loadMcpDocument } from '../lib/persist/mcp-persist.js';
import { normalizeMcpServers } from '../lib/mcp/mcp-config.js';
import { getMcpSecrets } from '../lib/mcp/mcp-secrets.js';
import {
  MCP_OAUTH_KEYS,
  McpOAuthLoginRequiredError,
  MCP_OAUTH_MANUAL_REDIRECT_URI,
  clearMcpOAuth,
  completeMcpOAuthFromRedirect,
  createMcpOAuthProvider,
  getMcpSecretOAuthState,
  findMcpOAuthState,
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
    assert.match(secrets[MCP_OAUTH_KEYS.state], /:done$/, 'state is single-use');
    assert.equal(secrets[MCP_OAUTH_KEYS.verifier], undefined);
    // A reloaded callback is recognised as an already finished login.
    assert.deepEqual(findMcpOAuthState(state), { serverId: id, done: true });
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

test('login is refused for stdio servers without an oauth block', async () => {
  await assert.rejects(
    startMcpOAuth({ id: 'x', transport: 'stdio', connection: { command: 'node' } }, 'https://cretli.example'),
    (err) => err.code === 'VALIDATION',
  );
});

/** Fake Google-style token endpoint; `idToken` and `scope` control what the login yields. */
function startFakeTokenServer(reply) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push(Object.fromEntries(new URLSearchParams(body)));
    res.writeHead(reply.status || 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls })));
}

/** @param {string} email */
function fakeIdToken(email) {
  return `h.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.s`;
}

async function createGmailServer(tokenUrl, loginHint = 'sklep@example.com') {
  const created = await createMcpServer({
    name: 'Gmail shop',
    transport: 'stdio',
    harnesses: ['claude'],
    connection: {
      command: 'node',
      args: ['gmail.js'],
      env: {
        GOOGLE_CLIENT_ID: { secret: 'GOOGLE_CLIENT_ID' },
        GOOGLE_REFRESH_TOKEN: { secret: 'GOOGLE_REFRESH_TOKEN' },
      },
    },
    oauth: { preset: 'google-gmail', loginHint, tokenUrl },
    secrets: { GOOGLE_CLIENT_ID: 'client-id-1', GOOGLE_CLIENT_SECRET: 'client-secret-1' },
  }, loadMcpDocument().revision);
  return created.server.id;
}

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';

test('secret OAuth: Google preset builds the login URL and stores the refresh token', async () => {
  const { server: fake, calls } = await startFakeTokenServer({
    body: {
      access_token: 'a', refresh_token: 'refresh-secret-1', id_token: fakeIdToken('Sklep@Example.com'),
      scope: `openid email ${[
        'gmail.readonly', 'gmail.send', 'gmail.modify', 'gmail.labels', 'gmail.settings.basic',
      ].map((name) => `https://www.googleapis.com/auth/${name}`).join(' ')}`,
    },
  });
  try {
    const id = await createGmailServer(`http://127.0.0.1:${fake.address().port}/token`);
    const server = rawServer(id);
    assert.equal(server.oauth.preset, 'google-gmail');
    assert.equal(server.oauth.authorizationUrl, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(getMcpSecretOAuthState(server).connected, false);

    const started = await startMcpOAuth(server, 'https://cretli.example:3011');
    assert.equal(started.manual, false);
    const url = new URL(started.authorizeUrl);
    assert.equal(url.searchParams.get('client_id'), 'client-id-1');
    assert.equal(url.searchParams.get('redirect_uri'), 'https://cretli.example:3011/api/mcp/oauth/callback');
    assert.equal(url.searchParams.get('login_hint'), 'sklep@example.com');
    assert.equal(url.searchParams.get('access_type'), 'offline');
    assert.equal(url.searchParams.get('prompt'), 'consent');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.match(url.searchParams.get('scope'), /gmail\.modify/);
    const state = url.searchParams.get('state');
    assert.equal(findMcpServerIdByOAuthState(state), id);

    await finishMcpOAuth(server, 'good-code');
    assert.equal(calls[0].grant_type, 'authorization_code');
    assert.equal(calls[0].code, 'good-code');
    assert.equal(calls[0].client_secret, 'client-secret-1');
    assert.ok(calls[0].code_verifier);
    const state2 = getMcpSecretOAuthState(rawServer(id));
    assert.deepEqual(state2, { connected: true, account: 'Sklep@Example.com' });
    assert.equal(getMcpSecrets(id).GOOGLE_REFRESH_TOKEN, 'refresh-secret-1');
    assert.deepEqual(findMcpOAuthState(state), { serverId: id, done: true });
    assert.doesNotMatch(JSON.stringify(loadMcpDocument()), /refresh-secret-1|client-secret-1/);

    const view = publicMcpServer(rawServer(id));
    assert.equal(view.oauth.connected, true);
    assert.equal(view.oauth.account, 'Sklep@Example.com');

    await clearMcpOAuth(id, rawServer(id));
    assert.equal(getMcpSecrets(id).GOOGLE_REFRESH_TOKEN, undefined);
    assert.equal(getMcpSecrets(id).GOOGLE_CLIENT_ID, 'client-id-1', 'client credentials survive a logout');
    assert.equal(getMcpSecretOAuthState(rawServer(id)).connected, false);
  } finally {
    fake.close();
  }
});

test('secret OAuth: plain-http origins use the manual flow and accept the pasted URL', async () => {
  const { server: fake } = await startFakeTokenServer({
    body: { access_token: 'a', refresh_token: 'refresh-2', id_token: fakeIdToken('sklep@example.com'), scope: `openid email ${GMAIL_SCOPE}` },
  });
  try {
    const id = await createGmailServer(`http://127.0.0.1:${fake.address().port}/token`);
    // The preset needs five scopes; with a narrower server config the grant below is complete.
    await updateMcpServer(id, { oauth: { preset: 'google-gmail', loginHint: 'sklep@example.com', scopes: [GMAIL_SCOPE], tokenUrl: `http://127.0.0.1:${fake.address().port}/token` } }, loadMcpDocument().revision);
    for (const origin of ['https://192.0.2.10:3011', 'https://my-pc:3011', 'https://pc.local:3011']) {
      assert.equal((await startMcpOAuth(rawServer(id), origin)).manual, true, `${origin} cannot be a redirect host`);
    }
    const started = await startMcpOAuth(rawServer(id), 'http://192.0.2.10:3011');
    assert.equal(started.manual, true);
    assert.equal(new URL(started.authorizeUrl).searchParams.get('redirect_uri'), MCP_OAUTH_MANUAL_REDIRECT_URI);
    const state = new URL(started.authorizeUrl).searchParams.get('state');

    await assert.rejects(
      completeMcpOAuthFromRedirect(rawServer(id), `${MCP_OAUTH_MANUAL_REDIRECT_URI}?state=forged&code=x`),
      /Unknown or expired/,
    );
    await assert.rejects(
      completeMcpOAuthFromRedirect(rawServer(id), `${MCP_OAUTH_MANUAL_REDIRECT_URI}?state=${state}&error=access_denied`),
      /not granted/,
    );
    const done = await completeMcpOAuthFromRedirect(rawServer(id), `${MCP_OAUTH_MANUAL_REDIRECT_URI}?state=${state}&code=pasted-code&scope=x`);
    assert.equal(done.account, 'sklep@example.com');
    assert.equal(getMcpSecrets(id).GOOGLE_REFRESH_TOKEN, 'refresh-2');
  } finally {
    fake.close();
  }
});

test('secret OAuth: a wrong account, a missing refresh token or partial consent store nothing', async () => {
  const cases = [
    [{ id_token: fakeIdToken('someone@else.com'), refresh_token: 'r', scope: `openid ${GMAIL_SCOPE}` }, /expects sklep@example\.com/],
    [{ id_token: fakeIdToken('sklep@example.com'), scope: `openid ${GMAIL_SCOPE}` }, /no refresh token/],
    [{ id_token: fakeIdToken('sklep@example.com'), refresh_token: 'r', scope: 'openid email' }, /Not every permission/],
  ];
  for (const [extra, expected] of cases) {
    const { server: fake } = await startFakeTokenServer({ body: { access_token: 'a', ...extra } });
    try {
      const id = await createGmailServer(`http://127.0.0.1:${fake.address().port}/token`);
      await updateMcpServer(id, { oauth: { preset: 'google-gmail', loginHint: 'sklep@example.com', scopes: [GMAIL_SCOPE], tokenUrl: `http://127.0.0.1:${fake.address().port}/token` } }, loadMcpDocument().revision);
      await startMcpOAuth(rawServer(id), 'https://cretli.example');
      await assert.rejects(finishMcpOAuth(rawServer(id), 'code'), expected);
      assert.equal(getMcpSecretOAuthState(rawServer(id)).connected, false);
    } finally {
      fake.close();
    }
  }
});

test('secret OAuth: a token endpoint error and a missing client id are reported', async () => {
  const { server: fake } = await startFakeTokenServer({ status: 400, body: { error: 'invalid_grant', error_description: 'Bad code' } });
  try {
    const id = await createGmailServer(`http://127.0.0.1:${fake.address().port}/token`);
    await startMcpOAuth(rawServer(id), 'https://cretli.example');
    await assert.rejects(finishMcpOAuth(rawServer(id), 'code'), /Bad code/);
  } finally {
    fake.close();
  }
  const created = await createMcpServer({
    name: 'No client',
    transport: 'stdio',
    harnesses: ['claude'],
    connection: { command: 'node' },
    oauth: { preset: 'google-sheets' },
  }, loadMcpDocument().revision);
  await assert.rejects(
    startMcpOAuth(rawServer(created.server.id), 'https://cretli.example'),
    (err) => err.code === 'VALIDATION' && /GOOGLE_CLIENT_ID/.test(err.message),
  );
});

test('oauth block is normalized: presets, custom endpoints, http rejected, removable', async () => {
  const created = await createMcpServer({
    name: 'Custom',
    transport: 'stdio',
    harnesses: ['claude'],
    connection: { command: 'node' },
    oauth: {
      authorizationUrl: 'https://idp.example/authorize',
      tokenUrl: 'https://idp.example/token',
      scopes: 'read write',
      clientIdKey: 'API_CLIENT_ID',
      refreshTokenKey: 'API_REFRESH_TOKEN',
    },
  }, loadMcpDocument().revision);
  const server = rawServer(created.server.id);
  assert.deepEqual(server.oauth.scopes, ['read', 'write']);
  assert.equal(server.oauth.pkce, true);
  const insecure = await createMcpServer({
    name: 'Insecure',
    transport: 'stdio',
    harnesses: ['claude'],
    connection: { command: 'node' },
    oauth: { preset: 'google-gmail', tokenUrl: 'http://idp.example/token' },
  }, loadMcpDocument().revision);
  assert.equal(rawServer(insecure.server.id).oauth, undefined, 'an insecure token URL drops the block');
  await updateMcpServer(created.server.id, { oauth: null }, loadMcpDocument().revision);
  assert.equal(rawServer(created.server.id).oauth, undefined);
});
