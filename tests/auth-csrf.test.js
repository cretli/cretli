import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-auth-csrf-'));
process.env.CURSOR_REMOTE_TEST_DATA_DIR = tempDir;

const auth = await import('../lib/auth.js');
const {
  AUTH_CSRF_HEADER,
  setPassword,
  createSession,
  getCsrfTokenForSessionToken,
  verifyCsrfToken,
  requireAuth,
  clearSession,
} = auth;

setPassword('test-password-123');
const sessionToken = createSession();
const csrfToken = getCsrfTokenForSessionToken(sessionToken);
assert.ok(csrfToken);

const cookieHeader = `cr_session=${encodeURIComponent(sessionToken)}`;
const authedReq = {
  method: 'POST',
  path: '/api/chats',
  headers: {
    cookie: cookieHeader,
    [AUTH_CSRF_HEADER]: csrfToken,
  },
};

let nextCalled = false;
requireAuth(authedReq, {
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
}, () => {
  nextCalled = true;
});
assert.equal(nextCalled, true);

const missingCsrfReq = {
  method: 'POST',
  path: '/api/chats',
  headers: { cookie: cookieHeader },
};
let blocked = false;
requireAuth(missingCsrfReq, {
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    blocked = body?.csrfRequired === true;
    return this;
  },
}, () => {
  blocked = false;
});
assert.equal(blocked, true);
assert.equal(verifyCsrfToken({
  headers: {
    cookie: cookieHeader,
    [AUTH_CSRF_HEADER]: 'wrong-token',
  },
}), false);

const { default: express } = await import('express');
const { registerAuthRoutes } = await import('../lib/routes/auth-routes.js');
const app = express();
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
const authedStatus = await fetch(`http://127.0.0.1:${port}/api/auth-status`, {
  headers: { cookie: cookieHeader },
});
assert.equal(authedStatus.headers.get('cache-control'), 'no-store');
const authedBody = await authedStatus.json();
assert.equal(typeof authedBody.csrfToken, 'string');
await new Promise((resolve) => server.close(resolve));

clearSession({ headers: { cookie: cookieHeader } });
assert.equal(verifyCsrfToken({
  headers: {
    cookie: cookieHeader,
    [AUTH_CSRF_HEADER]: csrfToken,
  },
}), false);

fs.rmSync(tempDir, { recursive: true, force: true });
delete process.env.CURSOR_REMOTE_TEST_DATA_DIR;

console.log('All auth-csrf tests passed.');
