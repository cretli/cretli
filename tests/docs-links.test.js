import './helpers/isolated-data-dir.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { ISOLATED_DATA_DIR as dataDir } from './helpers/isolated-data-dir.js';
import { getDocsService } from '../lib/docs/docs-service.js';
import { getDocsWorkspace } from '../lib/docs/docs-state-store.js';
import { DOC_MCP_TOOLS } from '../lib/mcp/builtin/doc-tools.js';
import { createCretliMcpToolHandlers, listCretliMcpToolDefs } from '../lib/mcp/mcp-builtin-tools.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';
import { registerDocsRoutes } from '../lib/routes/docs-routes.js';
import { setPassword, createSession, getCsrfTokenForSessionToken, AUTH_CSRF_HEADER, requireAuth } from '../lib/auth.js';
import { mintMcpIntegrationToken } from '../lib/mcp/mcp-integration-token.js';

const home = path.join(dataDir, 'workspace');
const root = path.join(home, 'docs');
const id = '12345678-abcd-4000-8000-123456789abc';
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, 'a.md'), `---\ncretli:\n  todo: 99999999-abcd-4000-8000-123456789abc\n---\n# Note\ncretli-ref todo=${id}\n\n\`cretli-ref todo=99999999-abcd-4000-8000-123456789abc\``);
const targets = new Set(['todo', 'initiative', 'decision'].map((kind) => `${kind}:${id}`));
const svc = getDocsService(dataDir, { resolveScope: async (_dir, scope) => {
  assert.equal(scope.workspaceId || scope.workspaceUuid, 'ws-links');
  return { workspaceUuid: 'ws-links', homeFolder: home };
}, targetExists: async (_dir, _ws, kind, targetId) => targets.has(`${kind}:${targetId}`) });
setPassword('docs-links-test');
const token = createSession();
const human = { cookie: `cr_session=${token}`, [AUTH_CSRF_HEADER]: getCsrfTokenForSessionToken(token) };
const integration = { authorization: `Bearer ${mintMcpIntegrationToken({ sessionId: 'links', workspaceId: 'ws-links', workspaceFolder: home, harness: 'test', incarnation: 'links' })}` };
const app = express(); app.use(express.json()); app.use(requireAuth); registerDocsRoutes(app, { dataDir });
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}/api/docs/`;
after(async () => { svc.close(); await new Promise((resolve) => server.close(resolve)); });
async function request(method, endpoint, body, headers = human) {
  const response = await fetch(`${base}${endpoint}${endpoint.includes('?') ? '&' : '?'}workspaceId=ws-links`, {
    method, headers: { ...headers, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
}
const client = createInProcessMcpClient({ dataDir: () => dataDir });
const session = { workspaceId: 'ws-links', workspaceFolder: home, chatId: 'docs' };
const tools = Object.fromEntries(DOC_MCP_TOOLS.map((tool) => [tool.name, tool]));
const call = async (name, args = {}) => (await tools[name].handler(args, { client, session })).structuredContent;

test('exact read-only catalog; REST and real in-process MCP resolve both directions for all target kinds', async () => {
  assert.deepEqual(DOC_MCP_TOOLS.map((tool) => tool.name), ['doc_list', 'doc_read', 'doc_search', 'doc_backlinks']);
  assert.ok(DOC_MCP_TOOLS.every((tool) => tool.readOnly));
  const catalog = listCretliMcpToolDefs();
  for (const tool of DOC_MCP_TOOLS) assert.ok(catalog.some((entry) => entry.name === tool.name));
  for (const kind of ['todo', 'initiative', 'decision']) {
    const added = await request('POST', 'links', { note: 'a.md', kind, targetId: id });
    assert.equal(added.link.createdBy, 'human');
    const reverse = await request('GET', `links?target=${kind}:${id}`, null, integration);
    assert.ok(reverse.items.some((link) => link.id === added.link.id && link.state === 'ok'));
    assert.ok((await call('doc_backlinks', { target: `${kind}:${id}` })).items.some((link) => link.id === added.link.id));
  }
  const forward = await request('GET', 'links?note=a.md');
  assert.equal(forward.items.filter((link) => link.source === 'managed').length, 3);
  assert.equal(forward.items.filter((link) => link.source === 'mention').length, 1);
  const read = await call('doc_read', { path: 'a.md', workspaceId: 'evil', scope: { workspaceId: 'evil' } });
  assert.equal(read.note.links.length, 4);
  assert.equal(read.note.linkHints[0].conflict, true);
  assert.deepEqual((await call('doc_backlinks', { path: 'a.md' })).links, read.note.links);
  assert.equal((await call('doc_list', { workspaceId: 'evil' })).items[0].path, 'a.md');
  assert.equal((await call('doc_search', { q: 'Note', workspaceFolder: '/invalid' })).items.length, 1);
});

test('target disappearance and external note rename/delete remain visible; MCP never writes docs state', async () => {
  const statePath = path.join(dataDir, 'docs-state.json');
  const before = fs.readFileSync(statePath, 'utf8');
  targets.delete(`todo:${id}`);
  const missing = await call('doc_backlinks', { target: `todo:${id}` });
  assert.ok(missing.items.every((link) => link.targetMissing && link.state === 'dangling'));
  targets.add(`todo:${id}`);
  assert.ok((await call('doc_backlinks', { target: `todo:${id}` })).items.every((link) => link.state === 'ok'));
  fs.renameSync(path.join(root, 'a.md'), path.join(root, 'b.md'));
  const moved = await call('doc_backlinks', { target: `initiative:${id}` });
  assert.equal(moved.items[0].note, 'a.md');
  assert.equal(moved.items[0].state, 'dangling');
  assert.equal(moved.items[0].suggestedPath, 'b.md');
  assert.equal(fs.readFileSync(statePath, 'utf8'), before);
  const linkId = moved.items[0].id;
  await request('POST', `links/${linkId}/resolve`, { note: 'b.md' });
  assert.equal((await call('doc_backlinks', { target: `initiative:${id}` })).items[0].state, 'ok');
  fs.unlinkSync(path.join(root, 'b.md'));
  assert.equal((await request('GET', `links?target=initiative:${id}`)).items[0].noteMissing, true);
  assert.equal(getDocsWorkspace(dataDir, 'ws-links').links.length, 3);
  await request('DELETE', `links/${linkId}`);
  assert.equal(getDocsWorkspace(dataDir, 'ws-links').links.length, 2);
});

test('all MCP reads enforce external consent and agentRead; invalid ops cannot mutate', async () => {
  const external = path.join(dataDir, 'external'); fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, 'private.md'), '# Private');
  await svc.setConfig({ workspaceId: 'ws-links' }, { root: external }, 'human');
  for (const [name, args] of [['doc_list', {}], ['doc_read', { path: 'private.md' }], ['doc_search', { q: 'Private' }], ['doc_backlinks', { target: `todo:${id}` }]]) {
    await assert.rejects(call(name, args), (e) => e.code === 'docs-consent-required');
  }
  await svc.consent({ workspaceId: 'ws-links' }, {}, 'human');
  for (const [name, args] of [['doc_list', {}], ['doc_read', { path: 'private.md' }], ['doc_search', { q: 'Private' }], ['doc_backlinks', { path: 'private.md' }]]) {
    await assert.rejects(call(name, args), (e) => e.code === 'docs-agent-read-denied');
  }
  await svc.consent({ workspaceId: 'ws-links' }, { agentRead: true }, 'human');
  assert.equal((await call('doc_read', { path: 'private.md' })).note.title, 'Private');
  await assert.rejects(client.docRequest({ op: 'write', scope: session, args: {} }), /Unknown Docs/);
  await assert.rejects(client.docRequest({ op: 'toString', scope: session, args: {} }), /Unknown Docs/);
});

test('stdio REST client uses signed workspace and only read operations', async () => {
  const { CretliApiClient } = await import('../lib/remote-api-client.js');
  const remote = new CretliApiClient({ baseUrl: base.replace('/api/docs/', ''), bearerToken: integration.authorization.slice(7) });
  const result = await remote.docRequest({ op: 'read', scope: { workspaceId: 'foreign' }, args: { path: 'private.md', workspaceId: 'foreign' } });
  assert.equal(result.note.title, 'Private');
  await assert.rejects(remote.docRequest({ op: 'addLink' }), /Unknown Docs/);
});

test('R1A1-F2: serialized MCP results and filesystem errors never expose host metadata', async (t) => {
  const handlers = createCretliMcpToolHandlers(client, session);
  const noHostPaths = (result) => {
    const json = JSON.stringify(result);
    assert.equal(json.includes(dataDir), false);
    assert.equal(json.includes(os.homedir()), false);
  };
  const reads = [['doc_list', {}], ['doc_read', { path: 'privacy.md' }], ['doc_search', { q: 'Privacy' }],
    ['doc_backlinks', { path: 'privacy.md' }], ['doc_backlinks', { target: `todo:${id}` }]];
  const external = path.join(dataDir, 'external');
  for (const activeRoot of [root, external]) {
    await svc.setConfig({ workspaceId: 'ws-links' }, { root: activeRoot }, 'human');
    if (activeRoot === external) await svc.consent({ workspaceId: 'ws-links' }, { agentRead: true }, 'human');
    fs.writeFileSync(path.join(activeRoot, 'privacy.md'), `# Privacy\ncretli-ref todo=${id}`);
    fs.symlinkSync(dataDir, path.join(activeRoot, 'outside'));
    for (const [name, args] of reads) {
      const result = await handlers[name](args);
      assert.equal(result.isError, false, name);
      noHostPaths(result);
      if (name === 'doc_list') assert.ok(result.structuredContent.skipped.some((entry) => entry.reason === 'docs-path-escape'));
    }
    const missing = await handlers.doc_read({ path: 'missing.md' });
    assert.equal(missing.isError, true);
    assert.equal(missing.structuredContent.code, 'NOT_FOUND');
    noHostPaths(missing);
    fs.unlinkSync(path.join(activeRoot, 'outside'));
    const originalStat = fs.statSync;
    const deniedStat = t.mock.method(fs, 'statSync', (target, ...args) => {
      if (target === activeRoot) throw Object.assign(new Error(`Cannot access ${activeRoot}`), { code: 'EACCES' });
      return originalStat(target, ...args);
    });
    try {
      const result = await handlers.doc_list({});
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.error, 'Docs operation failed');
      noHostPaths(result);
    } finally { deniedStat.mock.restore(); }
    // Removing the configured root exercises native failures for every read operation.
    const movedRoot = `${activeRoot}-unavailable`;
    fs.renameSync(activeRoot, movedRoot);
    try {
      for (const [name, args] of reads) {
        const result = await handlers[name](args);
        assert.equal(result.isError, true);
        noHostPaths(result);
      }
    } finally { fs.renameSync(movedRoot, activeRoot); }
  }
});
