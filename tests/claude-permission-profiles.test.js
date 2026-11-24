import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { resolveDataPath } from '../lib/runtime-paths.js';
import {
  CLAUDE_PERMISSION_PROFILES,
  CLAUDE_TOOL_PERMISSION_RULE,
  PROFILE_ORDER,
  effectiveGrant,
  emptyGrant,
  mergeGrants,
  normalizePermissionProfile,
  profileRequires,
  strongestProfile,
} from '../lib/mcp/claude-permission-profiles.js';
import {
  applyClaudePermissionProfile,
  CLAUDE_TOOL_PERMISSION_RULE as INSTALL_RULE,
  EXTERNAL_MCP_SERVER_NAME,
  planClaudePermissionRelease,
  releaseClaudePermissionGrant,
} from '../lib/mcp/mcp-external-install.js';
import { createExternalMcpManagedClient, listExternalMcpClients, revokeExternalMcpClient, setExternalMcpClientPermissionGrant } from '../lib/mcp/mcp-external-clients.js';
import { connectExternalMcpClient, releaseClientPermission, releaseServerApproval } from '../lib/mcp/mcp-external-connect.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-perm-profiles-'));
let folder = '';
let counter = 0;
const endpoint = { url: 'http://127.0.0.1:3011/mcp', caFile: '' };
const GUARDED = CLAUDE_PERMISSION_PROFILES.edits_bash_guarded;

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
/** @param {Record<string, unknown>} [extra] */
const connect = (extra = {}) => connectExternalMcpClient({ target: 'claude', folder, mode: 'operator', endpoint, ...extra });
/** @param {string} id */
const row = (id) => listExternalMcpClients().find((client) => client.id === id);

test('profile constants: one rule definition and a superset chain', () => {
  assert.equal(CLAUDE_TOOL_PERMISSION_RULE, `mcp__${EXTERNAL_MCP_SERVER_NAME}`);
  assert.equal(INSTALL_RULE, CLAUDE_TOOL_PERMISSION_RULE);
  for (let i = 1; i < PROFILE_ORDER.length; i += 1) {
    const lower = profileRequires(PROFILE_ORDER[i - 1]);
    const higher = profileRequires(PROFILE_ORDER[i]);
    for (const list of /** @type {const} */ (['allow', 'ask', 'deny'])) {
      for (const rule of lower[list]) assert.ok(higher[list].includes(rule), `${PROFILE_ORDER[i]} keeps ${rule}`);
    }
    if (lower.defaultMode) assert.equal(higher.defaultMode, lower.defaultMode);
  }
  assert.equal(strongestProfile(['prompt', 'edits_bash_guarded', 'cretli_tools']), 'edits_bash_guarded');
  assert.equal(strongestProfile([]), 'prompt');
});

test('allowTools and permissionProfile map to a profile', () => {
  assert.deepEqual(normalizePermissionProfile(undefined, { allowTools: true }), { profile: 'cretli_tools' });
  assert.deepEqual(normalizePermissionProfile(undefined, { allowTools: false }), { profile: 'prompt' });
  assert.deepEqual(normalizePermissionProfile(undefined, {}), { profile: undefined });
  assert.deepEqual(normalizePermissionProfile('edits_bash_guarded', { allowTools: false }), { profile: 'edits_bash_guarded' });
  assert.ok('error' in normalizePermissionProfile('everything'));
  assert.throws(() => connect({ permissionProfile: 'everything' }), /permissionProfile must be one of/);
});

test('merge keeps user keys and rules, adds only missing rules and is idempotent', () => {
  writeSettings({ env: { A: '1' }, permissions: { allow: ['Bash', 'Bash(npm test)'], ask: ['Bash(git push)'], deny: ['Read(./.env)', 'Read(./secret)'] }, model: 'opus' });
  const grant = applyClaudePermissionProfile(folder, 'edits_bash_guarded');
  const merged = readSettings();
  assert.equal(merged.env.A, '1');
  assert.equal(merged.model, 'opus');
  assert.equal(merged.permissions.defaultMode, 'acceptEdits');
  assert.deepEqual(merged.permissions.allow.slice(0, 2), ['Bash', 'Bash(npm test)']);
  assert.ok(merged.permissions.deny.includes('Read(./secret)'));
  // Rules the user already had are not Cretli's.
  assert.ok(!grant.addedRules.allow.includes('Bash'));
  assert.ok(!grant.addedRules.ask.includes('Bash(git push)'));
  assert.ok(!grant.addedRules.deny.includes('Read(./.env)'));
  assert.ok(grant.addedRules.allow.includes(CLAUDE_TOOL_PERMISSION_RULE));
  assert.equal(grant.defaultMode.owned, true);
  const before = fs.readFileSync(settingsFile(), 'utf8');
  const again = applyClaudePermissionProfile(folder, 'edits_bash_guarded', grant);
  assert.equal(fs.readFileSync(settingsFile(), 'utf8'), before);
  assert.equal(again.inserted, 0);
  assert.deepEqual(again.addedRules, grant.addedRules, 'inherited rules stay Cretli\'s');
  assert.deepEqual(again.defaultMode, grant.defaultMode);
});

test('changing the profile 3 -> 2 removes only the rules Cretli added and restores defaultMode', () => {
  writeSettings({ permissions: { allow: ['Bash', 'Bash(npm test)'], deny: ['Read(./.env)'] } });
  const guarded = applyClaudePermissionProfile(folder, 'edits_bash_guarded');
  const tools = applyClaudePermissionProfile(folder, 'cretli_tools', guarded);
  const settings = readSettings();
  assert.deepEqual(settings.permissions.allow, ['Bash', 'Bash(npm test)', CLAUDE_TOOL_PERMISSION_RULE]);
  assert.deepEqual(settings.permissions.ask, []);
  assert.deepEqual(settings.permissions.deny, ['Read(./.env)']);
  assert.equal(settings.permissions.defaultMode, undefined);
  assert.deepEqual(tools.addedRules, { allow: [CLAUDE_TOOL_PERMISSION_RULE], ask: [], deny: [] });
  assert.equal(tools.defaultMode.owned, false);
  const prompt = applyClaudePermissionProfile(folder, 'prompt', tools);
  assert.deepEqual(readSettings().permissions.allow, ['Bash', 'Bash(npm test)']);
  assert.equal(prompt.profile, 'prompt');
});

test('defaultMode: a user value is kept and reported, a user acceptEdits is never restored', () => {
  writeSettings({ permissions: { defaultMode: 'plan' } });
  const kept = applyClaudePermissionProfile(folder, 'edits_bash_guarded');
  assert.equal(readSettings().permissions.defaultMode, 'plan');
  assert.equal(kept.defaultModeKept, 'plan');
  assert.equal(kept.defaultMode.owned, false);

  writeSettings({ permissions: { defaultMode: 'acceptEdits' } });
  const own = applyClaudePermissionProfile(folder, 'edits_bash_guarded');
  assert.equal(own.defaultMode.owned, false);
  applyClaudePermissionProfile(folder, 'prompt', own);
  assert.equal(readSettings().permissions.defaultMode, 'acceptEdits');
});

test('defaultMode set by Cretli is restored only while it still holds Cretli\'s value', () => {
  const grant = applyClaudePermissionProfile(folder, 'edits_bash_guarded');
  assert.equal(readSettings().permissions.defaultMode, 'acceptEdits');
  writeSettings({ permissions: { ...readSettings().permissions, defaultMode: 'plan' } });
  releaseClaudePermissionGrant(folder, grant, []);
  assert.equal(readSettings().permissions.defaultMode, 'plan', 'user changed it meanwhile');

  const second = applyClaudePermissionProfile(folder, 'edits_bash_guarded', emptyGrant());
  assert.equal(second.defaultMode.owned, false, 'plan is the user\'s value now');
  fs.rmSync(settingsFile());
  const third = applyClaudePermissionProfile(folder, 'edits_bash_guarded');
  const { removed } = releaseClaudePermissionGrant(folder, third, []);
  assert.ok(removed.includes('defaultMode'));
  assert.equal(readSettings().permissions.defaultMode, undefined);
  assert.deepEqual(readSettings().permissions.allow, []);
});

test('invalid settings are refused with the file untouched', () => {
  for (const bad of ['{ broken', JSON.stringify({ permissions: { ask: 'x' } }), JSON.stringify({ permissions: { deny: {} } }), JSON.stringify({ permissions: { defaultMode: 3 } })]) {
    writeSettings(bad);
    assert.throws(() => applyClaudePermissionProfile(folder, 'edits_bash_guarded'), /left unchanged|unchanged/);
    assert.equal(fs.readFileSync(settingsFile(), 'utf8'), bad);
  }
  // The prompt profile with nothing to undo never reads the file.
  writeSettings('{ broken');
  assert.doesNotThrow(() => applyClaudePermissionProfile(folder, 'prompt'));
});

test('release plan: a rule another client\'s profile requires is transferred, guarded-only rules are not parked on cretli_tools', () => {
  const grant = applyClaudePermissionProfile(folder, 'edits_bash_guarded');
  const toolsOnly = planClaudePermissionRelease(grant, [{ id: 'c1', profile: 'cretli_tools' }, { id: 'c0', profile: 'prompt' }]);
  assert.deepEqual(toolsOnly.transfer.rules, [{ clientId: 'c1', rule: CLAUDE_TOOL_PERMISSION_RULE, list: 'allow' }]);
  assert.ok(toolsOnly.remove.allow.includes('Bash'));
  assert.deepEqual(toolsOnly.remove.ask, GUARDED.ask);
  assert.equal(toolsOnly.transfer.defaultMode, null);
  assert.deepEqual(toolsOnly.restoreDefaultMode, { previous: null });

  const guarded = planClaudePermissionRelease(grant, [{ id: 'g2', profile: 'edits_bash_guarded' }]);
  assert.equal(guarded.transfer.rules.length, grant.addedRules.allow.length + grant.addedRules.ask.length + grant.addedRules.deny.length);
  assert.deepEqual(guarded.transfer.defaultMode, { clientId: 'g2', previous: null });
  assert.equal(guarded.restoreDefaultMode, null);
  assert.deepEqual(guarded.remove, { allow: [], ask: [], deny: [] });
});

test('connect records the grant; several connections: rules stay until the last one that needs them leaves', () => {
  writeSettings({ permissions: { allow: ['Bash(npm test)'] } });
  const first = connect({ permissionProfile: 'edits_bash_guarded' });
  assert.equal(first.toolPermission.profile, 'edits_bash_guarded');
  assert.equal(first.permissionGrant.profile, 'edits_bash_guarded');
  assert.equal(effectiveGrant(row(first.client.id)).defaultMode.owned, true);
  // A rule Cretli added is released only with the connection that holds it.
  const owner = row(first.client.id);
  // Simulate a second live connection (e.g. a legacy state) holding cretli_tools.
  const second = connectExternalMcpClient({ target: 'codex', folder, endpoint });
  assert.equal(second.permissionGrant, null);
  const { removed } = releaseClientPermission(owner);
  assert.ok(removed.includes('Bash'));
  assert.deepEqual(readSettings().permissions.allow, ['Bash(npm test)']);
  assert.equal(readSettings().permissions.defaultMode, undefined);
  // Idempotent: the grant is cleared, a repeated release is a no-op.
  assert.deepEqual(releaseClientPermission(owner), { removed: [] });
  assert.equal(effectiveGrant(row(first.client.id)).profile, 'prompt');
});

test('release transfers needed rules to the remaining live client in any order', () => {
  const grant = applyClaudePermissionProfile(folder, 'edits_bash_guarded');
  const a = connect({ permissionProfile: 'prompt' });
  // Put the grant and a second live managed client of the same folder in the store by hand.
  setExternalMcpClientPermissionGrant(a.client.id, grant);
  const b = connect({});
  assert.equal(listExternalMcpClients().filter((client) => !client.revokedAt && client.installTarget === 'claude').length, 1, 'connect replaced the first one');
  // The replacement inherits the merged grant, so releasing it removes everything exactly once.
  const inherited = effectiveGrant(row(b.client.id));
  assert.equal(inherited.profile, 'edits_bash_guarded');
  assert.deepEqual(inherited.addedRules, grant.addedRules);
  const { removed } = releaseClientPermission(row(b.client.id));
  assert.ok(removed.includes(CLAUDE_TOOL_PERMISSION_RULE));
  assert.deepEqual(readSettings().permissions.allow, []);
  assert.deepEqual(readSettings().permissions.deny, []);
});

test('reconnect carries ownership: profile 3 then 2 then release leaves the user\'s file as it was', () => {
  writeSettings({ env: { KEEP: '1' }, permissions: { allow: ['Bash(npm test)'] } });
  connect({ permissionProfile: 'edits_bash_guarded' });
  const tools = connect({ permissionProfile: 'cretli_tools' });
  assert.deepEqual(readSettings().permissions.allow, ['Bash(npm test)', CLAUDE_TOOL_PERMISSION_RULE]);
  assert.equal(tools.client.claudeToolPermission, 'added');
  // What the revoke route does: permissions, then the server approval.
  releaseClientPermission(row(tools.client.id));
  releaseServerApproval(row(tools.client.id));
  assert.deepEqual(readSettings(), { env: { KEEP: '1' }, permissions: { allow: ['Bash(npm test)'], ask: [], deny: [] } });
});

test('omitting both fields carries the replaced grant; an apply failure keeps it', () => {
  const first = connect({ permissionProfile: 'edits_bash_guarded' });
  const second = connect({});
  assert.equal(second.toolPermission, null);
  assert.equal(effectiveGrant(row(second.client.id)).profile, 'edits_bash_guarded');
  assert.equal(row(first.client.id)?.revokedAt !== null, true);
  writeSettings('{ broken');
  const third = connect({ permissionProfile: 'cretli_tools' });
  assert.match(third.toolPermission.error, /not valid JSON/);
  assert.equal(third.permissionGrant.error !== undefined, true);
  assert.equal(effectiveGrant(row(third.client.id)).profile, 'edits_bash_guarded');
  assert.equal(fs.readFileSync(settingsFile(), 'utf8'), '{ broken');
});

test('legacy markers read as cretli_tools; merged grants take the strongest profile', () => {
  const added = effectiveGrant({ claudeToolPermission: 'added' });
  assert.equal(added.profile, 'cretli_tools');
  assert.deepEqual(added.addedRules.allow, [CLAUDE_TOOL_PERMISSION_RULE]);
  const existing = effectiveGrant({ claudeToolPermission: 'existing' });
  assert.deepEqual(existing.addedRules.allow, []);
  assert.equal(effectiveGrant({}).profile, 'prompt');
  const guarded = applyClaudePermissionProfile(folder, 'edits_bash_guarded');
  const merged = mergeGrants([existing, guarded, added]);
  assert.equal(merged.profile, 'edits_bash_guarded');
  assert.equal(merged.addedRules.allow.filter((rule) => rule === CLAUDE_TOOL_PERMISSION_RULE).length, 1);
  assert.equal(merged.defaultMode.owned, true);
});

/**
 * A live managed Claude client holding `grant`, as several connections in one folder would.
 *
 * @param {import('../lib/mcp/claude-permission-profiles.js').ClaudePermissionGrant | null} grant
 */
function liveClient(grant) {
  const { client } = createExternalMcpManagedClient({ name: 'Claude Code', workspaceFolder: folder, mode: 'operator', installTarget: 'claude', installFolder: folder });
  if (grant) setExternalMcpClientPermissionGrant(client.id, grant);
  return client.id;
}

for (const order of [[0, 1], [1, 0]]) {
  test(`guarded owner + guarded + cretli_tools clients released in order ${order.join(',')}: nothing a live client needs is removed`, () => {
    const owner = applyClaudePermissionProfile(folder, 'edits_bash_guarded');
    const ids = [liveClient(owner), liveClient({ ...emptyGrant(), profile: 'edits_bash_guarded' })];
    const toolsId = liveClient({ ...emptyGrant(), profile: 'cretli_tools' });
    liveClient(null); // cleared grant: requires nothing, never receives a rule
    // Like the DELETE route: release first, then revoke the connection.
    const release = (/** @type {string} */ id) => {
      const result = releaseClientPermission(/** @type {any} */ (row(id)));
      revokeExternalMcpClient(id);
      return result;
    };
    release(ids[order[0]]);
    assert.ok(readSettings().permissions.allow.includes('Bash'), 'a guarded client is still live');
    assert.equal(readSettings().permissions.defaultMode, 'acceptEdits');
    if (order[0] === 0) assert.equal(effectiveGrant(row(ids[1])).addedRules.allow.includes('Bash'), true, 'transferred to the guarded client');
    release(ids[order[1]]);
    // Only the cretli_tools client is left: guarded-only rules are gone, its rule stays.
    const settings = readSettings();
    assert.deepEqual(settings.permissions.allow, [CLAUDE_TOOL_PERMISSION_RULE]);
    assert.deepEqual(settings.permissions.ask, []);
    assert.deepEqual(settings.permissions.deny, []);
    assert.equal(settings.permissions.defaultMode, undefined);
    assert.equal(effectiveGrant(row(toolsId)).addedRules.allow.includes(CLAUDE_TOOL_PERMISSION_RULE), true);
    release(toolsId);
    assert.deepEqual(readSettings().permissions.allow, []);
  });
}

test('release is idempotent after a crash between the file edit and the grant clear', () => {
  const grant = applyClaudePermissionProfile(folder, 'edits_bash_guarded');
  const id = liveClient(grant);
  releaseClaudePermissionGrant(folder, grant, []); // file edited, grant still on the row
  assert.deepEqual(releaseClientPermission(/** @type {any} */ (row(id))).removed, []);
  assert.deepEqual(readSettings().permissions.allow, []);
});

test('F1: a replaced client keeps no stale grant, so deleting it later leaves rules the user re-added', () => {
  const a = connect({ permissionProfile: 'edits_bash_guarded' });
  const b = connect({ permissionProfile: 'cretli_tools' });
  assert.equal(effectiveGrant(row(a.client.id)).profile, 'prompt', 'replaced row is cleared');
  assert.deepEqual(effectiveGrant(row(a.client.id)).addedRules.allow, []);
  assert.equal(readSettings().permissions.defaultMode, undefined);
  // The user re-adds Bash and acceptEdits by hand.
  const settings = readSettings();
  writeSettings({ permissions: { ...settings.permissions, allow: [...settings.permissions.allow, 'Bash'], defaultMode: 'acceptEdits' } });
  assert.deepEqual(releaseClientPermission(/** @type {any} */ (row(a.client.id))), { removed: [] });
  revokeExternalMcpClient(a.client.id);
  assert.ok(readSettings().permissions.allow.includes('Bash'));
  assert.equal(readSettings().permissions.defaultMode, 'acceptEdits');
  assert.ok(row(b.client.id));
});

test('F2: releasing a client that owns nothing clears its profile, so the owner later reverts instead of handing rules over', () => {
  const ownerGrant = applyClaudePermissionProfile(folder, 'edits_bash_guarded');
  const ownerId = liveClient(ownerGrant);
  const dependentId = liveClient({ ...emptyGrant(), profile: 'edits_bash_guarded' });
  assert.deepEqual(releaseClientPermission(/** @type {any} */ (row(dependentId))), { removed: [] });
  assert.equal(effectiveGrant(row(dependentId)).profile, 'prompt');
  const { removed } = releaseClientPermission(/** @type {any} */ (row(ownerId)));
  assert.ok(removed.includes('Bash'));
  assert.deepEqual(readSettings().permissions.allow, []);
  assert.equal(readSettings().permissions.defaultMode, undefined);
  assert.equal(effectiveGrant(row(dependentId)).addedRules.allow.length, 0, 'nothing handed to the released client');
});

test('F3: a settings read error keeps the grant; after the file is repaired a release still reverts', () => {
  const grant = applyClaudePermissionProfile(folder, 'edits_bash_guarded');
  const good = fs.readFileSync(settingsFile(), 'utf8');
  const id = liveClient(grant);
  const peerId = liveClient({ ...emptyGrant(), profile: 'edits_bash_guarded' });
  writeSettings('{ broken');
  const failed = releaseClientPermission(/** @type {any} */ (row(id)));
  assert.match(failed.failed || '', /not valid JSON/);
  assert.equal(fs.readFileSync(settingsFile(), 'utf8'), '{ broken');
  assert.equal(effectiveGrant(row(id)).defaultMode.owned, true, 'ownership kept');
  assert.equal(effectiveGrant(row(peerId)).addedRules.allow.length, 0, 'no transfer on a failed read');
  revokeExternalMcpClient(peerId);
  writeSettings(good);
  const done = releaseClientPermission(/** @type {any} */ (row(id)));
  assert.equal(done.failed, undefined);
  assert.ok(done.removed.includes('Bash'));
  assert.deepEqual(readSettings().permissions.allow, []);
  assert.equal(effectiveGrant(row(id)).profile, 'prompt');
});
