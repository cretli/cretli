import './helpers/isolated-data-dir.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { ISOLATED_DATA_DIR as dataDir } from './helpers/isolated-data-dir.js';
import { createChromeAccessRegistry } from '../lib/browser/chrome-access.js';
import { createNavigationConsentRegistry } from '../lib/browser/navigation-consent.js';
import { registerBrowserRoutes } from '../lib/browser/routes.js';
import { addChatAsync } from '../lib/persist/chats-persist.js';
import { createSession, getSessionIdFromRequest, requireAuth, setPassword, getCsrfTokenForSessionToken } from '../lib/auth.js';

setPassword('browser-access-test');
const human = createSession();
const preview = createSession({ browserPreview: true });
const agent = createSession({ agentSession: true });
const chat = await addChatAsync('browser-run', 'Preview checkout', null, dataDir, 'test');
const access = createChromeAccessRegistry({ onChange: () => {} });
const navigation = createNavigationConsentRegistry();
const app = express();
app.use(express.json());
app.use(requireAuth);
registerBrowserRoutes(app, { browserManager: {}, dataDir, chromeAccess: access,
  navigationConsent: navigation, getOwnerSessionId: getSessionIdFromRequest });
const server = await new Promise((resolve) => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
const base = `http://127.0.0.1:${server.address().port}`;
after(() => new Promise((resolve) => server.close(resolve)));

async function request(route, token = human, body) {
  const response = await fetch(base + route, {
    method: body ? 'POST' : 'GET',
    headers: { cookie: `cr_session=${encodeURIComponent(token)}`, 'content-type': 'application/json',
      'x-cretli-csrf': getCsrfTokenForSessionToken(token) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}

test('global queue includes the chat name and both request kinds; only a human session can answer', async () => {
  const chromeWaiting = access.request('run-1', chat.id);
  const navWaiting = navigation.request({ chatId: chat.id, workspaceKey: dataDir, origin: 'https://example.com' });
  const listing = await request('/api/browser/requests');
  assert.equal(listing.status, 200);
  assert.deepEqual(listing.body.prompts.map((prompt) => prompt.kind).sort(), ['chrome', 'navigation']);
  assert.ok(listing.body.prompts.every((prompt) => prompt.chatTitle === chat.title));
  assert.ok(listing.body.prompts.every((prompt) => !('ownerSessionId' in prompt)));
  const prompt = listing.body.prompts.find((row) => row.kind === 'chrome');
  for (const token of [preview, agent]) {
    assert.equal((await request('/api/browser/requests', token)).status, 403);
    assert.equal((await request(`/api/browser/access/${prompt.id}`, token, { chatId: chat.id, decision: 'allow' })).status, 403);
  }
  assert.equal((await request(`/api/browser/access/${prompt.id}`, human, { chatId: 'other', decision: 'allow' })).status, 404);
  assert.equal((await request(`/api/browser/access/${prompt.id}`, human, { chatId: chat.id, decision: 'always' })).status, 400);
  assert.equal((await request(`/api/browser/access/${prompt.id}`, human, { chatId: chat.id, decision: 'allow' })).status, 200);
  assert.deepEqual(await chromeWaiting, { decision: 'allow', ownerSessionId: human.split('.')[0] });
  assert.equal((await request(`/api/browser/access/${prompt.id}`, human, { chatId: chat.id, decision: 'deny' })).status, 404);
  navigation.resolve(listing.body.prompts.find((row) => row.kind === 'navigation').id, 'deny', { chatId: chat.id });
  assert.equal(await navWaiting, 'deny');
  assert.deepEqual((await request('/api/browser/requests')).body.prompts, []);
});

test('duplicate requests share one card, and silence or a changed run never grants access', async () => {
  let now = 1000;
  let current = true;
  const registry = createChromeAccessRegistry({ now: () => now, timeoutMs: 100, onChange: () => {} });
  const first = registry.request('key', 'chat', () => current);
  const second = registry.request('key', 'chat', () => current);
  assert.equal(registry.list().length, 1);
  const [prompt] = registry.list();
  now = 1101;
  assert.deepEqual(registry.list(), []);
  assert.equal((await first).decision, 'timeout');
  assert.equal((await second).decision, 'timeout');
  assert.equal(registry.resolve(prompt.id, 'allow', 'chat', 'human').code, 'not-found');
  const third = registry.request('next', 'chat', () => current);
  current = false;
  assert.deepEqual(registry.list(), []);
  assert.equal((await third).decision, 'timeout');
});
