import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const previousDataDir = process.env.CRETLI_DATA_DIR;
const previousStreaming = process.env.CRETLI_CLAUDE_STREAMING_SESSION;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-claude-streaming-'));
process.env.CRETLI_DATA_DIR = tempDir;
delete process.env.CRETLI_CLAUDE_STREAMING_SESSION;

const {
  CLAUDE_SYSTEM_PROMPT,
  appendClaudeStderrChunk,
  buildClaudeNoticePayload,
  buildClaudeQueryOptions,
  createClaudePromptRunner,
  interruptActiveQuery,
  readClaudeStderrTail,
  readLastClaudeStderrLine,
  redactClaudeStderrLine,
} = await import('../lib/claude/claude-agent-ws.js');
const {
  setClaudeSdkForTests,
  resetClaudeSdkForTests,
  loadClaudeSdk,
} = await import('../lib/claude/claude-sdk.js');
const {
  buildClaudeUserMessage,
  buildClaudeAuthSignature,
  buildClaudeTuningSignature,
  resolveClaudeRunTuning,
} = await import('../lib/claude/claude-session.js');
const {
  invalidateClaudeModelsCache,
  isClaudeSessionModelCatalogFresh,
  listClaudeModels,
} = await import('../lib/claude/claude-models.js');
const { clearMcpBridgeToolsListed, markMcpBridgeToolsListed } = await import('../lib/mcp/mcp-bridge-ready.js');
const { ORCHESTRATOR_MCP_CONTRACT_TOOLS } = await import('../lib/mcp/mcp-orchestrator-contract.js');

const SDK_SESSION_ID = 'sess-1';

/**
 * @param {unknown} message
 * @returns {string}
 */
function extractText(message) {
  const content = message?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((block) => block?.text || '').join('');
  return '';
}

/**
 * Minimal fake of `sdk.query()`: the returned Query is an async iterator, the
 * prompt is consumed (string or AsyncIterable), control methods record calls.
 *
 * @param {{
 *   autoResult?: boolean,
 *   resumeFailureOnce?: boolean,
 *   failNextTurn?: boolean,
 *   sessionId?: string,
 *   rejectSetModelOnce?: boolean,
 *   rejectSetPermissionModeOnce?: boolean,
 *   interruptSilent?: boolean,
 *   endSilently?: boolean,
 *   supportedModels?: Array<Record<string, unknown>>,
 * }} [config]
 */
function createFakeClaudeSdk(config = {}) {
  const calls = [];
  const state = {
    sessionId: config.sessionId || SDK_SESSION_ID,
    autoResult: config.autoResult !== false,
    resumeFailureOnce: config.resumeFailureOnce === true,
    failNextTurn: config.failNextTurn === true,
    rejectSetModelOnce: config.rejectSetModelOnce === true,
    rejectSetPermissionModeOnce: config.rejectSetPermissionModeOnce === true,
    interruptSilent: config.interruptSilent === true,
    endSilently: config.endSilently === true,
    supportedModels: config.supportedModels || [],
  };
  let resumeFailureEmitted = false;
  let failEmitted = false;
  let setModelRejected = false;
  let permissionRejected = false;

  function createQuery({ prompt, options }) {
    const call = {
      prompt,
      options,
      isStreaming: typeof prompt !== 'string',
      interrupts: 0,
      setModel: [],
      setPermissionMode: [],
      setMcpServers: [],
      closes: 0,
      messages: [],
      turnCount: 0,
      pendingResult: null,
      emit(value) {
        enqueue({ value });
      },
      emitError(error) {
        fail(error);
      },
      completeTurn(overrides = {}) {
        if (!call.pendingResult) return false;
        const emit = call.pendingResult;
        call.pendingResult = null;
        emit(overrides);
        return true;
      },
    };
    calls.push(call);
    // Test hook: simulate work the CLI does when its process starts (for
    // example connecting MCP servers) without touching the shared fake.
    if (typeof config.onQuery === 'function') config.onQuery({ call, prompt, options });

    /** @type {Array<{ value?: unknown, error?: Error }>} */
    const pending = [];
    /** @type {Array<(item: { value?: unknown, error?: Error }) => void>} */
    const waiters = [];
    let closed = false;

    function enqueue(item) {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter) waiter(item);
      else pending.push(item);
    }

    function fail(error) {
      enqueue({ error });
      closed = true;
    }

    function endNow() {
      closed = true;
      while (waiters.length > 0) {
        const waiter = waiters.shift();
        waiter({ value: undefined });
      }
    }

    function emitResult(overrides = {}) {
      const resumeFailure = state.resumeFailureOnce
        && !resumeFailureEmitted
        && typeof call.options?.resume === 'string'
        && call.options.resume;
      if (resumeFailure) resumeFailureEmitted = true;
      enqueue({
        value: {
          type: 'result',
          subtype: resumeFailure ? 'error_during_execution' : 'success',
          is_error: resumeFailure,
          errors: resumeFailure ? [`No conversation found with session ID: ${call.options.resume}`] : undefined,
          result: resumeFailure ? undefined : 'ok',
          session_id: state.sessionId,
          duration_ms: 1,
          total_cost_usd: 0,
          ...overrides,
        },
      });
      call.pendingResult = null;
    }

    function emitAssistantTurn(userMessage) {
      call.turnCount += 1;
      enqueue({ value: { type: 'system', subtype: 'init', session_id: state.sessionId } });
      enqueue({
        value: {
          type: 'assistant',
          session_id: state.sessionId,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: `reply:${extractText(userMessage)}` }],
          },
        },
      });
    }

    const iterator = {
      next() {
        if (pending.length > 0) {
          const item = pending.shift();
          if (item.error) return Promise.reject(item.error);
          return Promise.resolve({ value: item.value, done: false });
        }
        if (closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => {
          waiters.push((item) => {
            if (item.error) reject(item.error);
            else resolve({ value: item.value, done: false });
          });
        });
      },
      return() {
        closed = true;
        while (waiters.length > 0) {
          const waiter = waiters.shift();
          waiter({ value: undefined });
        }
        return Promise.resolve({ value: undefined, done: true });
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };

    const query = {
      async interrupt() {
        call.interrupts += 1;
        if (!state.interruptSilent) emitResult();
      },
      async setModel(model) {
        call.setModel.push(model);
        if (state.rejectSetModelOnce && !setModelRejected) {
          setModelRejected = true;
          throw new Error('setModel rejected');
        }
      },
      async setPermissionMode(mode) {
        call.setPermissionMode.push(mode);
        if (state.rejectSetPermissionModeOnce && !permissionRejected) {
          permissionRejected = true;
          throw new Error('setPermissionMode rejected');
        }
      },
      async setMcpServers(servers) {
        call.setMcpServers.push(servers);
        return { added: [], removed: [], errors: [] };
      },
      async supportedModels() {
        return state.supportedModels;
      },
      close() {
        call.closes += 1;
        closed = true;
        while (waiters.length > 0) {
          const waiter = waiters.shift();
          waiter({ value: undefined });
        }
      },
      [Symbol.asyncIterator]() {
        return iterator;
      },
    };

    async function consumePrompt() {
      if (typeof prompt === 'string') {
        call.messages.push({ type: 'user', message: { role: 'user', content: prompt } });
        emitAssistantTurn(prompt);
        if (state.autoResult) emitResult();
        else call.pendingResult = emitResult;
        // A one-shot string prompt closes its iterator after the result.
        closed = true;
        return;
      }
      try {
        for await (const userMessage of prompt) {
          call.messages.push(userMessage);
          emitAssistantTurn(userMessage);
          if (state.failNextTurn && !failEmitted) {
            failEmitted = true;
            fail(new Error('stream boom'));
            return;
          }
          if (state.endSilently) {
            endNow();
            return;
          }
          if (state.autoResult) emitResult();
          else call.pendingResult = emitResult;
        }
      } catch {
        // prompt stream failures surface through the query iterator
      }
    }
    void consumePrompt();

    return query;
  }

  return { sdk: { query: createQuery }, calls, state };
}

/**
 * @param {() => boolean} predicate
 * @param {{ timeoutMs?: number, intervalMs?: number }} [options]
 */
async function waitFor(predicate, options = {}) {
  const timeoutMs = Number(options.timeoutMs) || 1000;
  const intervalMs = Number(options.intervalMs) || 5;
  const startedAt = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * @param {{ chatId?: string }} [overrides]
 */
function createRoom(overrides = {}) {
  return {
    sessionKey: 'claude-stream-room',
    chatId: '',
    cwd: tempDir,
    sdkMode: 'agent',
    modelId: 'claude-model-a',
    claudeSessionId: '',
    pendingPrompts: [],
    delegationAssignment: '',
    clients: new Set(),
    ...overrides,
  };
}

/**
 * @param {{
 *   room: any,
 *   sdk: any,
 *   streamingEnabled?: boolean,
 *   idleMs?: number,
 *   mcpRevision?: () => number,
 *   claudeMcp?: () => Record<string, unknown>,
 * }} options
 */
function createRunner(options) {
  const events = [];
  const revision = typeof options.mcpRevision === 'function' ? options.mcpRevision : () => 1;
  const claudeMcp = typeof options.claudeMcp === 'function' ? options.claudeMcp : () => ({});
  const runner = createClaudePromptRunner({
    room: options.room,
    hooks: {
      broadcast: (payload) => {
        events.push(payload);
      },
      sendRoomState: () => {},
      persistRoomEvent: () => {},
      flushPersist: () => {},
      loadSdk: async () => options.sdk,
      buildEnv: typeof options.buildEnv === 'function'
        ? options.buildEnv
        : () => ({ ANTHROPIC_API_KEY: 'test-key', CLAUDE_CONFIG_DIR: tempDir }),
      getAuthMode: typeof options.getAuthMode === 'function' ? options.getAuthMode : () => 'api-key',
      prepareMcp: () => ({
        mcpContext: {},
        mcpPrep: { revision: revision(), servers: [] },
        claudeMcp: claudeMcp(),
      }),
      markMcpApplied: () => {},
      resolveModel: (model) => model,
      persistModel: (model) => {
        options.room.modelId = model;
      },
      streamingEnabled: () => options.streamingEnabled !== false,
      sessionIdleMs: () => options.idleMs ?? 60_000,
    },
  });
  return { runner, events };
}

/** @param {Record<string, unknown>[]} events */
function finishedEvents(events) {
  return events.filter((event) => event.type === 'sdkRunFinished');
}

/** @param {Record<string, unknown>[]} events */
function noticeEvents(events) {
  return events.filter((event) => event.type === 'sdkRunProgress' && event.noticeType);
}

try {
  // --- SDKUserMessage shape ---
  const userMessage = buildClaudeUserMessage('sess-9', 'hello');
  assert.equal(userMessage.type, 'user');
  assert.equal(userMessage.session_id, 'sess-9');
  assert.equal(userMessage.parent_tool_use_id, null);
  assert.deepEqual(userMessage.origin, { kind: 'human' });
  assert.equal(userMessage.message.role, 'user');
  assert.equal(userMessage.message.content, 'hello');
  assert.equal(buildClaudeUserMessage('', 'x').session_id, '');

  // --- explicit claude_code preset system prompt ---
  const optionsProbe = buildClaudeQueryOptions({ cwd: '/tmp', sdkMode: 'agent' }, 'agent');
  assert.deepEqual(optionsProbe.systemPrompt, { type: 'preset', preset: 'claude_code' });
  assert.equal(CLAUDE_SYSTEM_PROMPT.append, undefined);

  // --- auth signature never exposes the secret but detects rotation ---
  const signatureA = buildClaudeAuthSignature('api-key', { ANTHROPIC_API_KEY: 'sk-ant-secret-a' });
  assert.equal(signatureA.includes('sk-ant-secret-a'), false);
  const signatureARotated = buildClaudeAuthSignature('api-key', { ANTHROPIC_API_KEY: 'sk-ant-secret-b' });
  assert.notEqual(signatureA, signatureARotated);
  assert.equal(
    buildClaudeAuthSignature('api-key', { ANTHROPIC_API_KEY: 'sk-ant-secret-a' }),
    signatureA,
  );
  assert.equal(
    buildClaudeAuthSignature('api-key', {}),
    buildClaudeAuthSignature('api-key', {}),
  );
  assert.notEqual(buildClaudeAuthSignature('api-key', {}), signatureA);
  const awsSignature = buildClaudeAuthSignature('api-key', {
    CLAUDE_CODE_USE_BEDROCK: '1',
    AWS_SESSION_TOKEN: 'aws-session-secret-a',
  });
  assert.notEqual(awsSignature, buildClaudeAuthSignature('api-key', {
    CLAUDE_CODE_USE_BEDROCK: '1',
    AWS_SESSION_TOKEN: 'aws-session-secret-b',
  }));
  assert.doesNotMatch(awsSignature, /aws-session-secret-a/);
  const planSignature = buildClaudeAuthSignature('subscription', {
    CLAUDE_CODE_OAUTH_TOKEN: 'plan-token-secret-a',
  });
  assert.doesNotMatch(planSignature, /plan-token-secret-a/);
  assert.notEqual(planSignature, buildClaudeAuthSignature('subscription', {
    CLAUDE_CODE_OAUTH_TOKEN: 'plan-token-secret-b',
  }));

  // --- test seam: loadClaudeSdk returns the fake ---
  const seamFake = createFakeClaudeSdk();
  setClaudeSdkForTests(seamFake.sdk);
  assert.equal(await loadClaudeSdk(), seamFake.sdk);
  resetClaudeSdkForTests();

  // --- two prompts share one query and one session ---
  {
    const fake = createFakeClaudeSdk();
    const room = createRoom();
    const { runner, events } = createRunner({ room, sdk: fake.sdk });
    await runner.startPrompt('one');
    await runner.startPrompt('two');
    assert.equal(fake.calls.length, 1, 'one streaming query for two prompts');
    assert.equal(fake.calls[0].isStreaming, true);
    assert.equal(fake.calls[0].messages.length, 2);
    // decorateHarnessPrompt output stays in the per-turn user message.
    assert.match(String(fake.calls[0].messages[0].message.content), /one/);
    assert.match(String(fake.calls[0].messages[1].message.content), /two/);
    assert.equal(fake.calls[0].messages[0].type, 'user');
    assert.equal(fake.calls[0].messages[0].origin.kind, 'human');
    assert.equal(room._claudeSession.alive, true);
    assert.equal(room._claudeSession.turns, 2);
    const finished = finishedEvents(events);
    assert.equal(finished.length, 2);
    assert.deepEqual(finished.map((event) => event.status), ['completed', 'completed']);
    assert.equal(room.claudeSessionId, SDK_SESSION_ID);
  }

  // --- orchestrator gate runs after the Query process starts, before the prompt ---
  {
    const chatId = 'claude-gate-order';
    clearMcpBridgeToolsListed(chatId);
    const fake = createFakeClaudeSdk({
      // The fake CLI lists the bridge catalog when its process starts, which is
      // exactly what the orchestrator gate waits for.
      onQuery: () => markMcpBridgeToolsListed(chatId, {
        now: Date.now(),
        toolNames: ORCHESTRATOR_MCP_CONTRACT_TOOLS,
      }),
    });
    const room = createRoom({ chatId, watcherOrchestrator: true });
    const events = [];
    const runner = createClaudePromptRunner({
      room,
      hooks: {
        broadcast: (payload) => events.push(payload),
        sendRoomState: () => {},
        persistRoomEvent: () => {},
        flushPersist: () => {},
        loadSdk: async () => fake.sdk,
        buildEnv: () => ({ ANTHROPIC_API_KEY: 'test-key', CLAUDE_CONFIG_DIR: tempDir }),
        getAuthMode: () => 'api-key',
        // A managed bridge whose endpoint is dead: only the session's own mark
        // can release the first prompt, so this fails if the gate runs early.
        prepareMcp: () => ({
          mcpContext: { chatId },
          mcpPrep: {
            revision: 1,
            servers: [],
            bridge: { command: 'node', args: [], env: { CRETLI_URL: 'https://127.0.0.1:1', CRETLI_MCP_TOKEN: 'tok' } },
          },
          claudeMcp: {},
        }),
        markMcpApplied: () => {},
        resolveModel: (model) => model,
        persistModel: () => {},
        streamingEnabled: () => true,
        sessionIdleMs: () => 60_000,
      },
    });
    await runner.startPrompt('hello');
    assert.equal(fake.calls.length, 1);
    assert.equal(
      fake.calls[0].messages.length,
      1,
      'the first prompt is pushed only after the session bridge listed its catalog',
    );
    assert.equal(finishedEvents(events).at(-1)?.status, 'completed');
    clearMcpBridgeToolsListed(chatId);
  }

  // --- model change uses setModel, no restart ---
  {
    const fake = createFakeClaudeSdk();
    const room = createRoom();
    const { runner } = createRunner({ room, sdk: fake.sdk });
    await runner.startPrompt('one');
    room.modelId = 'claude-model-b';
    await runner.startPrompt('two');
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(fake.calls[0].setModel, ['claude-model-b']);
  }

  // --- plan -> ask stays in the read-only class: setPermissionMode, no restart ---
  {
    const fake = createFakeClaudeSdk();
    const room = createRoom({ sdkMode: 'plan' });
    const { runner } = createRunner({ room, sdk: fake.sdk });
    await runner.startPrompt('one', 'plan');
    assert.deepEqual(fake.calls[0].options.settingSources, ['project']);
    assert.deepEqual(fake.calls[0].options.disallowedTools, ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
    await runner.startPrompt('two', 'ask');
    assert.equal(fake.calls.length, 1, 'same class must not restart');
    assert.deepEqual(fake.calls[0].setPermissionMode, ['default']);
    assert.deepEqual(fake.calls[0].options.settingSources, ['project']);
  }

  // --- plan -> agent changes the mode class: restart with resume ---
  {
    const fake = createFakeClaudeSdk();
    const room = createRoom({ sdkMode: 'plan' });
    const { runner } = createRunner({ room, sdk: fake.sdk });
    await runner.startPrompt('one', 'plan');
    assert.equal(fake.calls[0].options.resume, undefined);
    await runner.startPrompt('two', 'agent');
    assert.equal(fake.calls.length, 2);
    assert.equal(fake.calls[0].closes, 1);
    assert.equal(fake.calls[1].options.resume, SDK_SESSION_ID);
    assert.equal(fake.calls[1].options.disallowedTools, undefined);
  }

  // --- cancel interrupts the turn, keeps the session, next turn reuses it ---
  {
    const fake = createFakeClaudeSdk({ autoResult: false });
    const room = createRoom();
    const { runner, events } = createRunner({ room, sdk: fake.sdk });
    const first = runner.startPrompt('one');
    await waitFor(() => fake.calls.length === 1 && fake.calls[0].pendingResult);
    await runner.cancelCurrentRun();
    await first;
    assert.equal(fake.calls[0].interrupts, 1);
    assert.equal(room._claudeSession.alive, true, 'interrupt must not kill the session');
    assert.equal(finishedEvents(events).at(-1).status, 'cancelled');

    const second = runner.startPrompt('two');
    await waitFor(() => fake.calls[0].pendingResult);
    fake.calls[0].completeTurn();
    await second;
    assert.equal(fake.calls.length, 1, 'next turn stays in the same session');
    assert.equal(finishedEvents(events).at(-1).status, 'completed');
    assert.equal(room._claudeSession.turns, 2);
  }

  // --- consumer failure ends the turn as error; next prompt resumes a new session ---
  {
    const fake = createFakeClaudeSdk({ failNextTurn: true });
    const room = createRoom();
    const { runner, events } = createRunner({ room, sdk: fake.sdk });
    await runner.startPrompt('one');
    const failed = finishedEvents(events).at(-1);
    assert.equal(failed.status, 'error');
    assert.match(String(failed.lastErrorMessage), /stream boom/);
    assert.equal(room._claudeSession, null);

    await runner.startPrompt('two');
    assert.equal(fake.calls.length, 2);
    assert.equal(fake.calls[1].options.resume, SDK_SESSION_ID);
    assert.equal(finishedEvents(events).at(-1).status, 'completed');
  }

  // --- rate limit: the clock-bearing result text survives to the finish payload ---
  {
    const fake = createFakeClaudeSdk({ autoResult: false });
    const room = createRoom();
    const { runner, events } = createRunner({ room, sdk: fake.sdk });
    const withoutClock = 'Claude rate limit reached. Try again later.';
    const withClock = "You've hit your session limit · resets 1:50am (Europe/Warsaw)";
    const started = runner.startPrompt('one');
    await waitFor(() => fake.calls.length === 1 && fake.calls[0].pendingResult);
    // The assistant-level error and the result prose can both belong to one run.
    fake.calls[0].emit({
      type: 'assistant',
      session_id: SDK_SESSION_ID,
      error: 'rate_limit',
      message: { role: 'assistant', content: [] },
    });
    fake.calls[0].completeTurn({ is_error: true, errors: [withoutClock], result: withClock });
    await started;
    const failed = finishedEvents(events).at(-1);
    assert.equal(failed.status, 'error');
    assert.match(String(failed.lastErrorMessage), /rate limit/i);
    const candidates = failed.lastErrorMessages;
    assert.ok(Array.isArray(candidates), 'the finish payload carries every error variant');
    assert.ok(candidates.includes(withClock), 'the clock-bearing result text must be kept');
    assert.ok(candidates.includes(withoutClock), 'the generic message must be kept too');
  }

  // --- auth/env signature change restarts with resume ---
  {
    const fake = createFakeClaudeSdk();
    const room = createRoom();
    let apiKey = 'sk-ant-rotation-a';
    const { runner } = createRunner({
      room,
      sdk: fake.sdk,
      buildEnv: () => ({ ANTHROPIC_API_KEY: apiKey, CLAUDE_CONFIG_DIR: tempDir }),
    });
    await runner.startPrompt('one');
    apiKey = 'sk-ant-rotation-b';
    await runner.startPrompt('two');
    assert.equal(fake.calls.length, 2, 'rotated key must start a new process');
    assert.equal(fake.calls[0].closes, 1);
    assert.equal(fake.calls[1].options.resume, SDK_SESSION_ID);
  }

  // --- resume failure: clear the id, retry once without resume ---
  {
    const fake = createFakeClaudeSdk({ resumeFailureOnce: true });
    const room = createRoom({ claudeSessionId: SDK_SESSION_ID });
    const { runner, events } = createRunner({ room, sdk: fake.sdk });
    await runner.startPrompt('one');
    assert.equal(fake.calls.length, 2, 'exactly one resume-failure retry');
    assert.equal(fake.calls[0].options.resume, SDK_SESSION_ID);
    assert.equal(fake.calls[1].options.resume, undefined);
    const notice = noticeEvents(events).find((event) => event.noticeType === 'session_reset');
    assert.ok(notice, 'session reset notice');
    // The retry is transparent: one run, one sdkRunFinished with the final status.
    const statuses = finishedEvents(events).map((event) => event.status);
    assert.deepEqual(statuses, ['completed']);
    assert.equal(room.claudeSessionId, SDK_SESSION_ID);
  }

  // --- MCP revision change is applied live, no restart ---
  {
    const fake = createFakeClaudeSdk();
    const room = createRoom();
    let revision = 1;
    const { runner } = createRunner({
      room,
      sdk: fake.sdk,
      mcpRevision: () => revision,
      claudeMcp: () => ({ cretli_bridge: { type: 'stdio' } }),
    });
    await runner.startPrompt('one');
    revision = 2;
    await runner.startPrompt('two');
    assert.equal(fake.calls.length, 1, 'MCP revision change must not restart');
    assert.equal(fake.calls[0].setMcpServers.length, 1);
    assert.equal(room._claudeSession.startKey.mcpRevision, 2);
  }

  // --- idle timeout closes the session ---
  {
    const fake = createFakeClaudeSdk();
    const room = createRoom();
    const { runner } = createRunner({ room, sdk: fake.sdk, idleMs: 30 });
    await runner.startPrompt('one');
    assert.equal(room._claudeSession.alive, true);
    await waitFor(() => room._claudeSession === null, { timeoutMs: 500 });
    assert.equal(fake.calls[0].closes, 1);
  }

  // --- kill switch: one-shot query on a string prompt ---
  {
    const fake = createFakeClaudeSdk();
    const room = createRoom();
    const { runner, events } = createRunner({ room, sdk: fake.sdk, streamingEnabled: false });
    await runner.startPrompt('one');
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].isStreaming, false);
    assert.equal(typeof fake.calls[0].prompt, 'string');
    assert.equal(room._claudeSession ?? null, null);
    assert.equal(finishedEvents(events).at(-1).status, 'completed');
  }

  // --- queue: a prompt sent during a turn runs after that turn's result ---
  {
    const fake = createFakeClaudeSdk({ autoResult: false });
    const room = createRoom();
    const { runner, events } = createRunner({ room, sdk: fake.sdk });
    const first = runner.startPrompt('one');
    await waitFor(() => fake.calls.length === 1 && fake.calls[0].pendingResult);
    await runner.startPrompt('two');
    assert.equal(room.pendingPrompts.length, 1);
    assert.equal(fake.calls.length, 1);
    fake.calls[0].completeTurn();
    await first;
    await waitFor(() => fake.calls[0].pendingResult);
    fake.calls[0].completeTurn();
    await waitFor(() => room.busy === false && room.pendingPrompts.length === 0);
    const finished = finishedEvents(events);
    assert.equal(finished.length, 2);
    assert.deepEqual(finished.map((event) => event.status), ['completed', 'completed']);
    assert.equal(fake.calls.length, 1);
  }

  // --- Task D: start-time tuning is validated and restarts the session ---
  {
    const tuning = resolveClaudeRunTuning({
      CRETLI_CLAUDE_EFFORT: 'xhigh',
      CRETLI_CLAUDE_FALLBACK_MODEL: 'opus',
      CRETLI_CLAUDE_DELEGATION_MAX_TURNS: '3',
      CRETLI_CLAUDE_DELEGATION_MAX_BUDGET_USD: '1.5',
    }, { delegation: true });
    assert.deepEqual(tuning, {
      effort: 'xhigh',
      fallbackModel: 'opus',
      maxTurns: 3,
      maxBudgetUsd: 1.5,
    });
    const invalidTuning = resolveClaudeRunTuning({
      CRETLI_CLAUDE_EFFORT: 'ultra',
      CRETLI_CLAUDE_FALLBACK_MODEL: '   ',
      CRETLI_CLAUDE_DELEGATION_MAX_TURNS: '0',
      CRETLI_CLAUDE_DELEGATION_MAX_BUDGET_USD: '-1',
    }, { delegation: true });
    assert.deepEqual(invalidTuning, {
      effort: '',
      fallbackModel: '',
      maxTurns: null,
      maxBudgetUsd: null,
    });
    const nonDelegation = resolveClaudeRunTuning({
      CRETLI_CLAUDE_DELEGATION_MAX_TURNS: '3',
      CRETLI_CLAUDE_DELEGATION_MAX_BUDGET_USD: '1.5',
    }, { delegation: false });
    assert.equal(nonDelegation.maxTurns, null);
    assert.equal(nonDelegation.maxBudgetUsd, null);

    const delegationOptions = buildClaudeQueryOptions(
      { cwd: '/tmp', sdkMode: 'agent', delegationAssignment: 'implement' },
      'agent',
      {
        env: {
          CRETLI_CLAUDE_EFFORT: 'medium',
          CRETLI_CLAUDE_DELEGATION_MAX_TURNS: '4',
          CRETLI_CLAUDE_DELEGATION_MAX_BUDGET_USD: '3',
        },
      },
    );
    assert.equal(delegationOptions.effort, 'medium');
    assert.equal(delegationOptions.maxTurns, 4);
    assert.equal(delegationOptions.maxBudgetUsd, 3);
    assert.equal(buildClaudeQueryOptions({ cwd: '/tmp' }, 'agent', { env: {} }).effort, undefined);

    // Changing a start-time env value restarts the process with resume.
    const fake = createFakeClaudeSdk();
    const room = createRoom();
    const env = {
      ANTHROPIC_API_KEY: 'test-key',
      CLAUDE_CONFIG_DIR: tempDir,
      CRETLI_CLAUDE_EFFORT: 'high',
    };
    const { runner } = createRunner({ room, sdk: fake.sdk, buildEnv: () => ({ ...env }) });
    await runner.startPrompt('one');
    assert.equal(fake.calls[0].options.effort, 'high');
    env.CRETLI_CLAUDE_EFFORT = 'low';
    await runner.startPrompt('two');
    assert.equal(fake.calls.length, 2, 'effort change must restart the process');
    assert.equal(fake.calls[1].options.resume, SDK_SESSION_ID);
    assert.equal(fake.calls[1].options.effort, 'low');
  }

  // --- Task D/startKey: tuning signature is stable and compared ---
  {
    assert.equal(
      buildClaudeTuningSignature({ effort: 'high', fallbackModel: 'opus', maxTurns: 2, maxBudgetUsd: 1 }),
      buildClaudeTuningSignature({ effort: 'high', fallbackModel: 'opus', maxTurns: 2, maxBudgetUsd: 1 }),
    );
    assert.notEqual(
      buildClaudeTuningSignature({ effort: 'high' }),
      buildClaudeTuningSignature({ effort: 'low' }),
    );
  }

  // --- Task C: query.supportedModels() populates the session catalog ---
  {
    const previousKey = process.env.ANTHROPIC_API_KEY;
    const previousBase = process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    invalidateClaudeModelsCache();
    try {
      const fake = createFakeClaudeSdk({
        supportedModels: [
          { value: 'opus', displayName: 'Opus' },
          { value: 'sonnet', displayName: 'Sonnet' },
        ],
      });
      const room = createRoom();
      const { runner } = createRunner({ room, sdk: fake.sdk });
      await runner.startPrompt('one');
      await waitFor(() => isClaudeSessionModelCatalogFresh(), { timeoutMs: 500 });
      const listed = await listClaudeModels();
      assert.equal(listed.modelsSource, 'session');
      assert.deepEqual(listed.models.map((row) => row.id), ['opus', 'sonnet', 'claude-haiku-5-5']);
    } finally {
      if (typeof previousKey === 'string') process.env.ANTHROPIC_API_KEY = previousKey;
      else delete process.env.ANTHROPIC_API_KEY;
      if (typeof previousBase === 'string') process.env.ANTHROPIC_BASE_URL = previousBase;
      else delete process.env.ANTHROPIC_BASE_URL;
      invalidateClaudeModelsCache();
    }
  }

  // --- Task G: stderr ring buffer, redaction and last-line fallback ---
  {
    assert.equal(redactClaudeStderrLine('Authorization: Bearer abc.def.ghi'), 'Authorization: Bearer ***');
    assert.match(redactClaudeStderrLine('sk-ant-api03-secretvalue'), /sk-ant-\*\*\*/);
    assert.equal(redactClaudeStderrLine('ANTHROPIC_API_KEY=sk-ant-xyz'), 'ANTHROPIC_API_KEY=***');
    assert.equal(redactClaudeStderrLine('CLAUDE_CODE_OAUTH_TOKEN=abc123'), 'CLAUDE_CODE_OAUTH_TOKEN=***');

    const stderrRoom = createRoom();
    for (let i = 0; i < 60; i += 1) appendClaudeStderrChunk(stderrRoom, `line-${i}\n`);
    assert.equal(readClaudeStderrTail(stderrRoom).length, 50);
    assert.equal(readClaudeStderrTail(stderrRoom)[0], 'line-10');
    assert.equal(readLastClaudeStderrLine(stderrRoom), 'line-59');

    const optionsRoom = createRoom();
    const stderrOptions = buildClaudeQueryOptions(optionsRoom, 'agent');
    assert.equal(typeof stderrOptions.stderr, 'function');
    stderrOptions.stderr('starting claude\nsk-ant-secret\n');
    assert.deepEqual(readClaudeStderrTail(optionsRoom), ['starting claude', 'sk-ant-***']);

    // A silent session end uses the last non-empty stderr line as the message.
    const fake = createFakeClaudeSdk({ endSilently: true });
    const room = createRoom();
    const { runner, events } = createRunner({ room, sdk: fake.sdk });
    appendClaudeStderrChunk(room, 'fatal: claude binary crashed\n');
    await runner.startPrompt('one');
    const failed = finishedEvents(events).at(-1);
    assert.equal(failed.status, 'error');
    assert.equal(failed.lastErrorMessage, 'fatal: claude binary crashed');
  }

  // --- Task R: rejected setModel restarts the session with resume ---
  {
    const fake = createFakeClaudeSdk({ rejectSetModelOnce: true });
    const room = createRoom();
    const { runner } = createRunner({ room, sdk: fake.sdk });
    await runner.startPrompt('one');
    room.modelId = 'claude-model-b';
    await runner.startPrompt('two');
    assert.equal(fake.calls.length, 2, 'rejected setModel must restart');
    assert.equal(fake.calls[0].closes, 1);
    assert.deepEqual(fake.calls[0].setModel, ['claude-model-b']);
    assert.equal(fake.calls[1].options.resume, SDK_SESSION_ID);
  }

  // --- Task R: rejected setPermissionMode restarts the session with resume ---
  {
    const fake = createFakeClaudeSdk({ rejectSetPermissionModeOnce: true });
    const room = createRoom({ sdkMode: 'plan' });
    const { runner } = createRunner({ room, sdk: fake.sdk });
    await runner.startPrompt('one', 'plan');
    await runner.startPrompt('two', 'ask');
    assert.equal(fake.calls.length, 2, 'rejected setPermissionMode must restart');
    assert.equal(fake.calls[0].closes, 1);
    assert.deepEqual(fake.calls[0].setPermissionMode, ['default']);
    assert.equal(fake.calls[1].options.resume, SDK_SESSION_ID);
  }

  // --- Task R: interrupt fallback fires only while the turn is still open ---
  {
    const fake = createFakeClaudeSdk({ autoResult: false, interruptSilent: true });
    const room = createRoom();
    const { runner } = createRunner({ room, sdk: fake.sdk });
    const first = runner.startPrompt('one');
    await waitFor(() => fake.calls.length === 1 && fake.calls[0].pendingResult);
    await interruptActiveQuery(room, 5, 15);
    await waitFor(() => fake.calls[0].closes >= 1, { timeoutMs: 500 });
    await first;
    assert.equal(room._activeQuery, null);
    assert.equal(fake.calls[0].closes, 1);
  }
  {
    const fake = createFakeClaudeSdk({ autoResult: false });
    const room = createRoom();
    const { runner, events } = createRunner({ room, sdk: fake.sdk });
    const first = runner.startPrompt('one');
    await waitFor(() => fake.calls.length === 1 && fake.calls[0].pendingResult);
    await interruptActiveQuery(room, 5, 20);
    await first;
    assert.equal(finishedEvents(events).at(-1).status, 'completed');
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(fake.calls[0].closes, 0, 'fallback must not fire after the turn ends');
    assert.equal(room._claudeSession.alive, true);
  }

  // --- Task P: between-turn notices broadcast without a runId; others are dropped ---
  {
    const fake = createFakeClaudeSdk({ autoResult: false });
    const room = createRoom();
    const { runner, events } = createRunner({ room, sdk: fake.sdk });
    const first = runner.startPrompt('one');
    await waitFor(() => fake.calls.length === 1 && fake.calls[0].pendingResult);
    fake.calls[0].completeTurn();
    await first;

    fake.calls[0].emit({
      type: 'rate_limit_event',
      session_id: SDK_SESSION_ID,
      rate_limit_info: { status: 'allowed_warning', resetsAt: 1_800_000_000 },
    });
    await waitFor(() => noticeEvents(events).some((event) => event.noticeType === 'rate_limit'));
    const rateNotice = noticeEvents(events).find((event) => event.noticeType === 'rate_limit');
    assert.equal(rateNotice.runId, undefined);
    assert.equal(rateNotice.status, 'allowed_warning');
    assert.equal(rateNotice.resetsAt, 1_800_000_000);

    const sdkEventsBefore = events.filter((event) => event.type === 'sdkEvent').length;
    fake.calls[0].emit({ type: 'tool_progress', tool_use_id: 't-1', session_id: SDK_SESSION_ID });
    fake.calls[0].emit({
      type: 'system',
      subtype: 'task_notification',
      session_id: SDK_SESSION_ID,
      task_id: 'task-1',
    });
    fake.calls[0].emit({
      type: 'assistant',
      parent_tool_use_id: 't-1',
      session_id: SDK_SESSION_ID,
      message: { content: [{ type: 'text', text: 'late subagent text' }] },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(events.filter((event) => event.type === 'sdkEvent').length, sdkEventsBefore);
    assert.equal(room._activeTurn, null);
  }

  // --- Task E (ws): a result with usage broadcasts an sdkEvent usage ---
  {
    const fake = createFakeClaudeSdk({
      autoResult: false,
    });
    const room = createRoom();
    const { runner, events } = createRunner({ room, sdk: fake.sdk });
    const first = runner.startPrompt('one');
    await waitFor(() => fake.calls.length === 1 && fake.calls[0].pendingResult);
    fake.calls[0].completeTurn({
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
      total_cost_usd: 0.02,
      modelUsage: { sonnet: { costUSD: 0.02 } },
    });
    await first;
    const usageEvent = events
      .filter((event) => event.type === 'sdkEvent')
      .map((event) => event.event)
      .find((event) => event && event.type === 'usage');
    assert.ok(usageEvent, 'usage sdkEvent is broadcast');
    assert.equal(usageEvent.usage.inputTokens, 12);
    assert.equal(usageEvent.usage.outputTokens, 5);
    assert.equal(usageEvent.usage.totalTokens, 17);
    assert.equal(usageEvent.usage.cacheReadTokens, 2);
    assert.equal(usageEvent.totalCostUsd, 0.02);
    assert.equal(usageEvent.modelUsage.sonnet.costUSD, 0.02);
  }

  // --- Task E (ws): notice payload keeps advisories out of the error path ---
  {
    const payload = buildClaudeNoticePayload({
      kind: 'notice',
      noticeType: 'rate_limit',
      message: 'Claude is nearing its rate limit.',
      status: 'allowed_warning',
      resetsAt: 1_800_000_000,
    });
    assert.equal(payload.type, 'sdkRunProgress');
    assert.equal(payload.noticeType, 'rate_limit');
    assert.equal(payload.status, 'allowed_warning');
    assert.equal(payload.resetsAt, 1_800_000_000);
    assert.equal(payload.phase, 'notice');
  }

  console.log('claude-streaming-session.test.js OK');
} finally {
  resetClaudeSdkForTests();
  if (typeof previousDataDir === 'string') process.env.CRETLI_DATA_DIR = previousDataDir;
  else delete process.env.CRETLI_DATA_DIR;
  if (typeof previousStreaming === 'string') process.env.CRETLI_CLAUDE_STREAMING_SESSION = previousStreaming;
  else delete process.env.CRETLI_CLAUDE_STREAMING_SESSION;
  fs.rmSync(tempDir, { recursive: true, force: true });
}
