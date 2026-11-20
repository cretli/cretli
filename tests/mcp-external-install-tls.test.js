import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import express from 'express';

test('install API validates local TLS trust before writing the client configuration', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-mcp-install-tls-'));
  const previousDataDir = process.env.CRETLI_DATA_DIR;
  const previousCertPath = process.env.SSL_CERT_PATH;
  process.env.CRETLI_DATA_DIR = dir;
  delete process.env.SSL_CERT_PATH;
  let server;
  try {
    const { registerExternalMcpRoutes } = await import('../lib/routes/mcp-external-routes.js');
    const { createExternalMcpClient } = await import('../lib/mcp/mcp-external-clients.js');
    const { client } = createExternalMcpClient({ name: 'TLS test', workspaceFolder: dir, mode: 'plan' });
    const app = express();
    app.use(express.json());
    registerExternalMcpRoutes(app);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    const install = async (options = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/mcp/external-clients/${client.id}/install`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'claude', mode: 'stdio', url: 'https://localhost:3011/mcp', trustCertificate: true, ...options }),
      });
      return { status: response.status, body: await response.json() };
    };
    assert.equal((await install()).status, 409);
    assert.equal(fs.existsSync(path.join(dir, '.mcp.json')), false);
    assert.equal((await install({ mode: 'http' })).status, 400);
    assert.equal((await install({ url: 'invalid' })).status, 400);
    assert.equal((await install({ url: 'http://localhost:3011/mcp' })).status, 400);
    const certPath = path.join(dir, 'custom-cert.pem');
    const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', path.join(dir, 'key.pem'), '-out', certPath, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    assert.equal(generated.status, 0);
    fs.copyFileSync(certPath, path.join(dir, 'cert.pem'));
    assert.equal((await install()).status, 200);
    const readEnv = () => JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8')).mcpServers.cretli.env;
    assert.equal(readEnv().CRETLI_MCP_CA_FILE, path.join(dir, 'cert.pem'));
    process.env.SSL_CERT_PATH = certPath;
    assert.equal((await install()).status, 200);
    assert.equal(readEnv().CRETLI_MCP_CA_FILE, certPath);
    fs.writeFileSync(certPath, 'not a certificate');
    const before = fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8');
    assert.equal((await install()).status, 409);
    assert.equal(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'), before);
    assert.equal((await install({ trustCertificate: false })).status, 200);
    assert.equal(readEnv().CRETLI_MCP_CA_FILE, undefined);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousDataDir === undefined) delete process.env.CRETLI_DATA_DIR;
    else process.env.CRETLI_DATA_DIR = previousDataDir;
    if (previousCertPath === undefined) delete process.env.SSL_CERT_PATH;
    else process.env.SSL_CERT_PATH = previousCertPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
