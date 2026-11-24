import './helpers/isolated-data-dir.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { ISOLATED_DATA_DIR as dataDir } from './helpers/isolated-data-dir.js';
import { setPassword, createSession, getCsrfTokenForSessionToken, AUTH_CSRF_HEADER, requireAuth } from '../lib/auth.js';
import { mintMcpIntegrationToken } from '../lib/mcp/mcp-integration-token.js';
import { getDocsService } from '../lib/docs/docs-service.js';
import { DocsError } from '../lib/docs/docs-state-store.js';
import { installWidgetApiGate } from '../lib/widget/widget-http.ts';
import { registerDocsRoutes } from '../lib/routes/docs-routes.js';

// Final Docs audit: guards that must keep holding when new routes or files are added.
setPassword('docs-audit-password');
const session = (options = {}) => {
  const token = createSession(options);
  return { cookie: `cr_session=${encodeURIComponent(token)}`, [AUTH_CSRF_HEADER]: getCsrfTokenForSessionToken(token) };
};
const human = session();
const agentSession = session({ agentSession: true });
const integration = { authorization: `Bearer ${mintMcpIntegrationToken({ sessionId: 'audit', chatId: 'audit', workspaceId: 'ws-audit', workspaceFolder: dataDir, harness: 'test', incarnation: 'audit' })}` };
const home = path.join(dataDir, 'audit-workspace');
fs.mkdirSync(path.join(home, 'docs'), { recursive: true });
const svc = getDocsService(dataDir, { resolveScope: async (_dir, input) => {
  if (!['ws-audit'].includes(input.workspaceUuid || input.workspaceId)) throw new DocsError('workspace_required', 'Registered workspace required', 409);
  return { workspaceUuid: 'ws-audit', homeFolder: home };
} });

const routes = [];
const app = express();
app.use(express.json());
app.use(requireAuth);
installWidgetApiGate(app);
const recorder = Object.fromEntries(['get', 'post', 'put', 'delete'].map((method) => [method, (route, ...handlers) => {
  routes.push({ method: method.toUpperCase(), route });
  return app[method](route, ...handlers);
}]));
registerDocsRoutes(recorder, { dataDir });
const server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => { svc.close(); await new Promise((resolve) => server.close(resolve)); });

const call = (method, route, headers, body) => fetch(`${base}${route.replace(':id', 'x')}?workspaceUuid=ws-audit`, {
  method, headers: { ...headers, 'content-type': 'application/json' }, ...(method === 'GET' ? {} : { body: JSON.stringify(body || {}) }),
});

test('every direct mutating Docs route is human-only, proposal routes are agent-only', async () => {
  const mutating = routes.filter(({ method }) => method !== 'GET');
  assert.ok(mutating.length >= 12, 'route enumeration found the mutating routes');
  for (const { method, route } of mutating) {
    const proposal = route.startsWith('/api/docs/proposals/');
    for (const headers of proposal ? [human, agentSession] : [agentSession, integration]) {
      const response = await call(method, route, headers);
      assert.equal(response.status, 403, `${method} ${route} must refuse this caller`);
    }
  }
});

test('Docs sources avoid raw HTML sinks, literal colours, Polish literals and host paths', () => {
  const files = [];
  const walk = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full); else files.push(full);
  } };
  for (const dir of ['lib/docs', 'app_front/features/docs', 'app_front/css/features/docs']) walk(new URL(`../${dir}`, import.meta.url).pathname);
  files.push(new URL('../lib/routes/docs-routes.js', import.meta.url).pathname, new URL('../lib/mcp/builtin/doc-tools.js', import.meta.url).pathname);
  assert.ok(files.length > 20);
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const name = path.relative(path.join(import.meta.dirname, '..'), file);
    assert.doesNotMatch(source, /unsafeHTML|unsafeSVG|\.innerHTML\s*=|insertAdjacentHTML/, `${name}: raw HTML sink`);
    assert.doesNotMatch(source, /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/, `${name}: Polish literal (use i18n / English comments)`);
    assert.doesNotMatch(source, /\/home\/|\/Users\/|[A-Z]:\\\\/, `${name}: host path`);
    if (file.endsWith('.scss')) assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/, `${name}: use var(--cr-*) tokens`);
  }
});
