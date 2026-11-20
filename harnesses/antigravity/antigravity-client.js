import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolveAntigravityCli } from './antigravity-config.js';
import { buildAssistantDeltaEvent, buildToolCallEvent } from '../../lib/agent-harness/event-normalizer.ts';

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

export function acpMcpServers(servers) {
  return Object.entries(servers || {}).map(([name, server]) => {
    if (!server.command) throw new Error('Antigravity MCP requires the managed stdio bridge');
    return { name, command: server.command, args: server.args || [], env: Object.entries(server.env || {}).map(([name, value]) => ({ name, value: String(value) })) };
  });
}

/** A fresh ACP process per turn gives bounded lifetime and reloads MCP policy. */
export async function runAntigravityPrompt({ cwd, model, sessionId, prompt, mode, assignment, scoutReadOnly, mcpServers, signal, checkPermission, onSession, onEvent, connectionFactory = (options) => new AntigravityConnection(options) }) {
  if (signal?.aborted) throw new Error('Antigravity run cancelled');
  // ACP permission callbacks alone do not certify a hard read-only boundary.
  if (assignment === 'review' || scoutReadOnly) throw new Error('Antigravity is not certified for read-only review or scout runs');
  let replaying = true;
  let activeSession = '';
  const normalize = createAntigravityEventNormalizer(onEvent);
  const connection = connectionFactory({
    cwd,
    onUpdate: (params) => {
      if (!replaying && params.sessionId === activeSession) normalize(params.update);
    },
    onPermission: async (params) => {
      if (replaying || params.sessionId !== activeSession || signal?.aborted) return { outcome: { outcome: 'cancelled' } };
      // Never grant a lasting permission on behalf of a single Cretli approval.
      const option = params.options?.find((item) => item.kind === 'allow_once');
      if (!option) return { outcome: { outcome: 'cancelled' } };
      const tool = params.toolCall || {};
      const name = ({ execute: 'run_terminal_command', edit: 'edit_file', delete: 'delete_file', read: 'read_file', search: 'grep', fetch: 'web_fetch' })[tool.kind] || tool.name || 'antigravity_tool';
      if (mode === 'plan' || mode === 'ask') {
        if (!['read', 'search', 'think'].includes(tool.kind)) return { outcome: { outcome: 'cancelled' } };
      }
      const decision = await checkPermission(name, tool.rawInput || {});
      return { outcome: decision.outcome === 'proceed' ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } };
    },
  });
  const abort = () => connection.close(new Error('Antigravity run cancelled'));
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const init = await connection.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'cretli', version: '0.5.0' } });
    if (init.protocolVersion !== 1) throw new Error('Antigravity returned an unsupported ACP version');
    if (sessionId && !init.agentCapabilities?.loadSession) throw new Error('This Antigravity CLI cannot resume saved sessions; start a new chat');
    const params = { cwd, mcpServers: acpMcpServers(mcpServers), ...(sessionId ? { sessionId } : {}) };
    const session = await connection.request(sessionId ? 'session/load' : 'session/new', params);
    activeSession = sessionId || session.sessionId;
    if (!activeSession) throw new Error('Antigravity did not return a session id');
    await onSession(activeSession);
    if (model && model !== 'default') {
      const config = session.configOptions?.find((item) => item.category === 'model');
      if (config) await connection.request('session/set_config_option', { sessionId: activeSession, configId: config.id, value: model });
      else await connection.request('session/set_model', { sessionId: activeSession, modelId: model });
    }
    if (mode === 'plan' || mode === 'ask') {
      const plan = session.modes?.availableModes?.find((item) => item.id === 'plan');
      if (!plan) throw new Error('This Antigravity CLI does not advertise a native Plan mode');
      await connection.request('session/set_mode', { sessionId: activeSession, modeId: plan.id });
    } else if (session.modes?.currentModeId === 'plan') {
      const agent = session.modes.availableModes.find((item) => ['agent', 'default', 'code'].includes(item.id));
      if (!agent) throw new Error('This Antigravity session cannot switch from Plan to Agent');
      await connection.request('session/set_mode', { sessionId: activeSession, modeId: agent.id });
    }
    replaying = false;
    const result = await connection.request('session/prompt', { sessionId: activeSession, prompt: [{ type: 'text', text: prompt }] }, 0);
    if (signal?.aborted || result.stopReason === 'cancelled') throw new Error('Antigravity run cancelled');
    if (result.stopReason !== 'end_turn') throw new Error(`Antigravity stopped: ${result.stopReason || 'unknown reason'}`);
    return result;
  } finally {
    signal?.removeEventListener('abort', abort);
    connection.close();
  }
}
