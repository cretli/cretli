import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ExternalMcpInstallError, installExternalMcpConfig, mergeCodexToml } from '../lib/mcp/mcp-external-install.js';

const URL_A = 'http://127.0.0.1:3011/mcp';

/** @returns {string} */
function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-mcp-install-'));
}

test('claude: writes .mcp.json with an env token reference and keeps other servers', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
  const result = installExternalMcpConfig({ target: 'claude', folder: dir, url: URL_A });
  assert.equal(result.existed, true);
  const json = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'));
  assert.deepEqual(json.mcpServers.other, { command: 'x' });
  assert.equal(json.mcpServers.cretli.headers.Authorization, 'Bearer ${CRETLI_MCP_TOKEN}');
});

test('cursor: creates .cursor/mcp.json using the ${env:} syntax', () => {
  const dir = tmp();
  installExternalMcpConfig({ target: 'cursor', folder: dir, url: URL_A });
  const json = JSON.parse(fs.readFileSync(path.join(dir, '.cursor', 'mcp.json'), 'utf8'));
  assert.equal(json.mcpServers.cretli.headers.Authorization, 'Bearer ${env:CRETLI_MCP_TOKEN}');
});

test('codex: appends and then replaces only the cretli table', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, '.codex'));
  const file = path.join(dir, '.codex', 'config.toml');
  fs.writeFileSync(file, 'model = "x"\n\n[mcp_servers.cretli]\nurl = "old"\n\n[other]\na = 1\n');
  installExternalMcpConfig({ target: 'codex', folder: dir, url: URL_A });
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /model = "x"/);
  assert.match(text, /\[other\]\na = 1/);
  assert.match(text, /url = "http:\/\/127\.0\.0\.1:3011\/mcp"/);
  assert.doesNotMatch(text, /"old"/);
  assert.equal(mergeCodexToml('', URL_A).startsWith('[mcp_servers.cretli]'), true);
});

test('rejects bad target, bad url, invalid JSON and symlinked files', () => {
  const dir = tmp();
  assert.throws(() => installExternalMcpConfig({ target: 'vim', folder: dir, url: URL_A }), ExternalMcpInstallError);
  assert.throws(() => installExternalMcpConfig({ target: 'claude', folder: dir, url: 'file:///etc/passwd' }), ExternalMcpInstallError);
  fs.writeFileSync(path.join(dir, '.mcp.json'), '{nope');
  assert.throws(() => installExternalMcpConfig({ target: 'claude', folder: dir, url: URL_A }), /not valid JSON/);
  const other = tmp();
  fs.writeFileSync(path.join(other, 'real.json'), '{}');
  fs.symlinkSync(path.join(other, 'real.json'), path.join(dir, '.cursor-link'));
  fs.mkdirSync(path.join(dir, '.cursor'));
  fs.symlinkSync(path.join(other, 'real.json'), path.join(dir, '.cursor', 'mcp.json'));
  assert.throws(() => installExternalMcpConfig({ target: 'cursor', folder: dir, url: URL_A }), /not a regular file/);
});

test('a literal token is written for every target when provided', () => {
  const dir = tmp();
  const token = 'cmx1.abc.def';
  for (const target of ['claude', 'cursor', 'codex']) {
    const result = installExternalMcpConfig({ target, folder: dir, url: URL_A, token });
    assert.equal(result.tokenWritten, true);
    assert.match(fs.readFileSync(result.file, 'utf8'), /Bearer cmx1\.abc\.def/);
  }
});

test('installs into a custom folder and keeps other servers there', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { keep: { command: 'y' } } }));
  installExternalMcpConfig({ target: 'claude', folder: dir, url: URL_A });
  const json = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'));
  assert.deepEqual(json.mcpServers.keep, { command: 'y' });
  assert.ok(json.mcpServers.cretli);
});

test('refuses a missing folder and leaves an invalid JSON file untouched', () => {
  assert.throws(() => installExternalMcpConfig({ target: 'claude', folder: path.join(tmp(), 'nope'), url: URL_A }), ExternalMcpInstallError);
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '.mcp.json'), '{broken');
  assert.throws(() => installExternalMcpConfig({ target: 'claude', folder: dir, url: URL_A }), ExternalMcpInstallError);
  assert.equal(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'), '{broken');
});

test('stdio mode: writes a command entry for the bridge, keeps other servers, no token by default', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { keep: { command: 'y' } } }));
  const result = installExternalMcpConfig({ target: 'claude', folder: dir, url: URL_A, mode: 'stdio' });
  assert.equal(result.mode, 'stdio');
  const { mcpServers } = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'));
  assert.deepEqual(mcpServers.keep, { command: 'y' });
  assert.equal(mcpServers.cretli.command, 'node');
  assert.match(mcpServers.cretli.args[0], /cretli-mcp-http-bridge\.mjs$/);
  assert.equal(mcpServers.cretli.env.CRETLI_MCP_URL, URL_A);
  assert.equal(mcpServers.cretli.env.CRETLI_MCP_TOKEN, '${CRETLI_MCP_TOKEN}');
});

test('stdio mode: codex uses env_vars without a token and rejects unknown modes', () => {
  const dir = tmp();
  installExternalMcpConfig({ target: 'codex', folder: dir, url: URL_A, mode: 'stdio' });
  const text = fs.readFileSync(path.join(dir, '.codex', 'config.toml'), 'utf8');
  assert.match(text, /command = "node"/);
  assert.match(text, /env_vars = \["CRETLI_MCP_TOKEN"\]/);
  assert.throws(() => installExternalMcpConfig({ target: 'claude', folder: dir, url: URL_A, mode: 'x' }), ExternalMcpInstallError);
});
