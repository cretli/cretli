import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import { parseFrontmatterChecked } from '../lib/skills/frontmatter.js';
import { buildContextRegistry, resolveEntryByName } from '../lib/context/registry.ts';
import { assemble, CONTEXT_ADAPTERS } from '../lib/context/context-assembler.ts';
import {
  compareAllAdapters,
  compareWithLegacy,
  resolveContextBuilderMode,
} from '../lib/context/context-compare.ts';
import { getCursorContext } from '../lib/sdk/cursor-context.ts';
import {
  applyHarnessOutboundPrompt,
  applySdkHarnessOutboundPrompt,
} from '../lib/sdk/harness-plan-prompt.ts';

test.after(() => {
  removeIsolatedDataDir();
});

/**
 * Isolated project / shared / bundled / home roots.
 *
 * @returns {{ base: string, project: string, shared: string, bundled: string, home: string, context: (extra?: object) => Record<string, any>, cleanup: () => void }}
 */
function makeFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-registry-'));
  const dirs = Object.fromEntries(['project', 'shared', 'bundled', 'home'].map((name) => {
    const dir = path.join(base, name);
    fs.mkdirSync(dir, { recursive: true });
    return [name, dir];
  }));
  return {
    base,
    ...dirs,
    // Every scan root is pinned, so the legacy scan sees the same sources.
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

/**
 * @param {string} root
 * @param {string} rel
 * @param {string} content
 */
function put(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function registryFor(fx) {
  return buildContextRegistry(fx.project, {
    additionalDirs: [fx.shared],
    bundledRoot: fx.bundled,
    homeDir: fx.home,
  });
}

test('parseFrontmatterChecked reads multiline descriptions and reports malformed YAML', () => {
  const folded = parseFrontmatterChecked('---\nname: a\ndescription: >-\n  first line\n  second line\n---\nBody\n');
  assert.equal(folded.status, 'ok');
  assert.equal(folded.data.description, 'first line second line');
  assert.equal(folded.body, 'Body');

  const literal = parseFrontmatterChecked('---\ndescription: |\n  one\n  two\n---\n');
  assert.equal(literal.data.description, 'one\ntwo\n');

  const malformed = parseFrontmatterChecked('---\nname: [unclosed\ndescription: x: y: z\n---\nBody');
  assert.equal(malformed.status, 'malformed');
  assert.equal(malformed.data, null);
  assert.match(malformed.error, /Invalid frontmatter YAML/);

  assert.equal(parseFrontmatterChecked('---\n- a\n- b\n---\n').status, 'malformed');
  assert.equal(parseFrontmatterChecked('---\nname: a\n').status, 'absent');
  assert.equal(parseFrontmatterChecked('# Plain\n').status, 'absent');
  // JSON schema keeps a date-like scalar as the string it was written as.
  assert.equal(parseFrontmatterChecked('---\nname: 2024-01-01\n---\n').data.name, '2024-01-01');
});

test('parseFrontmatterChecked rejects an oversized frontmatter block before parsing', () => {
  const big = `---\nname: a\ndescription: ${'x'.repeat(200)}\n---\n`;
  const actual = parseFrontmatterChecked(big, { maxBytes: 64 });
  assert.equal(actual.status, 'too_large');
  assert.equal(actual.data, null);
  // An alias bomb stays under the byte cap but is still just bounded input.
  assert.equal(parseFrontmatterChecked('---\nname: a\n---\n', { maxBytes: 64 }).status, 'ok');
});

test('registry resolves multiline descriptions for skills and rules', () => {
  const fx = makeFixture();
  try {
    put(fx.project, '.agents/skills/folded/SKILL.md', [
      '---',
      'name: folded',
      'description: >-',
      '  Long folded description',
      '  that continues on a second line.',
      '---',
      'Skill body',
    ].join('\n'));
    put(fx.project, '.cursor/rules/doc.mdc', '---\ndescription: |\n  Rule line one\n  Rule line two\nalwaysApply: false\n---\nRule body\n');
    const registry = registryFor(fx);
    const skill = registry.entries.find((e) => e.kind === 'skill');
    assert.equal(skill.callName, 'folded');
    assert.equal(skill.description, 'Long folded description that continues on a second line.');
    assert.equal(skill.valid, true);
    const rule = registry.entries.find((e) => e.kind === 'rule');
    assert.equal(rule.description, 'Rule line one Rule line two');
  } finally {
    fx.cleanup();
  }
});

test('invalid entries stay visible with diagnostics but are never executed', () => {
  const fx = makeFixture();
  try {
    put(fx.project, '.agents/skills/good/SKILL.md', '---\nname: good\ndescription: Fine.\n---\nGood body\n');
    put(fx.project, '.agents/skills/broken/SKILL.md', '---\nname: broken\ndescription: [oops\n---\nBROKEN-SECRET-BODY\n');
    put(fx.project, '.agents/skills/huge/SKILL.md', `---\nname: huge\n---\n${'a'.repeat(70 * 1024)}`);
    put(fx.project, '.agents/skills/badname/SKILL.md', '---\nname: "bad name!"\n---\nbody');
    put(fx.project, '.cursor/rules/broken.mdc', '---\nalwaysApply: [true\n---\nRULE-SECRET-BODY\n');
    const registry = registryFor(fx);
    const byRel = (rel) => registry.entries.find((e) => e.relPath === rel);

    assert.equal(byRel('.agents/skills/broken/SKILL.md').valid, false);
    assert.equal(byRel('.agents/skills/broken/SKILL.md').diagnostics[0].code, 'malformed_frontmatter');
    assert.equal(byRel('.agents/skills/huge/SKILL.md').diagnostics[0].code, 'too_large');
    assert.equal(byRel('.agents/skills/huge/SKILL.md').contentHash, '');
    assert.equal(byRel('.agents/skills/badname/SKILL.md').diagnostics.some((d) => d.code === 'invalid_name'), true);
    assert.equal(byRel('.cursor/rules/broken.mdc').valid, false);
    assert.equal(registry.diagnostics.some((d) => d.code === 'malformed_frontmatter'), true);

    const result = assemble(
      { ...fx.context(), prompt: 'use the broken skill @broken', mode: 'agent' },
      CONTEXT_ADAPTERS.harness,
    );
    assert.match(result.payload, /- good:/);
    assert.equal(result.payload.includes('BROKEN-SECRET-BODY'), false);
    assert.equal(result.payload.includes('RULE-SECRET-BODY'), false);
    assert.equal(result.payload.includes('- broken:'), false);
    assert.equal(result.warnings.some((w) => w.startsWith('invalid_entry:') && w.includes('broken')), true);
    assert.equal(result.manifest.warnings.length, result.warnings.length);

    // The legacy picker lists keep the entry, flagged invalid.
    const api = getCursorContext(fx.project, {
      additionalDirs: [],
      homeDir: fx.home,
      bundledRoot: fx.bundled,
    });
    const listed = api.projectSkills.find((item) => item.name === 'broken');
    assert.equal(listed.valid, false);
    assert.equal(listed.diagnostics[0].code, 'malformed_frontmatter');
  } finally {
    fx.cleanup();
  }
});

test('name collisions in one source are flagged on every entry, not hidden', () => {
  const fx = makeFixture();
  try {
    put(fx.project, '.agents/skills/dup/SKILL.md', '---\nname: dup\ndescription: from agents\n---\nA');
    put(fx.project, '.cursor/skills/dup/SKILL.md', '---\nname: dup\ndescription: from cursor\n---\nB');
    put(fx.project, '.cursor/skills/solo/SKILL.md', '---\nname: solo\n---\nS');
    put(fx.shared, '.agents/skills/solo/SKILL.md', '---\nname: solo\ndescription: shared solo\n---\nShared');
    const registry = registryFor(fx);
    const dups = registry.entries.filter((e) => e.callName === 'dup');
    assert.equal(dups.length, 2);
    for (const entry of dups) {
      assert.equal(entry.ambiguous, true);
      assert.equal(entry.diagnostics.some((d) => d.code === 'duplicate_name' && d.severity === 'error'), true);
    }

    // Name resolution refuses an ambiguous name; an explicit ID still reaches it.
    const byName = resolveEntryByName(registry, 'dup', { kind: 'skill' });
    assert.equal(byName.entry, null);
    assert.equal(byName.ambiguous, true);
    assert.equal(byName.candidates.length, 2);
    const byId = resolveEntryByName(registry, 'dup', { explicitId: dups[1].id });
    assert.equal(byId.entry.id, dups[1].id);

    // Project wins over shared for a plain name; both IDs stay in the registry.
    const solo = resolveEntryByName(registry, 'solo', { kind: 'skill' });
    assert.equal(solo.entry.source, 'project');
    assert.equal(solo.via, 'nearest_project_entry');
    assert.equal(registry.entries.filter((e) => e.callName === 'solo').length, 2);

    // The assembler keeps the ambiguous name out of the catalog and says so.
    const result = assemble({ ...fx.context(), prompt: '' }, CONTEXT_ADAPTERS.sdk);
    assert.equal(result.blocks.find((b) => b.id === 'skills_catalog').text.includes('- dup:'), false);
    assert.equal(result.warnings.some((w) => w.startsWith('ambiguous_name:')), true);
    assert.match(result.blocks.find((b) => b.id === 'skills_catalog').text, /- solo: .* \(read .*\.cursor\/skills\/solo\/SKILL\.md\)/);

    // Legacy lists keep their "first folder wins" projection.
    const api = getCursorContext(fx.project, { additionalDirs: [], homeDir: fx.home, bundledRoot: fx.bundled });
    assert.equal(api.projectSkills.filter((item) => item.name === 'dup').length, 1);
    assert.equal(api.registry.entries.filter((item) => item.callName === 'dup').length, 2);
  } finally {
    fx.cleanup();
  }
});

test('stable ID survives a content change; the hash is the version', () => {
  const fx = makeFixture();
  try {
    const file = put(fx.project, '.agents/skills/stable/SKILL.md', '---\nname: stable\n---\nv1');
    const before = registryFor(fx);
    const entryBefore = before.entries.find((e) => e.callName === 'stable');
    fs.writeFileSync(file, '---\nname: stable\n---\nv2 with changes');
    const after = registryFor(fx);
    const entryAfter = after.entries.find((e) => e.callName === 'stable');
    assert.equal(entryAfter.id, entryBefore.id);
    assert.equal(entryAfter.id, 'project::skill::.agents/skills/stable/SKILL.md');
    assert.notEqual(entryAfter.contentHash, entryBefore.contentHash);
    assert.match(entryAfter.contentHash, /^[0-9a-f]{64}$/);
    // Composition (epoch) is unchanged by an edit; the content revision is not.
    assert.equal(after.epoch, before.epoch);
    assert.notEqual(after.contentRevision, before.contentRevision);

    // A moved file is a different entry.
    fs.mkdirSync(path.join(fx.project, '.cursor/skills/stable'), { recursive: true });
    fs.renameSync(file, path.join(fx.project, '.cursor/skills/stable/SKILL.md'));
    const moved = registryFor(fx).entries.find((e) => e.callName === 'stable');
    assert.notEqual(moved.id, entryBefore.id);
    assert.equal(moved.contentHash, entryAfter.contentHash);

    // Two shared roots with the same basename get distinct source labels.
    const otherShared = path.join(fx.base, 'other', 'shared');
    put(otherShared, '.agents/skills/twin/SKILL.md', '---\nname: twin\n---\nT');
    put(fx.shared, '.agents/skills/twin/SKILL.md', '---\nname: twin\n---\nT');
    const twins = buildContextRegistry(fx.project, {
      additionalDirs: [fx.shared, otherShared],
      bundledRoot: fx.bundled,
      homeDir: fx.home,
    }).entries.filter((e) => e.callName === 'twin');
    assert.equal(twins.length, 2);
    assert.notEqual(twins[0].id, twins[1].id);
  } finally {
    fx.cleanup();
  }
});

test('a symlink that escapes the authorized root is rejected and never read', () => {
  const fx = makeFixture();
  try {
    const outside = path.join(fx.base, 'outside');
    put(outside, 'evil/SKILL.md', '---\nname: evil\n---\nOUTSIDE-SECRET');
    fs.mkdirSync(path.join(fx.project, '.agents/skills'), { recursive: true });
    fs.symlinkSync(path.join(outside, 'evil'), path.join(fx.project, '.agents/skills/evil'));
    const registry = registryFor(fx);
    const entry = registry.entries.find((e) => e.callName === 'evil');
    assert.equal(entry.valid, false);
    assert.equal(entry.diagnostics[0].code, 'symlink_escape');
    assert.equal(registry.getContent(entry.id), '');
    const api = getCursorContext(fx.project, { additionalDirs: [], homeDir: fx.home, bundledRoot: fx.bundled });
    assert.equal(api.projectSkills.some((item) => item.name === 'evil'), false);
    assert.equal(api.registry.entries.some((item) => item.callName === 'evil' && !item.valid), true);
    const result = assemble({ ...fx.context(), prompt: 'use evil skill @evil' }, CONTEXT_ADAPTERS.harness);
    assert.equal(result.payload.includes('OUTSIDE-SECRET'), false);
  } finally {
    fx.cleanup();
  }
});

/**
 * Valid project/shared/bundled/user content that the legacy scan and the
 * registry read identically.
 */
function seedComparableFixture(fx) {
  put(fx.project, '.agents/skills/alpha/SKILL.md', '---\nname: alpha\ndescription: >-\n  Alpha does\n  things.\n---\nALPHA-BODY\n');
  put(fx.project, '.cursor/skills/beta/SKILL.md', '---\nname: beta\ndescription: Beta.\n---\nBETA-BODY\n');
  put(fx.shared, '.agents/skills/gamma/SKILL.md', '---\nname: gamma\ndescription: Gamma.\n---\nGAMMA-BODY\n');
  put(fx.bundled, '.agents/skills/delta/SKILL.md', '---\nname: delta\ndescription: Delta.\n---\nDELTA-BODY\n');
  put(fx.home, '.agents/skills/epsilon/SKILL.md', '---\nname: epsilon\ndescription: Epsilon.\n---\nEPS-BODY\n');
  put(fx.project, '.cursor/rules/always.mdc', '---\nalwaysApply: true\n---\nPROJECT-RULE-BODY\n');
  put(fx.project, '.cursor/rules/sub/nested.md', '---\nalwaysApply: true\n---\nNESTED-RULE-BODY\n');
  put(fx.project, '.cursor/rules/optional.mdc', '---\ndescription: not always\nalwaysApply: false\n---\nOPTIONAL-BODY\n');
  put(fx.shared, '.cursor/rules/shared.mdc', '---\nalwaysApply: true\n---\nSHARED-RULE-BODY\n');
  put(fx.shared, '.cursor/rules/scoped.mdc', '---\nalwaysApply: true\ncretli:\n  taskKinds: [docs]\n---\nSCOPED-RULE-BODY\n');
}

test('SDK and non-SDK candidates match their own legacy blocks exactly', () => {
  const fx = makeFixture();
  try {
    seedComparableFixture(fx);
    const context = fx.context({
      prompt: 'please run @alpha now',
      selection: { skillIds: [], parseMentions: true },
      mode: 'plan',
      transport: 'opencode',
      chatId: 'cmp-chat-1',
      pageContext: '[PAGE] visible page',
      taskKind: 'code',
    });
    const result = compareAllAdapters(context, { includeText: true });

    for (const side of [result.sdk, result.harness]) {
      assert.equal(side.defaultResult, 'legacy');
      assert.deepEqual(
        side.differences.filter((row) => row.status !== 'same'),
        [],
        `adapter ${side.adapter}: ${JSON.stringify(side.differences.filter((row) => row.status !== 'same'))}`,
      );
      assert.equal(side.identical, true);
      assert.equal(side.payloadIdentical, true);
      assert.equal(side.legacy.payloadHash, side.candidate.payloadHash);
    }

    // Exact blocks, asserted literally per baseline.
    const sdk = assemble(context, CONTEXT_ADAPTERS.sdk);
    const harness = assemble(context, CONTEXT_ADAPTERS.harness);
    const text = (res, id) => res.blocks.find((b) => b.id === id).text;
    assert.match(text(harness, 'workspace_rules'), /^\[WORKSPACE CURSOR RULES\]\n/);
    assert.match(text(harness, 'workspace_rules'), /### \.cursor\/rules\/always\.mdc\nPROJECT-RULE-BODY\n### \.cursor\/rules\/sub\/nested\.md\nNESTED-RULE-BODY$/);
    assert.equal(text(harness, 'workspace_rules').includes('OPTIONAL-BODY'), false);
    assert.equal(text(sdk, 'workspace_rules'), '');
    assert.equal(text(sdk, 'modeHint'), '');
    assert.match(text(harness, 'modeHint'), /^You are in plan mode\./);
    assert.equal(text(sdk, 'pageContext'), '[PAGE] visible page');
    assert.equal(text(harness, 'pageContext'), '');
    // Scoped shared rule is dropped for taskKind "code" in both baselines.
    assert.equal(text(sdk, 'shared_rules').includes('SCOPED-RULE-BODY'), false);
    assert.match(text(sdk, 'shared_rules'), /### \.cursor\/rules\/shared\.mdc\nSHARED-RULE-BODY$/);
    assert.equal(text(sdk, 'shared_rules'), text(harness, 'shared_rules'));
    // Selected skill body is a dynamic block in both.
    assert.equal(text(sdk, 'skills'), '[SKILL: alpha]\n' + fs.readFileSync(path.join(fx.project, '.agents/skills/alpha/SKILL.md'), 'utf8'));
    for (const name of ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) {
      assert.match(text(sdk, 'skills_catalog'), new RegExp(`- ${name}: `));
    }
    assert.match(text(sdk, 'skills_catalog'), /- alpha: Alpha does things\. \(read /);

    // The two baselines are kept apart: only the non-SDK path has workspace rules and mode hint.
    assert.deepEqual(
      result.baselineDelta.map((row) => [row.block, row.sdkHasBlock, row.harnessHasBlock]),
      [
        ['workspace_rules', false, true],
        ['pageContext', true, false],
        ['modeHint', false, true],
      ].filter(([id]) => id !== 'static_block'),
    );
    assert.equal(result.sdk.legacy.payload.includes('[WORKSPACE CURSOR RULES]'), false);
    assert.equal(result.harness.legacy.payload.includes('[WORKSPACE CURSOR RULES]'), true);
    assert.equal(result.sdk.legacy.payload.includes('You are in plan mode.'), false);
    assert.equal(result.harness.legacy.payload.includes('You are in plan mode.'), true);
    assert.notEqual(result.sdk.legacy.payloadHash, result.harness.legacy.payloadHash);

    // Manifest: epoch/revision, adapter, block hashes and the entries used.
    assert.equal(sdk.manifest.adapter, 'sdk');
    assert.equal(harness.manifest.adapter, 'harness');
    assert.equal(sdk.manifest.registryEpoch, harness.manifest.registryEpoch);
    assert.match(sdk.manifest.contentRevision, /^[0-9a-f]{16}$/);
    assert.equal(sdk.manifest.entries.some((e) => e.role === 'selected' && e.callName === 'alpha'), true);
    assert.equal(sdk.manifest.entries.some((e) => e.role === 'rule' && e.scope === 'project'), false);
    assert.equal(harness.manifest.entries.some((e) => e.role === 'rule' && e.scope === 'project'), true);
    assert.equal(sdk.manifest.blocks.find((b) => b.id === 'skills_catalog').hash, sdk.blocks.find((b) => b.id === 'skills_catalog').hash);
    assert.equal(JSON.stringify(sdk.manifest).includes('ALPHA-BODY'), false);
  } finally {
    fx.cleanup();
  }
});

test('comparison reports a difference when the registry rejects what legacy still sends', () => {
  const fx = makeFixture();
  try {
    seedComparableFixture(fx);
    // Legacy reads this rule through the tolerant scanner; the registry marks it invalid.
    put(fx.project, '.cursor/rules/tolerated.mdc', '---\nalwaysApply: true\ndescription: [unclosed\n---\nTOLERATED-BODY\n');
    const result = compareWithLegacy(fx.context({ prompt: 'x', mode: 'agent', transport: 'codex' }), 'harness', { includeText: true });
    assert.equal(result.identical, false);
    const row = result.differences.find((d) => d.block === 'workspace_rules');
    assert.equal(row.status, 'different');
    assert.equal(row.legacyText.includes('TOLERATED-BODY'), true);
    assert.equal(row.candidateText.includes('TOLERATED-BODY'), false);
    assert.equal(result.candidate.warnings.some((w) => w.includes('tolerated.mdc')), true);
    // The SDK baseline never sends workspace rules, so it is unaffected.
    assert.equal(compareWithLegacy(fx.context({ prompt: 'x', mode: 'agent' }), 'sdk').identical, true);
  } finally {
    fx.cleanup();
  }
});

test('comparison never changes the real send path; the legacy builder stays the default', () => {
  const fx = makeFixture();
  try {
    seedComparableFixture(fx);
    const context = fx.context({ prompt: 'run alpha', mode: 'plan', transport: 'opencode', chatId: 'cmp-chat-2' });
    const sendInput = {
      cwd: context.cwd,
      chatId: context.chatId,
      mode: context.mode,
      transport: context.transport,
      reportContext: '',
      skillOptions: context.skillOptions,
      sharedDirs: context.additionalDirs,
    };
    const beforeHarness = applyHarnessOutboundPrompt('run alpha', sendInput);
    const beforeSdk = applySdkHarnessOutboundPrompt('run alpha', { ...sendInput, pageContext: '' });
    compareAllAdapters(context);
    assemble(context, CONTEXT_ADAPTERS.sdk);
    const afterHarness = applyHarnessOutboundPrompt('run alpha', sendInput);
    const afterSdk = applySdkHarnessOutboundPrompt('run alpha', { ...sendInput, pageContext: '' });
    assert.equal(afterHarness, beforeHarness);
    assert.equal(afterSdk, beforeSdk);
    // The send payloads equal the legacy baselines inside the comparison.
    const result = compareAllAdapters(context);
    assert.equal(result.harness.legacy.payload, beforeHarness);
    assert.equal(result.sdk.legacy.payload, beforeSdk);
    assert.equal(resolveContextBuilderMode({}), 'legacy');
    assert.equal(resolveContextBuilderMode({ CRETLI_CONTEXT_BUILDER: 'registry' }), 'legacy');
    assert.equal(resolveContextBuilderMode({ CRETLI_CONTEXT_BUILDER: 'compare' }), 'compare');
  } finally {
    fx.cleanup();
  }
});

test('getCursorContext keeps the legacy list shapes and adds registry fields', () => {
  const fx = makeFixture();
  try {
    seedComparableFixture(fx);
    put(fx.project, '.cursor/commands/deploy.md', '---\ndescription: Deploy\n---\nrun');
    put(fx.project, '.cursor/agents/reviewer.md', '---\ndescription: Reviewer\n---\nbody');
    put(fx.home, '.cursor/agents/helper.md', 'body');
    const api = getCursorContext(fx.project, {
      additionalDirs: [fx.shared],
      homeDir: fx.home,
      bundledRoot: fx.bundled,
    });
    const rule = api.projectRules.find((item) => item.name === 'always.mdc');
    assert.equal(rule.path, '.cursor/rules/always.mdc');
    assert.equal(rule.source, 'project');
    assert.equal(rule.id, 'project::rule::.cursor/rules/always.mdc');
    assert.deepEqual(api.projectCommands.map((item) => [item.name, item.path]), [['deploy.md', '.cursor/commands/deploy.md']]);
    assert.deepEqual(api.projectAgents.map((item) => [item.name, item.path]), [['reviewer', '.cursor/agents/reviewer.md']]);
    assert.equal(api.projectSkills.find((item) => item.name === 'alpha').path, '.agents/skills/alpha/SKILL.md');
    const shared = api.sharedSkills.find((item) => item.name === 'gamma');
    assert.equal(shared.source, `shared:${path.basename(fx.shared)}`);
    assert.equal(shared.path, path.join(fx.shared, '.agents/skills/gamma/SKILL.md'));
    assert.equal(api.sharedSkills.find((item) => item.name === 'delta').source, 'bundled');
    assert.deepEqual(api.userSkills.map((item) => item.name), ['epsilon']);
    assert.deepEqual(api.userAgents.map((item) => [item.name, item.path]), [['helper', '~/.cursor/agents/helper.md']]);
    assert.equal(api.sharedRules.some((item) => item.name === 'shared.mdc'), true);
    assert.equal(api.registry.entries.length > 0, true);
    assert.equal(api.registry.entries.every((entry) => !('absPath' in entry)), true);
    assert.equal(JSON.stringify(api.registry).includes(fx.base), false);
    assert.match(api.registry.epoch, /^[0-9a-f]{16}$/);

    const widget = getCursorContext(fx.project, {
      audience: 'widget',
      additionalDirs: [fx.shared],
      homeDir: fx.home,
      bundledRoot: fx.bundled,
    });
    assert.deepEqual(widget.userSkills, []);
    assert.equal(widget.registry.entries.some((entry) => entry.scope === 'shared' || entry.scope === 'user'), false);
    assert.equal(widget.sharedSkills.every((item) => item.source === 'bundled'), true);
  } finally {
    fx.cleanup();
  }
});

test('js-yaml is a declared server dependency and stays out of the frontend bundle', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.match(pkg.dependencies['js-yaml'], /^\^?4\./);
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && /from ['"]js-yaml['"]|skills\/frontmatter|context\/registry/.test(fs.readFileSync(full, 'utf8'))) {
        offenders.push(path.relative(root, full));
      }
    }
  };
  walk(path.join(root, 'app_front'));
  assert.deepEqual(offenders, []);
});
