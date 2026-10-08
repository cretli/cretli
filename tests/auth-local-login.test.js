import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-auth-local-login-'));
process.env.CURSOR_REMOTE_TEST_DATA_DIR = tempDir;
// The flat script style below has no teardown hook, so the data dir goes with
// the process (including on an assertion failure).
process.on('exit', () => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const { setPassword } = await import('../lib/auth.js');
const { getLocalLoginToken, isLocalLoginRequest, isLoopbackAddress, LOCAL_LOGIN_HEADER } = await import('../lib/local-login.js');
const { registerAuthRoutes } = await import('../lib/routes/auth-routes.js');

setPassword('test-password-123');

const token = getLocalLoginToken();
assert.equal(token.length, 48);
assert.equal(isLocalLoginRequest({
  socket: { remoteAddress: '10.0.0.8' },
  headers: { [LOCAL_LOGIN_HEADER]: token },
}), false);
assert.equal(isLocalLoginRequest({
  socket: { remoteAddress: '127.0.0.1' },
  headers: { [LOCAL_LOGIN_HEADER]: 'wrong-token-value-not-the-real-one' },
}), false);

// Every address form a loopback connection can arrive in, and one that must not.
for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
  assert.equal(isLoopbackAddress(address), true, address);
  assert.equal(isLocalLoginRequest({
    socket: { remoteAddress: address },
    headers: { [LOCAL_LOGIN_HEADER]: token },
  }), true, `${address} with the token signs in`);
}
for (const address of ['2001:db8::1', '::ffff:10.0.0.8', '10.0.0.8', '', undefined]) {
  assert.equal(isLoopbackAddress(address), false, String(address));
  assert.equal(isLocalLoginRequest({
    socket: { remoteAddress: address },
    headers: { [LOCAL_LOGIN_HEADER]: token },
  }), false, `${address} is not local even with the token`);
}

const app = express();
app.use(express.json());
registerAuthRoutes(app, {
  useHttps: false,
  buildWidgetAuthorizationPayload: () => ({}),
  isWidgetAuthRequest: () => false,
  parseWidgetAuthParams: () => null,
});
const server = await new Promise((resolve) => {
  const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
});
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}`;

const denied = await fetch(`${baseUrl}/api/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ local: true }),
});
assert.equal(denied.status, 401);

const statusWithoutToken = await fetch(`${baseUrl}/api/auth-status`);
const statusBody = await statusWithoutToken.json();
assert.equal(statusBody.localLogin, false);

const allowed = await fetch(`${baseUrl}/api/login`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    [LOCAL_LOGIN_HEADER]: token,
  },
  body: JSON.stringify({ local: true }),
});
assert.equal(allowed.status, 200);
const allowedBody = await allowed.json();
assert.equal(allowedBody.ok, true);
assert.equal(typeof allowedBody.csrfToken, 'string');
const setCookie = allowed.headers.get('set-cookie') || '';
assert.match(setCookie, /cr_session=/);

const statusWithToken = await fetch(`${baseUrl}/api/auth-status`, {
  headers: { [LOCAL_LOGIN_HEADER]: token },
});
const authedStatus = await statusWithToken.json();
assert.equal(authedStatus.localLogin, true);
assert.equal(authedStatus.authRequired, true);

await new Promise((resolve) => server.close(resolve));
