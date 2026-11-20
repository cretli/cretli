import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

const BRIDGE = new URL('../scripts/cretli-mcp-http-bridge.mjs', import.meta.url).pathname;

test('bridge retries a restarting server, sends the token and returns the JSON-RPC reply', async () => {
  let calls = 0;
  let auth = '';
  const server = http.createServer((req, res) => {
    calls += 1;
    auth = String(req.headers.authorization || '');
    if (calls === 1) { res.writeHead(503).end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const msg = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  const child = spawn(process.execPath, [BRIDGE], {
    env: { ...process.env, CRETLI_MCP_URL: `http://127.0.0.1:${port}/mcp`, CRETLI_MCP_TOKEN: 'tok' },
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stdin.end('{"jsonrpc":"2.0","id":7,"method":"ping"}\n');
  await new Promise((resolve) => child.on('close', resolve));
  server.close();
  assert.equal(auth, 'Bearer tok');
  assert.ok(calls >= 2);
  assert.deepEqual(JSON.parse(out), { jsonrpc: '2.0', id: 7, result: { ok: true } });
});
