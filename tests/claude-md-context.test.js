import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import { buildClaudeMdPromptBlock } from '../lib/context/claude-md.ts';
import { applyHarnessOutboundPrompt, buildHarnessDecorationParts, buildSdkDecorationParts } from '../lib/sdk/harness-plan-prompt.ts';
import { assemble, CONTEXT_ADAPTERS } from '../lib/context/context-assembler.ts';
import { compareAllAdapters } from '../lib/context/context-compare.ts';

test.after(removeIsolatedDataDir);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-claude-md-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('Codex and SDK receive project instructions; Claude uses its native loader', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'Use the project task system.');
  const input = { cwd: root, sharedDirs: [], skillOptions: { additionalDirs: [], homeDir: root, appRoot: root } };
  for (const transport of ['codex', 'opencode', 'openrouter', 'qwen', 'deepseek', 'codebuddy']) {
    const { blocks } = buildHarnessDecorationParts('hello', { ...input, transport });
    assert.match(blocks.staticBlock, /Use the project task system\./);
    assert.equal(blocks.staticBlock.split('[CLAUDE.MD INSTRUCTIONS]').length - 1, 1);
  }
  assert.match(buildSdkDecorationParts('hello', input).blocks.staticBlock, /Use the project task system\./);
  assert.doesNotMatch(buildHarnessDecorationParts('hello', { ...input, transport: 'claude' }).blocks.staticBlock, /Use the project task system\./);
});

test('a changed CLAUDE.md is delivered again in a deduplicated session', (t) => {
  const root = fixture(t);
  const file = path.join(root, 'CLAUDE.md');
  fs.writeFileSync(file, 'Initial project instruction.');
  let state;
  const input = { cwd: root, transport: 'codex', sessionKey: root, staticMode: 'dedupe', onState: (next) => { state = next; } };
  assert.match(applyHarnessOutboundPrompt('hello', input), /Initial project instruction\./);
  assert.doesNotMatch(applyHarnessOutboundPrompt('next', { ...input, previousState: state }), /Initial project instruction\./);
  fs.writeFileSync(file, 'Updated project instruction.');
  assert.match(applyHarnessOutboundPrompt('next', { ...input, previousState: state }), /Updated project instruction\./);
});

test('instructions follow the root-to-cwd chain without loading unrelated nested files', (t) => {
  const root = fixture(t);
  const cwd = path.join(root, 'src');
  fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(root, 'other'));
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'ROOT instruction');
  fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), 'LOCAL instruction');
  fs.writeFileSync(path.join(root, 'other', 'CLAUDE.md'), 'UNRELATED instruction');
  const text = buildClaudeMdPromptBlock({ projectRoot: root, cwd, transport: 'codex' });
  assert.ok(text.indexOf('ROOT instruction') < text.indexOf('LOCAL instruction'));
  assert.doesNotMatch(text, /UNRELATED/);
  assert.equal(buildClaudeMdPromptBlock({ projectRoot: cwd, cwd: root }), '');
});

test('missing, empty, oversized and escaping symlink files are skipped', (t) => {
  const root = fixture(t);
  const outside = fixture(t);
  const input = { cwd: root, transport: 'codex' };
  const file = path.join(root, 'CLAUDE.md');
  assert.equal(buildClaudeMdPromptBlock(input), '');
  fs.writeFileSync(file, '  \n');
  assert.equal(buildClaudeMdPromptBlock(input), '');
  fs.writeFileSync(file, 'x'.repeat(256 * 1024 + 1));
  assert.equal(buildClaudeMdPromptBlock(input), '');
  fs.rmSync(file);
  fs.writeFileSync(path.join(outside, 'instructions'), 'outside project');
  fs.symlinkSync(path.join(outside, 'instructions'), file);
  assert.equal(buildClaudeMdPromptBlock(input), '');
});

test('registry assembler and live decoration agree on the CLAUDE.md block', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'Shared project instruction.');
  const context = { cwd: root, projectRoot: root, transport: 'codex', prompt: 'hello', homeDir: root, bundledRoot: root, additionalDirs: [], skillOptions: { additionalDirs: [], homeDir: root, appRoot: root } };
  const result = assemble(context, CONTEXT_ADAPTERS.harness);
  assert.match(result.blocks.find((b) => b.id === 'claude_md').text, /Shared project instruction\./);
  const comparison = compareAllAdapters(context);
  for (const adapter of ['sdk', 'harness']) {
    assert.equal(comparison[adapter].identical, true, JSON.stringify(comparison[adapter].differences));
  }
});
