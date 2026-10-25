import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CURSOR_CONTEXT_SCOPE_ERROR_CODES,
  resolveCursorContextScope,
  resolveLegacyClientWorkspaceDir,
} from '../lib/context/context-scope.ts';

function makeDeps(chats = []) {
  return { loadChats: () => chats };
}

test('chat scope rejects client workspace outside authorized project', () => {
  const projectA = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ctx-a-'));
  const projectB = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ctx-b-'));
  const deps = makeDeps([{ id: 'c1', workspaceFolder: projectA }]);
  const result = resolveCursorContextScope(
    { query: { chatId: 'c1', workspaceFolder: projectB } },
    { getCurrentCwd: () => '/global', deps },
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, CURSOR_CONTEXT_SCOPE_ERROR_CODES.SCOPE_OUT_OF_BOUNDS);
    assert.equal(result.status, 403);
  }
  fs.rmSync(projectA, { recursive: true, force: true });
  fs.rmSync(projectB, { recursive: true, force: true });
});

test('chat scope accepts subdirectory within authorized project', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ctx-sub-'));
  const sub = path.join(project, 'packages', 'app');
  fs.mkdirSync(sub, { recursive: true });
  const deps = makeDeps([{ id: 'c1', workspaceFolder: project }]);
  const result = resolveCursorContextScope(
    { query: { chatId: 'c1', workspaceFolder: sub } },
    { getCurrentCwd: () => '/global', deps },
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.source, 'chat');
    assert.equal(fs.realpathSync(result.workspaceDir), fs.realpathSync(sub));
  }
  fs.rmSync(project, { recursive: true, force: true });
});

test('widget scope rejects query cwd override', () => {
  const widgetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ctx-w-'));
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ctx-o-'));
  const result = resolveCursorContextScope(
    {
      query: { cwd: otherDir },
      widgetAccess: { workspaceFolder: widgetDir, installationId: 'i', pageSessionId: 'p' },
    },
    { getCurrentCwd: () => '/global', deps: makeDeps() },
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 403);
  }
  fs.rmSync(widgetDir, { recursive: true, force: true });
  fs.rmSync(otherDir, { recursive: true, force: true });
});

test('legacy client selection is exposed separately from authorized scope', () => {
  const widgetDir = '/widget/root';
  const legacy = resolveLegacyClientWorkspaceDir(
    { query: { cwd: '/evil' }, widgetAccess: { workspaceFolder: widgetDir } },
    () => '/global',
  );
  assert.equal(path.resolve(legacy), path.resolve(widgetDir));
});
