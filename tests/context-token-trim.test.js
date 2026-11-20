/**
 * Regression tests for the Claude context trim: lossless skills catalog with a
 * shorter intro/footer, project-level opt-in dedupe, manifest byte sizes and the
 * size of the always-applied project rule. They pin behaviour, not token savings: sizes
 * here are bytes of Cretli's own contribution, never provider usage or cost.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import { buildSkillPromptBlocks, buildSkillsCatalogText, collectAvailableSkills } from '../lib/skills/skill-context.js';
import { resolveContextSettingsForScope, resolveInstructionDeliveryForTurn } from '../lib/context/context-settings-runtime.ts';
import { bumpInstructionEpoch, INSTRUCTION_EPOCH_REASON, noteNativeSession } from '../lib/context/instruction-epoch.ts';
import { buildContextSnapshot, recordContextSend } from '../lib/context/context-send-manifest.ts';
import { PROMPT_DECORATION_STATIC_MODE, decidePromptDecoration } from '../lib/sdk/prompt-decoration.ts';

test.after(() => removeIsolatedDataDir());

const ROOT = path.resolve(import.meta.dirname, '..');
const LONG = `${'Use this skill when the task involves configuring things carefully. '.repeat(8)}Trailing sentence.`;

function workspace(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-trim-'));
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('catalog: long descriptions are listed in full, with trailing triggers and constraints', () => {
  const text = buildSkillsCatalogText([{ name: 'my-skill', description: LONG, path: '/shared/my-skill/SKILL.md' }]);
  assert.ok(LONG.length > 160);
  assert.ok(text.includes(`- my-skill: ${LONG} (read /shared/my-skill/SKILL.md)`));
  assert.ok(text.includes('Trailing sentence.'));
  assert.equal(text.includes('…'), false);
});

test('catalog: keeps intro guidance (@skill-name, Read tool, native Skill tool) and the footer', () => {
  const text = buildSkillsCatalogText([{ name: 'my-skill', description: 'Short purpose.', path: '/shared/my-skill/SKILL.md' }]);
  assert.match(text, /^\[AVAILABLE AGENT SKILLS\]/);
  assert.match(text, /@skill-name/);
  assert.match(text, /Read tool/);
  assert.match(text, /native Skill tool/);
  assert.match(text, /follow its included instructions first\.$/);
});

test('catalog: real project skills keep their full description, including Use when / Never clauses', () => {
  const entries = collectAvailableSkills(ROOT, { additionalDirs: [], appRoot: ROOT, homeDir: os.tmpdir() });
  const catalog = buildSkillsCatalogText(entries);
  const long = entries.filter((entry) => entry.description.length > 160);
  assert.ok(long.length > 0, 'project has skills with descriptions over 160 chars');
  for (const entry of long) {
    assert.ok(catalog.includes(`- ${entry.name}: ${entry.description} (read ${entry.path})`), `${entry.name} listed in full`);
  }
  const clauses = entries.flatMap((entry) => entry.description.match(/\b(?:Use when|Never)\b[^.]*\./g) || []);
  assert.ok(clauses.length > 0, 'project skills contain trigger/constraint clauses');
  for (const clause of clauses) assert.ok(catalog.includes(clause), `clause kept: ${clause}`);
});

test('catalog: an explicit @name loads the full body next to the full catalog description', () => {
  const body = `---\nname: big-skill\ndescription: ${LONG}\n---\nFULL-BODY-MARKER line.\n`;
  const ws = workspace({ '.agents/skills/big-skill/SKILL.md': body });
  try {
    const options = { additionalDirs: [], appRoot: ws.root, homeDir: ws.root };
    const blocks = buildSkillPromptBlocks(ws.root, options, 'please use @big-skill now', { skillIds: [], parseMentions: true });
    assert.ok(blocks.catalog.includes(LONG));
    assert.ok(blocks.selected.includes('FULL-BODY-MARKER'));
    assert.ok(blocks.catalog.includes(path.join(ws.root, '.agents', 'skills', 'big-skill', 'SKILL.md')));
  } finally {
    ws.cleanup();
  }
});

test('project opt-in: .cretli/context.json enables dedupe only for a proven adapter with a native session', () => {
  const ws = workspace({ '.cretli/context.json': '{"version":1,"settings":{"instructions.dedupe":"proven_adapters"}}' });
  try {
    const settings = resolveContextSettingsForScope({ projectRoot: ws.root, hostSettings: {} });
    assert.equal(settings.effective['instructions.dedupe'], 'proven_adapters');
    const contextSettings = settings.effective;
    const room = { chatId: 'c1', cwd: ws.root };
    // No native session identity yet: conservative fallback.
    assert.equal(resolveInstructionDeliveryForTurn({ room, cwd: ws.root, transport: 'claude', contextSettings }).staticMode, 'always');
    noteNativeSession(room, { nativeSessionId: 'native-1' });
    assert.equal(resolveInstructionDeliveryForTurn({ room, cwd: ws.root, transport: 'claude', contextSettings }).staticMode, 'dedupe');
    // Other harnesses never dedupe, whatever the project says.
    assert.equal(resolveInstructionDeliveryForTurn({ room, cwd: ws.root, transport: 'codex', contextSettings }).staticMode, 'always');
    assert.equal(resolveInstructionDeliveryForTurn({ room, cwd: ws.root, transport: 'sdk', contextSettings }).staticMode, 'always');
  } finally {
    ws.cleanup();
  }
});

test('project without config keeps the global default (dedupe off)', () => {
  const ws = workspace({});
  try {
    const settings = resolveContextSettingsForScope({ projectRoot: ws.root, hostSettings: {} });
    assert.equal(settings.effective['instructions.dedupe'], 'off');
  } finally {
    ws.cleanup();
  }
});

test('this repository opts in at project level through a valid .cretli/context.json', () => {
  const settings = resolveContextSettingsForScope({ projectRoot: ROOT, hostSettings: {} });
  assert.equal(settings.effective['instructions.dedupe'], 'proven_adapters');
  assert.equal(settings.provenance['instructions.dedupe'].layer, 'project');
});

test('dedupe: second turn omits the static block, and a changed block or new epoch redelivers it', () => {
  const room = { chatId: 'c2' };
  noteNativeSession(room, { nativeSessionId: 'native-1' });
  const key = 'c2-e1';
  const dedupe = PROMPT_DECORATION_STATIC_MODE.DEDUPE;
  const first = decidePromptDecoration(null, { staticMode: dedupe, sessionKey: key, staticBlock: 'RULES-V1' });
  assert.equal(first.staticIncluded, true);
  const second = decidePromptDecoration(first.state, { staticMode: dedupe, sessionKey: key, staticBlock: 'RULES-V1' });
  assert.equal(second.staticIncluded, false);
  // Edited rules/catalog: content hash changes, so the whole block is delivered again.
  const edited = decidePromptDecoration(second.state, { staticMode: dedupe, sessionKey: key, staticBlock: 'RULES-V2' });
  assert.equal(edited.staticIncluded, true);
  // Compaction / model change drops decoration state, so the next turn is a first turn.
  bumpInstructionEpoch(room, INSTRUCTION_EPOCH_REASON.COMPACT_BOUNDARY);
  assert.equal(room._promptDecorationState, null);
  const afterCompaction = decidePromptDecoration(room._promptDecorationState, { staticMode: dedupe, sessionKey: 'c2-e2', staticBlock: 'RULES-V2' });
  assert.equal(afterCompaction.staticIncluded, true);
});

test('manifest: blocks[].bytes and payloadBytes are UTF-8 bytes of the ASSEMBLED text', () => {
  const ws = workspace({ '.cursor/rules/r.mdc': '---\nalwaysApply: true\n---\nZażółć gęślą jaźń — rule body.\n' });
  try {
    const snapshot = buildContextSnapshot({
      cwd: ws.root, projectRoot: ws.root, prompt: 'hi', transport: 'claude', mode: 'agent', homeDir: ws.root, appRoot: ws.root,
    }, 'harness');
    const rules = snapshot.blocks.find((block) => block.id === 'workspace_rules');
    assert.ok(rules && rules.included);
    assert.equal(typeof rules.bytes, 'number');
    assert.ok(rules.bytes > rules.length, 'multi-byte text: bytes exceed UTF-16 length');
    assert.ok(snapshot.payloadBytes > snapshot.payloadLength);
  } finally {
    ws.cleanup();
  }
});

test('manifest: delivery.sentPayloadBytes is the actually sent payload, not the assembled one', () => {
  const ws = workspace({ '.cursor/rules/r.mdc': '---\nalwaysApply: true\n---\nRule body.\n' });
  try {
    const context = {
      cwd: ws.root, projectRoot: ws.root, prompt: 'hi', transport: 'claude', mode: 'agent', homeDir: ws.root, appRoot: ws.root,
    };
    // A deduped turn sends less than the assembler builds; multi-byte text pins bytes vs UTF-16 length.
    const sentPayload = 'Zażółć — hi';
    const sent = recordContextSend({ chatId: 'trim-sent', sendId: 'trim-s1', context, adapterId: 'harness', sentPayload });
    assert.equal(sent.delivery.sentPayloadBytes, Buffer.byteLength(sentPayload, 'utf8'));
    assert.ok(sent.delivery.sentPayloadBytes > sent.delivery.sentPayloadLength);
    assert.equal(sent.delivery.sentPayloadLength, sentPayload.length);
    assert.ok(sent.delivery.sentPayloadBytes < sent.payloadBytes, 'sent bytes are independent of assembled bytes');
    assert.equal(sent.delivery.matchesAssembler, false);
    const none = recordContextSend({ chatId: 'trim-sent', sendId: 'trim-s2', context, adapterId: 'harness' });
    assert.equal(none.delivery.sentPayloadBytes, 0);
  } finally {
    ws.cleanup();
  }
});

test('always-applied project rule stays short and its doc pointers exist', () => {
  const rule = fs.readFileSync(path.join(ROOT, '.cursor/rules/cretli-system.mdc'), 'utf8');
  assert.ok(Buffer.byteLength(rule) <= 4000, 'cretli-system.mdc is sent on every first turn; keep procedures in docs/');
  for (const rel of rule.match(/docs\/[A-Za-z0-9_./-]+\.md/g) || []) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} referenced from the rule must exist`);
  }
  // Safety and project constraints stay in the always-applied rule.
  for (const needle of ['outside the sandbox', 'app_start', 'port_status', 'port_expose', 'never commit', 'delegation_start', 'review']) {
    assert.ok(rule.toLowerCase().includes(needle.toLowerCase()), `rule must still mention ${needle}`);
  }
});
