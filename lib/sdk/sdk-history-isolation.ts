/**
 * Cursor SDK conversation-store isolation: ignore files on every workspace
 * root, short ignore-scan cache, and reload after create/resume so a session
 * started before the ignore files still picks them up.
 */

import {
  ensureHistoryStoreIgnoreFiles,
  HISTORY_STORE_DIR_NAMES,
} from '../agent-harness/history-store-guard.ts';
import {
  canonicalizeSdkToolStatus,
  normalizeSdkCallId,
  readSdkToolCallId,
  unwrapSdkStreamMessage,
} from './sdk-thinking-state.ts';

export { unwrapSdkStreamMessage };

/** Re-scan project ignore files about once a second so new roots are not sticky. */
export const SDK_WORKSPACE_SCAN_CACHE_TTL_MS = 1000;

export const HISTORY_ISOLATION_MARKER = 'FOREIGN_DELEGATION_MARKER';

/** Contents of the probe hello files — a basename echo is not a successful read. */
export const HELLO_PROBE_CONTENT_A = 'ask-dropdown-hello-a-ok';
export const HELLO_PROBE_CONTENT_B = 'ask-dropdown-hello-b-ok';
export const HELLO_PROBE_CONTENT = HELLO_PROBE_CONTENT_A;

/** A native SDK tool call harvested from stream events / conversation steps. */
export type HarvestedSdkToolCall = {
  name: string;
  status: string;
  args: unknown;
  result: unknown;
  callId?: string;
};

type SdkToolCallRow = {
  name?: unknown;
  status?: unknown;
  args?: unknown;
  result?: unknown;
  callId?: string;
};

export type SdkIsolationAttempt = {
  id?: string;
  toolNeedles?: string[];
  pathNeedles?: string[];
  resultNeedles?: string[];
};

const INCOMPLETE_TOOL_STATUSES = new Set([
  'running',
  'pending',
  'in_progress',
  'started',
  'cancelled',
  'canceled',
  'timeout',
  'timed_out',
]);

/**
 * True when a native tool_call event has finished (success, error, or denial).
 * `running` without a later completed event is not evidence.
 */
export function isCompletedSdkToolCall(call: { status?: unknown; result?: unknown } | null | undefined): boolean {
  if (!call || typeof call !== 'object') return false;
  const status = String(call.status || '').toLowerCase().trim();
  if (INCOMPLETE_TOOL_STATUSES.has(status)) return false;
  if (status) return true;
  return call.result != null;
}

export function applyCursorSdkIsolationConfig(
  sdkModule: { configureCursorSdk?: (options: { local: { workspaceScanCacheTtlMs: number } }) => unknown } | null | undefined,
): void {
  if (typeof sdkModule?.configureCursorSdk !== 'function') return;
  sdkModule.configureCursorSdk({
    local: { workspaceScanCacheTtlMs: SDK_WORKSPACE_SCAN_CACHE_TTL_MS },
  });
}

export function prepareSdkWorkspaceHistoryIsolation(workspaceRoots: unknown): string[] {
  return ensureHistoryStoreIgnoreFiles(workspaceRoots);
}

export async function reloadSdkAgentForIgnore(agent: { reload?: () => unknown } | null | undefined): Promise<void> {
  if (typeof agent?.reload !== 'function') return;
  await agent.reload();
}

export function stringifySdkToolPayload(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Collect native SDK tool_call stream events (args + result). Assistant
 * `tool_use` blocks are recorded as running so a later completed `tool_call`
 * can inherit args when call_id is missing on one side.
 */
export function collectSdkToolCallEvent(event: unknown, bucket: HarvestedSdkToolCall[]): void {
  if (!Array.isArray(bucket)) return;
  const row = unwrapSdkStreamMessage(event);
  if (!row) return;
  if (row.type === 'assistant') {
    const message = row.message && typeof row.message === 'object'
      ? (row.message as Record<string, unknown>)
      : null;
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const part of content) {
      if (!part || typeof part !== 'object' || Array.isArray(part)) continue;
      const block = (part as Record<string, unknown>);
      if (block.type !== 'tool_use') continue;
      const name = String(block.name || '').trim();
      if (!name) continue;
      bucket.push({
        name,
        status: 'running',
        args: block.input ?? block.args,
        result: undefined,
        callId: typeof block.id === 'string' ? normalizeSdkCallId(block.id) : '',
      });
    }
    return;
  }
  if (row.type !== 'tool_call') return;
  bucket.push({
    name: String(row.name || ''),
    status: String(row.status || ''),
    args: row.args,
    result: row.result,
    callId: readSdkToolCallId(row),
  });
}

/**
 * Cursor Read/Glob results often omit `status` (`{ content }` / `{ error }`).
 * Leaving `running` in that case hid completed ignored Reads from the evaluator.
 */
export function statusFromHarvestedSdkToolResult(result: unknown): string {
  return canonicalizeSdkToolStatus({ result }) || 'running';
}

export function normalizeSdkHarvestToolName(raw: unknown): string {
  const text = String(raw || '').trim();
  if (!text) return '';
  const base = text.endsWith('ToolCall') ? text.slice(0, -8) : text;
  return base.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function readConversationSteps(turn: unknown): unknown[] {
  if (!turn || typeof turn !== 'object' || Array.isArray(turn)) return [];
  const row = (turn as Record<string, unknown>);
  const message = row.message && typeof row.message === 'object' && !Array.isArray(row.message)
    ? (row.message as Record<string, unknown>)
    : null;
  const nestedTurn = message?.agentConversationTurn && typeof message.agentConversationTurn === 'object'
    ? (message.agentConversationTurn as Record<string, unknown>)
    : null;
  if (Array.isArray(nestedTurn?.steps)) return nestedTurn.steps;
  if (row.agentConversationTurn && typeof row.agentConversationTurn === 'object') {
    const direct = (row.agentConversationTurn as Record<string, unknown>);
    if (Array.isArray(direct.steps)) return direct.steps;
  }
  if (row.turn && typeof row.turn === 'object' && !Array.isArray(row.turn)) {
    const inner = (row.turn as Record<string, unknown>);
    if (Array.isArray(inner.steps)) return inner.steps;
  }
  if (Array.isArray(row.steps)) return row.steps;
  return [];
}

function pushHarvestedToolCall(
  bucket: HarvestedSdkToolCall[],
  input: { name?: unknown; args?: unknown; result?: unknown; callId?: unknown; rec?: unknown },
): void {
  const name = normalizeSdkHarvestToolName(input.name);
  if (!name) return;
  const rec = input.rec && typeof input.rec === 'object' ? input.rec : null;
  const explicitId = String(input.callId || '').trim();
  bucket.push({
    name,
    status: statusFromHarvestedSdkToolResult(input.result),
    args: input.args,
    result: input.result,
    callId: explicitId || readSdkToolCallId(input) || readSdkToolCallId(rec),
  });
}

function collectFromToolCallMap(toolCall: unknown, bucket: HarvestedSdkToolCall[], rec: unknown): void {
  if (!toolCall || typeof toolCall !== 'object' || Array.isArray(toolCall)) return;
  const map = (toolCall as Record<string, unknown>);
  for (const key of Object.keys(map)) {
    const payload = map[key];
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
    const row = (payload as Record<string, unknown>);
    pushHarvestedToolCall(bucket, {
      name: key || row.type || row.name,
      args: row.args,
      result: row.result,
      callId: readSdkToolCallId(row),
      rec,
    });
  }
}

/**
 * Harvest toolCall steps from `run.conversation()` and `Agent.messages.list`.
 * Conversation() uses `{ type: 'toolCall', message }`. messages.list uses
 * `{ toolCall: { readToolCall: { args, result, toolCallId } } }`. A result
 * without a `status` field still counts as finished.
 */
export function collectSdkConversationToolCalls(conversation: unknown, bucket: HarvestedSdkToolCall[]): void {
  if (!Array.isArray(bucket) || !Array.isArray(conversation)) return;
  for (const turn of conversation) {
    const steps = readConversationSteps(turn);
    for (const step of steps) {
      if (!step || typeof step !== 'object' || Array.isArray(step)) continue;
      const rec = (step as Record<string, unknown>);
      collectFromToolCallMap(rec.toolCall, bucket, rec);
      if (rec.type !== 'toolCall') continue;
      const message = rec.message && typeof rec.message === 'object' && !Array.isArray(rec.message)
        ? (rec.message as Record<string, unknown>)
        : null;
      if (!message) continue;
      pushHarvestedToolCall(bucket, {
        name: message.type || message.name,
        args: message.args,
        result: message.result,
        callId: readSdkToolCallId(message) || readSdkToolCallId(rec),
      });
    }
  }
}

/**
 * Merge streaming running/completed snapshots so args from `running` apply to
 * the later completed event. Pairs by call_id when both sides have it; otherwise
 * FIFO by tool name so a running event without id still attaches to completed.
 */
export function coalesceSdkToolCalls(toolCalls: SdkToolCallRow[]): SdkToolCallRow[] {
  const rows = Array.isArray(toolCalls) ? toolCalls : [];
  const byId = new Map<string, SdkToolCallRow>();
  const fifoByName = new Map<string, SdkToolCallRow[]>();
  function mergeInto(target: SdkToolCallRow, src: SdkToolCallRow) {
    if (src.name) target.name = src.name;
    if (src.args != null) target.args = src.args;
    if (src.result != null) target.result = src.result;
    if (src.callId) target.callId = src.callId;
    if (!src.status) return;
    if (!isCompletedSdkToolCall(target) || isCompletedSdkToolCall(src)) {
      target.status = src.status;
    }
  }
  function fifoStack(name: string) {
    const stack = fifoByName.get(name) || [];
    fifoByName.set(name, stack);
    return stack;
  }
  function pathishKey(args: unknown): string {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
    const row = (args as Record<string, unknown>);
    for (const key of ['path', 'targetDirectory', 'target_directory', 'globPattern']) {
      if (typeof row[key] === 'string' && row[key].trim()) return `${key}:${row[key].trim()}`;
    }
    return '';
  }
  function argsCompatible(prev: SdkToolCallRow, incoming: SdkToolCallRow) {
    if (prev?.args == null || incoming?.args == null) return true;
    const left = pathishKey(prev.args);
    const right = pathishKey(incoming.args);
    if (left && right && left !== right) return false;
    return true;
  }
  function takeCompatible(stack: SdkToolCallRow[], incoming: SdkToolCallRow) {
    const index = stack.findIndex((entry) => argsCompatible(entry, incoming));
    if (index < 0) return null;
    return stack.splice(index, 1)[0];
  }
  function findMergeByName(name: string, incoming: SdkToolCallRow) {
    const matches = [...byId.values()].filter((entry) => String(entry.name || '') === name);
    const open = matches.filter((entry) => !isCompletedSdkToolCall(entry) && argsCompatible(entry, incoming));
    if (open.length) return open[open.length - 1];
    if (incoming?.args != null) {
      const missingArgs = matches.filter((entry) => entry.args == null && argsCompatible(entry, incoming));
      if (missingArgs.length) return missingArgs[missingArgs.length - 1];
    }
    if (incoming?.result != null) {
      const missingResult = matches.filter((entry) => entry.result == null && argsCompatible(entry, incoming));
      if (missingResult.length) return missingResult[missingResult.length - 1];
    }
    return null;
  }
  for (const raw of rows) {
    const name = String(raw?.name || '');
    const callId = String(raw?.callId || '').trim();
    if (callId) {
      let prev = byId.get(callId);
      if (!prev) {
        prev = takeCompatible(fifoStack(name), raw) || {
          name, callId, status: '', args: undefined, result: undefined,
        };
      }
      mergeInto(prev, raw);
      prev.callId = callId;
      byId.set(callId, prev);
      continue;
    }
    const openNamed = findMergeByName(name, raw);
    if (openNamed) {
      mergeInto(openNamed, raw);
      continue;
    }
    const stack = fifoStack(name);
    if (!isCompletedSdkToolCall(raw)) {
      stack.push({
        name,
        status: raw.status,
        args: raw.args,
        result: raw.result,
        callId: '',
      });
      continue;
    }
    const open = takeCompatible(stack, raw) || {
      name, status: '', args: undefined, result: undefined, callId: '',
    };
    mergeInto(open, raw);
    const assignedId = String(open.callId || '').trim() || `fifo:${name}:${finishedPlaceholderId(open)}`;
    open.callId = assignedId;
    byId.set(assignedId, open);
  }
  return [...byId.values(), ...[...fifoByName.values()].flat()];
}

function finishedPlaceholderId(call: SdkToolCallRow): string {
  const args = stringifySdkToolPayload(call?.args).slice(0, 40);
  return `${String(call?.status || 'done')}:${args}`;
}

function isDeniedToolResult(result: unknown): boolean {
  const text = stringifySdkToolPayload(result).toLowerCase();
  if (!text) return false;
  return /denied|not available|conversation history|permission|blocked|ignored|no such file|could not read|access/.test(text);
}

function callMatchesAttempt(call: SdkToolCallRow, attempt: SdkIsolationAttempt): boolean {
  const name = String(call?.name || '').toLowerCase();
  const blob = `${stringifySdkToolPayload(call?.args)}\n${stringifySdkToolPayload(call?.result)}`;
  const toolNeedles = Array.isArray(attempt?.toolNeedles) ? attempt.toolNeedles : [];
  const pathNeedles = Array.isArray(attempt?.pathNeedles) ? attempt.pathNeedles : [];
  const resultNeedles = Array.isArray(attempt?.resultNeedles) ? attempt.resultNeedles : [];
  if (toolNeedles.length && !toolNeedles.some((needle) => name.includes(String(needle).toLowerCase()))) {
    return false;
  }
  if (pathNeedles.length && !pathNeedles.some((needle) => blob.includes(String(needle)))) {
    return false;
  }
  if (!resultNeedles.length) return true;
  if (isDeniedToolResult(call?.result)) return false;
  const resultText = stringifySdkToolPayload(call?.result);
  return resultNeedles.every((needle) => resultText.includes(String(needle)));
}

const EVIDENCE_EXCERPT_MAX = 240;

function excerptSdkPayload(value: unknown): string {
  const text = stringifySdkToolPayload(value).replace(/\s+/g, ' ').trim();
  if (text.length <= EVIDENCE_EXCERPT_MAX) return text;
  return `${text.slice(0, EVIDENCE_EXCERPT_MAX)}…`;
}

/**
 * Map required attempts to completed call_id / path / result excerpts.
 */
export type SdkIsolationAttemptSummary = {
  id: string;
  completed: boolean;
  callId: string;
  name: string;
  status: string;
  argsExcerpt: string;
  resultExcerpt: string;
};

export function summarizeSdkIsolationAttempts(input: {
  toolCalls?: SdkToolCallRow[];
  requiredAttempts?: SdkIsolationAttempt[];
}): SdkIsolationAttemptSummary[] {
  const requiredAttempts = Array.isArray(input?.requiredAttempts) ? input.requiredAttempts : [];
  const toolCalls = coalesceSdkToolCalls(Array.isArray(input?.toolCalls) ? input.toolCalls : []);
  const completedCalls = toolCalls.filter((call) => isCompletedSdkToolCall(call));
  return requiredAttempts.map((attempt) => {
    const id = String(attempt?.id || 'attempt');
    const call = completedCalls.find((row) => callMatchesAttempt(row, attempt));
    if (call) {
      return {
        id,
        completed: true,
        callId: String(call.callId || ''),
        name: String(call.name || ''),
        status: String(call.status || ''),
        argsExcerpt: excerptSdkPayload(call.args),
        resultExcerpt: excerptSdkPayload(call.result),
      };
    }
    const unfinished = toolCalls.find((row) => callMatchesAttempt(
      { ...row, result: row.result ?? row.args },
      { ...attempt, resultNeedles: [] },
    ));
    return {
      id,
      completed: false,
      callId: String(unfinished?.callId || ''),
      name: String(unfinished?.name || ''),
      status: String(unfinished?.status || ''),
      argsExcerpt: excerptSdkPayload(unfinished?.args),
      resultExcerpt: excerptSdkPayload(unfinished?.result),
    };
  });
}

/**
 * Verdict from real tool results (not model prose). A filename in args or a
 * denied error is not a successful hello read. Each required path must have a
 * completed tool attempt (not `running` or cancelled). Error payloads that echo
 * a probe path are not treated as a content leak.
 */
export function evaluateSdkHistoryIsolationEvidence(input: {
  toolCalls?: SdkToolCallRow[];
  marker?: string;
  helloContent?: string;
  helloContents?: string[];
  helloNeedle?: string;
  blockedBasenames?: string[];
  requiredAttempts?: SdkIsolationAttempt[];
}): {
  ok: boolean;
  helloSeen: boolean;
  toolCallCount: number;
  completedToolCallCount: number;
  missingAttempts: string[];
  leaks: Array<{ reason: string; name: string; detail: string }>;
  attempts: ReturnType<typeof summarizeSdkIsolationAttempts>;
} {
  const marker = String(input?.marker || HISTORY_ISOLATION_MARKER);
  const helloContents = Array.isArray(input?.helloContents) && input.helloContents.length
    ? input.helloContents.map(String)
    : [String(input?.helloContent || input?.helloNeedle || HELLO_PROBE_CONTENT)];
  const blockedBasenames = Array.isArray(input?.blockedBasenames)
    ? input.blockedBasenames.filter(Boolean).map(String)
    : [];
  const requiredAttempts = Array.isArray(input?.requiredAttempts) ? input.requiredAttempts : [];
  const toolCalls = coalesceSdkToolCalls(Array.isArray(input?.toolCalls) ? input.toolCalls : []);
  const completedCalls = toolCalls.filter((call) => isCompletedSdkToolCall(call));
  const leaks: Array<{ reason: string; name: string; detail: string }> = [];
  const helloFound = new Set<string>();
  for (const call of completedCalls) {
    const name = String(call?.name || '');
    const resultText = stringifySdkToolPayload(call?.result);
    const denied = isDeniedToolResult(call?.result);
    if (!denied) {
      for (const hello of helloContents) {
        if (hello && resultText.includes(hello)) helloFound.add(hello);
      }
    }
    if (resultText.includes(marker)) {
      leaks.push({ reason: 'marker', name, detail: marker });
      continue;
    }
    if (denied) continue;
    for (const basename of blockedBasenames) {
      if (resultText.includes(basename)) {
        leaks.push({ reason: 'basename', name, detail: basename });
      }
    }
  }
  const missingAttempts = requiredAttempts
    .filter((attempt) => !completedCalls.some((call) => callMatchesAttempt(call, attempt)))
    .map((attempt) => String(attempt?.id || 'attempt'));
  const helloSeen = helloContents.every((hello) => helloFound.has(hello));
  return {
    ok: leaks.length === 0 && helloSeen && completedCalls.length > 0 && missingAttempts.length === 0,
    helloSeen,
    toolCallCount: toolCalls.length,
    completedToolCallCount: completedCalls.length,
    missingAttempts,
    leaks,
    attempts: summarizeSdkIsolationAttempts({ toolCalls, requiredAttempts }),
  };
}

export function historyStoreDirNames(): readonly string[] {
  return HISTORY_STORE_DIR_NAMES;
}
