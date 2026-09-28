import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { registerCursorContextRoutes } from '../lib/routes/cursor-context-routes.js';
import { ensureCursorShare } from '../lib/sdk/cursor-share.js';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';

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

test('cursor-context prefers query workspaceFolder over getCurrentCwd', async () => {
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
  assert.equal(actual.body.ok, true);
  assert.equal(actual.body.projectSkills.some((item) => item.name === 'chat-skill'), true);
  assert.equal(actual.body.projectSkills.some((item) => item.name === 'fallback-skill'), false);
  fs.rmSync(inputChatCwd, { recursive: true, force: true });
  fs.rmSync(inputFallbackCwd, { recursive: true, force: true });
});

test('cursor-context widget workspace wins over query cwd', async () => {
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
      widgetAccess: { workspaceFolder: inputWidgetCwd },
    },
    os.tmpdir(),
  );
  assert.equal(actual.body.ok, true);
  assert.equal(actual.body.projectSkills.some((item) => item.name === 'widget-skill'), true);
  fs.rmSync(inputWidgetCwd, { recursive: true, force: true });
  fs.rmSync(inputQueryCwd, { recursive: true, force: true });
});

test('cursor-context includes bundled cretli-multi-harness for a foreign cwd', async () => {
  ensureCursorShare();
  const inputFadeCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ctx-fade-'));
  const actual = await invokeCursorContext({ query: { workspaceFolder: inputFadeCwd } }, os.tmpdir());
  assert.equal(actual.body.ok, true);
  assert.ok(
    actual.body.sharedSkills.some(
      (item) => item.name === 'cretli-multi-harness' && item.source === 'bundled',
    ),
  );
  fs.rmSync(inputFadeCwd, { recursive: true, force: true });
});
