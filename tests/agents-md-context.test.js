import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import {
  AGENTS_MD_MATRIX,
  buildAgentsMdPromptBlock,
  buildGlobScopeIndex,
  collectAgentsMdChain,
  globToRegExp,
  indexNestedAgentsMd,
  matchesAnyGlob,
  parseGlobsValue,
  readInstructionsForPath,
  resolveAgentsMdDelivery,
} from '../lib/context/agents-md.ts';
import { buildContextRegistry } from '../lib/context/registry.ts';
import { assemble, CONTEXT_ADAPTERS } from '../lib/context/context-assembler.ts';
import { compareWithLegacy } from '../lib/context/context-compare.ts';
import { buildHarnessDecorationParts } from '../lib/sdk/harness-plan-prompt.ts';

test.after(() => removeIsolatedDataDir());

/** @returns {{ root: string, sub: string, cleanup: () => void }} */
function makeProject() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-agents-')));
  const root = path.join(base, 'proj');
  const sub = path.join(root, 'packages', 'web');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'ROOT RULES\n');
  fs.writeFileSync(path.join(root, 'packages', 'AGENTS.md'), 'PACKAGES RULES\n');
  fs.writeFileSync(path.join(sub, 'AGENTS.md'), 'WEB RULES\n');
  fs.mkdirSync(path.join(root, 'tools', 'x'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tools', 'x', 'AGENTS.md'), 'TOOLS RULES\n');
  fs.mkdirSync(path.join(root, '.cursor', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(root, '.cursor', 'rules', 'ts.mdc'), '---\nglobs: "src/**/*.ts,*.{md,txt}"\nalwaysApply: false\n---\nTS ONLY\n');
  return { root, sub, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('cwd in a subdirectory collects ancestor AGENTS.md, root first, most local last', () => {
  const p = makeProject();
  try {
    const chain = collectAgentsMdChain(p.root, p.sub);
    assert.deepEqual(chain.entries.map((e) => e.relPath), ['AGENTS.md', 'packages/AGENTS.md', 'packages/web/AGENTS.md']);
    assert.equal(chain.cwdRel, 'packages/web');
    // Sibling scopes are indexed, never loaded into the chain.
    const nested = indexNestedAgentsMd(p.root, p.root);
    assert.ok(nested.scopes.some((s) => s.relPath === 'tools/x/AGENTS.md'));
    assert.ok(nested.scopes.every((s) => !('content' in s)));
  } finally { p.cleanup(); }
});

test('cwd outside the authorized root falls back to the root chain with a warning', () => {
  const p = makeProject();
  try {
    const chain = collectAgentsMdChain(p.root, os.tmpdir());
    assert.deepEqual(chain.entries.map((e) => e.relPath), ['AGENTS.md']);
    assert.ok(chain.warnings.some((w) => w.startsWith('agents_md_cwd_outside_root')));
  } finally { p.cleanup(); }
});

test('AGENTS.md symlink escaping the root is rejected, not read', () => {
  const p = makeProject();
  const outside = path.join(path.dirname(p.root), 'secret.md');
  try {
    fs.writeFileSync(outside, 'LEAK');
    fs.rmSync(path.join(p.sub, 'AGENTS.md'));
    fs.symlinkSync(outside, path.join(p.sub, 'AGENTS.md'));
    const chain = collectAgentsMdChain(p.root, p.sub);
    const bad = chain.entries.find((e) => e.relPath === 'packages/web/AGENTS.md');
    assert.equal(bad.valid, false);
    assert.equal(bad.content, '');
    const block = buildAgentsMdPromptBlock({ projectRoot: p.root, cwd: p.sub, transport: 'x', mode: 'force' });
    assert.ok(!block.text.includes('LEAK'));
  } finally { p.cleanup(); }
});

test('delivery matrix: unknown is not injected, native is never doubled, force is explicit', () => {
  assert.ok(Object.values(AGENTS_MD_MATRIX).every((row) => row.status === 'unknown'), 'no harness is claimed as confirmed');
  const auto = resolveAgentsMdDelivery({ transport: 'codex', mode: 'auto' });
  assert.equal(auto.deliver, false);
  assert.match(auto.warning, /agents_md_unknown_not_injected/);
  const forced = resolveAgentsMdDelivery({ transport: 'codex', mode: 'force' });
  assert.equal(forced.deliver, true);
  assert.match(forced.warning, /agents_md_unknown_forced/);
  assert.equal(resolveAgentsMdDelivery({ transport: 'codex', mode: 'off' }).deliver, false);
  const matrix = { a: { status: 'native' }, b: { status: 'both' }, c: { status: 'cretli' } };
  for (const mode of ['auto', 'force']) {
    assert.equal(resolveAgentsMdDelivery({ transport: 'a', mode, matrix }).deliver, false, `native ${mode}`);
    assert.equal(resolveAgentsMdDelivery({ transport: 'b', mode, matrix }).deliver, false, `both ${mode}`);
    assert.equal(resolveAgentsMdDelivery({ transport: 'c', mode, matrix }).deliver, true, `cretli ${mode}`);
  }
});

test('block renders general to local and carries only valid entries', () => {
  const p = makeProject();
  try {
    const block = buildAgentsMdPromptBlock({
      projectRoot: p.root, cwd: p.sub, transport: 'c', mode: 'auto', matrix: { c: { status: 'cretli' } },
    });
    assert.ok(block.text.indexOf('ROOT RULES') < block.text.indexOf('PACKAGES RULES'));
    assert.ok(block.text.indexOf('PACKAGES RULES') < block.text.indexOf('WEB RULES'));
    assert.equal(block.entryIds.length, 3);
    assert.ok(!block.text.includes('TOOLS RULES'));
  } finally { p.cleanup(); }
});

test('real send path and assembler agree; default (unknown harness) adds no AGENTS.md', () => {
  const p = makeProject();
  try {
    const ctx = { cwd: p.sub, projectRoot: p.root, transport: 'codex', prompt: 'hi', reportContext: '', additionalDirs: [], homeDir: p.root, bundledRoot: p.root };
    const parts = buildHarnessDecorationParts('hi', { ...ctx });
    assert.equal(parts.blocks.agentsMdBlock, '');
    assert.ok(!parts.blocks.staticBlock.includes('ROOT RULES'));
    const forced = { ...ctx, contextSettings: { 'agentsMd.mode': 'force' } };
    const sendParts = buildHarnessDecorationParts('hi', forced);
    assert.match(sendParts.blocks.staticBlock, /ROOT RULES[\s\S]*WEB RULES/);
    const assembled = assemble(forced, CONTEXT_ADAPTERS.harness);
    assert.ok(assembled.blocks.find((b) => b.id === 'agents_md').text.includes('WEB RULES'));
    assert.ok(assembled.warnings.some((w) => w.startsWith('agents_md_unknown_forced')));
    // Each confirmed/forced source is delivered once: exactly one pasted copy.
    assert.equal(assembled.payload.split('ROOT RULES').length - 1, 1);
  } finally { p.cleanup(); }
});

test('compare mode stays identical with the new agents_md block', () => {
  const p = makeProject();
  try {
    const result = compareWithLegacy(
      { cwd: p.sub, projectRoot: p.root, transport: 'codex', prompt: 'x', reportContext: '', additionalDirs: [], homeDir: p.root, bundledRoot: p.root, skillOptions: { additionalDirs: [], appRoot: p.root, homeDir: p.root }, contextSettings: { 'agentsMd.mode': 'force' } },
      'harness',
    );
    assert.equal(result.identical, true, JSON.stringify(result.differences.filter((d) => d.status !== 'same')));
    assert.equal(result.differences.find((d) => d.block === 'agents_md').status, 'same');
  } finally { p.cleanup(); }
});

test('globs: matcher, parse and path-scoped explicit read; no activation by general text', () => {
  assert.deepEqual(parseGlobsValue('src/**/*.ts,*.{md,txt}'), ['src/**/*.ts', '*.{md,txt}']);
  assert.ok(globToRegExp('src/**/*.ts').test('src/a/b/c.ts'));
  assert.ok(globToRegExp('src/**/*.ts').test('src/c.ts'));
  assert.ok(!globToRegExp('src/**/*.ts').test('lib/c.ts'));
  assert.ok(matchesAnyGlob(['*.{md,txt}'], 'docs/deep/readme.md'));
  assert.ok(!matchesAnyGlob(['*.md'], 'a.mdx'));
  assert.equal(globToRegExp('{a,b'), null);
  const p = makeProject();
  try {
    const registry = buildContextRegistry(p.root, { projectRoot: p.root });
    const index = buildGlobScopeIndex(registry);
    assert.equal(index.length, 1);
    assert.deepEqual(index[0].globs, ['src/**/*.ts', '*.{md,txt}']);
    assert.ok(!('body' in index[0]));
    const hit = readInstructionsForPath({ projectRoot: p.root, relPath: 'packages/web/readme.md', registry });
    assert.equal(hit.ok, true);
    assert.deepEqual(hit.agents.map((a) => a.relPath), ['AGENTS.md', 'packages/AGENTS.md', 'packages/web/AGENTS.md']);
    assert.equal(hit.rules.length, 1);
    assert.match(hit.note, /does not guarantee/);
    const miss = readInstructionsForPath({ projectRoot: p.root, relPath: 'packages/web/readme.rs', registry });
    assert.equal(miss.rules.length, 0);
    // The rule is not alwaysApply, so a normal turn never pastes it.
    assert.ok(!assemble({ cwd: p.root, projectRoot: p.root, prompt: 'edit src/a.ts', reportContext: '', additionalDirs: [], homeDir: p.root, bundledRoot: p.root }, CONTEXT_ADAPTERS.harness).payload.includes('TS ONLY'));
  } finally { p.cleanup(); }
});

test('explicit path read rejects traversal and symlink escapes', () => {
  const p = makeProject();
  try {
    const registry = buildContextRegistry(p.root, { projectRoot: p.root });
    assert.equal(readInstructionsForPath({ projectRoot: p.root, relPath: '../etc/passwd', registry }).ok, false);
    fs.symlinkSync(os.tmpdir(), path.join(p.root, 'link'));
    assert.equal(readInstructionsForPath({ projectRoot: p.root, relPath: 'link/x', registry }).ok, false);
  } finally { p.cleanup(); }
});
