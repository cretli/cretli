import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { resolveDataPath } from '../lib/runtime-paths.js';
import { listExternalMcpClients, revokeExternalMcpClient } from '../lib/mcp/mcp-external-clients.js';
import {
  addClaudeToolPermission,
  CLAUDE_TOOL_PERMISSION_RULE,
  EXTERNAL_MCP_SERVER_NAME,
  isClaudeLocalSettingsIgnored,
  removeClaudeToolPermission,
} from '../lib/mcp/mcp-external-install.js';
import { connectExternalMcpClient, releaseClaudeToolPermission, releaseServerApproval } from '../lib/mcp/mcp-external-connect.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-tool-perm-'));
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

test('the rule is named after the server entry of the client configs', () => {
  assert.equal(CLAUDE_TOOL_PERMISSION_RULE, `mcp__${EXTERNAL_MCP_SERVER_NAME}`);
});

test('a missing file is created with just the rule', () => {
  const result = addClaudeToolPermission(folder);
  assert.equal(result.added, true);
  assert.equal(result.relativeFile, path.join('.claude', 'settings.local.json'));
  assert.deepEqual(readSettings(), { permissions: { allow: [CLAUDE_TOOL_PERMISSION_RULE] } });
});

test('merging keeps env, other rules and keys; a second call changes nothing', () => {
  writeSettings({ env: { NODE_EXTRA_CA_CERTS: '/x/cert.pem' }, permissions: { allow: ['Bash(npm test)'], deny: ['Read(.env)'] }, model: 'opus' });
  assert.equal(addClaudeToolPermission(folder).added, true);
  const merged = readSettings();
  assert.deepEqual(merged, {
    env: { NODE_EXTRA_CA_CERTS: '/x/cert.pem' },
    permissions: { allow: ['Bash(npm test)', CLAUDE_TOOL_PERMISSION_RULE], deny: ['Read(.env)'] },
    model: 'opus',
  });
  const before = fs.readFileSync(settingsFile(), 'utf8');
  assert.equal(addClaudeToolPermission(folder).added, false);
  assert.equal(fs.readFileSync(settingsFile(), 'utf8'), before, 'idempotent');
});

test('removing takes out only the Cretli rule', () => {
  writeSettings({ env: { A: '1' }, permissions: { allow: ['Bash(ls)', CLAUDE_TOOL_PERMISSION_RULE] } });
  assert.equal(removeClaudeToolPermission(folder), true);
  assert.deepEqual(readSettings(), { env: { A: '1' }, permissions: { allow: ['Bash(ls)'] } });
  assert.equal(removeClaudeToolPermission(folder), false);
  fs.rmSync(settingsFile());
  assert.equal(removeClaudeToolPermission(folder), false, 'missing file is a no-op');
});

test('invalid content is refused and left untouched', () => {
  for (const content of ['{ "env": ', '[1, 2]', JSON.stringify({ permissions: [] }), JSON.stringify({ permissions: { allow: 'mcp__x' } })]) {
    writeSettings(content);
    assert.throws(() => addClaudeToolPermission(folder), /left unchanged/);
    assert.throws(() => removeClaudeToolPermission(folder), /left unchanged/);
    assert.equal(fs.readFileSync(settingsFile(), 'utf8'), content);
  }
});

test('git ignore detection: not a repo, not ignored, ignored', () => {
  // Hermetic: no global excludes file (Claude Code often adds this path to it).
  const gitHome = path.join(root, `git-home-${counter}`);
  fs.mkdirSync(gitHome, { recursive: true });
  fs.writeFileSync(path.join(gitHome, 'config'), '');
  process.env.GIT_CONFIG_GLOBAL = path.join(gitHome, 'config');
  process.env.XDG_CONFIG_HOME = gitHome;
  assert.equal(isClaudeLocalSettingsIgnored(folder), null);
  execFileSync('git', ['init', '-q', folder]);
  assert.equal(isClaudeLocalSettingsIgnored(folder), false);
  fs.writeFileSync(path.join(folder, '.gitignore'), '.claude/settings.local.json\n');
  assert.equal(isClaudeLocalSettingsIgnored(folder), true);
});

test('connect adds the rule and marks it; revoking that connection removes only its own rule', () => {
  writeSettings({ env: { A: '1' } });
  const first = connectExternalMcpClient({ target: 'claude', folder, mode: 'operator', endpoint, allowTools: true });
  assert.equal(first.toolPermission.allowed, true);
  assert.equal(first.toolPermission.added, true);
  assert.equal(first.client.claudeToolPermission, 'added');

  // Reconnecting keeps the marker even though the rule is already there.
  const second = connectExternalMcpClient({ target: 'claude', folder, mode: 'operator', endpoint, allowTools: true });
  assert.equal(second.toolPermission.added, false);
  assert.equal(second.client.claudeToolPermission, 'added');
  assert.deepEqual(readSettings().permissions.allow, [CLAUDE_TOOL_PERMISSION_RULE], 'no duplicate');

  const row = listExternalMcpClients().find((client) => client.id === second.client.id);
  revokeExternalMcpClient(second.client.id);
  assert.equal(releaseClaudeToolPermission(/** @type {any} */ (row)), true);
  releaseServerApproval(/** @type {any} */ (row));
  assert.deepEqual(readSettings(), { env: { A: '1' }, permissions: { allow: [] } });
});

test('a rule that was already there is not Cretli\'s to remove', () => {
  writeSettings({ permissions: { allow: [CLAUDE_TOOL_PERMISSION_RULE] } });
  const result = connectExternalMcpClient({ target: 'claude', folder, endpoint, allowTools: true });
  assert.equal(result.client.claudeToolPermission, 'existing');
  const row = listExternalMcpClients().find((client) => client.id === result.client.id);
  revokeExternalMcpClient(result.client.id);
  assert.equal(releaseClaudeToolPermission(/** @type {any} */ (row)), false);
  assert.deepEqual(readSettings().permissions.allow, [CLAUDE_TOOL_PERMISSION_RULE]);
});

test('connecting again without the option takes back a rule Cretli added', () => {
  connectExternalMcpClient({ target: 'claude', folder, endpoint, allowTools: true });
  const result = connectExternalMcpClient({ target: 'claude', folder, endpoint, allowTools: false });
  assert.equal(result.toolPermission.removed, true);
  assert.equal(result.client.claudeToolPermission, undefined);
  assert.deepEqual(readSettings().permissions.allow, []);
});

test('a broken settings file does not undo the MCP connection', () => {
  writeSettings('{ broken');
  const result = connectExternalMcpClient({ target: 'claude', folder, endpoint, allowTools: true });
  assert.equal(result.toolPermission.allowed, false);
  assert.match(result.toolPermission.error, /not valid JSON/);
  assert.ok(fs.existsSync(path.join(folder, '.mcp.json')));
  assert.equal(listExternalMcpClients().find((client) => client.id === result.client.id)?.revokedAt, null);
  assert.equal(fs.readFileSync(settingsFile(), 'utf8'), '{ broken');
});

test('other targets never touch Claude settings', () => {
  const result = connectExternalMcpClient({ target: 'codex', folder, endpoint, allowTools: true });
  assert.equal(result.toolPermission, null);
  assert.equal(fs.existsSync(settingsFile()), false);
});
