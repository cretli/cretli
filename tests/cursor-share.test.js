import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ensureCursorShare } from '../lib/sdk/cursor-share.js';
import { getCursorContext } from '../lib/sdk/cursor-context.js';
import {
  buildSharedAlwaysApplyRulesPrompt,
  resolveSdkCwdList,
} from '../lib/sdk/shared-cursor-context.js';
import { resolveDataPath, resolveProjectPath } from '../lib/runtime-paths.js';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';

test.after(() => {
  removeIsolatedDataDir();
});

test('ensureCursorShare removes stale skills and leftover rules', () => {
  const inputAppRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-share-stale-app-'));
  const inputShareRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-share-stale-out-'));
  const skillDir = path.join(inputAppRoot, '.cursor', 'skills', 'keep-skill');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Keep\n');
  fs.mkdirSync(path.join(inputShareRoot, '.cursor', 'skills', 'stale-skill'), { recursive: true });
  fs.writeFileSync(
    path.join(inputShareRoot, '.cursor', 'skills', 'stale-skill', 'SKILL.md'),
    '# Stale\n',
  );
  fs.mkdirSync(path.join(inputShareRoot, '.cursor', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(inputShareRoot, '.cursor', 'rules', 'leak.mdc'), '---\nalwaysApply: true\n---\nLeak\n');
  ensureCursorShare(inputAppRoot, inputShareRoot);
  assert.ok(fs.existsSync(path.join(inputShareRoot, '.cursor', 'skills', 'keep-skill', 'SKILL.md')));
  assert.equal(fs.existsSync(path.join(inputShareRoot, '.cursor', 'skills', 'stale-skill')), false);
  assert.equal(fs.existsSync(path.join(inputShareRoot, '.cursor', 'rules')), false);
  fs.rmSync(inputAppRoot, { recursive: true, force: true });
  fs.rmSync(inputShareRoot, { recursive: true, force: true });
});

test('ensureCursorShare mirrors skills and agents but not rules', () => {
  const inputAppRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-share-app-'));
  const inputShareRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-share-out-'));
  const skillDir = path.join(inputAppRoot, '.cursor', 'skills', 'demo-skill');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Demo skill\n');
  fs.mkdirSync(path.join(inputAppRoot, '.cursor', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(inputAppRoot, '.cursor', 'agents', 'demo-agent.md'), '# Agent\n');
  fs.mkdirSync(path.join(inputAppRoot, '.cursor', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(inputAppRoot, '.cursor', 'rules', 'secret.mdc'), '---\nalwaysApply: true\n---\nLeak\n');
  const actualShareRoot = ensureCursorShare(inputAppRoot, inputShareRoot);
  assert.equal(actualShareRoot, inputShareRoot);
  assert.ok(fs.existsSync(path.join(inputShareRoot, '.cursor', 'skills', 'demo-skill', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(inputShareRoot, '.cursor', 'agents', 'demo-agent.md')));
  assert.equal(fs.existsSync(path.join(inputShareRoot, '.cursor', 'rules')), false);
  fs.rmSync(inputAppRoot, { recursive: true, force: true });
  fs.rmSync(inputShareRoot, { recursive: true, force: true });
});

test('resolveSdkCwdList includes share dir and excludes Cretli git root', () => {
  const inputProjectCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-share-fade-'));
  const expectedShareDir = ensureCursorShare();
  const expectedCretliRoot = resolveProjectPath();
  const actualCwdList = resolveSdkCwdList(inputProjectCwd, []);
  assert.deepEqual(actualCwdList[0], inputProjectCwd);
  assert.ok(actualCwdList.includes(expectedShareDir));
  assert.equal(actualCwdList.includes(expectedCretliRoot), false);
  fs.rmSync(inputProjectCwd, { recursive: true, force: true });
});

test('getCursorContext for unrelated project cwd lists bundled cretli-multi-harness skill', () => {
  ensureCursorShare();
  const inputFadeCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-share-fade-ctx-'));
  const actualContext = getCursorContext(inputFadeCwd);
  const expectedSkillName = 'cretli-multi-harness';
  const actualBundledSkill = actualContext.sharedSkills.find(
    (item) => item.name === expectedSkillName && item.source === 'bundled',
  );
  assert.ok(actualBundledSkill, 'expected bundled cretli-multi-harness in sharedSkills');
  assert.match(String(actualBundledSkill.path), /cursor-share/);
  assert.equal(actualContext.projectSkills.length, 0);
  fs.rmSync(inputFadeCwd, { recursive: true, force: true });
});

test('buildSharedAlwaysApplyRulesPrompt is empty for the skills-only share root', () => {
  const inputShareRoot = ensureCursorShare();
  const actualPrompt = buildSharedAlwaysApplyRulesPrompt([inputShareRoot]);
  assert.equal(actualPrompt, '');
  assert.equal(fs.existsSync(path.join(inputShareRoot, '.cursor', 'rules')), false);
  assert.ok(fs.existsSync(path.join(resolveProjectPath(), '.cursor', 'rules')));
  assert.equal(resolveDataPath('cursor-share'), inputShareRoot);
});
