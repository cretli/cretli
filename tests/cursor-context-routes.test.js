import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { registerCursorContextRoutes } from '../lib/routes/cursor-context-routes.js';
import { ensureCursorShare } from '../lib/sdk/cursor-share.ts';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import { loadChats, saveChats } from '../lib/persist/chats-persist.js';

test.after(() => {
  removeIsolatedDataDir();
});

/**
 * @param {{ query?: object, widgetAccess?: object }} req
 * @param {string} fallbackCwd
 * @returns {Promise<{ status: number, body: object }>}
 */
function invokeCursorContext(req, fallbackCwd) {
  /** @type {(req: object, res: object) => void} */
  let handler = () => {};
  const app = {
    get(_path, fn) {
      handler = fn;
    },
  };
  registerCursorContextRoutes(app, { getCurrentCwd: () => fallbackCwd });
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        resolve({ status: this.statusCode, body });
      },
    };
    handler(req, res);
  });
}

test('cursor-context uses explicit workspace query when unscoped', async () => {
  const inputChatCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ctx-chat-'));
  const inputFallbackCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ctx-fallback-'));
  fs.mkdirSync(path.join(inputChatCwd, '.cursor', 'skills', 'chat-skill'), { recursive: true });
  fs.writeFileSync(path.join(inputChatCwd, '.cursor', 'skills', 'chat-skill', 'SKILL.md'), '# Chat\n');
  fs.mkdirSync(path.join(inputFallbackCwd, '.cursor', 'skills', 'fallback-skill'), { recursive: true });
  fs.writeFileSync(
    path.join(inputFallbackCwd, '.cursor', 'skills', 'fallback-skill', 'SKILL.md'),
    '# Fallback\n',
  );
  const actual = await invokeCursorContext(
    { query: { workspaceFolder: inputChatCwd } },
    inputFallbackCwd,
  );
  assert.equal(actual.status, 200);
  assert.equal(actual.body.ok, true);
  assert.equal(actual.body.projectSkills.some((item) => item.name === 'chat-skill'), true);
  assert.equal(actual.body.projectSkills.some((item) => item.name === 'fallback-skill'), false);
  fs.rmSync(inputChatCwd, { recursive: true, force: true });
  fs.rmSync(inputFallbackCwd, { recursive: true, force: true });
});

test('cursor-context chat scope rejects foreign client workspaceFolder', async () => {
  const projectA = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ctx-a-'));
  const projectB = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ctx-b-'));
  const chatId = 'chat-scope-test-1';
  saveChats([
    ...loadChats(),
    {
      id: chatId,
      title: 'Scope test',
      cursorSessionId: 'sess-scope-1',
      workspaceFolder: projectA,
    },
  ]);
  const actual = await invokeCursorContext(
    { query: { chatId, workspaceFolder: projectB } },
    os.tmpdir(),
  );
  assert.equal(actual.status, 403);
  assert.equal(actual.body.ok, false);
  assert.equal(actual.body.code, 'scope_out_of_bounds');
  fs.rmSync(projectA, { recursive: true, force: true });
  fs.rmSync(projectB, { recursive: true, force: true });
});

test('cursor-context widget rejects query cwd override', async () => {
  const inputWidgetCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ctx-widget-'));
  const inputQueryCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ctx-query-'));
  fs.mkdirSync(path.join(inputWidgetCwd, '.cursor', 'skills', 'widget-skill'), { recursive: true });
  fs.writeFileSync(
    path.join(inputWidgetCwd, '.cursor', 'skills', 'widget-skill', 'SKILL.md'),
    '# Widget\n',
  );
  const actual = await invokeCursorContext(
    {
      query: { cwd: inputQueryCwd },
      widgetAccess: { workspaceFolder: inputWidgetCwd, installationId: 'i', pageSessionId: 'p' },
    },
    os.tmpdir(),
  );
  assert.equal(actual.status, 403);
  assert.equal(actual.body.ok, false);
  fs.rmSync(inputWidgetCwd, { recursive: true, force: true });
  fs.rmSync(inputQueryCwd, { recursive: true, force: true });
});

test('cursor-context widget serves authorized workspace without client path', async () => {
  const inputWidgetCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ctx-widget-'));
  fs.mkdirSync(path.join(inputWidgetCwd, '.cursor', 'skills', 'widget-skill'), { recursive: true });
  fs.writeFileSync(
    path.join(inputWidgetCwd, '.cursor', 'skills', 'widget-skill', 'SKILL.md'),
    '# Widget\n',
  );
  const actual = await invokeCursorContext(
    {
      query: {},
      widgetAccess: { workspaceFolder: inputWidgetCwd, installationId: 'i', pageSessionId: 'p' },
    },
    os.tmpdir(),
  );
  assert.equal(actual.status, 200);
  assert.equal(actual.body.ok, true);
  assert.equal(actual.body.projectSkills.some((item) => item.name === 'widget-skill'), true);
  assert.deepEqual(actual.body.userSkills, []);
  fs.rmSync(inputWidgetCwd, { recursive: true, force: true });
});

test('cursor-context compare=legacy keeps widget host-source gate', async () => {
  ensureCursorShare();
  const widgetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ctx-w-legacy-'));
  const foreignDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ctx-f-legacy-'));
  const actual = await invokeCursorContext(
    {
      query: { compare: 'legacy', cwd: foreignDir },
      widgetAccess: { workspaceFolder: widgetDir, installationId: 'i', pageSessionId: 'p' },
    },
    foreignDir,
  );
  assert.equal(actual.status, 403);
  assert.equal(actual.body.ok, false);
  fs.rmSync(widgetDir, { recursive: true, force: true });
  fs.rmSync(foreignDir, { recursive: true, force: true });
});

test('cursor-context includes bundled cretli-multi-harness for authorized workspace', async () => {
  ensureCursorShare();
  const inputBackendCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ctx-backend-'));
  const actual = await invokeCursorContext({ query: { workspaceFolder: inputBackendCwd } }, os.tmpdir());
  assert.equal(actual.status, 200);
  assert.equal(actual.body.ok, true);
  assert.ok(
    actual.body.sharedSkills.some(
      (item) => item.name === 'cretli-multi-harness' && item.source === 'bundled',
    ),
  );
  fs.rmSync(inputBackendCwd, { recursive: true, force: true });
});

test('cursor-context project symlink escape is rejected via config validation', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ctx-symlink-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ctx-outside-'));
  fs.mkdirSync(path.join(project, '.cretli'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'skill.md'), '# x');
  const linkDir = path.join(project, 'linked');
  fs.symlinkSync(outside, linkDir, 'dir');
  fs.writeFileSync(
    path.join(project, '.cretli/context.json'),
    JSON.stringify({ version: 1, entries: [{ source: 'project', path: 'linked/skill.md' }] }),
  );
  const actual = await invokeCursorContext({ query: { workspaceFolder: project } }, os.tmpdir());
  assert.equal(actual.status, 400);
  assert.equal(actual.body.ok, false);
  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('cursor-context discovery skips skill dir symlink outside project root', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ctx-sk-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ctx-sk-out-'));
  fs.mkdirSync(path.join(project, '.cursor', 'skills', 'in-project'), { recursive: true });
  fs.writeFileSync(path.join(project, '.cursor', 'skills', 'in-project', 'SKILL.md'), '# ok\n');
  fs.mkdirSync(path.join(outside, 'escaped-skill'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'escaped-skill', 'SKILL.md'), '# leaked\n');
  fs.symlinkSync(
    path.join(outside, 'escaped-skill'),
    path.join(project, '.cursor', 'skills', 'escaped-skill'),
    'dir',
  );
  const actual = await invokeCursorContext({ query: { workspaceFolder: project } }, os.tmpdir());
  assert.equal(actual.status, 200);
  assert.equal(actual.body.projectSkills.some((item) => item.name === 'in-project'), true);
  assert.equal(actual.body.projectSkills.some((item) => item.name === 'escaped-skill'), false);
  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('cursor-context discovery skips rule symlink outside project root', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ctx-rule-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ctx-rule-out-'));
  fs.mkdirSync(path.join(project, '.cursor', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(project, '.cursor', 'rules', 'safe.mdc'), '---\n---\n');
  fs.writeFileSync(path.join(outside, 'escaped.mdc'), '---\n---\n');
  fs.symlinkSync(
    path.join(outside, 'escaped.mdc'),
    path.join(project, '.cursor', 'rules', 'escaped.mdc'),
    'file',
  );
  const actual = await invokeCursorContext({ query: { workspaceFolder: project } }, os.tmpdir());
  assert.equal(actual.status, 200);
  assert.equal(actual.body.projectRules.some((item) => item.name === 'safe.mdc'), true);
  assert.equal(actual.body.projectRules.some((item) => item.name === 'escaped.mdc'), false);
  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('cursor-context discovery skips command symlink outside project root', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ctx-cmd-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ctx-cmd-out-'));
  fs.mkdirSync(path.join(project, '.cursor', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(project, '.cursor', 'commands', 'safe.md'), '# safe\n');
  fs.writeFileSync(path.join(outside, 'escaped.md'), '# leaked\n');
  fs.symlinkSync(
    path.join(outside, 'escaped.md'),
    path.join(project, '.cursor', 'commands', 'escaped.md'),
    'file',
  );
  const actual = await invokeCursorContext({ query: { workspaceFolder: project } }, os.tmpdir());
  assert.equal(actual.status, 200);
  assert.equal(actual.body.projectCommands.some((item) => item.name === 'safe.md'), true);
  assert.equal(actual.body.projectCommands.some((item) => item.name === 'escaped.md'), false);
  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('cursor-context discovery skips agent symlink outside project root', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ctx-ag-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ctx-ag-out-'));
  fs.mkdirSync(path.join(project, '.cursor', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(project, '.cursor', 'agents', 'safe.md'), '# safe\n');
  fs.writeFileSync(path.join(outside, 'escaped.md'), '# leaked\n');
  fs.symlinkSync(
    path.join(outside, 'escaped.md'),
    path.join(project, '.cursor', 'agents', 'escaped.md'),
    'file',
  );
  const actual = await invokeCursorContext({ query: { workspaceFolder: project } }, os.tmpdir());
  assert.equal(actual.status, 200);
  assert.equal(actual.body.projectAgents.some((item) => item.name === 'safe'), true);
  assert.equal(actual.body.projectAgents.some((item) => item.name === 'escaped'), false);
  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});
