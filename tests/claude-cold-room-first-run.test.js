/**
 * Regression: the first Claude chat run right after a server restart was
 * accepted (`startChatRun` accepted=true) but left only the user message in the
 * history and `busy=false`. An accepted run must either execute the turn or
 * surface an error event; "accepted + idle + no event" is not allowed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-claude-cold-room-'));
process.env.CRETLI_DATA_DIR = tempDir;
delete process.env.CRETLI_CLAUDE_STREAMING_SESSION;

const { createClaudePromptRunner } = await import('../lib/claude/claude-agent-ws.ts');
const { acceptRoomPrompt } = await import('../lib/chat-run/kernel-adapter.ts');

const SESSION_ID = 'a1b2c3d4-0000-4000-8000-000000000001';

/**
 * Fake `sdk.query()` for a resumed (cold) session. `staleResultFirst` makes the
 * CLI replay a `result` of the pre-restart interrupted turn before it answers.
 */
function createColdSdk({ staleResultFirst = false } = {}) {
  const calls = [];
  const result = () => ({
    type: 'result', subtype: 'success', is_error: false, result: 'ok',
    session_id: SESSION_ID, duration_ms: 1, total_cost_usd: 0,
  });
  function query({ prompt, options }) {
    const call = { options, messages: [] };
    calls.push(call);
    const queue = [];
    const waiters = [];
    let closed = false;
    const push = (value) => {
      const waiter = waiters.shift();
      if (waiter) waiter({ value, done: false });
      else queue.push(value);
    };
    (async () => {
      for await (const message of prompt) {
        call.messages.push(message);
        if (staleResultFirst) {
          push(result());
          // The real answer lands after the turn already settled.
          setTimeout(() => {
            push({ type: 'assistant', session_id: SESSION_ID, message: { role: 'assistant', content: [{ type: 'text', text: 'late' }] } });
            push(result());
          }, 20);
        } else {
          push({ type: 'assistant', session_id: SESSION_ID, message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } });
          push(result());
        }
      }
    })().catch(() => {});
    const iterator = {
      next() {
        if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
        if (closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => waiters.push(resolve));
      },
      return() {
        closed = true;
        while (waiters.length) waiters.shift()({ value: undefined, done: true });
        return Promise.resolve({ value: undefined, done: true });
      },
      [Symbol.asyncIterator]() { return this; },
    };
    return Object.assign(iterator, {
      async interrupt() {},
      async setModel() {},
      async setPermissionMode() {},
      async setMcpServers() { return { added: [], removed: [], errors: [] }; },
      async supportedModels() { return []; },
      close() { closed = true; while (waiters.length) waiters.shift()({ value: undefined, done: true }); },
    });
  }
  return { sdk: { query }, calls };
}

function coldRoom() {
  return {
    sessionKey: 'cold-room',
    chatId: 'chat-cold',
    cwd: tempDir,
    sdkMode: 'agent',
    modelId: 'claude-model-a',
    // Persisted session id from before the restart: the first run resumes it.
    claudeSessionId: SESSION_ID,
    pendingPrompts: [],
    delegationAssignment: '',
    clients: new Set(),
  };
}

function bind(room, sdk) {
  const events = [];
  const runner = createClaudePromptRunner({
    room,
    hooks: {
      broadcast: (payload) => { events.push(payload); },
      sendRoomState: () => {},
      persistRoomEvent: () => {},
      flushPersist: () => {},
      loadSdk: async () => sdk,
      buildEnv: () => ({ ANTHROPIC_API_KEY: 'test-key', CLAUDE_CONFIG_DIR: tempDir }),
      getAuthMode: () => 'api-key',
      prepareMcp: () => ({ mcpContext: {}, mcpPrep: { revision: 1, servers: [] }, claudeMcp: {} }),
      markMcpApplied: () => {},
      resolveModel: (model) => model,
      persistModel: () => {},
      streamingEnabled: () => true,
      sessionIdleMs: () => 60_000,
    },
  });
  room.startPrompt = runner.startPrompt;
  room.startPromptArgs = ['text', 'mode', 'fromQueue', 'displayText', 'alreadyPersisted', 'selection'];
  return { events };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Invariant: an accepted run that went idle left an answer or an error event. */
function assertTraceInHistory(events) {
  const answered = events.some((e) => e.type === 'sdkEvent' && e.event?.kind !== 'user' && e.event?.type !== 'user');
  const errored = events.some((e) => e.type === 'sdkError');
  assert.ok(answered || errored, 'accepted run must produce an answer event or an error event');
}

try {
  // 1. Cold room, resumed session: the accepted run executes the turn.
  {
    const room = coldRoom();
    const fake = createColdSdk();
    const { events } = bind(room, fake.sdk);
    const accepted = acceptRoomPrompt(room, { prompt: 'first after boot', requestId: 'req-cold-1', recoveryRecord: null });
    assert.equal(accepted.accepted, true);
    assert.ok(accepted.runId, 'accept returns the executor run id');
    await waitFor(() => events.some((e) => e.type === 'sdkRunFinished'));
    assert.equal(room.busy, false);
    assert.equal(fake.calls[0].options.resume, SESSION_ID, 'cold room resumes the saved session');
    assert.equal(fake.calls[0].messages.length, 1);
    assert.equal(events.some((e) => e.type === 'sdkError'), false);
    assertTraceInHistory(events);
  }

  // 2. Resumed CLI settles the turn with a stale result before any answer:
  //    the run must not end silently (accepted + busy=false + no event).
  {
    const room = coldRoom();
    const fake = createColdSdk({ staleResultFirst: true });
    const { events } = bind(room, fake.sdk);
    const accepted = acceptRoomPrompt(room, { prompt: 'first after boot', requestId: 'req-cold-2', recoveryRecord: null });
    assert.equal(accepted.accepted, true);
    await waitFor(() => events.some((e) => e.type === 'sdkRunFinished'));
    assert.equal(room.busy, false);
    const empty = events.find((e) => e.type === 'sdkError' && e.code === 'claude_empty_turn');
    assert.ok(empty, 'silent turn surfaces a claude_empty_turn error event');
    assertTraceInHistory(events);
  }
  console.log('claude-cold-room-first-run: ok');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
