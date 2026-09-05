/**
 * Regression tests: sessions survive a process restart (persisted in data/sessions.json).
 *
 * Requires CURSOR_REMOTE_TEST_DATA_DIR — set in the test process so the real data/ is not overwritten.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-auth-test-'));

process.env.CURSOR_REMOTE_TEST_DATA_DIR = TMP_DATA_DIR;

const auth = await import('../lib/auth.js');
const {
  setPassword,
  verifyPassword,
  createSession,
  isAuthenticated,
  clearSession,
  requireAuth,
  verifyAgentCallback,
  __reloadSessionsFromDiskForTest,
} = auth;
const widgets = await import('../lib/widget/widget-installations.js');

/** Minimal req mock carrying a cookie header. */
function reqWithCookie(cookie) {
  return { headers: cookie ? { cookie } : {} };
}

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) {
    pass += 1;
    console.log(`OK: ${name}`);
  } else {
    fail += 1;
    console.error(`FAIL: ${name}`);
  }
}

try {
  // 1. Password setup.
  const setPasswordResult = setPassword('test-password-123');
  ok('setPassword returns ok', setPasswordResult.ok === true);

  // 2. Password verification.
  ok('verifyPassword accepts the correct password', verifyPassword('test-password-123') === true);
  ok('verifyPassword rejects a wrong password', verifyPassword('wrong') === false);

  // 3. Session creation + cookie.
  const token = createSession();
  ok('createSession returns a token', typeof token === 'string' && token.includes('.'));
  const cookieHeader = `cr_session=${encodeURIComponent(token)}`;
  ok('isAuthenticated before restart', isAuthenticated(reqWithCookie(cookieHeader)) === true);

  const installation = widgets.createWidgetInstallation({
    name: 'Auth scope widget',
    workspaceFile: '/work/project.code-workspace',
    workspaceFolder: '/work/project',
    allowedOrigins: ['https://project.example.com'],
    permissions: ['context'],
    enabled: true,
  });
  const widgetToken = widgets.createWidgetAccessToken({
    installationId: installation.id,
    origin: 'https://project.example.com',
    pageSessionId: 'page-auth-scope',
  });
  const scopedReq = {
    path: '/api/chats',
    headers: {
      cookie: cookieHeader,
      authorization: `Bearer ${widgetToken}`,
    },
  };
  let middlewareNextCalled = false;
  requireAuth(scopedReq, {
    status() { return this; },
    json() { return this; },
  }, () => {
    middlewareNextCalled = true;
  });
  ok(
    'widget bearer keeps its scope even with an active cookie session',
    middlewareNextCalled && scopedReq.widgetAccess?.pageSessionId === 'page-auth-scope',
  );

  // 4. Simulated process restart: clear memory, reload from disk.
  __reloadSessionsFromDiskForTest();
  ok('isAuthenticated after restart (same session)', isAuthenticated(reqWithCookie(cookieHeader)) === true);

  // 5. Logout invalidates the session and a restart does not bring it back.
  clearSession(reqWithCookie(cookieHeader));
  __reloadSessionsFromDiskForTest();
  ok('isAuthenticated after logout + restart = false', isAuthenticated(reqWithCookie(cookieHeader)) === false);

  // 6. Changing the password invalidates old sessions.
  const token2 = createSession();
  setPassword('new-password-456');
  __reloadSessionsFromDiskForTest();
  ok('password change invalidates old sessions', isAuthenticated(reqWithCookie(`cr_session=${encodeURIComponent(token2)}`)) === false);

  // 7. An expired session is not loaded after a restart.
  // Simulation: write a session with expiresAt in the past straight to the file.
  const expiredId = 'expired-session-id';
  fs.writeFileSync(
    path.join(TMP_DATA_DIR, 'sessions.json'),
    JSON.stringify({ v: 1, sessions: [{ id: expiredId, expiresAt: Date.now() - 1000 }] }),
    'utf8'
  );
  __reloadSessionsFromDiskForTest();
  ok('expired session is not loaded', isAuthenticated(reqWithCookie(`cr_session=${encodeURIComponent(expiredId + '.sig')}`)) === false);

  // 8. A corrupted session file does not break the module.
  fs.writeFileSync(path.join(TMP_DATA_DIR, 'sessions.json'), '{ not valid json', 'utf8');
  __reloadSessionsFromDiskForTest();
  ok('corrupted session file does not throw', true);

  const previousCallbackToken = process.env.AGENT_CALLBACK_TOKEN;
  process.env.AGENT_CALLBACK_TOKEN = 'callback-secret-token';
  ok(
    'verifyAgentCallback trusts localhost without a token',
    verifyAgentCallback({ socket: { remoteAddress: '127.0.0.1' }, headers: {} }) === true,
  );
  ok(
    'verifyAgentCallback rejects a mismatched LAN token',
    verifyAgentCallback({
      socket: { remoteAddress: '10.0.0.8' },
      headers: { 'x-agent-token': 'wrong' },
    }) === false,
  );
  ok(
    'verifyAgentCallback accepts a matching LAN token',
    verifyAgentCallback({
      socket: { remoteAddress: '10.0.0.8' },
      headers: { 'x-agent-token': 'callback-secret-token' },
    }) === true,
  );
  if (previousCallbackToken === undefined) delete process.env.AGENT_CALLBACK_TOKEN;
  else process.env.AGENT_CALLBACK_TOKEN = previousCallbackToken;
} catch (err) {
  fail += 1;
  console.error('FAIL: exception in test', err);
} finally {
  try {
    fs.rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {
    // ignore
  }
}

console.log(`\n${fail === 0 ? `All auth session persist tests passed (${pass}).` : `${fail} test(s) failed.`}`);
if (fail > 0) process.exit(1);
