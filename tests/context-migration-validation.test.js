import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import { buildContextRegistry } from '../lib/context/registry.ts';
import { assemble, CONTEXT_ADAPTERS } from '../lib/context/context-assembler.ts';
import { compareAllAdapters, resolveContextBuilderMode } from '../lib/context/context-compare.ts';
import { buildContextSnapshot } from '../lib/context/context-send-manifest.ts';
import { getCursorContext } from '../lib/sdk/cursor-context.ts';
import { AGENTS_MD_MATRIX, getAgentsMdDeliveryStatus } from '../lib/context/agents-md.ts';
import { loadValidatedProjectContextConfig } from '../lib/context/project-context-config.ts';
import { resolveSkillSelectionMode } from '../lib/skills/skill-selection.js';
import { patchHostContextSettings } from '../lib/context/context-settings-runtime.ts';
import { noteNativeSession } from '../lib/context/instruction-epoch.ts';
import { decorateHarnessPrompt } from '../lib/sdk/harness-plan-prompt.ts';
import { resetPromptDecorationStatesForTests } from '../lib/sdk/prompt-decoration.ts';
import { resetContextRestartsForTests } from '../lib/usage/context-restarts.ts';

/**
 * Final validation of the context-unification migration (stage 08). Each
 * stage has its own tests; this file pins the cross-stage acceptance
 * contracts and the documented rollback switches in one place.
 */

test.after(() => removeIsolatedDataDir());

const ROOT = path.resolve(import.meta.dirname, '..');

function put(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function makeFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-migration-'));
  const dirs = Object.fromEntries(['project', 'shared', 'bundled', 'home'].map((name) => {
    const dir = path.join(base, name);
    fs.mkdirSync(dir, { recursive: true });
    return [name, dir];
  }));
  put(dirs.project, '.agents/skills/alpha/SKILL.md', '---\nname: alpha\ndescription: Alpha.\n---\nALPHA-BODY\n');
  put(dirs.project, '.cursor/rules/always.mdc', '---\nalwaysApply: true\n---\nPROJECT-RULE-BODY\n');
  put(dirs.project, '.cursor/commands/deploy.md', '---\ndescription: Deploy\n---\nrun');
  put(dirs.project, 'AGENTS.md', 'AGENTS-BODY\n');
  return {
    base,
    ...dirs,
    context: (extra = {}) => ({
      cwd: dirs.project,
      reportContext: '',
      additionalDirs: [dirs.shared],
      homeDir: dirs.home,
      bundledRoot: dirs.bundled,
      skillOptions: { additionalDirs: [dirs.shared], appRoot: dirs.bundled, homeDir: dirs.home },
      ...extra,
    }),
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

// ── One data source, one builder ───────────────────────────────────────────

test('one data source: picker catalog and assembler resolve the same stable entry IDs', () => {
  const fx = makeFixture();
  try {
    const opts = { additionalDirs: [fx.shared], homeDir: fx.home, bundledRoot: fx.bundled };
    const registry = buildContextRegistry(fx.project, opts);
    const api = getCursorContext(fx.project, opts);
    const registryIds = registry.entries.map((entry) => entry.id).sort();
    assert.deepEqual(api.registry.entries.map((entry) => entry.id).sort(), registryIds);
    for (const list of [api.projectRules, api.projectSkills, api.projectCommands]) {
      for (const item of list) assert.ok(registryIds.includes(item.id), `picker item ${item.id} is a registry entry`);
    }
    // The assembler reports the same IDs for the entries it used.
    const result = assemble(fx.context({ prompt: 'x', mode: 'agent', transport: 'codex', chatId: 'mv-1' }), CONTEXT_ADAPTERS.harness);
    const ruleId = 'project::rule::.cursor/rules/always.mdc';
    assert.ok(registryIds.includes(ruleId));
    assert.ok(JSON.stringify(result.manifest).includes(ruleId));
  } finally {
    fx.cleanup();
  }
});

test('one builder: assemble() is deterministic and the preview snapshot carries no host paths', () => {
  const fx = makeFixture();
  try {
    const context = fx.context({ prompt: 'hello', mode: 'agent', transport: 'codex', chatId: 'mv-2' });
    const direct = assemble(context, CONTEXT_ADAPTERS.harness);
    const snapshot = buildContextSnapshot(context, 'harness');
    assert.ok(snapshot && typeof snapshot === 'object');
    assert.equal(JSON.stringify(snapshot).includes(fx.base), false, 'snapshot carries no absolute host paths');
    const again = assemble(context, CONTEXT_ADAPTERS.harness);
    assert.equal(again.payload, direct.payload, 'assemble is deterministic for unchanged data');
  } finally {
    fx.cleanup();
  }
});

// ── Comparison mode decision ───────────────────────────────────────────────

test('comparison mode: stays available but observational; unified builder is not the send default', () => {
  assert.equal(resolveContextBuilderMode({}), 'legacy');
  assert.equal(resolveContextBuilderMode({ CRETLI_CONTEXT_BUILDER: 'compare' }), 'compare');
  // No value can switch the real send path to the assembler result yet.
  for (const value of ['registry', 'assembler', 'unified', 'on', '1']) {
    assert.equal(resolveContextBuilderMode({ CRETLI_CONTEXT_BUILDER: value }), 'legacy', value);
  }
  const fx = makeFixture();
  try {
    const result = compareAllAdapters(fx.context({ prompt: 'x', mode: 'agent', transport: 'codex', chatId: 'mv-3' }));
    assert.equal(result.sdk.defaultResult, 'legacy');
    assert.equal(result.harness.defaultResult, 'legacy');
    assert.equal(result.sdk.identical, true, 'SDK candidate equals SDK legacy baseline');
    assert.equal(result.harness.identical, true, 'harness candidate equals harness legacy baseline');
  } finally {
    fx.cleanup();
  }
});

// ── Portable formats and trust boundary ────────────────────────────────────

test('portable formats: AGENTS.md and SKILL.md are read as-is; repo config cannot assign host sources', () => {
  const fx = makeFixture();
  try {
    const registry = buildContextRegistry(fx.project, { additionalDirs: [], homeDir: fx.home, bundledRoot: fx.bundled });
    assert.ok(registry.entries.some((entry) => entry.kind === 'skill' && entry.callName === 'alpha'));
    // Legacy files stay untouched by the migration.
    assert.equal(fs.readFileSync(path.join(fx.project, '.cursor/rules/always.mdc'), 'utf8').includes('PROJECT-RULE-BODY'), true);

    put(fx.project, '.cretli/context.json', JSON.stringify({ version: 1, entries: [{ source: 'shared:team', path: 'x' }] }));
    const bad = loadValidatedProjectContextConfig(fx.project);
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'host_source_in_repo_config');

    put(fx.project, '.cretli/context.json', JSON.stringify({ version: 1, settings: { sharedDirs: ['/x'] } }));
    const badSettings = loadValidatedProjectContextConfig(fx.project);
    assert.equal(badSettings.ok, false);
  } finally {
    fx.cleanup();
  }
});

test('AGENTS.md matrix: every harness is unknown until evidence is recorded; no auto-injection claim', () => {
  const required = ['sdk', 'opencode', 'codex', 'deepseek', 'claude', 'qwen', 'codebuddy', 'openrouter'];
  for (const id of required) {
    assert.ok(AGENTS_MD_MATRIX[id], id);
    assert.equal(getAgentsMdDeliveryStatus(id).confirmed, false, `${id} has no live evidence`);
  }
});

// ── Measured repetition reduction without losing instructions ──────────────

test('repetition: proven-adapter dedupe shrinks repeated turns; default and unproven adapters lose nothing', () => {
  const fx = makeFixture();
  resetContextRestartsForTests();
  resetPromptDecorationStatesForTests();
  const marker = '[WORKSPACE CURSOR RULES]';
  const turns = ['one', 'two', 'three', 'four', 'five'];
  const total = (transport, chatId, setup) => {
    const room = { chatId, sessionKey: `${chatId}-s`, cwd: fx.project, sdkMode: 'agent', transport };
    setup?.(room);
    const prompts = turns.map((turn) => decorateHarnessPrompt(room, turn, transport));
    return { prompts, chars: prompts.reduce((sum, text) => sum + text.length, 0) };
  };
  try {
    const baseline = total('claude', 'rep-default', (room) => noteNativeSession(room, { nativeSessionId: 'n-default' }));
    assert.ok(baseline.prompts.every((p) => p.includes(marker)), 'default repeats the rules every turn');

    patchHostContextSettings({ settings: { instructions: { dedupe: 'proven_adapters' } } });
    const deduped = total('claude', 'rep-dedupe', (room) => noteNativeSession(room, { nativeSessionId: 'n-dedupe' }));
    assert.ok(deduped.prompts[0].includes(marker), 'first turn delivers the instructions');
    assert.equal(deduped.prompts.slice(1).some((p) => p.includes(marker)), false);
    assert.ok(deduped.prompts.every((p, i) => p.includes(turns[i])), 'the message itself is never dropped');
    assert.ok(deduped.chars < baseline.chars, `measured: ${deduped.chars} < ${baseline.chars} chars over ${turns.length} turns`);
    const saved = baseline.chars - deduped.chars;
    const ruleBlock = baseline.prompts[0].length - deduped.prompts[1].length;
    assert.equal(saved, ruleBlock * (turns.length - 1), 'saving equals the repeated static block, nothing else');

    // No retention proof: the opt-in changes nothing.
    const other = total('openrouter', 'rep-or', (room) => noteNativeSession(room, { nativeSessionId: 'n-or' }));
    assert.ok(other.prompts.every((p) => p.includes(marker)));
  } finally {
    patchHostContextSettings({ settings: { instructions: { dedupe: null } } });
    fx.cleanup();
  }
});

// ── Controlled rollback ────────────────────────────────────────────────────

test('rollback: documented switches restore legacy behaviour without data migration', () => {
  assert.equal(resolveSkillSelectionMode({}), 'explicit');
  assert.equal(resolveSkillSelectionMode({ CRETLI_SKILL_SELECTION: 'legacy' }), 'legacy');
  assert.equal(resolveContextBuilderMode({ CRETLI_CONTEXT_BUILDER: 'legacy' }), 'legacy');
  const fx = makeFixture();
  try {
    // Dedupe off (default) and budget off leave the payload byte-identical across turns.
    resetPromptDecorationStatesForTests();
    const room = { chatId: 'rb-1', sessionKey: 'rb-1-s', cwd: fx.project, sdkMode: 'agent', transport: 'codex' };
    const a = decorateHarnessPrompt(room, 'same', 'codex');
    const b = decorateHarnessPrompt(room, 'same', 'codex');
    assert.equal(a, b);
  } finally {
    fx.cleanup();
  }
});

// ── Documentation contract ─────────────────────────────────────────────────

test('docs: migration, matrix and architecture mention the final decisions and missing live tests', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const migration = read('docs/context/migration-validation.md');
  for (const needle of ['CRETLI_CONTEXT_BUILDER', 'CRETLI_SKILL_SELECTION', 'CRETLI_CONTEXT_MANIFEST', 'instructions.dedupe', 'Rollback', 'live test']) {
    assert.ok(migration.includes(needle), `migration doc mentions ${needle}`);
  }
  const matrix = read('docs/context/harness-source-matrix.md');
  for (const id of ['sdk', 'opencode', 'codex', 'deepseek', 'claude', 'qwen', 'codebuddy', 'openrouter']) {
    assert.ok(matrix.includes(`**${id}**`), `matrix row ${id}`);
  }
  assert.ok(matrix.includes('Live test'), 'matrix has a live-test column');
  assert.ok(read('docs/ARCHITECTURE.md').includes('docs/context/migration-validation.md'));
  assert.ok(read('CHANGELOG.md').includes('Context unification'));
});
