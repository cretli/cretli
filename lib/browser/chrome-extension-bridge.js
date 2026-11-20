/** Claude CLI's extension MCP server, pooled independently of the model harness. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolveClaudeCodeExecutable } from '../claude/claude-sdk.ts';
import { buildClaudeProcessEnv } from '../claude/claude-api-key.ts';
import { registerChildProcess, unregisterChildProcess } from '../child-process-registry.js';

const IDLE_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 30_000;
const MAX_CONNECTIONS = 8;

export function resolveChromeExtensionLaunch() {
  // Chrome uses the local subscription login independently of chat billing.
  const env = Object.fromEntries(Object.entries(buildClaudeProcessEnv({ authMode: 'subscription' })).filter(([, value]) => typeof value === 'string'));
  // Extension site approvals remain in effect even if the parent uses bypass mode.
  delete env.CLAUDE_CHROME_PERMISSION_MODE;
  return { command: resolveClaudeCodeExecutable() || 'claude', args: ['--claude-in-chrome-mcp'], env };
}

export class ChromeExtensionBridge {
  constructor({ launch = resolveChromeExtensionLaunch, idleMs = IDLE_MS } = {}) {
    this.launch = launch;
    this.idleMs = idleMs;
    this.entries = new Map();
  }

  async close(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    clearTimeout(entry.timer);
    await entry.client.close().catch(() => {});
    await entry.transport.close().catch(() => {});
    if (entry.pid) unregisterChildProcess(entry.pid);
  }

  async closeSession(sessionId) {
    const keys = [...this.entries].filter(([, entry]) => entry.sessionId === sessionId).map(([key]) => key);
    await Promise.all(keys.map((key) => this.close(key)));
    return keys.length;
  }

  async closeAll() {
    const keys = [...this.entries.keys()];
    await Promise.all(keys.map((key) => this.close(key)));
    return keys.length;
  }

  async connect(context) {
    const key = JSON.stringify([context.sessionId, context.harness, context.chatId, context.workspaceFolder, context.workspaceFile, context.ownerSessionId]);
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= MAX_CONNECTIONS) throw new Error('Chrome extension session limit reached. Close an unused chat or wait for its connection to expire.');
      const client = new Client({ name: 'cretli-chrome', version: '1.0.0' });
      const transport = new StdioClientTransport({ ...this.launch(), cwd: context.workspaceFolder, stderr: 'pipe' });
      // Keep CLI diagnostics off the MCP channel without filling the pipe.
      transport.stderr?.on('data', () => {});
      entry = { client, transport, sessionId: context.sessionId, pid: 0, timer: null, active: 0, ready: null };
      this.entries.set(key, entry);
      const current = entry;
      client.onclose = () => { if (this.entries.get(key) === current) void this.close(key); };
      entry.ready = (async () => {
        const timer = setTimeout(() => { void this.close(key); }, TIMEOUT_MS);
        timer.unref?.();
        try {
          await client.connect(transport, { timeout: TIMEOUT_MS });
          if (this.entries.get(key) !== current) throw new Error('Chrome extension connection closed during startup.');
          current.pid = transport.pid || 0;
          if (current.pid) registerChildProcess({ pid: current.pid, type: 'mcp-stdio', label: 'claude-chrome' });
          const tools = [];
          let cursor;
          do {
            const page = await client.listTools(cursor ? { cursor } : {}, { timeout: TIMEOUT_MS });
            tools.push(...page.tools);
            cursor = page.nextCursor;
          } while (cursor);
          return tools;
        } finally {
          clearTimeout(timer);
        }
      })();
    }
    return { key, entry };
  }

  async execute(context, toolName, args = {}, signal) {
    signal?.throwIfAborted();
    const { key, entry } = await this.connect(context);
    clearTimeout(entry.timer);
    entry.active += 1;
    try {
      const tools = await entry.ready;
      // Authorization is checked again after startup, before any page action.
      await context.authorize();
      signal?.throwIfAborted();
      if (!toolName) return { tools };
      if (!tools.some((tool) => tool.name === toolName)) throw new Error(`Unknown Chrome extension tool: ${toolName}`);
      return await entry.client.callTool({ name: toolName, arguments: args }, undefined, { timeout: TIMEOUT_MS, signal });
    } catch (error) {
      // Never replay a failed action: it may already have changed the page.
      await this.close(key);
      throw error;
    } finally {
      entry.active -= 1;
      if (entry.active === 0 && this.entries.get(key) === entry) {
        entry.timer = setTimeout(() => { void this.close(key); }, this.idleMs);
        entry.timer.unref?.();
      }
    }
  }
}

export const chromeExtensionBridge = new ChromeExtensionBridge();
