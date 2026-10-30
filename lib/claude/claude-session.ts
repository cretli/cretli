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
import type { ClaudeSdkModule } from './claude-sdk.ts';

/** Idle sessions are closed after this long without an active turn. */
export const CLAUDE_DEFAULT_SESSION_IDLE_MS = 10 * 60 * 1000;

/**
 * How long a process is kept for background tasks after their last signal. It
 * bounds a task that went silent; progress from a live task restarts it.
 */
export const CLAUDE_DEFAULT_BACKGROUND_HOLD_MS = 30 * 60 * 1000;

/**
 * After the last task ends the CLI needs a moment to start the turn that reads
 * its result, so the session stays held across that gap.
 */
export const CLAUDE_BACKGROUND_SETTLE_MS = 15_000;

const CLAUDE_BACKGROUND_TASK_SUBTYPES = new Set([
  'task_started',
  'task_progress',
  'task_updated',
  'task_notification',
]);

type EnvLike = Record<string, string | undefined>;

/** Loose view of the SDK `Query` object; every control request is optional. */
export interface ClaudeQueryLike extends AsyncIterable<unknown> {
  mcpServerStatus?: () => Promise<unknown>;
  reconnectMcpServer?: (name: string) => Promise<unknown>;
  close?: () => void;
  [key: string]: unknown;
}

/** Long-lived streaming session owned by one room. */
export interface ClaudeSession {
  query: ClaudeQueryLike;
  input: ClaudeInputStream;
  startKey: ClaudeSessionStartKey;
  alive: boolean;
  consumer: Promise<void> | null;
  startedAt: number;
  turns: number;
  mode: string;
  permissionMode: string;
  model: string;
  abortController: AbortController | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Live background task ids, replaced by each `background_tasks_changed`. */
  backgroundTasks?: Set<string>;
  backgroundActivityAt?: number;
  [key: string]: unknown;
}

/** Room fields this module touches; the room kernel owns the rest. */
export interface ClaudeRoomLike {
  _pendingQuestions?: unknown;
  _claudeSession?: ClaudeSession | null;
  _activeQuery?: unknown;
  _abortController?: unknown;
  _activeTurn?: unknown;
  [key: string]: unknown;
}

export function resolveClaudeSessionIdleMs(env: EnvLike = process.env): number {
  const raw = Number(env?.CRETLI_CLAUDE_SESSION_IDLE_MS);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return CLAUDE_DEFAULT_SESSION_IDLE_MS;
}

/**
 * Streaming sessions are the default; `CRETLI_CLAUDE_STREAMING_SESSION=0`
 * falls back to the one-shot `query({ prompt: string })` path.
 */
export function isClaudeStreamingSessionEnabled(env: EnvLike = process.env): boolean {
  const raw = String(env?.CRETLI_CLAUDE_STREAMING_SESSION ?? '').trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
}

/** `EffortLevel` from `sdk.d.ts` (SDK 0.3.284). */
export const CLAUDE_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'] as const);

export function parseClaudeEffortLevel(value: unknown): string {
  const raw = String(value ?? '').trim().toLowerCase();
  return (CLAUDE_EFFORT_LEVELS as readonly string[]).includes(raw) ? raw : '';
}

function parsePositiveInt(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  const int = Math.trunc(parsed);
  return int > 0 ? int : null;
}

function parsePositiveNumber(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

export interface ClaudeRunTuning {
  effort: string;
  fallbackModel: string;
  maxTurns: number | null;
  maxBudgetUsd: number | null;
}

/**
 * Start-time `Options` that must be chosen before the process spawns. Invalid
 * env values are ignored (the option is omitted). `maxTurns`/`maxBudgetUsd`
 * only apply to delegation runs.
 */
export function resolveClaudeRunTuning(
  env: EnvLike = process.env,
  options: { delegation?: boolean } = {},
): ClaudeRunTuning {
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
 */
export function buildClaudeTuningSignature(
  tuning: { effort?: unknown; fallbackModel?: unknown; maxTurns?: unknown; maxBudgetUsd?: unknown } = {},
): string {
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
 */
export interface ClaudeInputStream {
  push: (message: unknown) => boolean;
  close: () => void;
  isClosed: () => boolean;
  size: () => number;
  [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
}

export function createClaudeInputStream(): ClaudeInputStream {
  const queue: unknown[] = [];
  const waiters: Array<(result: IteratorResult<unknown>) => void> = [];
  let closed = false;

  const stream: ClaudeInputStream = {
    push(message: unknown) {
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
        next(): Promise<IteratorResult<unknown>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift(), done: false });
          }
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise<IteratorResult<unknown>>((resolve) => {
            waiters.push(resolve);
          });
        },
        return(): Promise<IteratorResult<unknown>> {
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
 */
export function buildClaudeAuthSignature(authMode: unknown, env?: EnvLike): string {
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

function fingerprintSecret(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '0';
  return `1:${createHash('sha256').update(text).digest('hex').slice(0, 8)}`;
}

export function buildClaudeMcpSignature(mcpServers: unknown): string {
  if (!mcpServers || typeof mcpServers !== 'object') return '';
  return Object.keys(mcpServers).sort().join(',');
}

/**
 * Everything that can only be chosen when the process starts. `modeClass`
 * captures the read-only vs agent split because `disallowedTools` and
 * `settingSources` differ between them. MCP is included so a revision change
 * can be detected, but it is handled live when `setMcpServers` exists.
 */
export interface ClaudeSessionStartKey {
  cwd: string;
  modeClass: string;
  authSignature: string;
  mcpRevision: number;
  mcpSignature: string;
  tuningSignature: string;
}

export function buildClaudeSessionStartKey(
  input: {
    cwd?: unknown;
    readOnly?: unknown;
    authSignature?: unknown;
    mcpRevision?: unknown;
    mcpSignature?: unknown;
    tuningSignature?: unknown;
  } = {},
): ClaudeSessionStartKey {
  return {
    cwd: String(input.cwd || ''),
    modeClass: input.readOnly === true ? 'read-only' : 'agent',
    authSignature: String(input.authSignature || ''),
    mcpRevision: Number.isFinite(Number(input.mcpRevision)) ? Number(input.mcpRevision) : 0,
    mcpSignature: String(input.mcpSignature || ''),
    tuningSignature: String(input.tuningSignature || ''),
  };
}

export function diffClaudeSessionStartKey(
  previous: unknown,
  next: unknown,
): { stableChanged: boolean; mcpChanged: boolean } {
  const prev = (previous && typeof previous === 'object' ? previous : {}) as Record<string, unknown>;
  const curr = (next && typeof next === 'object' ? next : {}) as Record<string, unknown>;
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
 */
export function buildClaudeUserMessage(sessionId: unknown, text: unknown): Record<string, unknown> {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  return {
    type: 'user',
    session_id: id,
    message: { role: 'user', content: String(text || '') },
    parent_tool_use_id: null,
    origin: { kind: 'human' },
  };
}

export function isClaudeSessionAlive(session: unknown): boolean {
  return Boolean(
    session
    && typeof session === 'object'
    && (session as { alive?: unknown }).alive === true
    && (session as { query?: unknown }).query,
  );
}

/** Upper bound for one MCP status/reconnect control request. */
export const CLAUDE_MCP_HEALTH_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Reconnects MCP servers of a reused session that the CLI reports as `failed`.
 * A stdio server that exits (e.g. the Cretli bridge crashing on startup) is
 * never restarted by the CLI on its own, so a long-lived session would keep
 * running every later turn without those tools.
 *
 * Resolves to the names that are still failed after one reconnect attempt;
 * an SDK without the control requests (or a status call that fails) counts as
 * healthy so the turn is never blocked by the probe itself.
 */
export async function reconnectFailedClaudeMcpServers(
  query: ClaudeQueryLike,
  serverNames: string[],
  options: { timeoutMs?: number } = {},
): Promise<{ reconnected: string[]; failed: string[] }> {
  const names = new Set(serverNames.filter(Boolean));
  const result: { reconnected: string[]; failed: string[] } = { reconnected: [], failed: [] };
  if (names.size === 0 || !query || typeof query.mcpServerStatus !== 'function') return result;
  const timeoutMs = options.timeoutMs ?? CLAUDE_MCP_HEALTH_TIMEOUT_MS;
  const failedNames = (statuses: unknown): string[] => (Array.isArray(statuses) ? statuses : [])
    .filter((row) => row && names.has(row.name) && row.status === 'failed')
    .map((row) => String(row.name));
  let failed: string[];
  try {
    failed = failedNames(await withTimeout(query.mcpServerStatus(), timeoutMs));
  } catch {
    return result;
  }
  if (failed.length === 0) return result;
  if (typeof query.reconnectMcpServer !== 'function') {
    result.failed = failed;
    return result;
  }
  for (const name of failed) {
    try {
      await withTimeout(query.reconnectMcpServer(name), timeoutMs);
    } catch {
      // Re-checked below.
    }
  }
  let still: Set<string>;
  try {
    still = new Set(failedNames(await withTimeout(query.mcpServerStatus(), timeoutMs)));
  } catch {
    still = new Set(failed);
  }
  result.failed = failed.filter((name) => still.has(name));
  result.reconnected = failed.filter((name) => !still.has(name));
  return result;
}

export function resolveClaudeBackgroundHoldMs(env: EnvLike = process.env): number {
  const raw = Number(env?.CRETLI_CLAUDE_BACKGROUND_HOLD_MS);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return CLAUDE_DEFAULT_BACKGROUND_HOLD_MS;
}

/** Records one SDK message's effect on the session's background task set. */
export function noteClaudeBackgroundTasks(
  session: ClaudeSession | null | undefined,
  message: unknown,
  now: number = Date.now(),
): void {
  if (!session || typeof session !== 'object' || !message || typeof message !== 'object') return;
  const rec = message as { type?: unknown; subtype?: unknown; tasks?: unknown };
  if (rec.type !== 'system' || typeof rec.subtype !== 'string') return;
  if (rec.subtype === 'background_tasks_changed' && Array.isArray(rec.tasks)) {
    // A level signal: replacing the set survives a missed start or end event.
    // Ambient tasks are watchers, not work that the session waits for.
    const live = (rec.tasks as Array<{ task_id?: unknown; ambient?: unknown }>)
      .filter((task) => task && typeof task.task_id === 'string' && task.ambient !== true)
      .map((task) => task.task_id as string);
    session.backgroundTasks = new Set(live);
    session.backgroundActivityAt = now;
    return;
  }
  if (CLAUDE_BACKGROUND_TASK_SUBTYPES.has(rec.subtype)) session.backgroundActivityAt = now;
}

export function countClaudeBackgroundTasks(session: unknown): number {
  const tasks = (session as ClaudeSession | null | undefined)?.backgroundTasks;
  return tasks instanceof Set ? tasks.size : 0;
}

/**
 * True while closing the room's process would lose background work: a task is
 * still live, or one just ended and the turn reading its result is about to
 * start.
 */
export function hasClaudeBackgroundWork(
  room: ClaudeRoomLike | null | undefined,
  now: number = Date.now(),
  holdMs: number = resolveClaudeBackgroundHoldMs(),
): boolean {
  const session = room?._claudeSession;
  if (!isClaudeSessionAlive(session)) return false;
  const activityAt = Number((session as ClaudeSession).backgroundActivityAt);
  if (!Number.isFinite(activityAt)) return false;
  const quietMs = now - activityAt;
  return countClaudeBackgroundTasks(session) > 0
    ? quietMs < holdMs
    : quietMs < CLAUDE_BACKGROUND_SETTLE_MS;
}

export function clearClaudeSessionIdleTimer(session: unknown): void {
  if (!session || typeof session !== 'object') return;
  const record = session as { idleTimer?: ReturnType<typeof setTimeout> | null };
  if (record.idleTimer) {
    clearTimeout(record.idleTimer);
    record.idleTimer = null;
  }
}

export function countRoomPendingClaudeQuestions(room: ClaudeRoomLike | null | undefined): number {
  return room?._pendingQuestions instanceof Map ? room._pendingQuestions.size : 0;
}

/**
 * Pauses the session idle close while AskUserQuestion waits; re-arms when idle.
 */
export function syncClaudeSessionIdleWithPendingQuestions(room: ClaudeRoomLike | null | undefined): void {
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
 */
export interface CreateClaudeStreamingSessionParams {
  room?: ClaudeRoomLike | null;
  sdk: ClaudeSdkModule;
  options: Record<string, unknown>;
  mode?: string;
  model?: string;
  permissionMode?: string;
  readOnly?: boolean;
  authSignature?: string;
  mcpRevision?: unknown;
  mcpSignature?: string;
  tuningSignature?: string;
  onMessage: (session: ClaudeSession, message: unknown) => void;
  onEnd: (session: ClaudeSession, error: unknown) => void;
}

export function createClaudeStreamingSession(params: CreateClaudeStreamingSessionParams): ClaudeSession {
  if (!params?.sdk || typeof params.sdk.query !== 'function') {
    throw new Error('Claude Agent SDK is missing query().');
  }
  const input = createClaudeInputStream();
  const query = params.sdk.query({ prompt: input, options: params.options });
  const session: ClaudeSession = {
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
    abortController: (params.options?.abortController as AbortController | undefined) || null,
    idleTimer: null,
  };
  session.consumer = (async () => {
    let endError: unknown = null;
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
 */
export function closeClaudeSession(
  room: ClaudeRoomLike | null | undefined,
  sessionOverride?: ClaudeSession | null,
): void {
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
 */
export function armClaudeSessionIdleTimer(
  room: ClaudeRoomLike | null | undefined,
  session: ClaudeSession | null | undefined,
  idleMs: number = resolveClaudeSessionIdleMs(),
): void {
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
    if (countRoomPendingClaudeQuestions(room) > 0 || hasClaudeBackgroundWork(room)) {
      armClaudeSessionIdleTimer(room, session, delay);
      return;
    }
    closeClaudeSession(room, session);
  }, delay);
  if (typeof timer.unref === 'function') timer.unref();
  session.idleTimer = timer;
}
