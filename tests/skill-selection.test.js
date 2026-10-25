import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import {
  extractActiveMentions,
  isSkillSelectedLegacy,
  normalizeSkillIds,
  normalizeSkillSelection,
  readClientSkillSelection,
  resolveSkillSelectionMode,
  selectionFromSkillIds,
  selectionRequestsSkill,
  selectSkills,
  stripNonActivatingText,
  withSkillSelection,
} from '../lib/skills/skill-selection.js';
import { buildSkillPromptBlocks } from '../lib/skills/skill-context.js';
import { buildContextRegistry } from '../lib/context/registry.ts';
import { assemble, CONTEXT_ADAPTERS } from '../lib/context/context-assembler.ts';
import { applyHarnessOutboundPrompt } from '../lib/sdk/harness-plan-prompt.ts';
import { acceptRoomPrompt } from '../lib/chat-run/kernel-adapter.ts';
import { acceptSdkRoomPrompt } from '../lib/sdk/sdk-prompt-accept.ts';
import { createCodexSteering } from '../lib/codex/codex-steer.ts';
import { recordSteerManifest } from '../lib/context/context-send-manifest.ts';
import { listContextSendManifests } from '../lib/persist/context-send-manifests-persist.js';
import { registerChatContextRoutes } from '../lib/routes/chat-context-routes.js';
import { saveChats } from '../lib/persist/chats-persist.js';
import { disposeOpenRouterRoom, ensureOpenRouterRoom, handleOpenRouterAgentWebSocket } from '../harnesses/openrouter/openrouter-agent-ws.js';

test.after(() => removeIsolatedDataDir());

/** @returns {{ root: string, options: Record<string, any>, registry: any, idOf: (name: string) => string, cleanup: () => void }} */
function makeWorkspace(skills, extraFiles = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-skill-sel-'));
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-skill-sel-empty-'));
  for (const [name, content] of Object.entries(skills)) {
    const dir = path.join(root, '.agents', 'skills', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8');
  }
  for (const [rel, content] of Object.entries(extraFiles)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content, 'utf8');
  }
  const options = { additionalDirs: [], appRoot: empty, homeDir: empty, bundledRoot: empty };
  const registry = buildContextRegistry(root, { audience: 'host', additionalDirs: [], bundledRoot: empty, homeDir: empty });
  return {
    root,
    options,
    registry,
    idOf: (name) => registry.entries.find((entry) => entry.callName === name && entry.kind === 'skill')?.id,
    cleanup: () => {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(empty, { recursive: true, force: true });
    },
  };
}

const skill = (name, body) => `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${body}\n`;
const MENTIONS = { skillIds: [], parseMentions: true };

test('mentions inside quotes, code, logs and blockquotes never activate', () => {
  assert.deepEqual(extractActiveMentions('please run @review now'), ['review']);
  assert.deepEqual(extractActiveMentions('(@review) and, @deploy.'), ['review', 'deploy']);
  const inert = [
    'He said "use @review here"',
    'inline `@review` code',
    '```\n@review\n```',
    '> @review quoted',
    '    @review indented code',
    '2026-10-22T10:00:00Z INFO @review started',
    'ERROR: @review failed',
    'mail me at user@review.example',
  ];
  for (const text of inert) assert.deepEqual(extractActiveMentions(text), [], text);
  assert.equal(stripNonActivatingText('a ```x``` b').includes('x'), false);
});

test('normalization limits and dedupes IDs, and a client message keeps the mention policy', () => {
  assert.deepEqual(normalizeSkillIds(['a', 'a', ' b ', '', 5, 'x'.repeat(600)]), ['a', 'b']);
  assert.equal(normalizeSkillIds(Array.from({ length: 80 }, (_, i) => `id${i}`)).length, 32);
  assert.deepEqual(normalizeSkillSelection(null), { skillIds: [], parseMentions: false });
  assert.deepEqual(normalizeSkillSelection(['p']), { skillIds: ['p'], parseMentions: false });
  assert.equal(readClientSkillSelection({ selectedSkillIds: ['p'] }).parseMentions, true);
  assert.equal(readClientSkillSelection({ skillMentions: false }).parseMentions, false);
  assert.deepEqual(selectionFromSkillIds(['p']), { skillIds: ['p'], parseMentions: false });
  assert.deepEqual(withSkillSelection({ text: 'x' }, null), { text: 'x' });
  assert.deepEqual(withSkillSelection({ text: 'x' }, ['p']).selection.skillIds, ['p']);
  assert.equal(selectionRequestsSkill('plain steer', MENTIONS), false);
  assert.equal(selectionRequestsSkill('use @review', MENTIONS), true);
  assert.equal(selectionRequestsSkill('use @review', { skillIds: [], parseMentions: false }), false);
  assert.equal(selectionRequestsSkill('plain', ['p']), true);
});

test('rollback switch: CRETLI_SKILL_SELECTION=legacy restores the keyword rule', () => {
  assert.equal(resolveSkillSelectionMode({}), 'explicit');
  assert.equal(resolveSkillSelectionMode({ CRETLI_SKILL_SELECTION: 'legacy' }), 'legacy');
  assert.equal(resolveSkillSelectionMode({ CRETLI_SKILL_SELECTION: 'nope' }), 'explicit');
  const candidates = [{ id: 'i1', name: 'review', readContent: () => 'B' }];
  const prompt = 'Use the review skill on this diff.';
  const explicit = selectSkills({ prompt, selection: MENTIONS, nameCandidates: candidates, resolveId: () => ({}) });
  assert.deepEqual(explicit.selected, []);
  assert.deepEqual(explicit.differences, [
    { name: 'review', legacy: true, explicit: false, note: 'legacy keyword rule would activate it; explicit selection did not' },
  ]);
  const legacy = selectSkills({ prompt, selection: MENTIONS, mode: 'legacy', nameCandidates: candidates, resolveId: () => ({}) });
  assert.deepEqual(legacy.selected.map((entry) => entry.name), ['review']);
  assert.equal(isSkillSelectedLegacy(prompt, 'review'), true);
});

test('plain mentions, quotes and delegation task text do not activate; picked IDs and @name do', () => {
  const ws = makeWorkspace({ review: skill('review', 'REVIEW-BODY'), shell: skill('shell', 'SHELL-BODY') });
  try {
    const pick = (prompt, selection) => buildSkillPromptBlocks(ws.root, ws.options, prompt, selection).selected;
    assert.equal(pick('Review the plan and use the shell skill', MENTIONS), '');
    assert.equal(pick('He wrote "@review" in the log', MENTIONS), '');
    assert.equal(pick('> @review\nplain', MENTIONS), '');
    // Delegation task text / queue / watcher prompts: not user-authored, no mentions.
    assert.equal(pick('Child task: please @review this', selectionFromSkillIds([])), '');
    assert.equal(pick('Child task: please @review this', null), '');
    assert.match(pick('please @shell ls', MENTIONS), /SHELL-BODY/);
    // Explicit ID works with no @name at all, and without any future role profile.
    const child = pick('Implement the change.', selectionFromSkillIds([ws.idOf('review')]));
    assert.match(child, /\[SKILL: review\]/);
    assert.match(child, /REVIEW-BODY/);
    assert.doesNotMatch(child, /SHELL-BODY/);
  } finally {
    ws.cleanup();
  }
});

test('IDs are resolved in the scope of the send; foreign, unknown and command IDs are reported', () => {
  const ws = makeWorkspace({ review: skill('review', 'REVIEW-BODY') }, { '.cursor/commands/deploy.md': '# deploy\n' });
  try {
    const commandId = ws.registry.entries.find((entry) => entry.kind === 'command')?.id;
    assert.ok(commandId, 'fixture must produce a command entry');
    const blocks = buildSkillPromptBlocks(ws.root, ws.options, 'go', selectionFromSkillIds([
      ws.idOf('review'), 'other-project:.agents/skills/secret/SKILL.md:skill', commandId,
    ]));
    assert.match(blocks.selected, /REVIEW-BODY/);
    assert.deepEqual(blocks.selectionResult.diagnostics.map((item) => item.code).sort(), ['kind_not_activatable', 'unknown_id']);
    // The catalog still lists skills only; commands keep being listed by the picker API, not activated here.
    assert.doesNotMatch(blocks.selected, /deploy/);
  } finally {
    ws.cleanup();
  }
});

test('explicit IDs flow through the real send path (applyHarnessOutboundPrompt) and the assembler', () => {
  const ws = makeWorkspace({ review: skill('review', 'REVIEW-BODY') });
  try {
    const id = ws.idOf('review');
    const common = { cwd: ws.root, skillOptions: ws.options, chatId: '', mode: 'agent', transport: 'codex' };
    const sent = applyHarnessOutboundPrompt('Implement it.', { ...common, selection: selectionFromSkillIds([id]) });
    assert.match(sent, /\[SKILL: review\]/);
    const none = applyHarnessOutboundPrompt('Implement it. @review', { ...common, selection: null });
    assert.doesNotMatch(none, /\[SKILL: review\]/);
    const result = assemble({
      cwd: ws.root, projectRoot: ws.root, homeDir: ws.options.homeDir, bundledRoot: ws.options.bundledRoot,
      additionalDirs: [], prompt: 'Use the review skill', transport: 'codex', mode: 'agent',
      selection: selectionFromSkillIds([id]),
    }, CONTEXT_ADAPTERS.harness);
    assert.deepEqual(result.manifest.selection.selectedIds, [id]);
    assert.equal(result.manifest.selection.parseMentions, false);
    // The legacy rule would also have picked it from this prompt, so nothing differs.
    assert.deepEqual(result.manifest.selection.differencesFromLegacy, []);
    const other = assemble({
      cwd: ws.root, projectRoot: ws.root, homeDir: ws.options.homeDir, bundledRoot: ws.options.bundledRoot,
      additionalDirs: [], prompt: 'Use the review skill', transport: 'codex', mode: 'agent', selection: MENTIONS,
    }, CONTEXT_ADAPTERS.harness);
    assert.deepEqual(other.manifest.selection.selectedNames, []);
    assert.deepEqual(other.manifest.selection.differencesFromLegacy.map((row) => row.name), ['review']);
    assert.match(result.payload, /REVIEW-BODY/);
  } finally {
    ws.cleanup();
  }
});

test('a name present in several sources is ambiguous: @name does not guess, an ID picks one', () => {
  const ws = makeWorkspace({ dup: skill('dup', 'DUP-A') });
  const second = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-skill-sel-shared-'));
  try {
    fs.mkdirSync(path.join(second, '.agents', 'skills', 'dup'), { recursive: true });
    fs.writeFileSync(path.join(second, '.agents', 'skills', 'dup', 'SKILL.md'), skill('dup', 'DUP-B'));
    const registry = buildContextRegistry(ws.root, { audience: 'host', additionalDirs: [second], bundledRoot: ws.options.bundledRoot, homeDir: ws.options.homeDir });
    const shared = registry.entries.find((entry) => entry.scope === 'shared' && entry.callName === 'dup');
    const ctx = { cwd: ws.root, projectRoot: ws.root, homeDir: ws.options.homeDir, bundledRoot: ws.options.bundledRoot, additionalDirs: [second], prompt: '@dup', transport: 'codex', mode: 'agent' };
    // Project entry shadows the shared one for the name table.
    const byName = assemble({ ...ctx, selection: MENTIONS }, CONTEXT_ADAPTERS.harness);
    assert.match(byName.payload, /DUP-A/);
    assert.doesNotMatch(byName.payload, /DUP-B/);
    // An explicit ID bypasses the table and the same-name mention adds nothing.
    const byId = assemble({ ...ctx, selection: { skillIds: [shared.id], parseMentions: true } }, CONTEXT_ADAPTERS.harness);
    assert.match(byId.payload, /DUP-B/);
    assert.doesNotMatch(byId.payload, /DUP-A/);
  } finally {
    ws.cleanup();
    fs.rmSync(second, { recursive: true, force: true });
  }
});

test('queue/watcher transports carry the IDs: kernel accept and SDK accept pass the selection', () => {
  const seen = [];
  const room = {
    busy: false,
    chatId: 'c1',
    currentRun: { id: 'run' },
    startPrompt: (...args) => { seen.push(args); },
  };
  acceptRoomPrompt(room, { prompt: 'p', mode: 'agent', displayText: 'd', selectedSkillIds: ['s1', 's1'], recoveryRecord: null, requestId: '' });
  assert.deepEqual(seen[0].slice(0, 4), ['p', 'agent', false, 'd']);
  assert.deepEqual(seen[0][4], { skillIds: ['s1'], parseMentions: false });

  const sdkSeen = [];
  const sdkRoom = { startPrompt: (...args) => { sdkSeen.push(args); return Promise.resolve(); } };
  return acceptSdkRoomPrompt(sdkRoom, { prompt: 'p', mode: 'agent', displayText: 'd', selectedSkillIds: ['s2'] }).then(() => {
    assert.deepEqual(sdkSeen[0][6], { skillIds: ['s2'], parseMentions: false });
    assert.equal(sdkSeen[0][4], 'd');
  });
});

test('Codex steer with a skill selection returns to a follow-up without a raw RPC steer', async () => {
  const queued = [];
  const acks = [];
  const recorded = [];
  let rpcSteers = 0;
  const room = { busy: true, currentRun: { id: 'run' }, _appServer: { turnId: 't', steer: async () => { rpcSteers += 1; return { turnId: 't' }; } } };
  const steering = createCodexSteering({
    room,
    enqueue: (...args) => queued.push(args),
    delivered() {},
    broadcast: (ack) => acks.push(ack),
    recordSteer: (entry) => recorded.push(entry),
  });
  await steering.steer('use @review please', 'agent', 'shown', { skillIds: [], parseMentions: true });
  assert.equal(rpcSteers, 0);
  assert.equal(queued.length, 1);
  assert.equal(queued[0][0], 'use @review please');
  assert.equal(queued[0][2], 'shown');
  assert.deepEqual(queued[0][3], { skillIds: [], parseMentions: true });
  assert.equal(acks[0].outcome, 'revert_to_followup');
  assert.deepEqual(recorded, [{ status: 'reverted_to_followup', text: 'use @review please' }]);

  // A plain steer is still delivered natively and recorded as a steer.
  await steering.steer('plain follow', 'agent', '', { skillIds: [], parseMentions: true });
  assert.equal(rpcSteers, 1);
  assert.equal(queued.length, 1);
  assert.equal(recorded[1].status, 'delivered');
  assert.equal(acks[1].outcome, 'complete_delivered');
});

test('a plain steer is stored as a separate kind=steer manifest and stays off the send panel', () => {
  const chatId = 'chat-steer-1';
  const manifest = recordSteerManifest({ chatId, transport: 'sdk', text: 'secret steer text', status: 'delivered' });
  assert.equal(manifest.kind, 'steer');
  assert.equal(manifest.redelivery, 'not_claimed');
  assert.equal(manifest.textLength, 'secret steer text'.length);
  const stored = listContextSendManifests(chatId);
  assert.equal(stored.length, 1);
  assert.equal(JSON.stringify(stored).includes('secret steer text'), false);
  assert.equal(stored[0].entries, undefined);

  saveChats([{ id: chatId, cursorSessionId: 's-steer', agentTransport: 'sdk', workspaceFolder: os.tmpdir() }]);
  let handler;
  registerChatContextRoutes({ get: (route, fn) => { if (route === '/api/chat-context/snapshot') handler = fn; } }, { getCurrentCwd: () => os.tmpdir() });
  let body;
  const res = { json: (value) => { body = value; return res; }, status: () => res };
  handler({ query: { chatId }, headers: {}, get: () => '' }, res);
  if (body?.ok) {
    assert.equal(body.latest, null);
    assert.equal(body.history[0].kind, 'steer');
    assert.equal(body.history[0].deliveryStatus, 'delivered');
  }
});

test('OpenRouter busy queues payload and selection instead of dropping it', async () => {
  process.env.OPENROUTER_API_KEY = 'sk-or-v1-test-key-0123456789';
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-or-queue-'));
  const sessionKey = 'or-session-1';
  saveChats([{ id: 'or-chat-1', cursorSessionId: sessionKey, agentTransport: 'openrouter', workspaceFolder: folder, title: 't' }]);
  const deps = { workspaceDirForAgent: () => folder };
  const ensured = await ensureOpenRouterRoom(sessionKey, deps);
  assert.ok(!('error' in ensured), JSON.stringify(ensured));
  const { room } = ensured;
  room.busy = true;
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.sent = [];
  ws.send = (data) => ws.sent.push(JSON.parse(data));
  ws.close = () => {};
  await handleOpenRouterAgentWebSocket(ws, sessionKey, deps);
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'send', text: 'second prompt', selectedSkillIds: ['skill-id-1'] })));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(room.pendingPrompts.length, 1);
  assert.equal(room.pendingPrompts[0].text, 'second prompt');
  assert.deepEqual(room.pendingPrompts[0].selection.skillIds, ['skill-id-1']);
  assert.ok(ws.sent.some((payload) => payload.type === 'sdkQueued' && payload.text === 'second prompt'));
  // The queue controls work for it too (queueRemove drops exactly that item).
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'queueRemove', text: 'second prompt' })));
  assert.equal(room.pendingPrompts.length, 0);
  room.busy = false;
  disposeOpenRouterRoom(sessionKey);
  delete process.env.OPENROUTER_API_KEY;
});

test('Claude steer with a skill selection goes straight to the follow-up queue with its selection', async () => {
  const { createClaudePromptRunner } = await import('../lib/claude/claude-agent-ws.ts');
  const broadcasts = [];
  const pushed = [];
  const room = {
    chatId: 'claude-steer-chat',
    busy: true,
    sdkMode: 'agent',
    currentRun: { id: 'run-1' },
    pendingPrompts: [],
    cancelled: false,
  };
  const runner = createClaudePromptRunner({
    room,
    hooks: { broadcast: (payload) => broadcasts.push(payload), sendRoomState() {}, persistRoomEvent() {}, flushPersist() {} },
  });
  const result = runner.steerPrompt('please @review this', 'agent', '', { skillIds: [], parseMentions: true });
  assert.equal(result, 'queued');
  assert.equal(pushed.length, 0);
  assert.equal(room.pendingPrompts.length, 1);
  assert.equal(room.pendingPrompts[0].text, 'please @review this');
  assert.deepEqual(room.pendingPrompts[0].selection, { skillIds: [], parseMentions: true });
  const ack = broadcasts.find((payload) => payload.type === 'sdkSteerAck');
  assert.equal(ack?.outcome, 'revert_to_followup');
  // A plain steer without a live session is also queued (not lost) and carries no selection.
  const plain = runner.steerPrompt('just continue', 'agent', '', { skillIds: [], parseMentions: true });
  assert.equal(plain, 'queued');
  assert.equal(room.pendingPrompts[1].text, 'just continue');
  assert.equal(room.pendingPrompts[1].selection?.skillIds.length ?? 0, 0);
  const kinds = listContextSendManifests('claude-steer-chat').map((row) => `${row.kind}:${row.delivery.status}`);
  assert.deepEqual(kinds, ['steer:reverted_to_followup', 'steer:reverted_to_followup']);
});

// ---- startPrompt argument layouts (acceptRoomPrompt must not guess the selection index) ----

test('acceptRoomPrompt: selection reaches each runner signature without corrupting other params', async () => {
  const { acceptRoomPrompt } = await import('../lib/chat-run/kernel-adapter.ts');
  const {
    STANDARD_START_PROMPT_ARGS, CLAUDE_START_PROMPT_ARGS, SDK_START_PROMPT_ARGS,
  } = await import('../lib/chat-run/start-prompt-args.ts');
  const make = (layout, runner) => ({
    chatId: 'c', cwd: '/tmp', transport: 'x', busy: false, serverHold: false,
    ...(layout ? { startPromptArgs: layout } : {}),
    startPrompt: runner,
  });
  const ids = ['skill-a'];
  const seen = {};
  const claude = make(CLAUDE_START_PROMPT_ARGS, (text, mode, fromQueue = false, displayText = '', alreadyPersisted = false, selection = null) => {
    Object.assign(seen, { claude: { fromQueue, displayText, alreadyPersisted, selection } });
  });
  const sdk = make(SDK_START_PROMPT_ARGS, (text, mode, fromQueue = false, clientSentAt = null, displayText = '', onAccepted, selection = null) => {
    Object.assign(seen, { sdk: { fromQueue, clientSentAt, displayText, onAccepted, selection } });
  });
  const std = make(null, (text, mode, fromQueue = false, displayText = '', selection = null) => {
    Object.assign(seen, { std: { fromQueue, displayText, selection } });
  });
  assert.equal(STANDARD_START_PROMPT_ARGS({ text: 't', mode: 'agent', selection: 1 }).length, 5);
  for (const room of [claude, sdk, std]) {
    acceptRoomPrompt(room, { prompt: 'p', mode: 'agent', displayText: 'shown', selectedSkillIds: ids, requestId: 'r', recoveryRecord: null });
  }
  assert.deepEqual(seen.claude.selection.skillIds, ids);
  assert.equal(seen.claude.alreadyPersisted, false);
  assert.equal(seen.claude.displayText, 'shown');
  assert.deepEqual(seen.sdk.selection.skillIds, ids);
  assert.equal(seen.sdk.clientSentAt, null);
  assert.equal(seen.sdk.onAccepted, undefined);
  assert.equal(seen.sdk.displayText, 'shown');
  assert.deepEqual(seen.std.selection.skillIds, ids);
  assert.equal(seen.std.displayText, 'shown');
});

test('every harness declares a startPrompt layout that matches its runPrompt signature', async () => {
  const fs = await import('node:fs');
  const { buildStartPromptArgs } = await import('../lib/chat-run/start-prompt-args.ts');
  const {
    CLAUDE_START_PROMPT_ARGS, SDK_START_PROMPT_ARGS,
  } = await import('../lib/chat-run/start-prompt-args.ts');
  const files = {
    'lib/claude/claude-agent-ws.ts': CLAUDE_START_PROMPT_ARGS,
    'lib/sdk/cursor-agent-sdk-ws.ts': SDK_START_PROMPT_ARGS,
    'lib/codex/codex-agent-ws.ts': null,
    'harnesses/opencode/opencode-agent-ws.js': null,
    'harnesses/qwen/qwen-agent-ws.js': null,
    'harnesses/deepseek/deepseek-agent-ws.js': null,
    'harnesses/codebuddy/codebuddy-agent-ws.js': null,
  };
  for (const [file, layout] of Object.entries(files)) {
    const src = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    // Lazy match up to the `{` that opens the body: TypeScript signatures carry
    // a return type and callback parameter types that contain `)`.
    const match = src.match(/async function runPrompt\(([\s\S]*?)\)\s*(?::\s*Promise<[^>]*>\s*)?\{/);
    assert.ok(match, `${file}: runPrompt signature`);
    const params = match[1]
      .replace(/\([^)]*\)\s*=>\s*\w+/g, 'fn')
      .split(',')
      .map((p) => p.trim().split('=')[0].split(':')[0].replace('?', '').trim())
      .filter(Boolean);
    const sentinel = { sentinel: true };
    const args = buildStartPromptArgs(layout ? { startPromptArgs: layout } : {}, {
      text: 't', mode: 'agent', displayText: 'd', selection: sentinel,
    });
    assert.equal(args[params.indexOf('selection')], sentinel, `${file}: selection index`);
    assert.equal(args[params.indexOf('fromQueue')], false, `${file}: fromQueue`);
    assert.equal(args[params.indexOf('displayText')], 'd', `${file}: displayText`);
    if (params.includes('alreadyPersisted')) assert.equal(args[params.indexOf('alreadyPersisted')], false);
    if (layout) assert.ok(src.includes('room.startPromptArgs ='), `${file}: declares layout`);
  }
});
