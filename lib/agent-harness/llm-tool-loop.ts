import { randomUUID } from 'crypto';
import { executeTool } from './tool-executor.ts';
import { getToolsForMode } from './tool-definitions.ts';
import { normalizeSdkMode } from '../sdk/sdk-mode.ts';
import {
  buildAssistantFullEvent,
  buildToolCallEvent,
} from './event-normalizer.ts';

// Orchestrator runs (delegation_wait polling, model picks, fanout) routinely
// exceed 25 single-tool-call iterations on harnesses that do not batch calls.
const DEFAULT_MAX_ITERATIONS = 100;
const DEFAULT_MAX_MESSAGES = 80;
const SYSTEM_PROMPT = [
  'You are a coding agent running inside Cretli with access to workspace tools.',
  'Use tools to read, search, and modify files when needed.',
  'Prefer small, focused edits. Explain your plan briefly before large changes.',
  'Workspace paths in tools are relative to the project root.',
].join(' ');

/**
 * Names the workspace so "all changes" / "the project" cannot be read as every
 * checkout the shell can reach.
 */
export function buildLlmSystemPrompt(cwd?: string): string {
  const root = String(cwd || '').trim();
  if (!root) return SYSTEM_PROMPT;
  return [
    SYSTEM_PROMPT,
    `The project root (workspace) of this chat is ${root}; shell commands start there.`,
    'Requests such as "commit", "push" or "all local changes" refer to this workspace repository only.',
    'Other directories and repositories on the machine, including projects named in shared rules or seen in listings, are out of scope:',
    'never modify, commit or push them unless the user names that project explicitly in this chat.',
  ].join(' ');
}

export function getLlmFinishReasonError(finishReason: unknown): string {
  const normalized = String(finishReason || '').trim().toLowerCase();
  if (!normalized) return '';
  if (normalized !== 'network_error') return '';
  return `Provider finish_reason: ${normalized}`;
}

export interface AgentLoopCallbacks {
  onEvent: (event: Record<string, unknown>) => void;
  onFinished?: (status: string, detail?: string) => void;
  isCancelled?: () => boolean;
}

type LlmMessage = Record<string, unknown>;

/** Options accepted by {@link runLlmToolLoop}. */
export interface RunLlmToolLoopOptions {
  transport?: string;
  providerLabel?: string;
  streamChatCompletion: (options: object) => AsyncIterable<Record<string, any>>;
  apiKey?: string;
  model: string;
  cwd: string;
  mode: 'agent' | 'plan';
  assignment?: string;
  delegationId?: string;
  attemptId?: string;
  scoutReadOnly?: boolean;
  messages: LlmMessage[];
  extraTools?: Array<Record<string, unknown>>;
  mcpContext?: object;
  checkPermission?: (name: string, args: object) => Promise<{ outcome: string; message?: string }>;
  signal?: AbortSignal;
  maxIterations?: number;
  /**
   * Called when the start-of-run trim dropped earlier messages. Earlier
   * messages may have carried instruction blocks, so the caller must bump the
   * instruction epoch and re-assemble the required blocks for the next turn.
   */
  onHistoryTrimmed?: (info: { dropped: number; kept: number }) => void;
  callbacks: AgentLoopCallbacks;
}

/** Result of {@link runLlmToolLoop}. */
export interface RunLlmToolLoopResult {
  ok: boolean;
  messages: LlmMessage[];
  status: string;
  error?: string;
}

/**
 * Splits the conversation into atomic units: an assistant message that asks for
 * tool calls stays glued to the tool results answering it. Providers reject a
 * `tool` message whose calling assistant was dropped — Mistral answers 400
 * `invalid_request_message_order` "Unexpected role 'tool' after role 'system'" —
 * so trimming has to cut between units, never inside one.
 */
function splitToolCallUnits(messages: LlmMessage[]): LlmMessage[][] {
  const units: LlmMessage[][] = [];
  for (const message of messages) {
    const open = units[units.length - 1];
    const asksForTools = !!open
      && open[0].role === 'assistant'
      && Array.isArray(open[0].tool_calls)
      && (open[0].tool_calls as unknown[]).length > 0;
    if (message.role === 'tool') {
      // A tool result whose call is gone is invalid on its own: drop it.
      if (asksForTools) open!.push(message);
      continue;
    }
    units.push([message]);
  }
  return units;
}

/**
 * Normalizes the outgoing conversation: system messages first (the pause note is
 * appended at the end of a run and must not stay between tool results and the
 * next prompt), then the newest whole units that fit the budget. The newest unit
 * always survives, even when it alone exceeds the budget.
 */
function trimMessages(messages: LlmMessage[], maxMessages: number): LlmMessage[] {
  const system = messages.filter((msg) => msg.role === 'system');
  const units = splitToolCallUnits(messages.filter((msg) => msg.role !== 'system'));
  const kept: LlmMessage[][] = [];
  let total = system.length;
  for (let index = units.length - 1; index >= 0; index -= 1) {
    if (kept.length > 0 && total + units[index].length > maxMessages) break;
    kept.push(units[index]);
    total += units[index].length;
  }
  kept.reverse();
  return [...system, ...kept.flat()];
}

/**
 * Runs the provider-agnostic tool loop until the model finishes or limits are hit.
 * The transport only selects tool policy and error labels; the stream function
 * must yield the shared chunk shape (deltaText, toolCallDeltas, finishReason, usage, error).
 */
export async function runLlmToolLoop(options: RunLlmToolLoopOptions): Promise<RunLlmToolLoopResult> {
  const transport = options.transport || 'openrouter';
  const providerLabel = options.providerLabel || 'OpenRouter';
  const callbacks = options.callbacks;
  const mode = normalizeSdkMode(options.mode);
  const maxIterations = Number.isFinite(options.maxIterations)
    ? (options.maxIterations as number)
    : DEFAULT_MAX_ITERATIONS;
  let messages = Array.isArray(options.messages) ? [...options.messages] : [];
  if (!messages.some((msg) => msg.role === 'system')) {
    messages.unshift({ role: 'system', content: buildLlmSystemPrompt(options.cwd) });
  }
  const beforeTrim = messages.length;
  messages = trimMessages(messages, DEFAULT_MAX_MESSAGES);
  if (messages.length < beforeTrim) {
    options.onHistoryTrimmed?.({ dropped: beforeTrim - messages.length, kept: messages.length });
  }
  const tools = [
    ...getToolsForMode(mode, options.assignment, transport),
    ...(Array.isArray(options.extraTools) ? options.extraTools : []),
  ];
  let iteration = 0;
  while (iteration < maxIterations) {
    iteration += 1;
    if (callbacks.isCancelled?.()) {
      callbacks.onFinished?.('cancelled');
      return { ok: false, messages, status: 'cancelled' };
    }
    let assistantText = '';
    const pendingToolCalls: Array<{ id: string; name: string; arguments: string }> = [];
    const toolCallBuilders: Record<number, { id?: string; name?: string; arguments?: string }> = {};
    let finishReason = '';
    let lastUsage: Record<string, unknown> | null = null;
    try {
      for await (const chunk of options.streamChatCompletion({
        model: options.model,
        messages,
        tools,
        signal: options.signal,
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      })) {
        if (callbacks.isCancelled?.()) {
          callbacks.onFinished?.('cancelled');
          return { ok: false, messages, status: 'cancelled' };
        }
        if (chunk.error) {
          const message = chunk.error.message || `${providerLabel} stream error`;
          callbacks.onFinished?.('error', message);
          return { ok: false, messages, status: 'error', error: message };
        }
        if (chunk.deltaText) {
          assistantText += chunk.deltaText;
          callbacks.onEvent(buildAssistantFullEvent(assistantText));
        }
        if (Array.isArray(chunk.toolCallDeltas)) {
          for (const delta of chunk.toolCallDeltas) {
            const index = typeof delta.index === 'number' ? delta.index : 0;
            if (!toolCallBuilders[index]) toolCallBuilders[index] = {};
            const entry = toolCallBuilders[index];
            if (typeof delta.id === 'string') entry.id = delta.id;
            if (delta.function && typeof delta.function.name === 'string') {
              entry.name = delta.function.name;
            }
            if (delta.function && typeof delta.function.arguments === 'string') {
              entry.arguments = `${entry.arguments || ''}${delta.function.arguments}`;
            }
          }
        }
        if (chunk.finishReason) finishReason = chunk.finishReason;
        if (chunk.usage && typeof chunk.usage === 'object') lastUsage = chunk.usage;
      }
      // A client that stops yielding on abort ends the stream silently; without
      // this check the cancelled run would be reported as completed.
      if (callbacks.isCancelled?.()) {
        callbacks.onFinished?.('cancelled');
        return { ok: false, messages, status: 'cancelled' };
      }
      if (lastUsage) {
        // Report the usage of *this* loop response. Recording only the last
        // iteration's `lastUsage` after the whole loop would silently drop
        // every earlier request in a tool-calling run. The room kernel records
        // this as one delta per response, so there is no double count.
        callbacks.onEvent({ type: 'usage', usage: lastUsage });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      callbacks.onFinished?.('error', message);
      return { ok: false, messages, status: 'error', error: message };
    }
    for (const key of Object.keys(toolCallBuilders).sort((a, b) => Number(a) - Number(b))) {
      const built = toolCallBuilders[Number(key)];
      if (!built?.name) continue;
      pendingToolCalls.push({
        id: built.id || randomUUID(),
        name: built.name,
        arguments: built.arguments || '{}',
      });
    }
    const finishReasonError = getLlmFinishReasonError(finishReason);
    if (finishReasonError) {
      callbacks.onFinished?.('error', finishReasonError);
      return {
        ok: false,
        messages,
        status: 'error',
        error: finishReasonError,
      };
    }
    if (pendingToolCalls.length === 0) {
      if (assistantText.trim()) {
        messages.push({ role: 'assistant', content: assistantText });
      }
      callbacks.onFinished?.('completed');
      return { ok: true, messages, status: 'completed' };
    }
    const assistantMessage = {
      role: 'assistant',
      content: assistantText || null,
      tool_calls: pendingToolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      })),
    };
    messages.push(assistantMessage);
    for (const call of pendingToolCalls) {
      let parsedArgs = {};
      try {
        parsedArgs = JSON.parse(call.arguments || '{}');
      } catch {
        parsedArgs = {};
      }
      callbacks.onEvent(
        buildToolCallEvent({
          callId: call.id,
          name: call.name,
          status: 'running',
          args: parsedArgs,
        }),
      );
      const result = await executeTool(call.name, parsedArgs, {
        cwd: options.cwd,
        mode,
        assignment: options.assignment,
        delegationId: options.delegationId,
        attemptId: options.attemptId,
        mcpContext: options.mcpContext,
        checkPermission: options.checkPermission,
        scoutReadOnly: options.scoutReadOnly === true,
      });
      const toolContent = result.ok
        ? result.output
        : `Error: ${result.error || 'tool failed'}\n${result.output || ''}`.trim();
      callbacks.onEvent(
        buildToolCallEvent({
          callId: call.id,
          name: call.name,
          status: result.ok ? 'completed' : 'error',
          args: parsedArgs,
          result: { output: toolContent, ok: result.ok },
        }),
      );
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: toolContent,
      });
    }
    if (finishReason === 'stop') {
      callbacks.onFinished?.('completed');
      return { ok: true, messages, status: 'completed' };
    }
  }
  // Reaching the limit is a pause, not a model/tool failure: persist a note so
  // the next prompt resumes with context, and tell the user how to continue.
  messages.push({
    role: 'system',
    content: [
      `The tool loop reached its per-run limit of ${maxIterations} iterations and was paused.`,
      'Everything done so far (tool calls and results) is preserved in this conversation.',
      'When the user sends the next message, continue the task from where it stopped instead of starting over.',
    ].join(' '),
  });
  const limitError = `Max tool iterations reached (${maxIterations}). The conversation was preserved — send another message to continue the run.`;
  callbacks.onFinished?.('error', limitError);
  return { ok: false, messages, status: 'error', error: limitError };
}

export function appendUserMessage(existingMessages: LlmMessage[], userText: string): LlmMessage[] {
  const messages = Array.isArray(existingMessages) ? [...existingMessages] : [];
  messages.push({ role: 'user', content: userText });
  return messages;
}
