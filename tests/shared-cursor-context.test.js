import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildSharedAlwaysApplyRulesPrompt,
  buildWorkspaceAlwaysApplyRulesPrompt,
  explainSharedAlwaysApplyRules,
  matchCursorRuleScope,
  mergeNamedContextEntries,
  normalizeAdditionalCursorContextDirs,
  resolveSdkCwdList,
} from '../lib/sdk/shared-cursor-context.ts';
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

/**
 * Shared root with three rules: one global, one scoped to another project and
 * one scoped to a task kind.
 *
 * @returns {{ root: string, otherProject: string, cleanup: () => void }}
 */
function makeScopedRulesRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-shared-scope-'));
  const otherProject = path.join(root, 'other-project');
  const rulesDir = path.join(root, '.cursor', 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });
  fs.mkdirSync(otherProject);
  fs.writeFileSync(
    path.join(rulesDir, 'global.mdc'),
    '---\nalwaysApply: true\n---\nGlobal shared rule.\n',
  );
  fs.writeFileSync(
    path.join(rulesDir, 'other-project.mdc'),
    [
      '---',
      'alwaysApply: true',
      'cretliScopeProjects:',
      `  - ${otherProject}`,
      '---',
      'Rule for another project only.',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(rulesDir, 'review-only.mdc'),
    [
      '---',
      'alwaysApply: true',
      'cretli:',
      '  taskKinds:',
      '    - review',
      '---',
      'Rule for review tasks only.',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(rulesDir, 'scss-only.mdc'),
    [
      '---',
      'alwaysApply: true',
      'cretliScopeFileTypes:',
      '  - .scss',
      '---',
      'Rule for stylesheets only.',
      '',
    ].join('\n'),
  );
  return {
    root,
    otherProject,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('a rule scoped to another project never reaches the current prompt', () => {
  const workspace = makeScopedRulesRoot();
  try {
    const prompt = buildSharedAlwaysApplyRulesPrompt([workspace.root], { cwd: workspace.root });
    assert.match(prompt, /Global shared rule/);
    assert.equal(prompt.includes('Rule for another project only'), false);
    // No task or file context: the scoped rules stay, so nothing is dropped on a guess.
    assert.match(prompt, /Rule for review tasks only/);
    assert.match(prompt, /Rule for stylesheets only/);
  } finally {
    workspace.cleanup();
  }
});

test('a project-scoped rule applies when the cwd is inside it', () => {
  const workspace = makeScopedRulesRoot();
  try {
    const nested = path.join(workspace.otherProject, 'app_front');
    const prompt = buildSharedAlwaysApplyRulesPrompt([workspace.root], { cwd: nested });
    assert.match(prompt, /Rule for another project only/);
  } finally {
    workspace.cleanup();
  }
});

test('task and file scopes filter only when the context is known', () => {
  const workspace = makeScopedRulesRoot();
  try {
    const reviewPrompt = buildSharedAlwaysApplyRulesPrompt([workspace.root], {
      cwd: workspace.root,
      taskKind: 'review',
      fileTypes: ['app_front/theme.scss'],
    });
    assert.match(reviewPrompt, /Rule for review tasks only/);
    assert.match(reviewPrompt, /Rule for stylesheets only/);

    const implementPrompt = buildSharedAlwaysApplyRulesPrompt([workspace.root], {
      cwd: workspace.root,
      taskKind: 'implement',
      fileTypes: ['lib/sdk/prompt-decoration.ts'],
    });
    assert.equal(implementPrompt.includes('Rule for review tasks only'), false);
    assert.equal(implementPrompt.includes('Rule for stylesheets only'), false);
    assert.match(implementPrompt, /Global shared rule/);
  } finally {
    workspace.cleanup();
  }
});

test('explainSharedAlwaysApplyRules reports the decision without any rule body', () => {
  const workspace = makeScopedRulesRoot();
  try {
    const rows = explainSharedAlwaysApplyRules([workspace.root], {
      cwd: workspace.root,
      taskKind: 'implement',
    });
    const byRule = new Map(rows.map((row) => [row.rule, row]));
    assert.equal(byRule.get('.cursor/rules/global.mdc').included, true);
    assert.equal(byRule.get('.cursor/rules/global.mdc').reason, 'no-scope');
    assert.equal(byRule.get('.cursor/rules/other-project.mdc').included, false);
    assert.equal(byRule.get('.cursor/rules/other-project.mdc').reason, 'project-mismatch');
    assert.equal(byRule.get('.cursor/rules/review-only.mdc').included, false);
    assert.equal(byRule.get('.cursor/rules/review-only.mdc').reason, 'task-kind-mismatch');
    const serialized = JSON.stringify(rows);
    assert.equal(serialized.includes('Global shared rule'), false);
    assert.equal(serialized.includes('Rule for another project only'), false);
  } finally {
    workspace.cleanup();
  }
});

test('a rule without scope metadata keeps the previous global behaviour', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-shared-plain-'));
  const rulesDir = path.join(root, '.cursor', 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });
  fs.writeFileSync(path.join(rulesDir, 'plain.mdc'), '---\nalwaysApply: true\n---\nPlain rule.\n');
  try {
    assert.match(buildSharedAlwaysApplyRulesPrompt([root]), /Plain rule/);
    assert.match(buildSharedAlwaysApplyRulesPrompt([root], { cwd: '/somewhere/else' }), /Plain rule/);
    const rows = explainSharedAlwaysApplyRules([root], { cwd: '/somewhere/else' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].included, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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


test('project scope matches whole path segments only', () => {
  const scope = { projects: ['/workspace/my-app'], taskKinds: [], fileTypes: [] };
  assert.equal(matchCursorRuleScope(scope, { cwd: '/workspace/my-app' }).included, true);
  assert.equal(matchCursorRuleScope(scope, { cwd: '/workspace/my-app/src' }).included, true);
  assert.equal(matchCursorRuleScope(scope, { cwd: '/workspace/my-app-other' }).included, false);
  const bare = { projects: ['my-app'], taskKinds: [], fileTypes: [] };
  assert.equal(matchCursorRuleScope(bare, { cwd: '/w/my-app/x' }).included, true);
  assert.equal(matchCursorRuleScope(bare, { cwd: '/w/my-app-other' }).included, false);
});

test('file type scope does not match substrings', () => {
  const scope = { projects: [], taskKinds: [], fileTypes: ['js'] };
  assert.equal(matchCursorRuleScope(scope, { fileTypes: ['a/b.json'] }).included, false);
  assert.equal(matchCursorRuleScope(scope, { fileTypes: ['a/b.js'] }).included, true);
});
