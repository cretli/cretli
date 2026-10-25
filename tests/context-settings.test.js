import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import {
  mergeSettingsPatch,
  normalizeSettingsLayer,
  resolveContextSettings,
  validateRepoContextSettings,
} from '../lib/context/context-settings.ts';
import { loadValidatedProjectContextConfig } from '../lib/context/project-context-config.ts';
import {
  buildAgentsMdBlockForTurn,
  patchChatContextSettings,
  patchHostContextSettings,
  resolveContextSettingsForScope,
} from '../lib/context/context-settings-runtime.ts';
import { registerContextSettingsRoutes } from '../lib/routes/context-settings-routes.js';
import { loadSettings, saveSettings } from '../lib/persist/settings.js';
import { loadChats, saveChats } from '../lib/persist/chats-persist.js';

test.after(() => removeIsolatedDataDir());

const repo = (config) => ({ active: true, config, path: '/x/.cretli/context.json' });

test('layers: default -> host -> project -> chat, last wins with provenance', () => {
  const r = resolveContextSettings({
    hostSettings: { contextSettings: { agentsMd: { mode: 'off' } } },
    projectConfig: repo({ version: 1, settings: { agentsMd: { mode: 'force' } } }),
    chat: { contextSettings: { agentsMd: { mode: 'auto' } } },
  });
  assert.equal(r.effective['agentsMd.mode'], 'auto');
  assert.deepEqual(r.provenance['agentsMd.mode'], { layer: 'chat', via: 'chat' });
  assert.equal(r.provenance['globs.index'].layer, 'default');
  assert.equal(r.repoConfig.active, true);
  assert.deepEqual(r.repoConfig.changes, ['agentsMd.mode']);
  assert.equal(r.effects['agentsMd.mode'].effect, 'next_turn');
  assert.equal(r.effects['agentsMd.mode'].retraction, 'new_session');
});

test('host policy locks keys and forbids values against project and chat layers', () => {
  const r = resolveContextSettings({
    hostSettings: { contextSettings: { agentsMd: { mode: 'off' } }, contextPolicy: { locked: ['agentsMd.mode'] } },
    projectConfig: repo({ version: 1, settings: { agentsMd: { mode: 'force' } } }),
    chat: { contextSettings: { agentsMd: { mode: 'auto' } } },
  });
  assert.equal(r.effective['agentsMd.mode'], 'off');
  assert.equal(r.blocked.filter((b) => b.reason === 'host_policy_locked').length, 2);
  const f = resolveContextSettings({
    hostSettings: { contextPolicy: { forbiddenValues: { 'agentsMd.mode': ['force'] } } },
    chat: { contextSettings: { agentsMd: { mode: 'force' } } },
  });
  assert.equal(f.effective['agentsMd.mode'], 'auto');
  assert.equal(f.blocked[0].reason, 'host_policy_value');
});

test('profile is a named set resolved by the same layers (no second resolver)', () => {
  const r = resolveContextSettings({
    hostSettings: { contextProfiles: { quiet: { agentsMd: { mode: 'off' }, globs: { index: false } } } },
    projectConfig: repo({ version: 1, profiles: { strict: { agentsMd: { mode: 'force' } } }, settings: { profile: 'strict' } }),
    chat: { contextSettings: { profile: 'quiet', globs: { index: true } } },
  });
  // chat: profile values first, then the chat's own explicit value wins.
  assert.equal(r.effective['agentsMd.mode'], 'off');
  assert.equal(r.effective['globs.index'], true);
  assert.equal(r.provenance['agentsMd.mode'].via, 'profile:quiet');
  assert.equal(r.provenance['globs.index'].via, 'chat');
  const unknown = resolveContextSettings({ chat: { contextSettings: { profile: 'nope' } } });
  assert.ok(unknown.blocked.some((b) => b.reason === 'unknown_profile'));
});

test('repo config cannot select or assign host sources', () => {
  for (const key of ['sharedDirs', 'additionalCursorContextDirs', 'sources', 'assignments', 'bundled']) {
    const checked = validateRepoContextSettings({ settings: { [key]: ['/etc'] } });
    assert.equal(checked.ok, false, key);
    assert.equal(checked.code, 'host_source_in_repo_config');
  }
  assert.equal(validateRepoContextSettings({ profiles: { p: { sharedDirs: [] } } }).ok, false);
  assert.equal(validateRepoContextSettings({ settings: { bogus: 1 } }).ok, false);
});

test('project config loader: bad settings rejected, symlink-escaping entry rejected, valid accepted', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ctxcfg-')));
  try {
    const root = path.join(base, 'p');
    fs.mkdirSync(path.join(root, '.cretli'), { recursive: true });
    const write = (obj) => fs.writeFileSync(path.join(root, '.cretli', 'context.json'), JSON.stringify(obj));
    write({ version: 1, settings: { agentsMd: { mode: 'off' } } });
    assert.equal(loadValidatedProjectContextConfig(root).ok, true);
    write({ version: 1, settings: { sharedDirs: ['/tmp'] } });
    assert.equal(loadValidatedProjectContextConfig(root).code, 'host_source_in_repo_config');
    fs.symlinkSync(os.tmpdir(), path.join(root, 'out'));
    write({ version: 1, entries: [{ path: 'out/x.md' }] });
    assert.equal(loadValidatedProjectContextConfig(root).ok, false);
    write({ version: 1, entries: [{ source: 'shared:x', path: 'a.md' }] });
    assert.equal(loadValidatedProjectContextConfig(root).code, 'host_source_in_repo_config');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('patch merge validates, clears with null and never applies a partial patch', () => {
  const a = mergeSettingsPatch(undefined, { agentsMd: { mode: 'force' }, profile: 'p1' });
  assert.equal(a.ok, true);
  assert.equal(a.block.agentsMd.mode, 'force');
  assert.equal(a.block.profile, 'p1');
  const b = mergeSettingsPatch(a.block, { 'agentsMd.mode': null, profile: null });
  assert.deepEqual(b.block, { version: 1 });
  const bad = mergeSettingsPatch(a.block, { agentsMd: { mode: 'weird' } });
  assert.equal(bad.ok, false);
  assert.equal(normalizeSettingsLayer({ agentsMd: { mode: 'x' } }).errors[0].code, 'invalid_value');
});

test('persistence: host + chat patches survive reload and keep additionalCursorContextDirs intact', () => {
  const owner = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-owner-')));
  const before = loadSettings();
  const beforeChats = loadChats();
  try {
    saveSettings({ ...before, additionalCursorContextDirs: [owner], lanHost: 'keep-me' });
    assert.equal(patchHostContextSettings({ settings: { agentsMd: { mode: 'off' } }, profiles: { q: { globs: { index: false } } } }).ok, true);
    const stored = loadSettings();
    assert.deepEqual(stored.additionalCursorContextDirs, [owner]);
    assert.equal(stored.lanHost, 'keep-me');
    assert.equal(stored.contextSettings.agentsMd.mode, 'off');
    assert.equal(stored.contextProfiles.q.globs.index, false);
    assert.equal(patchHostContextSettings({ settings: { agentsMd: { mode: 'bad' } } }).ok, false);
    assert.equal(loadSettings().contextSettings.agentsMd.mode, 'off');
    // Legacy dirs are still shown (read-only) in the effective view.
    const view = resolveContextSettings({ hostSettings: loadSettings() });
    assert.deepEqual(view.sharedDirs, { values: [owner], readOnly: true, storedAs: 'additionalCursorContextDirs' });

    saveChats([{ id: 'ctx-set-1', title: 't', workspaceFolder: owner, messages: [] }]);
    assert.equal(patchChatContextSettings('ctx-set-1', { profile: 'q', agentsMd: { mode: 'force' } }).ok, true);
    const chat = loadChats().find((c) => c.id === 'ctx-set-1');
    assert.equal(chat.contextSettings.agentsMd.mode, 'force');
    const resolved = resolveContextSettingsForScope({ projectRoot: owner, chatId: 'ctx-set-1' });
    assert.equal(resolved.effective['agentsMd.mode'], 'force');
    assert.equal(resolved.effective['globs.index'], false);
  } finally {
    saveSettings(before, { allowEmpty: true });
    saveChats(beforeChats);
    fs.rmSync(owner, { recursive: true, force: true });
  }
});

test('multiroot: repo config belongs to the chat folder root, not to another root', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-multi-')));
  const rootA = path.join(base, 'a');
  const rootB = path.join(base, 'b');
  for (const r of [rootA, rootB]) fs.mkdirSync(path.join(r, '.cretli'), { recursive: true });
  fs.writeFileSync(path.join(rootA, '.cretli', 'context.json'), JSON.stringify({ version: 1, settings: { agentsMd: { mode: 'off' } } }));
  fs.writeFileSync(path.join(rootB, 'AGENTS.md'), 'B RULES');
  const before = loadChats();
  try {
    saveChats([
      { id: 'mr-a', title: 'a', workspaceFolder: rootA, messages: [] },
      { id: 'mr-b', title: 'b', workspaceFolder: rootB, messages: [] },
    ]);
    assert.equal(resolveContextSettingsForScope({ projectRoot: rootA, chatId: 'mr-a' }).effective['agentsMd.mode'], 'off');
    const b = resolveContextSettingsForScope({ projectRoot: rootB, chatId: 'mr-b' });
    assert.equal(b.effective['agentsMd.mode'], 'auto');
    assert.equal(b.repoConfig.active, false);
    // Per-turn block follows the chat's own root (forced here to prove the right AGENTS.md is read).
    const turn = buildAgentsMdBlockForTurn({ cwd: rootB, chatId: 'mr-b', transport: 'codex', contextSettings: { 'agentsMd.mode': 'force' } });
    assert.match(turn.text, /B RULES/);
    const none = buildAgentsMdBlockForTurn({ cwd: rootA, chatId: 'mr-a', transport: 'codex' });
    assert.equal(none.text, '');
  } finally { saveChats(before); fs.rmSync(base, { recursive: true, force: true }); }
});

/** Minimal express stand-in covering get/patch routes. */
function mountRoutes(cwd) {
  const handlers = {};
  const app = {
    get: (p, fn) => { handlers[`GET ${p}`] = fn; },
    patch: (p, fn) => { handlers[`PATCH ${p}`] = fn; },
  };
  registerContextSettingsRoutes(app, { getCurrentCwd: () => cwd });
  return (method, route, req) => new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(body) { resolve({ status: this.statusCode, body }); },
    };
    handlers[`${method} ${route}`](req, res);
  });
}

test('API: effective config shows repo-config activity, delivery and next-turn effect; widget cannot patch', async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-api-')));
  const root = path.join(base, 'p');
  const sub = path.join(root, 'sub');
  fs.mkdirSync(path.join(root, '.cretli'), { recursive: true });
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(root, '.cretli', 'context.json'), JSON.stringify({ version: 1, settings: { globs: { index: false } } }));
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'R');
  fs.writeFileSync(path.join(sub, 'AGENTS.md'), 'S');
  const before = loadChats();
  try {
    saveChats([{ id: 'api-1', title: 't', workspaceFolder: root, executionFolder: sub, agentTransport: 'codex', messages: [] }]);
    const call = mountRoutes(base);
    const got = await call('GET', '/api/context-settings', { query: { chatId: 'api-1' } });
    assert.equal(got.status, 200);
    assert.equal(got.body.settings.repoConfig.active, true);
    assert.equal(got.body.settings.effective['globs.index'], false);
    assert.equal(got.body.settings.effects['agentsMd.mode'].effect, 'next_turn');
    assert.deepEqual(got.body.agentsMd.chain.map((e) => e.relPath), ['AGENTS.md', 'sub/AGENTS.md']);
    assert.equal(got.body.agentsMd.delivery.reason, 'unknown_not_injected');
    assert.deepEqual(got.body.globs, []);
    assert.ok(!JSON.stringify(got.body.agentsMd).includes(base), 'no absolute paths in the AGENTS payload');

    const patched = await call('PATCH', '/api/context-settings', { query: { chatId: 'api-1' }, body: { level: 'chat', settings: { agentsMd: { mode: 'off' } } } });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.settings.effective['agentsMd.mode'], 'off');
    const bad = await call('PATCH', '/api/context-settings', { query: { chatId: 'api-1' }, body: { level: 'chat', settings: { agentsMd: { mode: 'nope' } } } });
    assert.equal(bad.status, 400);
    const widget = await call('PATCH', '/api/context-settings', {
      query: {}, widgetAccess: { workspaceFolder: root }, body: { level: 'host', settings: { agentsMd: { mode: 'force' } } },
    });
    assert.equal(widget.status, 403);
    const read = await call('GET', '/api/context-instructions', { query: { chatId: 'api-1', path: 'sub/file.ts' } });
    assert.equal(read.status, 200);
    assert.deepEqual(read.body.agents.map((a) => a.relPath), ['AGENTS.md', 'sub/AGENTS.md']);
    const esc = await call('GET', '/api/context-instructions', { query: { chatId: 'api-1', path: '../x' } });
    assert.equal(esc.status, 403);
  } finally { saveChats(before); fs.rmSync(base, { recursive: true, force: true }); }
});
