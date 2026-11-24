import { isMutatingPlanModeShellCommand, readPlanModeShellCommand } from '../../lib/sdk/sdk-plan-guard.ts';
import { isReviewReadOnlyAssignment } from '../../lib/delegation-review-policy.js';
import { configureAntigravitySession } from './antigravity-session-config.js';
import { buildSdkPromptMessage } from '../../lib/sdk/sdk-prompt-images.ts';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolveAntigravityCli } from './antigravity-config.js';
import { buildAssistantDeltaEvent, buildToolCallEvent } from '../../lib/agent-harness/event-normalizer.ts';
import { readAntigravityCommandNames } from './antigravity-context.js';

/** ACP v1 uses one JSON-RPC object per line on stdio. */
export class AntigravityConnection {
  constructor({ cwd, bin = resolveAntigravityCli(), spawnProcess = spawn, onUpdate = (_params) => {}, onPermission = async (_params) => ({ outcome: { outcome: 'cancelled' } }) }) {
    this.nextId = 0;
    this.pending = new Map();
    this.closed = false;
    this.child = spawnProcess(bin, ['acp'], { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    this.onUpdate = onUpdate;
    this.onPermission = onPermission;
    this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.lines.on('line', (line) => {
      if (Buffer.byteLength(line) > 8 * 1024 * 1024) return this.close(new Error('Antigravity ACP message exceeds size limit'));
      try { void this.receive(JSON.parse(line)).catch((error) => this.close(error)); }
      catch { this.close(new Error('Invalid JSON from Antigravity ACP')); }
    });
    // Drain diagnostics separately; they are not protocol events or chat content.
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', (error) => this.close(error));
    this.child.on('error', (error) => this.close(error));
    this.child.on('exit', (code, signal) => this.close(new Error(`Antigravity CLI exited (${signal || code})`)));
  }

  write(message) {
    if (this.closed) throw new Error('Antigravity connection is closed');
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  }

  request(method, params, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error('Antigravity connection is closed'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => this.close(new Error(`Antigravity ${method} timed out`)), timeoutMs) : null;
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (error) { this.close(error); }
    });
  }

  async receive(message) {
    if (message.method === 'session/update') {
      this.onUpdate(message.params);
    } else if (message.method && message.id !== undefined) {
      if (message.method !== 'session/request_permission') {
        this.write({ id: message.id, error: { code: -32601, message: 'Client capability not supported' } });
        return;
      }
      let result;
      try { result = await this.onPermission(message.params); }
      catch { result = { outcome: { outcome: 'cancelled' } }; }
      if (!this.closed) this.write({ id: message.id, result });
    } else if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`Antigravity ACP: ${message.error.message || 'request failed'}`));
      else pending.resolve(message.result);
    }
  }

  close(error = new Error('Antigravity connection closed')) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.lines.close();
    this.child.stdin.destroy();
    const kill = (signal) => {
      if (process.platform !== 'win32' && this.child.pid) {
        try { process.kill(-this.child.pid, signal); } catch { this.child.kill(signal); }
      } else this.child.kill(signal);
    };
    kill('SIGTERM');
    const timer = setTimeout(() => kill('SIGKILL'), 1500);
    timer.unref();
    this.child.once('close', () => clearTimeout(timer));
  }
}

/** Merge partial ACP tool updates by id; text chunks are deltas. */
export function createAntigravityEventNormalizer(onEvent) {
  const tools = new Map();
  let thoughts = '';
  return (update) => {
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
      onEvent(buildAssistantDeltaEvent(update.content.text));
    } else if (update.sessionUpdate === 'agent_thought_chunk' && update.content?.type === 'text') {
      thoughts += update.content.text;
      onEvent({ type: 'thinking', text: thoughts, streamTextMode: 'snapshot' });
    } else if (['tool_call', 'tool_call_update'].includes(update.sessionUpdate)) {
      const patch = Object.fromEntries(Object.entries(update).filter(([, value]) => value != null));
      const tool = { ...tools.get(update.toolCallId), ...patch };
      tools.set(update.toolCallId, tool);
      onEvent(buildToolCallEvent({
        callId: tool.toolCallId, name: tool.name || tool.title || tool.kind || 'tool',
        status: tool.status === 'completed' ? 'completed' : tool.status === 'failed' ? 'error' : 'running',
        args: tool.rawInput && typeof tool.rawInput === 'object' ? tool.rawInput : {},
        result: tool.rawOutput ?? tool.content,
      }));
    }
  };
}

/**
 * Antigravity reports an exhausted account quota as the turn's only assistant
 * text ("⚠ Individual quota reached. … Resets in 166h45m41s.") and still ends
 * the turn with `end_turn`. Returns that notice, or '' for a normal answer.
 *
 * @param {unknown} text the turn's whole assistant text
 * @returns {string}
 */
export function readAntigravityQuotaNotice(text) {
  const notice = String(text || '').replace(/^(?:\s|⚠|️)+/u, '').trim();
  return notice.length <= 500 && /\bquota\s+reached\b/i.test(notice) ? notice : '';
}

/** @param {unknown} value @returns {number|null} */
function readTokenCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

/**
 * Turn the ACP usage signals of one prompt into the shared harness events.
 *
 * `usage_update { used, size }` is the session's current context occupancy
 * and window; the `session/prompt` result carries the turn's token split.
 * Antigravity reports `inputTokens` without cached tokens (disjoint) and
 * counts thought tokens inside `outputTokens`, so the prompt size is
 * input + cache read + cache write.
 *
 * @param {{ result?: any, usageUpdate?: { used?: unknown, size?: unknown } | null, model?: string, observedAt?: string, turnId?: string }} input
 * @returns {Array<Record<string, any>>} `context_usage` (meter/cache samples) and `usage` (ledger) events
 */
export function buildAntigravityUsageEvents({ result, usageUpdate = null, model = '', observedAt = new Date().toISOString(), turnId = '' }) {
  const raw = result?.usage && typeof result.usage === 'object' ? result.usage : null;
  if (!raw) return [];
  const input = readTokenCount(raw.inputTokens);
  const output = readTokenCount(raw.outputTokens);
  if (input == null && output == null) return [];
  const cacheRead = readTokenCount(raw.cachedReadTokens) ?? 0;
  const cacheWrite = readTokenCount(raw.cachedWriteTokens) ?? 0;
  const reasoning = readTokenCount(raw.thoughtTokens);
  const promptTokens = (input ?? 0) + cacheRead + cacheWrite;
  const used = readTokenCount(usageUpdate?.used);
  const window = readTokenCount(usageUpdate?.size);
  const total = used != null && used > 0 ? used : readTokenCount(raw.totalTokens) ?? promptTokens + (output ?? 0);
  const ledgerUsage = {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    ...(reasoning != null && output != null && reasoning <= output ? { reasoningTokens: reasoning } : {}),
  };
  const events = [];
  if (promptTokens > 0 && total > 0) {
    events.push({
      type: 'context_usage',
      source: 'antigravity-acp',
      model,
      usage: {
        inputTokens: promptTokens,
        outputTokens: output,
        totalTokens: total,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        ...(ledgerUsage.reasoningTokens != null ? { reasoningTokens: ledgerUsage.reasoningTokens } : {}),
      },
      contextWindowTokens: window != null && window > 0 ? window : null,
      observedAt,
      ...(turnId ? { turnId } : {}),
    });
  }
  events.push({ type: 'usage', model, usage: ledgerUsage, final: true, ...(turnId ? { turnId } : {}) });
  return events;
}

export function acpMcpServers(servers) {
  return Object.entries(servers || {}).map(([name, server]) => {
    if (!server.command) throw new Error('Antigravity MCP requires the managed stdio bridge');
    return { name, command: server.command, args: server.args || [], env: Object.entries(server.env || {}).map(([name, value]) => ({ name, value: String(value) })) };
  });
}

/** A fresh ACP process per turn gives bounded lifetime and reloads MCP policy. */
export async function runAntigravityPrompt({ cwd, model, sessionId, prompt, mode, assignment, scoutReadOnly, mcpServers, signal, checkPermission, onSession, onEvent, onConfiguration = (_config) => {}, promptImageOptions = {}, turnId = '', onCommands = (_names) => {}, onSessionDropped = async () => {}, connectionFactory = (options) => new AntigravityConnection(options) }) {
  if (signal?.aborted) throw new Error('Antigravity run cancelled');
  // Scout requires certified enforcement; review has a separate uncertified opt-in.
  if (scoutReadOnly) throw new Error('Antigravity is not certified for read-only scout runs');
  const review = isReviewReadOnlyAssignment(assignment);
  if (review) mode = 'plan';
  let replaying = true;
  let activeSession = '';
  /** @type {{ used?: unknown, size?: unknown } | null} */
  let usageUpdate = null;
  let replayed = 0;
  let assistantText = '';
  let toolCalls = 0;
  const normalize = createAntigravityEventNormalizer(onEvent);
  const connection = connectionFactory({
    cwd,
    onUpdate: (params) => {
      const kind = params.update?.sessionUpdate;
      if (kind === 'available_commands_update') {
        const names = readAntigravityCommandNames(params.update);
        if (names.length) onCommands(names);
        return;
      }
      if (replaying) {
        // History replay of the resumed session proves it still exists.
        if (sessionId && params.sessionId === sessionId && !['usage_update', 'session_info_update'].includes(kind)) replayed += 1;
        return;
      }
      if (params.sessionId !== activeSession) return;
      if (kind === 'usage_update') usageUpdate = params.update;
      else {
        if (kind === 'agent_message_chunk' && params.update.content?.type === 'text') assistantText += params.update.content.text;
        else if (kind === 'tool_call') toolCalls += 1;
        normalize(params.update);
      }
    },
    onPermission: async (params) => {
      if (replaying || params.sessionId !== activeSession || signal?.aborted) return { outcome: { outcome: 'cancelled' } };
      // Never grant a lasting permission on behalf of a single Cretli approval.
      const option = params.options?.find((item) => item.kind === 'allow_once');
      if (!option) return { outcome: { outcome: 'cancelled' } };
      const tool = params.toolCall || {};
      const name = ({ execute: 'run_terminal_command', edit: 'edit_file', delete: 'delete_file', read: 'read_file', search: 'grep', fetch: 'web_fetch' })[tool.kind] || tool.name || 'antigravity_tool';
      let input = tool.rawInput || {};
      if (mode === 'plan' || mode === 'ask') {
        if (review && tool.kind === 'execute') {
          // ACP uses CommandLine; the shared host permission gate expects command.
          const command = readPlanModeShellCommand(input.CommandLine ?? input.command ?? input.commandLine ?? input.cmd);
          if (!command || isMutatingPlanModeShellCommand(command)) return { outcome: { outcome: 'cancelled' } };
          input = { ...input, command };
        } else if (!['read', 'search', 'think'].includes(tool.kind)) {
          return { outcome: { outcome: 'cancelled' } };
        }
      }
      const decision = await checkPermission(name, input);
      return { outcome: decision.outcome === 'proceed' ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } };
    },
  });
  let cancelTimer;
  const abort = () => {
    const error = new Error('Antigravity run cancelled');
    if (!replaying && activeSession && typeof connection.write === 'function') {
      try {
        connection.write({ method: 'session/cancel', params: { sessionId: activeSession } });
        cancelTimer = setTimeout(() => connection.close(error), 1500);
        cancelTimer.unref();
        return;
      } catch { /* A broken pipe still needs immediate process cleanup. */ }
    }
    connection.close(error);
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) abort();
    const init = await connection.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'cretli', version: '0.5.0' } });
    if (init.protocolVersion !== 1) throw new Error('Antigravity returned an unsupported ACP version');
    if (sessionId && !init.agentCapabilities?.loadSession) throw new Error('This Antigravity CLI cannot resume saved sessions; start a new chat');
    const params = { cwd, mcpServers: acpMcpServers(mcpServers), ...(sessionId ? { sessionId } : {}) };
    const session = await connection.request(sessionId ? 'session/load' : 'session/new', params);
    activeSession = sessionId || session.sessionId;
    if (!activeSession) throw new Error('Antigravity did not return a session id');
    // Loading an unknown id silently yields an empty session; the model lost the history.
    if (sessionId && replayed === 0) await onSessionDropped();
    await onSession(activeSession);
    const configuration = await configureAntigravitySession(connection, activeSession, session, { model, mode });
    onConfiguration(configuration);
    const message = await buildSdkPromptMessage(prompt, promptImageOptions);
    /** @type {Array<{ type: string, text?: string, data?: string, mimeType?: string }>} */
    const promptBlocks = [{ type: 'text', text: typeof message === 'string' ? message : message.text }];
    if (typeof message !== 'string') {
      if (!init.agentCapabilities?.promptCapabilities?.image) throw new Error('This Antigravity CLI does not support image attachments');
      for (const image of message.images) promptBlocks.push({ type: 'image', data: image.data, mimeType: image.mimeType });
    }
    if (signal?.aborted) throw new Error('Antigravity run cancelled');
    replaying = false;
    const result = await connection.request('session/prompt', { sessionId: activeSession, prompt: promptBlocks }, 0);
    if (signal?.aborted || result.stopReason === 'cancelled') throw new Error('Antigravity run cancelled');
    // Usage is reported before an error stop too: those tokens were still spent.
    const usageModel = String(model && model !== 'default' ? model : configuration?.modelId || '');
    for (const event of buildAntigravityUsageEvents({ result, usageUpdate, model: usageModel, turnId })) onEvent(event);
    if (result.stopReason !== 'end_turn') throw new Error(`Antigravity stopped: ${result.stopReason || 'unknown reason'}`);
    // A quota notice is a provider refusal, not an answer: fail the run so the
    // shared usage-limit store locks the harness until the stated reset.
    const quota = toolCalls === 0 ? readAntigravityQuotaNotice(assistantText) : '';
    if (quota) throw new Error(`Antigravity usage limit: ${quota}`);
    return result;
  } finally {
    clearTimeout(cancelTimer);
    signal?.removeEventListener('abort', abort);
    connection.close();
  }
}
