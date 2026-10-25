import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NAME_RESOLUTION_ORDER,
  INSTRUCTION_PRECEDENCE_ORDER,
  buildRegistryEntryId,
  computeRegistryContentHash,
  buildContextManifest,
  parseProjectContextConfig,
} from '../lib/context/registry-contract.ts';
import {
  assertPathWithinProjectRoot,
  isHostOnlyContextSourceLabel,
  SOURCE_TRUST_ERROR_CODES,
} from '../lib/context/source-trust.ts';
import { loadValidatedProjectContextConfig } from '../lib/context/project-context-config.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('registry entry id is stable and hash tracks content', () => {
  const id = buildRegistryEntryId('project', '.cursor/rules/a.mdc', 'rule');
  assert.equal(id, 'project::rule::.cursor/rules/a.mdc');
  const hashA = computeRegistryContentHash('body-a');
  const hashB = computeRegistryContentHash('body-b');
  assert.notEqual(hashA, hashB);
});

test('name and instruction hierarchies are distinct ordered lists', () => {
  assert.notDeepEqual(NAME_RESOLUTION_ORDER, INSTRUCTION_PRECEDENCE_ORDER);
  assert.ok(NAME_RESOLUTION_ORDER.includes('explicit_chat_id'));
  assert.ok(INSTRUCTION_PRECEDENCE_ORDER.includes('explicit_user_turn'));
});

test('manifest builder carries epoch and entries', () => {
  const manifest = buildContextManifest({
    registryEpoch: '2026-10-13',
    assembledAt: '2026-10-13T00:00:00.000Z',
    projectRoot: '/tmp/project',
    contentRevision: 'abc',
    entries: [{ id: 'x' }],
    warnings: ['dup-name'],
  });
  assert.equal(manifest.registryEpoch, '2026-10-13');
  assert.equal(manifest.entries.length, 1);
  assert.deepEqual(manifest.warnings, ['dup-name']);
});

test('project config rejects host source labels', () => {
  const parsed = parseProjectContextConfig({ version: 1, entries: [{ source: 'shared', path: 'x.md' }] });
  assert.equal(parsed.ok, true);
  assert.equal(isHostOnlyContextSourceLabel('shared'), true);
  assert.equal(isHostOnlyContextSourceLabel('project'), false);
});

test('symlink outside project root is rejected', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ctx-proj-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ctx-out-'));
  fs.writeFileSync(path.join(outside, 'secret.md'), '# secret');
  const linkPath = path.join(project, 'escape-link');
  fs.symlinkSync(outside, linkPath, 'dir');
  const rootReal = fs.realpathSync(project);
  const check = assertPathWithinProjectRoot(rootReal, path.join(linkPath, 'secret.md'));
  assert.equal(check.ok, false);
  if (!check.ok) {
    assert.equal(check.code, SOURCE_TRUST_ERROR_CODES.SYMLINK_ESCAPE);
  }
  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('loadValidatedProjectContextConfig rejects host assignments in repo file', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ctx-cfg-'));
  fs.mkdirSync(path.join(project, '.cretli'), { recursive: true });
  fs.writeFileSync(
    path.join(project, '.cretli/context.json'),
    JSON.stringify({ version: 1, entries: [{ source: 'user', path: 'skills/x/SKILL.md' }] }),
  );
  const result = loadValidatedProjectContextConfig(project);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, SOURCE_TRUST_ERROR_CODES.HOST_SOURCE_IN_REPO_CONFIG);
  }
  fs.rmSync(project, { recursive: true, force: true });
});
