import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, test } from 'node:test';
import express from 'express';
import { saveSettings } from '../lib/persist/settings.js';
import { resolveDataPath } from '../lib/runtime-paths.js';
import {
  createExternalMcpManagedClient,
  EXTERNAL_MCP_MANAGED_RENEW_BEFORE_MS,
  externalMcpManagedTokenPath,
  listExternalMcpClients,
  renewExternalMcpManagedTokens,
  revokeExternalMcpClient,
  verifyExternalMcpToken,
} from '../lib/mcp/mcp-external-clients.js';
import { installExternalMcpConfig, scanExternalMcpInstalls } from '../lib/mcp/mcp-external-install.js';
import { registerExternalMcpRoutes } from '../lib/routes/mcp-external-routes.js';

const auth = await import('../lib/auth.js');

const BRIDGE = fileURLToPath(new URL('../scripts/cretli-mcp-http-bridge.mjs', import.meta.url));
const DAY_MS = 24 * 60 * 60 * 1000;
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-connect-ws-'));
/** @type {http.Server} */
let server;
let baseUrl = '';
let humanCookie = '';

before(async () => {
  assert.ok(ISOLATED_DATA_DIR);
  assert.equal(auth.setPassword('test-password-for-connect').ok, true);
  humanCookie = `cr_session=${encodeURIComponent(auth.createSession())}`;
  const app = express();
  app.use((req, res, next) => (req.method === 'GET' || req.method === 'HEAD' ? next() : express.json()(req, res, next)));
  registerExternalMcpRoutes(app, { oauth: { rateLimit: false }, managedRenewal: false });
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  baseUrl = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  fs.rmSync(workspace, { recursive: true, force: true });
});

beforeEach(() => {
  saveSettings({ externalMcpEnabled: true });
  fs.rmSync(resolveDataPath('mcp-external-clients.json'), { force: true });
  fs.rmSync(resolveDataPath('mcp-managed-tokens'), { recursive: true, force: true });
  fs.rmSync(path.join(workspace, '.mcp.json'), { force: true });
  fs.rmSync(path.join(workspace, '.codex'), { recursive: true, force: true });
});

/** @param {string} file */
function readToken(file) {
  return fs.readFileSync(file, 'utf8').trim();
}

/**
 * @param {Record<string, unknown>} body
 * @param {string} [cookie]
 */
async function connect(body, cookie = humanCookie) {
  const res = await fetch(`${baseUrl}/api/mcp/external-clients/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ target: 'claude', folder: workspace, mode: 'agent', ...body }),
  });
  return { status: res.status, json: await res.json() };
}

test('a managed client gets a 0600 token file that renews before expiry and slides with use only', () => {
  const now = Date.parse('2026-11-01T10:00:00Z');
  const { client, tokenFile } = createExternalMcpManagedClient({ name: 'Claude Code', workspaceFolder: workspace, mode: 'plan' }, { now });
  assert.equal(client.kind, 'oauth');
  assert.equal(client.managed, true);
  assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
  const first = readToken(tokenFile);
  assert.match(first, /^cmo1\./);
  assert.equal(verifyExternalMcpToken(first, { now }).id, client.id);

  // Fresh token: nothing to do.
  assert.equal(renewExternalMcpManagedTokens({ now: now + 10 * 60 * 1000 }).renewed, 0);
  // Close to expiry: a new token replaces the file, the old one stays valid until it expires.
  const later = now + 60 * 60 * 1000 - EXTERNAL_MCP_MANAGED_RENEW_BEFORE_MS + 1000;
  assert.equal(renewExternalMcpManagedTokens({ now: later }).renewed, 1);
  const second = readToken(tokenFile);
  assert.notEqual(second, first);
  assert.equal(verifyExternalMcpToken(first, { now: later }).id, client.id);
  assert.equal(verifyExternalMcpToken(second, { now: later }).id, client.id);

  // A deleted file is recreated on the next pass.
  fs.rmSync(tokenFile);
  assert.equal(renewExternalMcpManagedTokens({ now: later + 1000 }).renewed, 1);
  assert.ok(readToken(tokenFile));

  // Renewal alone does not extend the client (last use was the verify at `later`); use does.
  const usedAt = later + 20 * DAY_MS;
  renewExternalMcpManagedTokens({ now: usedAt });
  assert.equal(listExternalMcpClients()[0].expiresAt, new Date(later + 30 * DAY_MS).toISOString());
  verifyExternalMcpToken(readToken(tokenFile), { now: usedAt });
  assert.equal(listExternalMcpClients()[0].expiresAt, new Date(usedAt + 30 * DAY_MS).toISOString());

  // Idle past the sliding window: the file goes away.
  assert.equal(renewExternalMcpManagedTokens({ now: usedAt + 31 * DAY_MS }).removed, 1);
  assert.equal(fs.existsSync(tokenFile), false);
});

test('revoking a managed client deletes its token file and the token stops working', () => {
  const { client, tokenFile } = createExternalMcpManagedClient({ name: 'Claude Code', workspaceFolder: workspace });
  const token = readToken(tokenFile);
  assert.equal(revokeExternalMcpClient(client.id), true);
  assert.equal(fs.existsSync(tokenFile), false);
  assert.throws(() => verifyExternalMcpToken(token), /revoked/);
});

test('connect installs a bridge entry with a token file; a second connect replaces the first', async () => {
  const first = await connect({});
  assert.equal(first.status, 201, JSON.stringify(first.json));
  assert.equal(first.json.relativeFile, '.mcp.json');
  assert.equal(first.json.url, `${baseUrl}/mcp`);
  const entry = JSON.parse(fs.readFileSync(path.join(workspace, '.mcp.json'), 'utf8')).mcpServers.cretli;
  assert.equal(entry.command, 'node');
  assert.equal(entry.env.CRETLI_MCP_URL, `${baseUrl}/mcp`);
  assert.equal(entry.env.CRETLI_MCP_TOKEN_FILE, externalMcpManagedTokenPath(first.json.client.id));
  assert.equal('CRETLI_MCP_TOKEN' in entry.env, false, 'no secret in the config file');
  assert.deepEqual(scanExternalMcpInstalls([workspace]).map((row) => [row.target, row.managed]), [['claude', true]]);

  const second = await connect({});
  assert.equal(second.status, 201);
  assert.equal(second.json.replaced, 1);
  const rows = listExternalMcpClients();
  assert.equal(rows.find((row) => row.id === first.json.client.id)?.revokedAt !== null, true);
  assert.equal(rows.find((row) => row.id === second.json.client.id)?.revokedAt, null);

  // Codex in the same folder is a separate connection.
  const codex = await connect({ target: 'codex' });
  assert.equal(codex.status, 201);
  assert.equal(codex.json.replaced, 0);
  assert.match(fs.readFileSync(path.join(workspace, '.codex', 'config.toml'), 'utf8'), /CRETLI_MCP_TOKEN_FILE = "/);
});

test('connect needs a human session and enabled external MCP, and validates input', async () => {
  assert.equal((await connect({}, '')).status, 403);
  assert.equal((await connect({ target: 'vim' })).status, 400);
  assert.equal((await connect({ folder: 'relative/path' })).status, 400);
  saveSettings({ externalMcpEnabled: false });
  assert.equal((await connect({})).status, 409);
  assert.equal(listExternalMcpClients().length, 0);
});

test('a failed install leaves no live client behind', async () => {
  fs.mkdirSync(path.join(workspace, '.mcp.json'));
  try {
    const res = await connect({});
    assert.equal(res.status, 409);
    assert.ok(listExternalMcpClients().every((row) => row.revokedAt));
    assert.equal(fs.readdirSync(resolveDataPath('mcp-managed-tokens')).length, 0);
  } finally {
    fs.rmSync(path.join(workspace, '.mcp.json'), { recursive: true, force: true });
  }
});

test('the installed bridge reaches /mcp with the managed token file', async () => {
  const res = await connect({});
  assert.equal(res.status, 201);
  const entry = JSON.parse(fs.readFileSync(path.join(workspace, '.mcp.json'), 'utf8')).mcpServers.cretli;
  assert.equal(entry.args[0], BRIDGE);
  const child = spawn(process.execPath, entry.args, { env: { ...process.env, ...entry.env }, stdio: ['pipe', 'pipe', 'inherit'] });
  try {
    const reply = new Promise((resolve, reject) => {
      let buffer = '';
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        const line = buffer.split('\n').find((row) => row.trim());
        if (line && buffer.includes('\n')) resolve(JSON.parse(line));
      });
      child.on('error', reject);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`);
    const message = /** @type {any} */ (await reply);
    assert.equal(message.id, 1);
    assert.ok(Array.isArray(message.result?.tools), JSON.stringify(message));
    assert.ok(message.result.tools.some((/** @type {any} */ tool) => tool.name === 'todo_list'));
  } finally {
    child.kill();
  }
});

test('the installer refuses a token file outside stdio mode', () => {
  assert.throws(
    () => installExternalMcpConfig({ target: 'claude', folder: workspace, url: 'http://127.0.0.1:1/mcp', mode: 'http', tokenFile: '/tmp/x.token' }),
    /stdio/,
  );
});

test('connect accepts a permission profile; DELETE takes back only what Cretli added and is idempotent', async () => {
  const settings = path.join(workspace, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ env: { KEEP: '1' }, permissions: { allow: ['Bash(npm test)'] } }));
  try {
    const bad = await connect({ permissionProfile: 'everything' });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /permissionProfile must be one of/);

    const ok = await connect({ permissionProfile: 'edits_bash_guarded', allowTools: false });
    assert.equal(ok.status, 201);
    assert.equal(ok.json.permissionGrant.profile, 'edits_bash_guarded', 'permissionProfile wins over allowTools');
    assert.equal(ok.json.toolPermission.allowed, true);
    const written = JSON.parse(fs.readFileSync(settings, 'utf8'));
    assert.equal(written.permissions.defaultMode, 'acceptEdits');
    assert.ok(written.permissions.allow.includes('Bash(npm test)'));
    assert.ok(written.permissions.ask.includes('Bash(git push)'));

    const del = await fetch(`${baseUrl}/api/mcp/external-clients/${ok.json.client.id}`, { method: 'DELETE', headers: { cookie: humanCookie } });
    assert.deepEqual(await del.json(), { ok: true, toolPermissionRemoved: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), { env: { KEEP: '1' }, permissions: { allow: ['Bash(npm test)'], ask: [], deny: [] } });
    const again = await fetch(`${baseUrl}/api/mcp/external-clients/${ok.json.client.id}`, { method: 'DELETE', headers: { cookie: humanCookie } });
    assert.deepEqual(await again.json(), { ok: true, toolPermissionRemoved: false });
    const missing = await fetch(`${baseUrl}/api/mcp/external-clients/nope`, { method: 'DELETE', headers: { cookie: humanCookie } });
    assert.equal(missing.status, 404);

    // The legacy boolean still works.
    const legacy = await connect({ allowTools: true });
    assert.equal(legacy.json.permissionGrant.profile, 'cretli_tools');
  } finally {
    fs.rmSync(path.join(workspace, '.claude'), { recursive: true, force: true });
  }
});
