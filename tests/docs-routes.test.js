import './helpers/isolated-data-dir.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { ISOLATED_DATA_DIR as dataDir } from './helpers/isolated-data-dir.js';
import { setPassword, createSession, getCsrfTokenForSessionToken, AUTH_CSRF_HEADER, requireAuth } from '../lib/auth.js';
import { mintMcpIntegrationToken } from '../lib/mcp/mcp-integration-token.js';
import { getDocsService } from '../lib/docs/docs-service.js';
import { DocsError } from '../lib/docs/docs-state-store.js';
import { readNote } from '../lib/docs/docs-files.js';
import { installWidgetApiGate } from '../lib/widget/widget-http.ts';
import { registerDocsRoutes } from '../lib/routes/docs-routes.js';

setPassword('docs-test-password');
const headersFor = (options = {}) => {
  const token = createSession(options);
  return { cookie: `cr_session=${encodeURIComponent(token)}`, [AUTH_CSRF_HEADER]: getCsrfTokenForSessionToken(token) };
};
const human = headersFor();
const agentSession = headersFor({ agentSession: true });
const integration = { authorization: `Bearer ${mintMcpIntegrationToken({ sessionId: 'docs', chatId: 'docs', workspaceId: 'ws-route', workspaceFolder: dataDir, harness: 'test', incarnation: 'docs' })}` };
const home = path.join(dataDir, 'workspace');
const root = path.join(home, 'docs');
const external = path.join(dataDir, 'external');
const otherHome = path.join(dataDir, 'workspace-b');
fs.mkdirSync(path.join(otherHome, 'docs'), { recursive: true });
fs.writeFileSync(path.join(otherHome, 'docs', 'only-b.md'), '# Workspace B secret');
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(external);
const svc = getDocsService(dataDir, { resolveScope: async (_dir, input) => {
  const id = input.workspaceUuid || input.workspaceId;
  if (!['ws-route', 'ws-b'].includes(id)) throw new DocsError('workspace_required', 'Registered workspace required', 409);
  return { workspaceUuid: id, homeFolder: id === 'ws-b' ? otherHome : home };
} });
const app = express();
app.use(express.json());
app.use(requireAuth);
installWidgetApiGate(app);
registerDocsRoutes(app, { dataDir });
const server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => { svc.close(); await new Promise((resolve) => server.close(resolve)); });

async function request(method, endpoint, headers = human, body) {
  const response = await fetch(`${base}/api/docs/${endpoint}${endpoint.includes('?') ? '&' : '?'}workspaceUuid=ws-route`, {
    method, headers: { ...headers, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}
async function denied(method, endpoint, body) {
  // A valid agent cookie and its own valid CSRF must still never grant human authority.
  for (const headers of [agentSession, integration]) {
    const result = await request(method, endpoint, headers, body);
    assert.equal(result.status, 403, `${method} ${endpoint}: ${JSON.stringify(result.body)}`);
  }
}

test('PUT config: agent 403, human succeeds', async () => {
  await denied('PUT', 'config', { root: 'docs' });
  const result = await request('PUT', 'config', human, { root: 'docs' });
  assert.equal(result.status, 200);
  assert.equal(result.body.root.path, 'docs');
});

test('POST consent: agent 403, human succeeds and agentRead gates reads', async () => {
  await request('PUT', 'config', human, { root: external });
  await denied('POST', 'consent', { agentRead: true });
  const beforeConsent = (await request('GET', 'config', integration)).body;
  assert.deepEqual(beforeConsent.root, { external: true, consented: false, agentRead: false, label: 'External Docs' });
  assert.equal(JSON.stringify(beforeConsent).includes(external), false);
  assert.equal((await request('GET', 'config', human)).body.root.realpath, external);
  assert.equal((await request('GET', 'tree')).body.code, 'docs-consent-required');
  assert.equal((await request('POST', 'consent', human, {})).status, 200);
  const panelOnly = (await request('GET', 'config', integration)).body;
  assert.equal(panelOnly.consent.granted, true);
  assert.equal(JSON.stringify(panelOnly).includes(external), false);
  assert.equal((await request('GET', 'tree', agentSession)).body.code, 'docs-agent-scope-required');
  assert.equal((await request('GET', 'tree', integration)).body.code, 'docs-agent-read-denied');
  assert.equal((await request('POST', 'consent', human, { agentRead: true })).status, 200);
  const permitted = (await request('GET', 'config', integration)).body;
  assert.equal(permitted.root.consented, true);
  assert.equal(permitted.consent.agentRead, true);
  assert.equal(JSON.stringify(permitted).includes(external), false);
  assert.equal(JSON.stringify(permitted).includes(fs.realpathSync(external)), false);
  assert.equal((await request('GET', 'config', human)).body.consent.realpath, external);
  assert.equal((await request('GET', 'tree', agentSession)).status, 403);
  assert.equal((await request('GET', 'tree', integration)).status, 200);
});

test('DELETE consent: agent 403, human succeeds', async () => {
  await denied('DELETE', 'consent', {});
  assert.equal((await request('DELETE', 'consent', human, {})).status, 200);
  assert.equal((await request('GET', 'tree')).body.code, 'docs-consent-required');
  await request('PUT', 'config', human, { root: 'docs' });
});

test('POST note: agent 403, human creates', async () => {
  await denied('POST', 'note', { path: 'route.md', text: '# Route' });
  const result = await request('POST', 'note', human, { path: 'route.md', text: '# Route' });
  assert.equal(result.status, 200);
  assert.equal(result.body.note.text, '# Route');
});

test('PUT note: agent 403, human writes; stale hash returns 409', async () => {
  const args = { path: 'route.md', text: '# Updated', expectedSha256: readNote(root, 'route.md').sha256 };
  await denied('PUT', 'note', args);
  assert.equal((await request('PUT', 'note', human, args)).status, 200);
  assert.equal((await request('PUT', 'note', human, args)).status, 409);
  assert.equal((await request('PUT', 'note', human, { path: 'route.md', text: '' })).status, 428);
});

test('POST rename: agent 403, human renames', async () => {
  const args = { path: 'route.md', newPath: 'renamed.md', expectedSha256: readNote(root, 'route.md').sha256 };
  await denied('POST', 'note/rename', args);
  assert.equal((await request('POST', 'note/rename', human, args)).status, 200);
  assert.equal(fs.existsSync(path.join(root, 'route.md')), false);
});

test('DELETE note: agent 403, human moves note to trash', async () => {
  const args = { path: 'renamed.md', expectedSha256: readNote(root, 'renamed.md').sha256 };
  await denied('DELETE', 'note', args);
  const result = await request('DELETE', 'note', human, args);
  assert.equal(result.status, 200);
  assert.ok(fs.existsSync(path.join(root, result.body.trashPath)));
});

test('read REST surfaces return parsed note, tree, search and backlinks', async () => {
  await request('POST', 'note', human, { path: 'alpha.md', text: '# Alpha\nSearchword [[beta]]' });
  await request('POST', 'note', human, { path: 'beta.md', text: '# Beta' });
  assert.equal((await request('GET', 'config', integration)).status, 200);
  assert.equal((await request('GET', 'tree', integration)).body.items.length, 2);
  assert.equal((await request('GET', 'note?path=alpha.md', integration)).body.note.title, 'Alpha');
  assert.equal((await request('GET', 'search?q=searchword', integration)).body.items.length, 1);
  assert.deepEqual((await request('GET', 'backlinks?path=beta.md', integration)).body.items, [{ path: 'alpha.md', title: 'Alpha' }]);
  assert.equal((await request('GET', 'note?path=missing.md')).status, 404);
  assert.equal((await request('GET', 'note?path=../outside.md')).status, 400);
  const noScope = await fetch(`${base}/api/docs/config`, { headers: human });
  assert.equal(noScope.status, 409);
  assert.equal((await request('PUT', 'config', { cookie: human.cookie }, { root: null })).status, 403);
});

test('Docs routes are wired into the application composition root', () => {
  const source = fs.readFileSync(new URL('../lib/register-app-routes.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ registerDocsRoutes \} from '.\/routes\/docs-routes.js'/);
  assert.match(source, /registerDocsRoutes\(app, \{ dataDir: ctx.dataDir \}\)/);
});

test('agent workspace comes only from signed claims; other workspace selectors cannot override it', async () => {
  const endpoints = ['config', 'tree', 'note?path=only-b.md', 'search?q=secret', 'backlinks?path=only-b.md'];
  for (const endpoint of endpoints) {
    const suffix = `${endpoint}${endpoint.includes('?') ? '&' : '?'}workspaceUuid=ws-b&workspaceId=ws-b&workspaceFolder=${encodeURIComponent(otherHome)}`;
    const response = await fetch(`${base}/api/docs/${suffix}`, { headers: integration });
    const result = await response.json();
    assert.equal(JSON.stringify(result).includes('Workspace B secret'), false);
    if (endpoint.startsWith('note?')) assert.equal(response.status, 404);
    else {
      assert.equal(response.status, 200);
      if (endpoint === 'config') {
        assert.equal(result.root.internal, true);
        assert.equal(result.root.relativeHint, 'docs');
        assert.equal(JSON.stringify(result).includes(root), false);
      }
      if (endpoint === 'tree') assert.equal(result.items.some((note) => note.path === 'only-b.md'), false);
      if (endpoint.startsWith('search?')) assert.deepEqual(result.items, []);
    }
    const cookie = await fetch(`${base}/api/docs/${suffix}`, { headers: agentSession });
    assert.equal(cookie.status, 403);
    assert.equal((await cookie.json()).code, 'docs-agent-scope-required');
  }
  const humanResponse = await fetch(`${base}/api/docs/note?path=only-b.md&workspaceUuid=ws-b`, { headers: human });
  assert.equal(humanResponse.status, 200);
  assert.equal((await humanResponse.json()).note.text, '# Workspace B secret');
  const unbound = mintMcpIntegrationToken({ sessionId: 'unbound', harness: 'test', incarnation: 'unbound' });
  const denied = await request('GET', 'config', { authorization: `Bearer ${unbound}` });
  assert.equal(denied.status, 403);
});

test('all managed-link mutations require a human cookie with CSRF', async () => {
  for (const [method, endpoint] of [['POST', 'links'], ['DELETE', 'links/missing'], ['POST', 'links/missing/resolve']]) {
    await denied(method, endpoint, { note: 'alpha.md', kind: 'todo', targetId: '12345678-abcd-4000-8000-123456789abc' });
    assert.equal((await request(method, endpoint, { cookie: human.cookie }, {})).status, 403);
  }
});

test('R1A1-F2: bearer config hides host metadata for every root and preserves the human view', async () => {
  const noHostPaths = (value) => {
    const json = JSON.stringify(value);
    for (const forbidden of [dataDir, root, external, fs.realpathSync(root), fs.realpathSync(external), os.homedir()]) {
      assert.equal(json.includes(forbidden), false, 'Agent response must not contain host paths');
    }
    assert.equal(Object.hasOwn(value.root || {}, 'path'), false);
    assert.equal(Object.hasOwn(value.root || {}, 'realpath'), false);
    assert.equal(Object.hasOwn(value.consent || {}, 'realpath'), false);
  };
  for (const configured of ['docs', root]) {
    await request('PUT', 'config', human, { root: configured });
    const agent = (await request('GET', 'config', integration)).body;
    noHostPaths(agent);
    assert.equal(agent.root.internal, true);
    assert.equal(agent.root.relativeHint, configured === 'docs' ? 'docs' : undefined);
    const full = (await request('GET', 'config', human)).body;
    assert.equal(full.root.path, configured);
    assert.equal(full.root.realpath, fs.realpathSync(root));
  }
  await request('PUT', 'config', human, { root: external });
  noHostPaths((await request('GET', 'config', integration)).body);
  await request('POST', 'consent', human, { agentRead: true });
  const agent = (await request('GET', 'config', integration)).body;
  noHostPaths(agent);
  assert.equal(agent.root.consented, true);
  assert.equal(agent.root.agentRead, true);
  assert.equal(agent.consent.granted, true);
  assert.equal(typeof agent.consent.at, 'string');
  const full = (await request('GET', 'config', human)).body;
  assert.equal(full.root.path, external);
  assert.equal(full.root.realpath, fs.realpathSync(external));
  assert.equal(full.consent.realpath, fs.realpathSync(external));
  await request('PUT', 'config', human, { root: 'docs' });
});

test('R1A1-F2: every agent REST read, skipped diagnostic and error is free of host paths', async () => {
  const target = '12345678-abcd-4000-8000-123456789abc';
  const text = `---\ntitle: Privacy fixture\n---\n# Privacy fixture\ncretli-ref todo=${target}\n[[alpha]]`;
  for (const activeRoot of [root, external]) {
    await request('PUT', 'config', human, { root: activeRoot });
    if (activeRoot === external) await request('POST', 'consent', human, { agentRead: true });
    fs.writeFileSync(path.join(activeRoot, 'privacy.md'), text);
    fs.symlinkSync(otherHome, path.join(activeRoot, 'outside'));
    const endpoints = ['config', 'tree', 'note?path=privacy.md', 'search?q=Privacy',
      'backlinks?path=privacy.md', `backlinks?target=todo:${target}`, 'links?note=privacy.md',
      `links?target=todo:${target}`, 'note?path=missing.md', 'note?path=outside/only-b.md', 'note?path=../invalid.md'];
    for (const endpoint of endpoints) {
      const result = await request('GET', endpoint, integration);
      const json = JSON.stringify(result.body);
      assert.equal(json.includes(dataDir), false, endpoint);
      assert.equal(json.includes(os.homedir()), false, endpoint);
      if (endpoint === 'tree') assert.ok(result.body.skipped.some((entry) => entry.path === 'outside' && entry.reason === 'docs-path-escape'));
    }
    fs.unlinkSync(path.join(activeRoot, 'outside'));
  }
  await request('PUT', 'config', human, { root: 'docs' });
});
