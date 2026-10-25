import { spawn, type ChildProcessByStdio, type SpawnOptions } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { createInterface, type Interface } from 'node:readline';

/** Child spawned with piped stdin/stdout and ignored stderr. */
export type CodexAppServerChild = ChildProcessByStdio<Writable, Readable, null>;
export type CodexAppServerSpawn = (command: string, args: string[], options: SpawnOptions) => CodexAppServerChild;

/** JSON-RPC message in either direction (loose view; only read fields are listed). */
export interface CodexRpcMessage {
  id?: number | string | null;
  method?: string;
  params?: any;
  result?: any;
  error?: { code?: number; message?: string };
}

/** Thread options passed to `thread/start` / `thread/resume`. */
export interface CodexAppServerThreadOptions {
  workingDirectory: string;
  model: string;
  approvalPolicy: string;
  sandboxMode: string;
  modelReasoningEffort?: string;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Opt-in until the experimental driver reaches SDK parity. */
export function isCodexAppServerEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.CRETLI_CODEX_APP_SERVER === '1';
}

/** Default per-request timeout for app-server JSON-RPC calls. */
export const CODEX_APP_SERVER_REQUEST_TIMEOUT_MS = 30000;

/** Line-delimited app-server RPC connection, owned by one room turn. */
export class CodexAppServer {
  pending = new Map<number | string, PendingRequest>();
  requestTimeoutMs: number;
  failure: Error | null = null;
  nextId = 0;
  onEvent: (event: CodexRpcMessage) => void;
  child: CodexAppServerChild;
  lines: Interface;
  // `declare` keeps these absent until first assigned, as in the JS original.
  declare threadId?: string;
  declare turnId?: string;
  declare rejectTurn?: (error: Error) => void;

  constructor({ cli = 'codex', env, spawnFn = spawn as CodexAppServerSpawn, onEvent = () => {}, requestTimeoutMs = CODEX_APP_SERVER_REQUEST_TIMEOUT_MS }: {
    cli?: string;
    env?: NodeJS.ProcessEnv;
    spawnFn?: CodexAppServerSpawn;
    onEvent?: (event: CodexRpcMessage) => void;
    requestTimeoutMs?: number;
  }) {
    this.requestTimeoutMs = requestTimeoutMs;
    this.onEvent = onEvent;
    this.child = spawnFn(cli, ['app-server', '--stdio'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', (line) => {
      let message: CodexRpcMessage;
      try { message = JSON.parse(line); } catch { return; }
      // Incoming requests have their own id space, which may overlap ours.
      if (message.method && message.id != null) {
        this.send({ id: message.id, error: { code: -32601, message: 'Interactive requests are disabled' } });
      } else if (message.id != null && this.pending.has(message.id)) {
        const request = this.pending.get(message.id) as PendingRequest;
        this.pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error.message || 'Codex RPC failed'));
        else request.resolve(message.result);
      } else if (message.method) this.onEvent(message);
    });
    this.child.on('error', (error: Error) => this.fail(error));
    this.child.on('close', () => this.fail(new Error('Codex app-server closed')));
    this.child.stdin.on('error', (error: Error) => this.fail(error));
  }
  send(message: CodexRpcMessage): void { this.child.stdin.write(`${JSON.stringify(message)}\n`); }
  request(method: string, params: unknown): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex RPC timeout: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  fail(error: Error): void {
    if (!this.failure) this.failure = error;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.rejectTurn?.(error);
  }
  async initialize(options: CodexAppServerThreadOptions, threadId: string | undefined | null, config?: Record<string, unknown>): Promise<string> {
    await this.request('initialize', { clientInfo: { name: 'cretli', version: '1.0.0' } });
    this.send({ method: 'initialized', params: {} });
    const params = {
      cwd: options.workingDirectory, model: options.model,
      approvalPolicy: options.approvalPolicy, sandbox: options.sandboxMode,
      config: { ...config, ...(options.modelReasoningEffort ? { model_reasoning_effort: options.modelReasoningEffort } : {}) },
    };
    const result = await this.request(threadId ? 'thread/resume' : 'thread/start', { ...params, ...(threadId ? { threadId } : {}) });
    const id: string = result.thread.id;
    this.threadId = id;
    return id;
  }
  input(text: string): Array<{ type: 'text'; text: string; text_elements: never[] }> { return [{ type: 'text', text, text_elements: [] }]; }
  async run(text: string, onNotification: (event: CodexRpcMessage) => void): Promise<any> {
    const completed = new Promise<any>((resolve, reject) => {
      this.rejectTurn = reject;
      this.onEvent = (event) => {
        if (event.method === 'turn/started') this.turnId = event.params.turn.id;
        onNotification(event);
        if (event.method === 'turn/completed') resolve(event.params.turn);
      };
    });
    // Attach rejection handling before awaiting turn/start.
    completed.catch(() => {});
    const result = await this.request('turn/start', { threadId: this.threadId, input: this.input(text) });
    this.turnId = result.turn.id;
    return completed;
  }
  steer(text: string, expectedTurnId: string | undefined = this.turnId): Promise<any> {
    return this.request('turn/steer', { threadId: this.threadId, expectedTurnId, input: this.input(text) });
  }
  async interrupt(): Promise<void> {
    await this.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId });
    this.rejectTurn?.(new Error('Codex turn interrupted'));
  }
  close(): void {
    // Fail first: kill() may emit 'close' synchronously, and the first failure wins.
    this.fail(new Error('Codex connection disposed'));
    this.lines.close();
    this.child.kill();
  }
}

/** Token counters in the SDK `turn.completed.usage` shape (snake_case). */
export interface CodexTurnUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

const USAGE_FIELDS: Array<[keyof CodexTurnUsage, string]> = [
  ['input_tokens', 'inputTokens'],
  ['cached_input_tokens', 'cachedInputTokens'],
  ['output_tokens', 'outputTokens'],
  ['reasoning_output_tokens', 'reasoningOutputTokens'],
];

function readUsageCounter(breakdown: any, key: string): number {
  const value = breakdown?.[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Turns `thread/tokenUsage/updated` notifications into the usage the SDK path
 * reports at `turn.completed`. The app-server sends thread-wide totals plus the
 * latest call, so a turn's usage is the growth of the total since the turn began
 * (first total minus that update's own call). Returns a synthetic SDK-shaped
 * `turn.completed` event when the app-server turn completes, otherwise null.
 */
export function createCodexAppServerUsageTracker() {
  let baseline: any = null;
  let latest: any = null;
  return {
    observe(event: CodexRpcMessage): { type: 'turn.completed'; thread_id?: string; usage: CodexTurnUsage } | null {
      if (event.method === 'thread/tokenUsage/updated') {
        const total = event.params?.tokenUsage?.total;
        if (!total || typeof total !== 'object') return null;
        if (!baseline) {
          const last = event.params?.tokenUsage?.last;
          baseline = {};
          for (const [, key] of USAGE_FIELDS) baseline[key] = Math.max(0, readUsageCounter(total, key) - readUsageCounter(last, key));
        }
        latest = total;
        return null;
      }
      if (event.method !== 'turn/completed') return null;
      const total = latest;
      const start = baseline;
      baseline = null;
      latest = null;
      if (!total || event.params?.turn?.error) return null;
      const usage = {} as CodexTurnUsage;
      for (const [field, key] of USAGE_FIELDS) usage[field] = Math.max(0, readUsageCounter(total, key) - (start?.[key] ?? 0));
      return { type: 'turn.completed', thread_id: event.params?.threadId, usage };
    },
  };
}

/**
 * True for native compaction signals: the `thread/compacted` notification and a
 * completed `contextCompaction` item (an app-server may send either or both).
 */
export function isCodexAppServerCompaction(event: CodexRpcMessage): boolean {
  if (event.method === 'thread/compacted') return true;
  return event.method === 'item/completed' && event.params?.item?.type === 'contextCompaction';
}

/**
 * Runs one app-server turn through the production stream path: native usage is
 * folded into an SDK-shaped `turn.completed`, native compaction signals are
 * reported separately, and every notification (or its SDK-shaped replacement)
 * reaches `onEvent`.
 */
export function runCodexAppServerTurn(
  client: Pick<CodexAppServer, 'run'>,
  prompt: string,
  hooks: {
    observe?: (notification: CodexRpcMessage) => void;
    onCompaction?: () => void;
    onEvent: (event: CodexRpcMessage | { type: 'turn.completed'; thread_id?: string; usage: CodexTurnUsage }) => void;
  },
): Promise<any> {
  const usageTracker = createCodexAppServerUsageTracker();
  return client.run(prompt, (notification) => {
    hooks.observe?.(notification);
    if (isCodexAppServerCompaction(notification)) hooks.onCompaction?.();
    hooks.onEvent(usageTracker.observe(notification) || notification);
  });
}
