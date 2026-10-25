import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import {
  DEFAULT_SOFT_BUDGET_TOKENS,
  buildContextBudget,
  buildProviderWindowError,
  buildTruncationMarker,
  isProviderWindowError,
} from '../lib/context/context-budget.ts';
import {
  INSTRUCTION_EPOCH_REASON,
  bumpInstructionEpoch,
  noteNativeSession,
  readInstructionEpoch,
  resolveInstructionDelivery,
} from '../lib/context/instruction-epoch.ts';
import { patchHostContextSettings } from '../lib/context/context-settings-runtime.ts';
import { assemble, CONTEXT_ADAPTERS } from '../lib/context/context-assembler.ts';
import { buildContextSnapshot } from '../lib/context/context-send-manifest.ts';
import { decorateHarnessPrompt } from '../lib/sdk/harness-plan-prompt.ts';
import { resetPromptDecorationStatesForTests } from '../lib/sdk/prompt-decoration.ts';
import { advanceRoomContextEpoch, recordContextRestart, resetContextRestartsForTests } from '../lib/usage/context-restarts.ts';
import { clearClaudeRoomSession } from '../lib/claude/claude-agent-ws.ts';
import { saveChats } from '../lib/persist/chats-persist.js';
import { appendChatHistoryEvents } from '../lib/persist/chat-history-service.js';
import { disposeOpenRouterRoom, ensureOpenRouterRoom } from '../harnesses/openrouter/openrouter-agent-ws.js';
import { runOpenRouterAgentLoop } from '../harnesses/openrouter/openrouter-agent-loop.js';
import { buildDelegationParentReportContext } from '../lib/delegation-prompt.js';
import { HARNESS_HANDOFF_MAX_CHARS, buildHarnessHandoffPrompt } from '../lib/conversation-fork.js';

test.after(() => removeIsolatedDataDir());

const RULES_MARKER = '[WORKSPACE CURSOR RULES]';

/** Temp workspace with one alwaysApply rule so the static block is non-empty. */
function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-epoch-'));
  fs.mkdirSync(path.join(root, '.cursor', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(root, '.cursor', 'rules', 'always.mdc'), '---\nalwaysApply: true\n---\nEpoch test rule body.\n');
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function newRoom(root, id, transport = 'claude') {
  return { chatId: id, sessionKey: `${id}-session`, cwd: root, sdkMode: 'agent', transport };
}

// ── Soft budget ────────────────────────────────────────────────────────────

test('budget: estimated tokens are labelled, separate from usage/cache/cost, and nothing is trimmed', () => {
  const big = 'x'.repeat(4 * 20000);
  const budget = buildContextBudget({
    message: 'do it',
    blocks: [
      { id: 'workspace_rules', text: big },
      { id: 'skills_catalog', text: 'y'.repeat(4000) },
    ],
    softLimitTokens: 1000,
  });
  assert.equal(budget.status, 'over_soft_limit');
  assert.equal(budget.estimate.kind, 'estimated');
  assert.deepEqual(budget.separateFrom, ['usage', 'cache', 'cost']);
  assert.deepEqual(budget.trimmed, []);
  assert.equal(budget.blocks.find((row) => row.id === 'workspace_rules').requirement, 'required');
  assert.equal(budget.blocks.find((row) => row.id === 'skills_catalog').requirement, 'optional');
  assert.ok(budget.warnings.some((w) => w.code === 'soft_budget_exceeded'));
  // Optional material alone cannot fix it: the budget says so instead of cutting required blocks.
  assert.ok(budget.warnings.some((w) => w.code === 'required_exceeds_soft_budget'));
  assert.equal(budget.suggestions[0].id, 'skills_catalog');
  assert.equal(budget.totals.requiredTokens + budget.totals.optionalTokens, budget.totals.estimatedTokens);
});

test('budget: within the limit is ok, mode off is off, default limit applies', () => {
  assert.equal(buildContextBudget({ message: 'hi' }).status, 'ok');
  assert.equal(buildContextBudget({ message: 'hi' }).softLimitTokens, DEFAULT_SOFT_BUDGET_TOKENS);
  assert.equal(buildContextBudget({ message: 'x'.repeat(10 ** 6), mode: 'off' }).status, 'off');
});

test('budget: the seed and the current plan are required, never optional', () => {
  const budget = buildContextBudget({
    message: 'continue',
    blocks: [{ id: 'chatPlan', text: 'PLAN' }, { id: 'seed', text: 'SEED' }, { id: 'pageContext', text: 'PAGE' }],
  });
  const req = (id) => budget.blocks.find((row) => row.id === id).requirement;
  assert.equal(req('chatPlan'), 'required');
  assert.equal(req('seed'), 'required');
  assert.equal(req('pageContext'), 'optional');
});

test('budget: the assembler and the snapshot carry it without changing the payload', () => {
  const ws = makeWorkspace();
  try {
    const context = {
      cwd: ws.root, projectRoot: ws.root, homeDir: ws.root, bundledRoot: ws.root, additionalDirs: [],
      prompt: 'hello', mode: 'agent', transport: 'claude',
    };
    const plain = assemble(context, CONTEXT_ADAPTERS.harness);
    const tight = assemble({ ...context, softBudgetTokens: 5 }, CONTEXT_ADAPTERS.harness);
    assert.equal(tight.budget.status, 'over_soft_limit');
    assert.equal(plain.budget.status, 'ok');
    // Over the soft limit changes nothing about what is sent.
    assert.equal(tight.payload, plain.payload);
    const snapshot = buildContextSnapshot({ ...context, staticDelivery: { staticMode: 'always', reason: 'dedupe_off_by_setting', epoch: 3 } }, 'harness');
    assert.equal(snapshot.budget.estimate.kind, 'estimated');
    assert.equal(snapshot.staticDelivery.mode, 'always');
    assert.equal(snapshot.staticDelivery.instructionEpoch, 3);
    // The manifest records what Cretli did, not what the harness remembers.
    assert.equal(snapshot.staticDelivery.memoryKnowledge, 'not_claimed');
  } finally {
    ws.cleanup();
  }
});

// ── Legacy limits and bounded material keep a marker + reference ──────────

test('marker: a truncated delegation report carries sizes and a reference to the full report', () => {
  const text = buildDelegationParentReportContext({ id: 'del-1', status: 'completed', report: 'r'.repeat(9000) });
  assert.match(text, /\[truncated: first 8000 of 9000 chars; full content: delegation_show del-1\]/);
});

test('marker: a clipped handoff transcript says what was dropped and where the full one is', () => {
  const prompt = buildHarnessHandoffPrompt({
    sourceText: `HEAD${'x'.repeat(HARNESS_HANDOFF_MAX_CHARS)}TAIL`, fromHarness: 'sdk', toHarness: 'qwen',
  });
  assert.match(prompt, /Earlier conversation truncated/);
  assert.match(prompt, /last 24000 of 24008 chars; full content: chat_history of the source chat/);
});

test('marker: no reference is invented when none exists', () => {
  assert.match(buildTruncationMarker({ kept: 5, total: 9 }), /full content not retained here/);
});

// ── Hard provider window error ────────────────────────────────────────────

test('window error: explicit sizes, ways forward, never an automatic retry', () => {
  const budget = buildContextBudget({
    message: 'm'.repeat(400),
    blocks: [{ id: 'workspace_rules', text: 'r'.repeat(4000) }, { id: 'skills_catalog', text: 'c'.repeat(800) }],
  });
  const error = buildProviderWindowError({ transport: 'claude', providerMessage: 'prompt is too long: 250000 tokens', budget });
  assert.equal(error.code, 'context_window_exceeded');
  assert.equal(error.autoRetry, false);
  assert.equal(error.sizes.estimated, true);
  assert.equal(error.sizes.cretliChars, 5200);
  assert.equal(error.sizes.blocks.length, 3);
  assert.deepEqual(error.options, ['change_context_set', 'start_new_session', 'compress_history']);
  assert.match(error.message, /did not shorten any instructions and did not resend/);
  assert.match(error.message, /5200 chars/);
  // Without a measurement it says so instead of inventing sizes.
  assert.match(buildProviderWindowError({}).message, /could not measure/);
  assert.equal(buildProviderWindowError({}).sizes, null);
});

test('window error: detection matches provider wording and ignores other errors', () => {
  for (const text of ['Prompt is too long', 'maximum context length is 200000 tokens', 'context_length_exceeded', 'exceeds the model context window']) {
    assert.equal(isProviderWindowError(text), true, text);
  }
  for (const text of ['rate limit', 'network down', '']) assert.equal(isProviderWindowError(text), false, text);
});

// ── Epoch and delivery ────────────────────────────────────────────────────

test('epoch: every invalidating reason advances it and drops the remembered decoration state', () => {
  for (const reason of Object.values(INSTRUCTION_EPOCH_REASON)) {
    const room = { _promptDecorationState: { staticHash: 'abc' } };
    const before = readInstructionEpoch(room).epoch;
    assert.equal(bumpInstructionEpoch(room, reason), before + 1, reason);
    assert.equal(room._promptDecorationState, null, reason);
    assert.equal(readInstructionEpoch(room).reason, reason);
  }
  assert.equal(readInstructionEpoch({}).epoch, 0);
  assert.equal(bumpInstructionEpoch(null, 'reset'), null);
});

test('epoch: a changed native session id is a new session, the first one is only recorded', () => {
  const room = {};
  assert.deepEqual(noteNativeSession(room, { nativeSessionId: 'a' }), { bumped: false, epoch: 0 });
  assert.deepEqual(noteNativeSession(room, { nativeSessionId: 'a' }), { bumped: false, epoch: 0 });
  assert.equal(noteNativeSession(room, { nativeSessionId: 'b' }).bumped, true);
  assert.equal(readInstructionEpoch(room).reason, INSTRUCTION_EPOCH_REASON.NEW_SESSION);
  assert.equal(noteNativeSession(room, { nativeSessionId: 'c', resumeRequested: true }).bumped, true);
  assert.equal(readInstructionEpoch(room).reason, INSTRUCTION_EPOCH_REASON.RESUME_FAILED);
  assert.equal(noteNativeSession(room, { nativeSessionId: '' }).bumped, false);
});

test('delivery: dedupe needs the opt-in setting, a retention proof and a native session identity', () => {
  const room = { _instructionEpoch: { epoch: 1, nativeSessionId: 'n1', log: [] } };
  assert.equal(resolveInstructionDelivery({ transport: 'claude', dedupeSetting: 'off', room }).reason, 'dedupe_off_by_setting');
  assert.equal(resolveInstructionDelivery({ transport: 'claude', room }).staticMode, 'always');
  assert.equal(resolveInstructionDelivery({ transport: 'codex', dedupeSetting: 'proven_adapters', room }).reason, 'no_retention_proof');
  assert.equal(resolveInstructionDelivery({ transport: 'openrouter', dedupeSetting: 'proven_adapters', room }).staticMode, 'always');
  assert.equal(resolveInstructionDelivery({ transport: 'claude', dedupeSetting: 'proven_adapters', room: {} }).reason, 'no_native_session_identity');
  const ok = resolveInstructionDelivery({ transport: 'claude', dedupeSetting: 'proven_adapters', room });
  assert.equal(ok.staticMode, 'dedupe');
  assert.equal(ok.epoch, 1);
});

// ── Session boundaries through the real send path ─────────────────────────

test('boundaries: default delivery repeats the static block and the plan block every turn', () => {
  const ws = makeWorkspace();
  resetContextRestartsForTests();
  resetPromptDecorationStatesForTests();
  try {
    for (const transport of ['claude', 'codex', 'qwen', 'openrouter']) {
      const room = newRoom(ws.root, `chat-default-${transport}`, transport);
      for (const turn of ['one', 'two', 'three']) {
        assert.ok(decorateHarnessPrompt(room, turn, transport).includes(RULES_MARKER), `${transport}/${turn}`);
      }
    }
  } finally {
    ws.cleanup();
  }
});

test('boundaries: with the opt-in, claude dedupes — and every session boundary brings the block back', () => {
  const ws = makeWorkspace();
  resetContextRestartsForTests();
  resetPromptDecorationStatesForTests();
  assert.deepEqual(patchHostContextSettings({ settings: { instructions: { dedupe: 'proven_adapters' } } }), { ok: true });
  try {
    const has = (text) => text.includes(RULES_MARKER);
    const fresh = (id) => {
      const room = newRoom(ws.root, id);
      noteNativeSession(room, { nativeSessionId: `${id}-native` });
      return room;
    };
    const settle = (room) => {
      assert.equal(has(decorateHarnessPrompt(room, 'a', 'claude')), true, 'first turn delivers');
      assert.equal(has(decorateHarnessPrompt(room, 'b', 'claude')), false, 'proven + opted in: deduped');
    };

    // Failed resume (real helper used by the Claude adapter).
    let room = fresh('chat-resume-failed');
    settle(room);
    clearClaudeRoomSession(room);
    assert.equal(has(decorateHarnessPrompt(room, 'c', 'claude')), true, 'failed resume');

    // New native session id.
    room = fresh('chat-new-session');
    settle(room);
    noteNativeSession(room, { nativeSessionId: 'another-native-id' });
    assert.equal(has(decorateHarnessPrompt(room, 'c', 'claude')), true, 'new session');

    // compact_boundary and codex-style compaction, through the shared epoch hook.
    room = fresh('chat-compact');
    settle(room);
    advanceRoomContextEpoch(room, 'compact_boundary');
    assert.equal(readInstructionEpoch(room).reason, INSTRUCTION_EPOCH_REASON.COMPACT_BOUNDARY);
    assert.equal(has(decorateHarnessPrompt(room, 'c', 'claude')), true, 'compact_boundary');
    assert.equal(has(decorateHarnessPrompt(room, 'c2', 'claude')), false, 'deduped again after delivery in the new epoch');
    advanceRoomContextEpoch(room, 'compaction');
    assert.equal(has(decorateHarnessPrompt(room, 'd', 'claude')), true, 'compaction');

    // Model / mode change, reset, seed, trim.
    for (const reason of [
      INSTRUCTION_EPOCH_REASON.MODEL_CHANGE, INSTRUCTION_EPOCH_REASON.MODE_CHANGE,
      INSTRUCTION_EPOCH_REASON.RESET, INSTRUCTION_EPOCH_REASON.SEED, INSTRUCTION_EPOCH_REASON.HISTORY_TRIM,
    ]) {
      room = fresh(`chat-${reason}`);
      settle(room);
      bumpInstructionEpoch(room, reason);
      assert.equal(has(decorateHarnessPrompt(room, 'c', 'claude')), true, reason);
    }

    // Restart: the in-memory decoration state is gone, so the block is delivered again.
    room = fresh('chat-restart');
    settle(room);
    room._promptDecorationState = null;
    assert.equal(has(decorateHarnessPrompt(room, 'c', 'claude')), true, 'restart');

    // Reset creates a new room (new session key, no state).
    room = fresh('chat-reset');
    settle(room);
    const rebuilt = newRoom(ws.root, 'chat-reset');
    rebuilt.sessionKey = 'chat-reset-session-rotated';
    assert.equal(has(decorateHarnessPrompt(rebuilt, 'c', 'claude')), true, 'reset/rotated room');

    // A recorded restart (model/mode/MCP rebuild) changes the session key.
    room = fresh('chat-restart-ledger');
    settle(room);
    recordContextRestart({ chatId: room.chatId, harness: 'claude', reason: 'model_change' });
    assert.equal(has(decorateHarnessPrompt(room, 'c', 'claude')), true, 'recorded restart');

    // Settled again after delivery in the new epoch (dedupe resumes, proof-bound).
    assert.equal(has(decorateHarnessPrompt(room, 'd', 'claude')), false, 'deduped again after redelivery');

    // Adapters without proof stay on fallback even with the opt-in.
    for (const transport of ['codex', 'openrouter']) {
      const other = newRoom(ws.root, `chat-noproof-${transport}`, transport);
      noteNativeSession(other, { nativeSessionId: 'x' });
      assert.equal(has(decorateHarnessPrompt(other, 'a', transport)), true);
      assert.equal(has(decorateHarnessPrompt(other, 'b', transport)), true, `${transport} never dedupes`);
    }
  } finally {
    patchHostContextSettings({ settings: { instructions: { dedupe: null } } });
    ws.cleanup();
  }
});

test('boundaries: openrouter hydrate and trim bump the epoch and the next turn carries the required blocks', async () => {
  const ws = makeWorkspace();
  resetPromptDecorationStatesForTests();
  const chatId = 'epoch-openrouter-hydrate-trim';
  const sessionKey = `${chatId}-session`;
  try {
    saveChats([{ id: chatId, cursorSessionId: sessionKey, agentTransport: 'openrouter', workspaceFolder: ws.root }]);
    await appendChatHistoryEvents(chatId, sessionKey, [{ rec: { kind: 'localUser', text: 'persisted turn' } }]);
    const ensured = await ensureOpenRouterRoom(sessionKey, { workspaceDirForAgent: () => ws.root });
    assert.ok(!('error' in ensured), JSON.stringify(ensured));
    const { room } = ensured;
    assert.equal(room.conversationMessages[0].content, 'persisted turn');
    assert.equal(readInstructionEpoch(room).reason, INSTRUCTION_EPOCH_REASON.HYDRATE);

    const messages = Array.from({ length: 100 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `m${index}` }));
    messages.push({ role: 'user', content: decorateHarnessPrompt(room, 'current turn', 'openrouter') });
    let sent = null;
    const result = await runOpenRouterAgentLoop({
      room, model: 'm', cwd: ws.root, mode: 'agent', messages,
      streamChatCompletion: async function* (request) {
        sent = request.messages;
        yield { deltaText: 'ok', finishReason: 'stop' };
      },
      callbacks: { onEvent: () => {}, onFinished: () => {} },
    });
    assert.equal(result.ok, true);
    assert.ok(sent.length <= 81);
    assert.ok(sent.some((message) => String(message.content).includes(RULES_MARKER)));
    assert.equal(readInstructionEpoch(room).reason, INSTRUCTION_EPOCH_REASON.HISTORY_TRIM);
    assert.equal(readInstructionEpoch(room).epoch, 2);
    const nextTurn = decorateHarnessPrompt(room, 'after trim', 'openrouter');
    assert.ok(nextTurn.includes(RULES_MARKER));
    let nextSent = null;
    await runOpenRouterAgentLoop({
      room, model: 'm', cwd: ws.root, mode: 'agent',
      messages: [...result.messages, { role: 'user', content: nextTurn }],
      streamChatCompletion: async function* (request) {
        nextSent = request.messages;
        yield { deltaText: 'ok', finishReason: 'stop' };
      },
      callbacks: { onEvent: () => {}, onFinished: () => {} },
    });
    assert.ok(String(nextSent.filter((message) => message.role === 'user').at(-1).content).includes(RULES_MARKER));
  } finally {
    disposeOpenRouterRoom(sessionKey);
    ws.cleanup();
  }
});
