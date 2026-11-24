import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { resolveDataPath } from '../lib/runtime-paths.js';
import { listExternalMcpClients, revokeExternalMcpClient } from '../lib/mcp/mcp-external-clients.js';
import { approveClaudeProjectServer, unapproveClaudeProjectServer } from '../lib/mcp/mcp-external-install.js';
import { connectExternalMcpClient, ensureServerApproval, releaseServerApproval } from '../lib/mcp/mcp-external-connect.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-server-approval-'));
let folder = '';
let counter = 0;
const endpoint = { url: 'http://127.0.0.1:3011/mcp', caFile: '' };

beforeEach(() => {
  assert.ok(ISOLATED_DATA_DIR);
  folder = path.join(root, `project-${++counter}`);
  fs.mkdirSync(folder, { recursive: true });
  fs.rmSync(resolveDataPath('mcp-external-clients.json'), { force: true });
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

const settingsFile = () => path.join(folder, '.claude', 'settings.local.json');
const readSettings = () => JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
/** @param {unknown} value */
function writeSettings(value) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}
/** @param {string} id */
const row = (id) => /** @type {any} */ (listExternalMcpClients().find((client) => client.id === id));

test('approval is merged once, keeps other keys and is taken back alone', () => {
  writeSettings({ env: { A: '1' }, enabledMcpjsonServers: ['domq'], permissions: { allow: ['Bash'] } });
  assert.equal(approveClaudeProjectServer(folder).added, true);
  assert.deepEqual(readSettings(), { env: { A: '1' }, enabledMcpjsonServers: ['domq', 'cretli'], permissions: { allow: ['Bash'] } });
  assert.equal(approveClaudeProjectServer(folder).added, false, 'idempotent');
  assert.equal(unapproveClaudeProjectServer(folder), true);
  assert.deepEqual(readSettings().enabledMcpjsonServers, ['domq']);
  assert.equal(unapproveClaudeProjectServer(folder), false);
});

test('a missing file is created; enableAllProjectMcpServers counts as approved; bad content is refused untouched', () => {
  assert.equal(approveClaudeProjectServer(folder).added, true);
  assert.deepEqual(readSettings(), { enabledMcpjsonServers: ['cretli'] });
  writeSettings({ enableAllProjectMcpServers: true });
  assert.equal(approveClaudeProjectServer(folder).added, false);
  assert.deepEqual(readSettings(), { enableAllProjectMcpServers: true });
  for (const content of ['{ nope', JSON.stringify({ enabledMcpjsonServers: 'cretli' })]) {
    writeSettings(content);
    assert.throws(() => approveClaudeProjectServer(folder), /left unchanged|valid JSON/);
    assert.equal(unapproveClaudeProjectServer(folder), false);
    assert.equal(fs.readFileSync(settingsFile(), 'utf8'), content);
  }
});

test('connecting Claude Code approves the server; revoking that connection takes back only its own approval', () => {
  const first = connectExternalMcpClient({ target: 'claude', folder, endpoint });
  assert.deepEqual(first.serverApproval, { approved: true, added: true });
  assert.equal(row(first.client.id).claudeServerApproval, 'added');
  assert.deepEqual(readSettings().enabledMcpjsonServers, ['cretli']);

  // Reconnecting hands the ownership to the new connection.
  const second = connectExternalMcpClient({ target: 'claude', folder, endpoint });
  assert.equal(second.serverApproval.added, false);
  assert.equal(row(second.client.id).claudeServerApproval, 'added');
  assert.equal(row(first.client.id).claudeServerApproval, undefined);

  assert.equal(releaseServerApproval(row(second.client.id)), true);
  revokeExternalMcpClient(second.client.id);
  assert.equal('enabledMcpjsonServers' in readSettings(), false, 'the list Cretli created is gone');
});

test('an approval that was already there stays after revoke', () => {
  writeSettings({ enabledMcpjsonServers: ['cretli'] });
  const result = connectExternalMcpClient({ target: 'claude', folder, endpoint });
  assert.equal(result.serverApproval.added, false);
  assert.equal(releaseServerApproval(row(result.client.id)), false);
  assert.deepEqual(readSettings().enabledMcpjsonServers, ['cretli']);
});

test('a broken settings file does not stop the connection; other targets are untouched', () => {
  writeSettings('{ broken');
  const result = connectExternalMcpClient({ target: 'claude', folder, endpoint });
  assert.equal(result.serverApproval.approved, false);
  assert.match(String(result.serverApproval.error), /valid JSON/);
  assert.equal(row(result.client.id).revokedAt, null);
  fs.rmSync(settingsFile());
  const codex = connectExternalMcpClient({ target: 'codex', folder, endpoint });
  assert.equal(codex.serverApproval, null);
  assert.equal(fs.existsSync(settingsFile()), false);
});

test('ensureServerApproval repairs a folder connected before approvals were written', () => {
  const result = connectExternalMcpClient({ target: 'claude', folder, endpoint });
  unapproveClaudeProjectServer(folder);
  const repaired = ensureServerApproval(result.client.id, folder, [row(result.client.id)]);
  assert.deepEqual(repaired, { approved: true, added: true });
  assert.deepEqual(readSettings().enabledMcpjsonServers, ['cretli']);
});
