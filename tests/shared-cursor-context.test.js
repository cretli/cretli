import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildSharedAlwaysApplyRulesPrompt,
  buildWorkspaceAlwaysApplyRulesPrompt,
  mergeNamedContextEntries,
  normalizeAdditionalCursorContextDirs,
  resolveSdkCwdList,
} from '../lib/sdk/shared-cursor-context.js';
import { resolveDataPath, resolveProjectPath } from '../lib/runtime-paths.js';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';

test.after(() => {
  removeIsolatedDataDir();
});

test('normalizeAdditionalCursorContextDirs keeps existing unique dirs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-shared-ctx-'));
  const a = path.join(root, 'a');
  const b = path.join(root, 'b');
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  const actual = normalizeAdditionalCursorContextDirs([
    a,
    `${a}/`,
    b,
    path.join(root, 'missing'),
    '',
  ]);
  assert.deepEqual(actual, [a, b]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('resolveSdkCwdList puts project first and skips duplicate shared root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-shared-cwd-'));
  const project = path.join(root, 'project');
  const shared = path.join(root, 'shared');
  const bundledShare = resolveDataPath('cursor-share');
  const cretliRoot = resolveProjectPath();
  fs.mkdirSync(project);
  fs.mkdirSync(shared);
  assert.deepEqual(resolveSdkCwdList(project, [shared, project]), [project, bundledShare, shared]);
  assert.deepEqual(resolveSdkCwdList(project, []), [project, bundledShare]);
  assert.equal(resolveSdkCwdList(project, []).includes(cretliRoot), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('buildWorkspaceAlwaysApplyRulesPrompt includes only alwaysApply bodies from cwd', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-workspace-rules-'));
  const rulesDir = path.join(root, '.cursor', 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });
  fs.writeFileSync(
    path.join(rulesDir, 'browser.mdc'),
    [
      '---',
      'alwaysApply: true',
      '---',
      'Use browser_* MCP tools, not private Playwright.',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(rulesDir, 'manual.mdc'),
    [
      '---',
      'alwaysApply: false',
      '---',
      'Manual only.',
      '',
    ].join('\n'),
  );
  const prompt = buildWorkspaceAlwaysApplyRulesPrompt(root);
  assert.match(prompt, /WORKSPACE CURSOR RULES/);
  assert.match(prompt, /browser_\* MCP tools/);
  assert.equal(prompt.includes('Manual only'), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('buildSharedAlwaysApplyRulesPrompt includes only alwaysApply bodies', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-shared-rules-'));
  const rulesDir = path.join(root, '.cursor', 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });
  fs.writeFileSync(
    path.join(rulesDir, 'lists.mdc'),
    [
      '---',
      'alwaysApply: true',
      '---',
      'Use compact list styling.',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(rulesDir, 'optional.mdc'),
    [
      '---',
      'alwaysApply: false',
      '---',
      'Ignore this rule.',
      '',
    ].join('\n'),
  );
  const prompt = buildSharedAlwaysApplyRulesPrompt([root]);
  assert.match(prompt, /SHARED CURSOR RULES/);
  assert.match(prompt, /not part of this workspace/);
  assert.match(prompt, /Use compact list styling/);
  assert.equal(prompt.includes('Ignore this rule'), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('mergeNamedContextEntries dedupes by name+path', () => {
  const primary = [{ name: 'a.mdc', path: '.cursor/rules/a.mdc' }];
  const extra = [
    { name: 'a.mdc', path: '.cursor/rules/a.mdc' },
    { name: 'b.mdc', path: '/shared/.cursor/rules/b.mdc' },
  ];
  const actual = mergeNamedContextEntries(primary, extra);
  assert.equal(actual.length, 2);
  assert.equal(actual[1].name, 'b.mdc');
});
