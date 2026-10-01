/**
 * Long-lived Claude Agent SDK session primitives (Phase 3).
 *
 * One `Query` per room, driven through streaming input: `sdk.query({ prompt:
 * AsyncIterable<SDKUserMessage> })`. Each room turn pushes one user message
 * into `session.input`; the single consumer loop (`session.consumer`) routes
 * SDK messages back to the active turn. Control requests (`setModel`,
 * `setPermissionMode`, `setMcpServers`, `interrupt`) keep the same process and
 * its MCP connections alive across turns.
 *
 * This module stays free of room-kernel/WebSocket concerns so it can be unit
 * tested with a fake SDK.
 */

import { createHash } from 'node:crypto';

/** Idle sessions are closed after this long without an active turn. */
export const CLAUDE_DEFAULT_SESSION_IDLE_MS = 10 * 60 * 1000;

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {number}
 */
export function resolveClaudeSessionIdleMs(env = process.env) {
  const raw = Number(env?.CRETLI_CLAUDE_SESSION_IDLE_MS);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return CLAUDE_DEFAULT_SESSION_IDLE_MS;
}

/**
 * Streaming sessions are the default; `CRETLI_CLAUDE_STREAMING_SESSION=0`
 * falls back to the one-shot `query({ prompt: string })` path.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isClaudeStreamingSessionEnabled(env = process.env) {
  const raw = String(env?.CRETLI_CLAUDE_STREAMING_SESSION ?? '').trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
}

/** `EffortLevel` from `sdk.d.ts` (SDK 0.3.284). */
export const CLAUDE_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * @param {unknown} value
 * @returns {string}
 */
export function parseClaudeEffortLevel(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  return CLAUDE_EFFORT_LEVELS.includes(raw) ? raw : '';
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function parsePositiveInt(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  const int = Math.trunc(parsed);
  return int > 0 ? int : null;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function parsePositiveNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

/**
 * Start-time `Options` that must be chosen before the process spawns. Invalid
 * env values are ignored (the option is omitted). `maxTurns`/`maxBudgetUsd`
 * only apply to delegation runs.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {{ delegation?: boolean }} [options]
 * @returns {{ effort: string, fallbackModel: string, maxTurns: number | null, maxBudgetUsd: number | null }}
 */
export function resolveClaudeRunTuning(env = process.env, options = {}) {
  const source = env && typeof env === 'object' ? env : {};
  const delegation = options.delegation === true;
  return {
    effort: parseClaudeEffortLevel(source.CRETLI_CLAUDE_EFFORT),
    fallbackModel: String(source.CRETLI_CLAUDE_FALLBACK_MODEL || '').trim(),
    maxTurns: delegation ? parsePositiveInt(source.CRETLI_CLAUDE_DELEGATION_MAX_TURNS) : null,
    maxBudgetUsd: delegation
      ? parsePositiveNumber(source.CRETLI_CLAUDE_DELEGATION_MAX_BUDGET_USD)
      : null,
  };
}

/**
 * Stable, secret-free signature of the tuning values that force a restart.
 *
 * @param {{ effort?: unknown, fallbackModel?: unknown, maxTurns?: unknown, maxBudgetUsd?: unknown }} [tuning]
 * @returns {string}
 */
export function buildClaudeTuningSignature(tuning = {}) {
  return [
    `effort=${String(tuning?.effort || '')}`,
    `fallbackModel=${String(tuning?.fallbackModel || '')}`,
    `maxTurns=${tuning?.maxTurns == null ? '' : String(tuning.maxTurns)}`,
    `maxBudgetUsd=${tuning?.maxBudgetUsd == null ? '' : String(tuning.maxBudgetUsd)}`,
  ].join('|');
}

/**
 * A pushable `AsyncIterable` that the SDK consumes as `Options.prompt`.
 * `push()` before a reader is waiting queues the message; `close()` ends the
 * iterator (and any pending `next()`).
 *
 * @returns {{
 *   push: (message: unknown) => boolean,
 *   close: () => void,
 *   isClosed: () => boolean,
 *   size: () => number,
 *   [Symbol.asyncIterator]: () => AsyncIterator<unknown>,
 * }}
 */
export function createClaudeInputStream() {
  /** @type {unknown[]} */
  const queue = [];
  /** @type {Array<(result: IteratorResult<unknown>) => void>} */
  const waiters = [];
  let closed = false;

  /** @type {any} */
  const stream = {
    push(message) {
      if (closed) return false;
      const resolve = waiters.shift();
      if (resolve) {
        resolve({ value: message, done: false });
        return true;
      }
      queue.push(message);
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      while (waiters.length > 0) {
        const resolve = waiters.shift();
        if (resolve) resolve({ value: undefined, done: true });
      }
    },
    isClosed() {
      return closed;
    },
    size() {
      return queue.length;
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift(), done: false });
          }
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => {
            waiters.push(resolve);
          });
        },
        return() {
          stream.close();
          return Promise.resolve({ value: undefined, done: true });
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    },
  };
  return stream;
}

/**
 * Secret-free auth/env signature. Secret values are reduced to short SHA-256
 * fingerprints so a rotated key forces a fresh process, while the value
 * itself never lands in the start key.
 *
 * @param {unknown} authMode
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function buildClaudeAuthSignature(authMode, env) {
  const source = env && typeof env === 'object' ? env : {};
  return [
    `mode=${String(authMode || '').trim()}`,
    `apiKey=${fingerprintSecret(source.ANTHROPIC_API_KEY)}`,
    `oauthToken=${fingerprintSecret(source.CLAUDE_CODE_OAUTH_TOKEN)}`,
    `bedrock=${String(source.CLAUDE_CODE_USE_BEDROCK || '')}`,
    `vertex=${String(source.CLAUDE_CODE_USE_VERTEX || '')}`,
    `foundry=${String(source.CLAUDE_CODE_USE_FOUNDRY || '')}`,
    `awsAccessKey=${fingerprintSecret(source.AWS_ACCESS_KEY_ID)}`,
    `awsSecretKey=${fingerprintSecret(source.AWS_SECRET_ACCESS_KEY)}`,
    `awsSessionToken=${fingerprintSecret(source.AWS_SESSION_TOKEN)}`,
    `awsProfile=${String(source.AWS_PROFILE || '')}`,
    `awsRegion=${String(source.AWS_REGION || source.AWS_DEFAULT_REGION || '')}`,
    `googleCredentials=${String(source.GOOGLE_APPLICATION_CREDENTIALS || '')}`,
    `vertexProject=${String(source.ANTHROPIC_VERTEX_PROJECT_ID || '')}`,
    `vertexRegion=${String(source.ANTHROPIC_VERTEX_REGION || '')}`,
    `foundryKey=${fingerprintSecret(source.ANTHROPIC_FOUNDRY_API_KEY)}`,
    `foundryResource=${String(source.ANTHROPIC_FOUNDRY_RESOURCE || '')}`,
    `configDir=${String(source.CLAUDE_CONFIG_DIR || '').trim()}`,
  ].join('|');
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function fingerprintSecret(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '0';
  return `1:${createHash('sha256').update(text).digest('hex').slice(0, 8)}`;
}

/**
 * @param {unknown} mcpServers
 * @returns {string}
 */
export function buildClaudeMcpSignature(mcpServers) {
  if (!mcpServers || typeof mcpServers !== 'object') return '';
  return Object.keys(mcpServers).sort().join(',');
}

/**
 * Everything that can only be chosen when the process starts. `modeClass`
 * captures the read-only vs agent split because `disallowedTools` and
 * `settingSources` differ between them. MCP is included so a revision change
 * can be detected, but it is handled live when `setMcpServers` exists.
 *
 * @param {{
 *   cwd?: unknown,
 *   readOnly?: unknown,
 *   authSignature?: unknown,
 *   mcpRevision?: unknown,
 *   mcpSignature?: unknown,
 *   tuningSignature?: unknown,
 * }} [input]
 * @returns {{ cwd: string, modeClass: string, authSignature: string, mcpRevision: number, mcpSignature: string, tuningSignature: string }}
 */
export function buildClaudeSessionStartKey(input = {}) {
  return {
    cwd: String(input.cwd || ''),
    modeClass: input.readOnly === true ? 'read-only' : 'agent',
    authSignature: String(input.authSignature || ''),
    mcpRevision: Number.isFinite(Number(input.mcpRevision)) ? Number(input.mcpRevision) : 0,
    mcpSignature: String(input.mcpSignature || ''),
    tuningSignature: String(input.tuningSignature || ''),
  };
}

/**
 * @param {unknown} previous
 * @param {unknown} next
 * @returns {{ stableChanged: boolean, mcpChanged: boolean }}
 */
export function diffClaudeSessionStartKey(previous, next) {
  const prev = previous && typeof previous === 'object' ? previous : {};
  const curr = next && typeof next === 'object' ? next : {};
  const stableChanged = ['cwd', 'modeClass', 'authSignature', 'tuningSignature'].some(
    (key) => prev[key] !== curr[key],
  );
  const mcpChanged = prev.mcpRevision !== curr.mcpRevision
    || prev.mcpSignature !== curr.mcpSignature;
  return { stableChanged, mcpChanged };
}

/**
 * One keyboard turn. `sdk.d.ts` declares `origin` on `SDKUserMessage` and the
 * SDK's own string-prompt path writes `session_id` onto the stream-json wire
 * message, so both are set here.
 *
 * @param {unknown} sessionId
 * @param {unknown} text
 * @returns {Record<string, unknown>}
 */
export function buildClaudeUserMessage(sessionId, text) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  return {
    type: 'user',
    session_id: id,
    message: { role: 'user', content: String(text || '') },
    parent_tool_use_id: null,
    origin: { kind: 'human' },
  };
}

/**
 * @param {unknown} session
 * @returns {boolean}
 */
export function isClaudeSessionAlive(session) {
  return Boolean(
    session
    && typeof session === 'object'
    && /** @type {{ alive?: unknown }} */ (session).alive === true
    && /** @type {{ query?: unknown }} */ (session).query,
  );
}

/**
 * @param {unknown} session
 * @returns {void}
 */
export function clearClaudeSessionIdleTimer(session) {
  if (!session || typeof session !== 'object') return;
  const record = /** @type {{ idleTimer?: ReturnType<typeof setTimeout> | null }} */ (session);
  if (record.idleTimer) {
    clearTimeout(record.idleTimer);
    record.idleTimer = null;
  }
}

/**
 * @param {any} room
 * @returns {number}
 */
export function countRoomPendingClaudeQuestions(room) {
  return room?._pendingQuestions instanceof Map ? room._pendingQuestions.size : 0;
}

/**
 * Pauses the session idle close while AskUserQuestion waits; re-arms when idle.
 *
 * @param {any} room
 * @returns {void}
 */
export function syncClaudeSessionIdleWithPendingQuestions(room) {
  const session = room?._claudeSession;
  if (!isClaudeSessionAlive(session)) return;
  if (countRoomPendingClaudeQuestions(room) > 0) {
    clearClaudeSessionIdleTimer(session);
    return;
  }
  armClaudeSessionIdleTimer(room, session, resolveClaudeSessionIdleMs());
}

/**
 * Starts the Query and its single consumer. The consumer runs for the whole
 * session lifetime; `onMessage` receives every SDK message, `onEnd` fires once
 * when the iterator settles (normal end or exception).
 *
 * @param {{
 *   room?: any,
 *   sdk: { query: Function },
 *   options: Record<string, unknown>,
 *   mode?: string,
 *   model?: string,
 *   permissionMode?: string,
 *   readOnly?: boolean,
 *   authSignature?: string,
 *   mcpRevision?: unknown,
 *   mcpSignature?: string,
 *   tuningSignature?: string,
 *   onMessage: (session: any, message: unknown) => void,
 *   onEnd: (session: any, error: unknown) => void,
 * }} params
 * @returns {any}
 */
export function createClaudeStreamingSession(params) {
  if (!params?.sdk || typeof params.sdk.query !== 'function') {
    throw new Error('Claude Agent SDK is missing query().');
  }
  const input = createClaudeInputStream();
  const query = params.sdk.query({ prompt: input, options: params.options });
  const session = {
    query,
    input,
    startKey: buildClaudeSessionStartKey({
      cwd: params.options?.cwd,
      readOnly: params.readOnly,
      authSignature: params.authSignature,
      mcpRevision: params.mcpRevision,
      mcpSignature: params.mcpSignature,
      tuningSignature: params.tuningSignature,
    }),
    alive: true,
    consumer: null,
    startedAt: Date.now(),
    turns: 0,
    mode: String(params.mode || ''),
    permissionMode: String(params.permissionMode || ''),
    model: String(params.model || ''),
    abortController: params.options?.abortController || null,
    idleTimer: null,
  };
  session.consumer = (async () => {
    let endError = null;
    try {
      for await (const message of query) {
        if (session.alive !== true) break;
        try {
          params.onMessage(session, message);
        } catch {
          // A handler failure must not kill the consumer.
        }
      }
    } catch (err) {
      endError = err;
    }
    session.alive = false;
    clearClaudeSessionIdleTimer(session);
    try {
      params.onEnd(session, endError);
    } catch {
      // ignore end-handler failures
    }
  })();
  if (params.room && typeof params.room === 'object') {
    params.room._claudeSession = session;
  }
  return session;
}

/**
 * Gracefully (or forcefully) closes a room's session. Does not touch
 * `room.claudeSessionId`: the next prompt resumes the conversation.
 *
 * @param {any} room
 * @param {any} [sessionOverride]
 * @returns {void}
 */
export function closeClaudeSession(room, sessionOverride) {
  const session = sessionOverride || room?._claudeSession;
  if (!session || typeof session !== 'object') return;
  clearClaudeSessionIdleTimer(session);
  session.alive = false;
  if (session.input && typeof session.input.close === 'function') {
    try {
      session.input.close();
    } catch {
      // ignore
    }
  }
  if (session.query && typeof session.query.close === 'function') {
    try {
      session.query.close();
    } catch {
      // ignore close failures
    }
  }
  if (room && room._claudeSession === session) room._claudeSession = null;
  if (room && room._activeQuery === session.query) room._activeQuery = null;
  if (room && room._abortController === session.abortController) room._abortController = null;
}

/**
 * Closes the session after an idle period with no active turn. Firing while a
 * turn is running re-arms instead of closing.
 *
 * @param {any} room
 * @param {any} session
 * @param {number} [idleMs]
 * @returns {void}
 */
export function armClaudeSessionIdleTimer(room, session, idleMs = resolveClaudeSessionIdleMs()) {
  if (!session || typeof session !== 'object') return;
  clearClaudeSessionIdleTimer(session);
  if (session.alive !== true) return;
  if (countRoomPendingClaudeQuestions(room) > 0) return;
  const delay = Number(idleMs);
  if (!Number.isFinite(delay) || delay <= 0) return;
  const timer = setTimeout(() => {
    session.idleTimer = null;
    if (room?._claudeSession !== session) return;
    if (room?._activeTurn) {
      armClaudeSessionIdleTimer(room, session, delay);
      return;
    }
    if (countRoomPendingClaudeQuestions(room) > 0) {
      armClaudeSessionIdleTimer(room, session, delay);
      return;
    }
    closeClaudeSession(room, session);
  }, delay);
  if (typeof timer.unref === 'function') timer.unref();
  session.idleTimer = timer;
}
