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
} = await import('../lib/claude/claude-agent-ws.ts');
const {
  setClaudeSdkForTests,
  resetClaudeSdkForTests,
  loadClaudeSdk,
} = await import('../lib/claude/claude-sdk.ts');
const {
  buildClaudeUserMessage,
  countClaudeBackgroundTasks,
  hasClaudeBackgroundWork,
  noteClaudeBackgroundTasks,
  resolveClaudeBackgroundHoldMs,
  buildClaudeAuthSignature,
  buildClaudeTuningSignature,
  buildClaudeSessionStartKey,
  resolveClaudeRunTuning,
} = await import('../lib/claude/claude-session.ts');
const {
  invalidateClaudeModelsCache,
  isClaudeSessionModelCatalogFresh,
  listClaudeModels,
} = await import('../lib/claude/claude-models.ts');
const { clearMcpBridgeToolsListed, markMcpBridgeToolsListed } = await import('../lib/mcp/mcp-bridge-ready.js');
const { ORCHESTRATOR_MCP_CONTRACT_TOOLS } = await import('../lib/mcp/mcp-orchestrator-contract.js');
const { saveSettings, loadSettings } = await import('../lib/persist/settings.js');
const { noteChatRowsForOperatorIndex } = await import('../lib/operator/operator-run-chat-registry.js');
const { noteChatRowsForScoutIndex } = await import('../lib/scout-chat-registry.js');
const { clearClaudePromptSuggestions, shouldAcceptClaudePromptSuggestion } = await import('../lib/claude/prompt-suggestion-state.ts');
const { buildHarnessHandoffPrompt } = await import('../lib/conversation-fork.js');

const { buildSdkRoomStatePayload } = await import('../lib/sdk/sdk-room-state.ts');
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
 *   interruptReceipt?: Record<string, unknown>,
 *   endSilently?: boolean,
 *   supportedModels?: Array<Record<string, unknown>>,
 *   promptSuggestion?: string,
 *   promptSuggestionSessionId?: string,
 *   endAfterPromptSuggestion?: boolean,
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
    promptSuggestion: config.promptSuggestion || '',
    promptSuggestionSessionId: config.promptSuggestionSessionId || '',
    endAfterPromptSuggestion: config.endAfterPromptSuggestion === true,
    interruptReceipt: config.interruptReceipt,
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
      if (state.promptSuggestion) {
        enqueue({ value: {
          type: 'prompt_suggestion', suggestion: state.promptSuggestion,
          session_id: state.promptSuggestionSessionId || state.sessionId,
        } });
        if (state.endAfterPromptSuggestion) endNow();
      }
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
        return state.interruptReceipt;
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
  const persisted = [];
  const roomStates = [];
  const broadcastOptions = [];
  const notices = [];
  const writeOrder = [];
  const revision = typeof options.mcpRevision === 'function' ? options.mcpRevision : () => 1;
  const claudeMcp = typeof options.claudeMcp === 'function' ? options.claudeMcp : () => ({});
  const runner = createClaudePromptRunner({
    room: options.room,
    hooks: {
      broadcast: (payload, options) => {
        events.push(payload);
        broadcastOptions.push(options);
      },
      sendRoomState: () => { roomStates.push(buildSdkRoomStatePayload(options.room)); },
      persistRoomEvent: (event) => { persisted.push(event); writeOrder.push({ type: 'history', event }); },
      flushPersist: () => typeof options.flushPersist === 'function' ? options.flushPersist() : options.flushResult || { ok: true, pending: 0, deadLettered: 0 },
      getChatHistoryPage: async () => ({ events: options.historyEvents || [] }),
      getChatRow: async () => ({
        id: options.room.chatId,
        workspaceFolder: options.room.cwd,
        agentTransport: 'claude',
        summaries: options.summaries || [],
        ...(typeof options.chatRow === 'function' ? options.chatRow() : {}),
      }),
      appendContextNotice: async (_chatId, text, meta) => { notices.push({ text, meta }); writeOrder.push({ type: 'notice', meta }); return { ok: true }; },
      recordPeerMessage: options.recordPeerMessage,
      loadSdk: typeof options.loadSdk === 'function' ? options.loadSdk : async () => options.sdk,
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
      enforceOneShotMcpGate: options.enforceOneShotMcpGate,
    },
  });
  return { runner, events, persisted, roomStates, broadcastOptions, notices, writeOrder };
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
  assert.equal(optionsProbe.promptSuggestions, true);
  assert.deepEqual(
    buildClaudeSessionStartKey({ cwd: tempDir, promptSuggestionEnabled: false }),
    buildClaudeSessionStartKey({ cwd: tempDir, promptSuggestionEnabled: true }),
    'toggling prompt suggestions must not change the session start key',
  );
  const suggestionGate = {
    enabled: true, busy: false, pendingPromptCount: 0, sessionId: 'sess-1',
    expectedSessionId: 'sess-1', resultStatus: 'completed', runMode: 'agent',
  };
  assert.equal(shouldAcceptClaudePromptSuggestion(suggestionGate), true);
  for (const patch of [
    { enabled: false }, { busy: true }, { pendingPromptCount: 1 },
    { sessionId: 'stale' }, { resultStatus: 'error' }, { runMode: 'plan' }, { apiError: true },
  ]) assert.equal(shouldAcceptClaudePromptSuggestion({ ...suggestionGate, ...patch }), false);
  {
    const room = { chatId: 'clear-test', promptSuggestion: { text: 'next', turnRunId: 'r1' } };
    const frames = [];
    assert.equal(clearClaudePromptSuggestions([room], (target, frame) => frames.push([target, frame])), 1);
    assert.equal(room.promptSuggestion, null);
    assert.deepEqual(frames[0][1], { type: 'promptSuggestion', chatId: 'clear-test', text: '', turnRunId: '' });
  }
  {
    const frames = [];
    const room = {
      chatId: 'session-close-test',
      promptSuggestion: { text: 'stale after close', turnRunId: 'r2' },
      _claudeSession: null,
    };
    const { closeClaudeSession } = await import('../lib/claude/claude-session.ts');
    closeClaudeSession(room, null, (frame) => frames.push(frame));
    assert.equal(room.promptSuggestion, null);
    assert.deepEqual(frames, [{
      type: 'promptSuggestion', chatId: 'session-close-test', text: '', turnRunId: '',
    }]);
  }
  assert.equal(buildClaudeQueryOptions({ delegationAssignment: { id: 'd' } }, 'agent').promptSuggestions, undefined);
  assert.equal(buildClaudeQueryOptions({ chatId: 'operator-test-id' }, 'agent').promptSuggestions, undefined);
  noteChatRowsForOperatorIndex({ id: 'regular-test-id', pickPurpose: '' });
  noteChatRowsForScoutIndex({ id: 'scout-test-id', readOnlyScout: true });
  assert.equal(buildClaudeQueryOptions({ chatId: 'scout-test-id' }, 'agent').promptSuggestions, undefined);
  assert.equal(buildClaudeQueryOptions({ watcherOrchestrator: true }, 'agent').promptSuggestions, undefined);
  assert.equal(buildClaudeQueryOptions({ chatId: 'regular-test-id' }, 'plan').promptSuggestions, undefined);
  assert.equal(buildClaudeQueryOptions({ chatId: 'regular-test-id' }, 'ask').promptSuggestions, undefined);
  saveSettings({ ...loadSettings(), claudePromptSuggestionEnabled: false });
  assert.equal(buildClaudeQueryOptions({ chatId: 'regular-test-id' }, 'agent').promptSuggestions, undefined);
  saveSettings({ ...loadSettings(), claudePromptSuggestionEnabled: true });
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
    room.promptSuggestion = { text: 'next turn', turnRunId: 'before-second-turn', createdAt: Date.now() };
    await runner.startPrompt('two');
    assert.equal(events.some((event) => event.type === 'promptSuggestion' && event.text === ''), true);
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

  // Fresh native sessions receive prior history in the SDK prompt only; stored and echoed user text stays intact.
  {
    const historyEvents = [
      { seq: 1, rec: { kind: 'localUser', text: 'Earlier task' } },
      { seq: 2, rec: { kind: 'sdk', event: { type: 'user', message: { content: 'Earlier task' } } } },
      { seq: 3, rec: { kind: 'sdk', event: { type: 'assistant', message: { content: [{ type: 'text', text: 'Earlier answer' }] } } } },
    ];
    const fake = createFakeClaudeSdk();
    const room = createRoom({ chatId: 'digest-fresh-room' });
    const { runner, events, notices, writeOrder } = createRunner({ room, sdk: fake.sdk, historyEvents });
    await runner.startPrompt('Current request');
    const sdkPrompt = String(fake.calls[0].messages[0].message.content);
    assert.match(sdkPrompt, /Earlier answer/);
    assert.match(sdkPrompt, /Current request/);
    assert.deepEqual(notices.map((row) => [row.meta.code, row.meta.turns]), [['context_restored', 1]]);
    assert.equal(writeOrder[0].type, 'notice');
    assert.equal(writeOrder[1].event.kind, 'localUser');
    assert.equal(writeOrder[1].event.text, 'Current request');
    assert.equal(extractText(events.find((row) => row.type === 'sdkEvent')?.event), 'Current request');
  }

  {
    const fake = createFakeClaudeSdk();
    const room = createRoom({ chatId: 'digest-plan-only' });
    const { runner, notices } = createRunner({ room, sdk: fake.sdk, historyEvents: [{ seq: 1, rec: { kind: 'meta', variant: 'contextSeed', payload: 'prior' } }], summaries: [{ summary: '## Chrome extension plan\nExisting plan details' }] });
    await runner.startPrompt('ok realize it');
    const sdkPrompt = String(fake.calls[0].messages[0].message.content);
    assert.match(sdkPrompt, /Chrome extension plan/);
    assert.match(sdkPrompt, /Current request:\nok realize it/);
    assert.equal(notices[0].meta.code, 'context_restored');
    assert.equal(notices[0].meta.turns, 0);
  }

  // A tool-heavy turn (40+ tool_call rows) must still carry the earlier user request into the SDK prompt.
  for (const withAnswer of [false, true]) {
    const historyEvents = [{ seq: 1, rec: { kind: 'localUser', text: 'Realize the Chrome extension plan' } }];
    for (let i = 0; i < 45; i += 1) {
      historyEvents.push({ seq: 2 + i * 2, rec: { kind: 'sdk', event: { type: 'tool_call', id: `c${i}`, name: 'Bash', status: 'running' } } });
      historyEvents.push({ seq: 3 + i * 2, rec: { kind: 'sdk', event: { type: 'tool_call', id: `c${i}`, name: 'Bash', status: 'completed' } } });
    }
    if (withAnswer) historyEvents.push({ seq: 500, rec: { kind: 'sdk', event: { type: 'assistant', message: { content: [{ type: 'text', text: 'Plan answer' }] } } } });
    const fake = createFakeClaudeSdk();
    const room = createRoom({ chatId: `digest-tools-${withAnswer}` });
    const { runner, notices } = createRunner({ room, sdk: fake.sdk, historyEvents });
    await runner.startPrompt('ok go');
    const sdkPrompt = String(fake.calls[0].messages[0].message.content);
    assert.match(sdkPrompt, /Realize the Chrome extension plan/);
    assert.deepEqual(notices.map((row) => [row.meta.code, row.meta.turns]), [['context_restored', 1]]);
  }

  {
    const fake = createFakeClaudeSdk({ resumeFailureOnce: true });
    const room = createRoom({ chatId: 'digest-stale-retry', claudeSessionId: SDK_SESSION_ID });
    const steerId = 'recovered-steer-current-id';
    const historyEvents = [
      { seq: 1, rec: { kind: 'localUser', text: 'Previous' } },
      { seq: 2, rec: { kind: 'sdk', event: { type: 'assistant', message: { content: [{ type: 'text', text: 'Previous answer' }] } } } },
      { seq: 3, rec: { kind: 'localUser', text: 'Retry current', contextMessageId: steerId } },
      { seq: 4, rec: { kind: 'sdk', event: { type: 'user', contextMessageId: steerId, message: { content: 'Retry current' } } } },
    ];
    const { runner, notices, writeOrder } = createRunner({ room, sdk: fake.sdk, historyEvents });
    await runner.startPrompt('Retry current', undefined, false, '', false, null, undefined, '', steerId);
    assert.equal(fake.calls.length, 2);
    assert.equal(fake.calls[0].options.resume, SDK_SESSION_ID);
    assert.match(String(fake.calls[1].messages[0].message.content), /Previous answer/);
    assert.equal((String(fake.calls[1].messages[0].message.content).match(/Retry current/g) || []).length, 1, 'recovered steer appears only as the current request, not again in the digest');
    assert.equal(notices.filter((row) => row.meta.code === 'context_restored').length, 1);
    assert.equal(writeOrder[0].event.kind, 'localUser');
    assert.equal(writeOrder[1].type, 'notice');
  }

  {
    const fake = createFakeClaudeSdk();
    const room = createRoom({ chatId: 'digest-flush-failed' });
    const historyEvents = [{ seq: 1, rec: { kind: 'localUser', text: 'Previous' } }];
    const { runner, notices } = createRunner({ room, sdk: fake.sdk, historyEvents, flushResult: { ok: false, pending: 1, deadLettered: 0 } });
    await runner.startPrompt('Current');
    assert.equal(notices[0].meta.code, 'context_lost');
  }

  {
    const fake = createFakeClaudeSdk();
    const room = createRoom({ chatId: 'digest-flush-timeout' });
    const { runner, notices } = createRunner({ room, sdk: fake.sdk, historyEvents: [{ seq: 1, rec: { kind: 'localUser', text: 'Previous' } }], flushPersist: () => new Promise(() => {}) });
    await runner.startPrompt('Current');
    assert.equal(notices[0].meta.code, 'context_lost');
  }

  {
    const fake = createFakeClaudeSdk();
    const room = createRoom({ chatId: 'digest-empty' });
    const { runner, notices } = createRunner({ room, sdk: fake.sdk });
    await runner.startPrompt('First message');
    assert.equal(notices.length, 0);
    assert.match(extractText(fake.calls[0].messages[0]), /First message/);
  }

  {
    const fake = createFakeClaudeSdk();
    const room = createRoom({ chatId: 'digest-history-without-text' });
    const { runner, notices } = createRunner({ room, sdk: fake.sdk, historyEvents: [{ seq: 1, rec: { kind: 'sdk', event: { type: 'tool_result', content: 'omitted payload' } } }] });
    await runner.startPrompt('Continue');
    assert.equal(notices[0].meta.code, 'context_lost');
    assert.doesNotMatch(String(fake.calls[0].messages[0].message.content), /omitted payload/);
  }

  {
    const fake = createFakeClaudeSdk();
    const room = createRoom({ chatId: 'digest-one-shot' });
    const { runner, persisted } = createRunner({ room, sdk: fake.sdk, streamingEnabled: false, historyEvents: [{ seq: 1, rec: { kind: 'localUser', text: 'Earlier' } }, { seq: 2, rec: { kind: 'sdk', event: { type: 'assistant', message: { content: [{ type: 'text', text: 'One-shot prior answer' }] } } } }] });
    await runner.startPrompt('One-shot current');
    assert.match(String(fake.calls[0].prompt), /One-shot prior answer/);
    assert.equal(persisted.find((row) => row.kind === 'localUser').text, 'One-shot current');
  }

  {
    const fake = createFakeClaudeSdk();
    const room = createRoom({ chatId: 'digest-resume-valid', claudeSessionId: SDK_SESSION_ID });
    const { runner, notices, persisted, events } = createRunner({ room, sdk: fake.sdk, historyEvents: [{ seq: 1, rec: { kind: 'localUser', text: 'Prior' } }] });
    await runner.startPrompt('Unchanged prompt');
    assert.equal(notices.length, 0);
    assert.match(String(fake.calls[0].messages[0].message.content), /Unchanged prompt/);
    assert.doesNotMatch(String(fake.calls[0].messages[0].message.content), /Prior/);
    assert.equal(persisted.filter((row) => row.kind === 'localUser').length, 1);
    const userEchoIndex = events.findIndex((row) => row.type === 'sdkEvent' && row.event?.type === 'user');
    const assistantEchoIndex = events.findIndex((row) => row.type === 'sdkEvent' && row.event?.type === 'assistant');
    assert.ok(userEchoIndex >= 0 && assistantEchoIndex > userEchoIndex, 'user echo precedes streamed assistant output');
  }

  {
    const room = createRoom({ chatId: 'persist-user-after-sdk-error' });
    const { runner, persisted, events } = createRunner({ room, sdk: createFakeClaudeSdk().sdk, loadSdk: async () => { throw new Error('SDK load failed'); } });
    await runner.startPrompt('Keep this request');
    assert.equal(persisted.filter((row) => row.kind === 'localUser' && row.text === 'Keep this request').length, 1);
    assert.equal(events.filter((row) => row.type === 'sdkEvent' && row.event?.type === 'user').length, 1);
  }

  {
    const room = createRoom({ chatId: 'persist-user-one-shot-block', watcherOrchestrator: true });
    const { runner, persisted, events } = createRunner({
      room,
      sdk: createFakeClaudeSdk().sdk,
      streamingEnabled: false,
      enforceOneShotMcpGate: async () => ({ code: 'mcp_tools_missing', message: 'Missing tools.', missing: [] }),
    });
    await runner.startPrompt('Keep blocked request');
    assert.equal(persisted.filter((row) => row.kind === 'localUser' && row.text === 'Keep blocked request').length, 1);
    assert.equal(events.filter((row) => row.type === 'sdkEvent' && row.event?.type === 'user').length, 1);
  }

  {
    const fake = createFakeClaudeSdk();
    const room = createRoom({ chatId: 'digest-handoff' });
    const wrapped = buildHarnessHandoffPrompt({ sourceHarness: 'opencode', targetHarness: 'claude', transcript: 'Prior context', followUp: 'Continue' });
    const { runner, notices } = createRunner({ room, sdk: fake.sdk, historyEvents: [{ seq: 1, rec: { kind: 'localUser', text: 'Prior' } }] });
    await runner.startPrompt(wrapped);
    assert.equal(notices.length, 0);
    assert.doesNotMatch(String(fake.calls[0].messages[0].message.content), /Earlier history/);
  }

  {
    const fake = createFakeClaudeSdk({ promptSuggestion: 'Add a test' });
    const room = createRoom({ chatId: 'regular-test-id' });
    const { runner, events, roomStates } = createRunner({ room, sdk: fake.sdk });
    await runner.startPrompt('first');
    await waitFor(() => room.promptSuggestion?.text === 'Add a test');
    assert.equal(events.some((event) => event.type === 'promptSuggestion' && event.text === 'Add a test'), true);
    assert.equal(roomStates.at(-1).promptSuggestion.text, 'Add a test');
  }

  {
    const fake = createFakeClaudeSdk({ promptSuggestion: 'Stale', promptSuggestionSessionId: 'other-session' });
    const room = createRoom({ chatId: 'regular-test-id' });
    const { runner, events } = createRunner({ room, sdk: fake.sdk });
    await runner.startPrompt('first');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(room.promptSuggestion, undefined);
    assert.equal(events.some((event) => event.type === 'promptSuggestion' && event.text), false);
  }

  {
    const fake = createFakeClaudeSdk({ promptSuggestion: 'Too late', endAfterPromptSuggestion: true });
    const room = createRoom({ chatId: 'ended-before-suggestion-timer', promptSuggestion: null });
    const { runner, events } = createRunner({ room, sdk: fake.sdk });
    await runner.startPrompt('finish before timer');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(room._claudeSession, null, 'the SDK iterator ended before the deferred callback');
    assert.equal(room.promptSuggestion, null);
    assert.equal(events.some((event) => event.type === 'promptSuggestion' && event.text), false);
  }

  {
    saveSettings({ ...loadSettings(), claudePromptSuggestionEnabled: false });
    const fake = createFakeClaudeSdk({ promptSuggestion: 'Disabled' });
    const room = createRoom({ chatId: 'regular-test-id' });
    const { runner, events } = createRunner({ room, sdk: fake.sdk });
    await runner.startPrompt('first');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(room.promptSuggestion, undefined);
    assert.equal(events.some((event) => event.type === 'promptSuggestion' && event.text), false);
    saveSettings({ ...loadSettings(), claudePromptSuggestionEnabled: true });
  }

  {
    const fake = createFakeClaudeSdk();
    const room = createRoom();
    const { runner, events, persisted } = createRunner({ room, sdk: fake.sdk });
    const origin = { kind: 'operator', clientId: 'mcp-test', clientName: 'Claude' };
    await runner.startPrompt('model prompt', 'agent', false, 'visible text', false, null, origin, 'request-test');
    const started = events.find((event) => event.type === 'sdkPromptStarted');
    const localUser = persisted.find((event) => event.kind === 'localUser');
    assert.deepEqual(started.origin, origin);
    assert.equal(started.requestId, 'request-test');
    assert.equal(localUser.text, 'visible text');
    assert.deepEqual(localUser.origin, origin);
    assert.equal(localUser.requestId, 'request-test');
  }

  {
    const room = createRoom({ busy: true });
    const { runner } = createRunner({ room, sdk: createFakeClaudeSdk().sdk });
    const origin = { kind: 'mailbox', sourceChatId: 'parent-chat' };
    await runner.startPrompt('queued model prompt', 'agent', false, 'queued display', false, null, origin, 'queued-request');
    assert.equal(room.pendingPrompts.length, 1);
    assert.deepEqual(room.pendingPrompts[0].origin, origin);
    assert.equal(room.pendingPrompts[0].requestId, 'queued-request');
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

  // --- Per-chat auto-compression drives Claude's native compaction ---
  {
    const fake = createFakeClaudeSdk();
    const room = createRoom();
    const chat = { autoContextCompressionEnabled: true, autoContextCompressionThreshold: 50 };
    const { runner } = createRunner({
      room,
      sdk: fake.sdk,
      buildEnv: () => ({ ANTHROPIC_API_KEY: 'test-key', CLAUDE_CONFIG_DIR: tempDir, DISABLE_AUTO_COMPACT: '1' }),
      chatRow: () => ({ ...chat }),
    });
    await runner.startPrompt('one');
    assert.equal(fake.calls[0].options.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, '50');
    assert.equal(fake.calls[0].options.env.DISABLE_AUTO_COMPACT, undefined, 'chat opt-in wins over global disable');
    await runner.startPrompt('two');
    assert.equal(fake.calls.length, 1, 'unchanged threshold must not restart');
    chat.autoContextCompressionThreshold = 70;
    await runner.startPrompt('three');
    assert.equal(fake.calls.length, 2, 'threshold change must restart the process');
    assert.equal(fake.calls[1].options.resume, SDK_SESSION_ID, 'restart keeps the transcript');
    assert.equal(fake.calls[1].options.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, '70');
    chat.autoContextCompressionEnabled = false;
    await runner.startPrompt('four');
    assert.equal(fake.calls.length, 3);
    assert.equal(fake.calls[2].options.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, undefined);
    assert.equal(fake.calls[2].options.env.DISABLE_AUTO_COMPACT, '1', 'opt-out restores the global env');
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
      assert.deepEqual(listed.models.map((row) => row.id), [
        'opus', 'sonnet', 'claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5',
      ]);
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

  {
    const room = createRoom({ chatId: 'session-end-suggestion' });
    const fake = createFakeClaudeSdk({
      endSilently: true,
      onQuery: () => {
      room.promptSuggestion = { text: 'stale after session end', turnRunId: 'run-end' };
      },
    });
    const { runner, events } = createRunner({ room, sdk: fake.sdk });
    await runner.startPrompt('trigger session end');
    assert.equal(room.promptSuggestion, null);
    assert.equal(events.some((event) => event.type === 'promptSuggestion' && event.text === ''), true);
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

  // --- a message from another session is recorded and opens its own run ---
  {
    const fake = createFakeClaudeSdk({ autoResult: false });
    const room = createRoom();
    const peers = [];
    const { runner, events } = createRunner({ room, sdk: fake.sdk, recordPeerMessage: (peer) => peers.push(peer) });
    const first = runner.startPrompt('one');
    await waitFor(() => fake.calls.length === 1 && fake.calls[0].pendingResult);
    fake.calls[0].completeTurn();
    await first;
    const startedBefore = events.filter((event) => event.type === 'sdkPromptStarted').length;
    const eventsBefore = events.length;
    fake.calls[0].emit({
      type: 'user',
      isReplay: true,
      isSynthetic: true,
      parent_tool_use_id: null,
      session_id: SDK_SESSION_ID,
      message: { role: 'user', content: 'wrapped' },
      origin: { kind: 'peer', msg_id: 'msg-1', name: 'my-app-chat-e95fdf1e', body: 'hello' },
    });
    await waitFor(() => peers.length === 1);
    assert.deepEqual(peers, [{ id: 'msg-1', fromName: 'my-app-chat-e95fdf1e', body: 'hello' }]);
    const started = events.filter((event) => event.type === 'sdkPromptStarted');
    assert.equal(started.length, startedBefore + 1);
    assert.equal(started.at(-1).followUp, true);
    assert.equal(room.busy, true);
    assert.deepEqual(events.slice(eventsBefore).filter((event) => event.event?.type === 'user'), []);
    room._activeTurn.finish({ reason: 'result' });
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
    // No auth stamp unless the run supplies one; no invented percentage.
    assert.equal('authMode' in payload, false);
    assert.equal('utilization' in payload, false);
    const stamped = buildClaudeNoticePayload({
      kind: 'notice', noticeType: 'rate_limit', status: 'rejected', utilization: null,
    }, 'run-1', { authMode: 'subscription' });
    assert.equal(stamped.authMode, 'subscription');
    assert.equal('utilization' in stamped, false);
    // Only rate-limit notices carry the scope stamp.
    const retry = buildClaudeNoticePayload({ kind: 'notice', noticeType: 'api_retry' }, 'run-1', { authMode: 'subscription' });
    assert.equal('authMode' in retry, false);
  }


  // --- steering: push into the live input stream (criterion 4) ---
  {
    const textOf = (events) => JSON.stringify(events);
    const ackOf = (events) => events.filter((event) => event.type === 'sdkSteerAck');
    const queuedOf = (events) => events.filter((event) => event.type === 'sdkQueued');
    const idle = () => new Promise((resolve) => setTimeout(resolve, 30));

    // delivered mid-turn; pendingPrompts untouched; second result settles once
    {
      const fake = createFakeClaudeSdk({ autoResult: false });
      const room = createRoom();
      const { runner, events } = createRunner({ room, sdk: fake.sdk });
      const started = runner.startPrompt('one');
      await waitFor(() => fake.calls.length === 1 && fake.calls[0].pendingResult);
      assert.equal(runner.steerPrompt('steered text'), 'delivered');
      assert.equal(room.pendingPrompts.length, 0);
      await waitFor(() => fake.calls[0].messages.length === 2);
      const pushed = fake.calls[0].messages[1];
      assert.equal(extractText(pushed), 'steered text');
      assert.equal(typeof pushed.uuid, 'string');
      assert.equal(ackOf(events).at(-1).outcome, 'complete_delivered');
      fake.calls[0].emit({
        type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: SDK_SESSION_ID,
        user_message_uuids: [pushed.uuid], queued_turn_count: 0,
      });
      await started;
      assert.equal(finishedEvents(events).length, 1);
      assert.equal(room._steerOutstanding.size, 0);
      assert.equal(room.pendingPrompts.length, 0);
    }

    // no live session: queued with revert ack, never dropped
    {
      const fake = createFakeClaudeSdk();
      const room = createRoom({ busy: true });
      const { runner, events } = createRunner({ room, sdk: fake.sdk });
      assert.equal(runner.steerPrompt('late'), 'queued');
      assert.equal(room.pendingPrompts.length, 1);
      assert.equal(room.pendingPrompts[0].text, 'late');
      assert.equal(ackOf(events).at(-1).outcome, 'revert_to_followup');
    }

    // closed input: push returns false -> queued
    {
      const fake = createFakeClaudeSdk({ autoResult: false });
      const room = createRoom();
      const { runner, events } = createRunner({ room, sdk: fake.sdk });
      const started = runner.startPrompt('one');
      await waitFor(() => fake.calls.length === 1 && fake.calls[0].pendingResult);
      room._claudeSession.input.close();
      assert.equal(runner.steerPrompt('closed'), 'queued');
      assert.equal(room.pendingPrompts.length, 1);
      assert.equal(ackOf(events).at(-1).outcome, 'revert_to_followup');
      room.pendingPrompts.length = 0;
      fake.calls[0].completeTurn();
      await started;
    }

    // steer after the final tool round: first result holds, reply of the second result is kept
    {
      const fake = createFakeClaudeSdk({ autoResult: false });
      const room = createRoom();
      const { runner, events } = createRunner({ room, sdk: fake.sdk });
      const started = runner.startPrompt('one');
      await waitFor(() => fake.calls.length === 1 && fake.calls[0].pendingResult);
      assert.equal(runner.steerPrompt('after-last-round'), 'delivered');
      await waitFor(() => fake.calls[0].messages.length === 2);
      const uuid = fake.calls[0].messages[1].uuid;
      fake.calls[0].emit({
        type: 'result', subtype: 'success', is_error: false, result: 'first', session_id: SDK_SESSION_ID,
        user_message_uuids: [], queued_turn_count: 1,
      });
      await idle();
      assert.equal(finishedEvents(events).length, 0, 'turn must not settle on the first result');
      assert.ok(room._activeTurn, 'turn stays active for the steered reply');
      fake.calls[0].emit({
        type: 'assistant',
        session_id: SDK_SESSION_ID,
        message: { role: 'assistant', content: [{ type: 'text', text: 'late-steer-reply' }] },
      });
      fake.calls[0].emit({
        type: 'result', subtype: 'success', is_error: false, result: 'second', session_id: SDK_SESSION_ID,
        user_message_uuids: [uuid], queued_turn_count: 0,
      });
      await started;
      assert.match(textOf(events), /late-steer-reply/);
      assert.equal(finishedEvents(events).length, 1);
      assert.equal(room.pendingPrompts.length, 0);
    }

    // queuedTurnCount 0 with an unlisted steer: settle, requeue once (no hang)
    {
      const fake = createFakeClaudeSdk({ autoResult: false });
      const room = createRoom();
      const { runner, events } = createRunner({ room, sdk: fake.sdk });
      const started = runner.startPrompt('one');
      await waitFor(() => fake.calls.length === 1 && fake.calls[0].pendingResult);
      assert.equal(runner.steerPrompt('zero-queue'), 'delivered');
      fake.calls[0].emit({
        type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: SDK_SESSION_ID,
        user_message_uuids: [], queued_turn_count: 0,
      });
      await started;
      assert.equal(queuedOf(events).filter((event) => event.text === 'zero-queue').length, 1);
      assert.equal(room._steerOutstanding.size, 0);
      await waitFor(() => fake.calls[0].pendingResult && fake.calls[0].messages.length >= 3);
      assert.equal(
        events.filter((event) => event.type === 'sdkEvent' && event.event?.type === 'user' && JSON.stringify(event).includes('zero-queue')).length,
        1,
        'drained steer must not add a second user bubble',
      );
      fake.calls[0].completeTurn();
      await waitFor(() => !room.busy);
    }

    // older CLI: no steering fields -> settle on first result, unconsumed steer queued once
    {
      const fake = createFakeClaudeSdk({ autoResult: false });
      const room = createRoom();
      const { runner, events, persisted } = createRunner({ room, sdk: fake.sdk });
      const started = runner.startPrompt('one');
      await waitFor(() => fake.calls.length === 1 && fake.calls[0].pendingResult);
      assert.equal(runner.steerPrompt('legacy'), 'delivered');
      assert.equal(persisted.filter((event) => event.kind === 'localUser' && event.text === 'legacy').length, 1);
      fake.calls[0].completeTurn();
      await started;
      assert.equal(finishedEvents(events).length >= 1, true);
      assert.equal(queuedOf(events).filter((event) => event.text === 'legacy').length, 1);
      assert.equal(room._steerOutstanding.size, 0);
      // the queued steer is drained as a follow-up turn; finish it
      await waitFor(() => fake.calls[0].pendingResult && fake.calls[0].messages.length >= 3);
      fake.calls[0].completeTurn();
      await waitFor(() => !room.busy);
      assert.equal(persisted.filter((event) => event.kind === 'localUser' && event.text === 'legacy').length, 1);
    }

    // cancel: consumed steer stays in history, unconsumed lands in pendingPrompts once
    {
      const fake = createFakeClaudeSdk({ autoResult: false });
      const room = createRoom();
      const { runner, events, persisted } = createRunner({ room, sdk: fake.sdk });
      const started = runner.startPrompt('one');
      await waitFor(() => fake.calls.length === 1 && fake.calls[0].pendingResult);
      runner.steerPrompt('consumed-one');
      runner.steerPrompt('unconsumed-two');
      await waitFor(() => fake.calls[0].messages.length === 3);
      const [consumedId, unconsumedId] = [fake.calls[0].messages[1].uuid, fake.calls[0].messages[2].uuid];
      fake.state.interruptReceipt = { still_queued: [unconsumedId] };
      fake.calls[0].emit({ type: 'system', subtype: 'status', user_message_uuid: consumedId, session_id: SDK_SESSION_ID });
      await idle();
      await runner.cancelCurrentRun();
      await started;
      const queued = queuedOf(events).map((event) => event.text);
      assert.deepEqual(queued, ['unconsumed-two']);
      assert.equal(room._steerOutstanding.size, 0);
      runner.drainQueue();
      await waitFor(() => fake.calls[0].pendingResult || !room.busy);
      if (room.busy) {
        fake.calls[0].completeTurn();
        await waitFor(() => !room.busy);
      }
      assert.equal(room.pendingPrompts.length, 0, 'cancelled steer drains as a follow-up turn');
      assert.equal(persisted.filter((event) => event.kind === 'localUser' && event.text === 'unconsumed-two').length, 1);
    }
  }

  // --- resume: an empty task-notification turn does not settle the user turn ---
  {
    const fake = createFakeClaudeSdk({ autoResult: false });
    const room = createRoom();
    const { runner, events } = createRunner({ room, sdk: fake.sdk });
    const run = runner.startPrompt('after resume');
    await waitFor(() => fake.calls[0]?.pendingResult);
    const pushedUuid = fake.calls[0].messages.at(-1).uuid;
    assert.ok(pushedUuid, 'the prompt carries a uuid that its result can name');
    // The exact order the CLI uses for a task stopped by the previous process.
    fake.calls[0].emit({ type: 'system', subtype: 'task_notification', task_id: 'a1', status: 'stopped', session_id: SDK_SESSION_ID });
    fake.calls[0].emit({
      type: 'result',
      subtype: 'success',
      result: '',
      num_turns: 0,
      duration_ms: 71,
      origin: { kind: 'task-notification' },
      session_id: SDK_SESSION_ID,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(room.busy, true, 'the stale result leaves the run open');
    assert.equal(finishedEvents(events).length, 0);
    fake.calls[0].completeTurn({ user_message_uuids: [pushedUuid] });
    await run;
    assert.deepEqual(finishedEvents(events).map((event) => event.status), ['completed']);
    assert.equal(events.some((event) => event.code === 'claude_empty_turn'), false);
  }

  // --- one-shot path: the same stale result does not become the run's result ---
  {
    const fake = createFakeClaudeSdk({ autoResult: false });
    const room = createRoom();
    const { runner, events } = createRunner({ room, sdk: fake.sdk, streamingEnabled: false });
    const run = runner.startPrompt('one shot');
    await waitFor(() => fake.calls[0]?.pendingResult);
    fake.calls[0].emit({ type: 'result', subtype: 'error_during_execution', is_error: true, origin: { kind: 'task-notification' }, session_id: SDK_SESSION_ID });
    fake.calls[0].completeTurn();
    await run;
    assert.deepEqual(finishedEvents(events).map((event) => event.status), ['completed']);
  }

  // --- a finished background task opens a follow-up run instead of being lost ---
  {
    const fake = createFakeClaudeSdk({ autoResult: false });
    const room = createRoom();
    const { runner, events, roomStates, broadcastOptions } = createRunner({ room, sdk: fake.sdk });
    const run = runner.startPrompt('start agent');
    await waitFor(() => fake.calls[0]?.pendingResult);
    fake.calls[0].emit({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'a1', task_type: 'local_agent' }, { task_id: 'w1', task_type: 'monitor', ambient: true }],
      session_id: SDK_SESSION_ID,
    });
    await waitFor(() => countClaudeBackgroundTasks(room._claudeSession) === 1);
    assert.equal(hasClaudeBackgroundWork(room), true, 'ambient tasks are not work');
    fake.calls[0].completeTurn();
    await run;
    assert.equal(room.busy, false);
    const noticeIndex = events.findIndex((event) => event.noticeType === 'background_tasks');
    assert.ok(noticeIndex >= 0, 'the idle chat says it is still working');
    assert.equal(events[noticeIndex].runId, finishedEvents(events)[0].runId);
    assert.equal(broadcastOptions[noticeIndex].log, true, 'notice survives room replay');
    assert.equal(roomStates.at(-1).claudeBackgroundTaskCount, 1);
    assert.equal(buildSdkRoomStatePayload(room).claudeBackgroundTaskCount, 1, 'refresh snapshot');

    // Subagent output stays inside its tool call and opens nothing.
    fake.calls[0].emit({
      type: 'assistant',
      parent_tool_use_id: 'toolu_1',
      session_id: SDK_SESSION_ID,
      message: { role: 'assistant', content: [{ type: 'text', text: 'subagent chatter' }] },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(room.busy, false);

    fake.calls[0].emit({ type: 'system', subtype: 'task_notification', task_id: 'a1', status: 'completed', session_id: SDK_SESSION_ID });
    fake.calls[0].emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [], session_id: SDK_SESSION_ID });
    fake.calls[0].emit({
      type: 'assistant',
      session_id: SDK_SESSION_ID,
      message: { role: 'assistant', content: [{ type: 'text', text: 'the plan' }] },
    });
    await waitFor(() => room.busy === true);
    assert.equal(roomStates.at(-1).claudeBackgroundTaskCount, 0);
    const started = events.filter((event) => event.type === 'sdkPromptStarted').at(-1);
    assert.equal(started.followUp, true);
    assert.equal(started.text, '');

    // A prompt sent during the follow-up waits for it.
    await runner.startPrompt('next');
    assert.equal(room.pendingPrompts.length, 1);
    fake.calls[0].emit({
      type: 'result',
      subtype: 'success',
      result: 'the plan',
      num_turns: 1,
      duration_ms: 5,
      origin: { kind: 'task-notification' },
      session_id: SDK_SESSION_ID,
    });
    await waitFor(() => finishedEvents(events).length === 2);
    assert.equal(finishedEvents(events)[1].status, 'completed');
    assert.ok(JSON.stringify(events).includes('the plan'));
    await waitFor(() => fake.calls[0].pendingResult);
    fake.calls[0].completeTurn();
    await waitFor(() => room.busy === false && room.pendingPrompts.length === 0);
    assert.equal(fake.calls.length, 1, 'the follow-up keeps the same session');
  }

  // --- a task list arriving after result still updates the idle room ---
  {
    const fake = createFakeClaudeSdk();
    const room = createRoom();
    const { runner, events, roomStates } = createRunner({ room, sdk: fake.sdk });
    await runner.startPrompt('hello');
    assert.equal(events.some((event) => event.noticeType === 'background_tasks'), false);
    fake.calls[0].emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'shell-late', task_type: 'local_bash' }] });
    await waitFor(() => roomStates.at(-1)?.claudeBackgroundTaskCount === 1);
    assert.equal(room.busy, false, 'a task-list signal does not open a model turn');
    assert.ok(events.some((event) => event.noticeType === 'background_tasks'));
    fake.calls[0].emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    await waitFor(() => roomStates.at(-1)?.claudeBackgroundTaskCount === 0);
    assert.equal(room.busy, false);
  }

  // --- server-driven rooms and cancelled runs never open a follow-up run ---
  for (const fields of [{ delegationId: 'delegation-1' }, { cancelled: true }]) {
    const fake = createFakeClaudeSdk();
    const room = createRoom();
    const { runner, events } = createRunner({ room, sdk: fake.sdk });
    await runner.startPrompt('hello');
    Object.assign(room, fields);
    fake.calls[0].emit({
      type: 'assistant',
      session_id: SDK_SESSION_ID,
      message: { role: 'assistant', content: [{ type: 'text', text: 'late' }] },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(room.busy, false);
    assert.equal(events.filter((event) => event.type === 'sdkPromptStarted').length, 1);
  }

  // --- live background work survives silence beyond the legacy hold ---
  {
    const session = { alive: true, query: {}, input: {} };
    const room = { _claudeSession: session };
    assert.equal(hasClaudeBackgroundWork(room, 1000), false, 'no signal, nothing to hold');
    noteClaudeBackgroundTasks(session, { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'a' }] }, 1000);
    assert.equal(hasClaudeBackgroundWork(room, 1000 + 5_000, 60_000), true);
    assert.equal(hasClaudeBackgroundWork(room, 1000 + 60_000, 60_000), true, 'a silent task still holds');
    assert.equal(hasClaudeBackgroundWork(room, 1000 + 43 * 60_000), true, 'quiet shell task exceeds 30 minutes');
    noteClaudeBackgroundTasks(session, { type: 'system', subtype: 'task_progress', task_id: 'a' }, 50_000);
    assert.equal(hasClaudeBackgroundWork(room, 100_000, 60_000), true, 'progress preserves the live-task hold');
    noteClaudeBackgroundTasks(session, { type: 'system', subtype: 'background_tasks_changed', tasks: [] }, 200_000);
    assert.equal(hasClaudeBackgroundWork(room, 205_000, 60_000), true, 'the result turn is about to start');
    assert.equal(hasClaudeBackgroundWork(room, 216_000, 60_000), false);
    assert.equal(resolveClaudeBackgroundHoldMs({ CRETLI_CLAUDE_BACKGROUND_HOLD_MS: '1000' }), 1000);
    session.alive = false;
    noteClaudeBackgroundTasks(session, { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'a' }] }, 300_000);
    assert.equal(hasClaudeBackgroundWork(room, 300_000), false, 'a dead process holds nothing');
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
