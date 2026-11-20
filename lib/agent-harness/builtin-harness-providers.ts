/**
 * Static descriptors for built-in harness providers.
 *
 * This module is the one place that wires a built-in harness's runtime into
 * the host: its WebSocket chat handler, its HTTP routes, its live room
 * (diagnostics, dispose, model sync) and the create-chat readiness gate. Core
 * modules (ws-router, register-app-routes, chats-routes) iterate these
 * descriptors instead of importing each harness by name, so a harness can later move to a plugin by leaving this
 * list (docs/ts-migration-and-core-harnesses-plan.md, B2).
 *
 * `sdk` (Cursor) has no descriptor: it stays the router's catch-all. MCP
 * adapters are NOT here: lib/mcp/adapters/index.js must stay a leaf-only
 * registry, because importing this module from the MCP session graph creates
 * an initialization cycle through the harness WebSocket modules.
 *
 * Handlers are imported statically on purpose: several of those modules
 * register their chat-run adapter as an import side effect
 * (`registerChatRunAdapter`), so a dynamic import would change when the adapter
 * becomes available. This module is read-only once evaluated.
 *
 * Built-in descriptors are intentionally NOT local plugin manifests and must
 * never be fed to `validateHarnessPluginManifest`: that validator reserves the
 * built-in transport ids for local plugins. Reusing only the shared closed
 * capability key set keeps the declarative shape aligned without validating a
 * built-in.
 */

import {
  handleClaudeAgentWebSocket,
  disposeClaudeRoom,
  getClaudeRoomDiag,
  syncClaudeRoomModelFromChat,
} from '../claude/claude-agent-ws.ts';
import {
  handleCodexAgentWebSocket,
  disposeCodexRoom,
  getCodexRoomDiag,
  syncCodexRoomModelFromChat,
} from '../codex/codex-agent-ws.ts';
import { registerClaudeRoutes } from '../routes/claude-routes.js';
import { registerCodexRoutes } from '../routes/codex-routes.js';
import { hasCodexCredentials } from '../codex/codex-credentials.ts';
import { getCodexCliMissingHint, isCodexCliFound } from '../codex/codex-cli.ts';
import { isCodexSdkAvailable } from '../codex/codex-sdk.ts';
import { isClaudeHarnessConfigured } from '../claude/claude-api-key.ts';
import { isClaudeSdkAvailable } from '../claude/claude-sdk.ts';
import { HARNESS_PLUGIN_CAPABILITY_KEYS } from './harness-plugin-contract.ts';
import { getHarnessMeta } from './registry.ts';
import type { WebSocket } from 'ws';
import type { HarnessProcessLifecycle } from './harness-plugin-contract.ts';

/**
 * Build the closed capability block for a built-in provider: every shared key
 * is present and boolean, and anything not explicitly enabled is `false`.
 */
function buildCapabilities(overrides: Record<string, boolean> = {}): Readonly<Record<string, boolean>> {
  return Object.freeze(Object.fromEntries(
    HARNESS_PLUGIN_CAPABILITY_KEYS.map((key) => [key, overrides[key] === true]),
  ));
}

/**
 * Deps ws-router passes to every harness chat handler.
 */
export interface HarnessWsDeps {
  workspaceDirForAgent: (workspaceFile: string | null) => string;
  todoSyncDataDir?: string;
}

export type HarnessChatHandler = (ws: WebSocket, sessionKey: string, deps: HarnessWsDeps) => unknown;

/**
 * Context handed to `registerRoutes`; the subset of the register-app-routes
 * context that built-in harness routes read.
 */
export interface HarnessRoutesContext {
  workspaceDirForAgent: (workspaceFile?: string | null) => string;
}

/**
 * A harness's live chat room, keyed by the chat's session id.
 */
export interface HarnessRoom {
  getDiag: (sessionId: string) => unknown;
  dispose: (sessionId: string) => unknown;
  syncModel: ((sessionId: string, model: string) => unknown) | null;
}

/**
 * What the create-chat gate knows about the request; resolved lazily because
 * only some harnesses need it.
 */
export interface HarnessCreateContext {
  resolveWorkspaceFolder: () => string;
}

export interface BuiltinHarnessProvider {
  /** Stable built-in transport id. */
  id: string;
  /** Built-in origin marker. */
  origin: 'builtin' | 'builtin-optional';
  /** Human label, synchronized with the harness registry. */
  label: string;
  /** Human description, synchronized with the registry. */
  description: string;
  /** Closed declarative capability set. */
  capabilities: Readonly<Record<string, boolean>>;
  /** Existing WebSocket handler. */
  handler: HarnessChatHandler;
  /** Log label when the handler run fails (`[ws] <label> failed`). */
  handlerLabel: string;
  /** Registers the harness HTTP routes. */
  registerRoutes: (app: object, ctx: HarnessRoutesContext) => void;
  /** Live room operations (`syncModel` null: no model to sync). */
  room: HarnessRoom;
  /** Create-chat gate: a user-facing reason (HTTP 503) or `null` when ready. */
  checkCreateReady: (ctx: HarnessCreateContext) => Promise<string | null>;
  /** Default title is `<prefix> chat <n>`. */
  chatTitlePrefix: string;
  /** The status tail is read from chat history. */
  historyStatusTail: boolean;
  /** Optional process start/stop/monitor hook; core iterates providers that expose it. */
  processLifecycle: HarnessProcessLifecycle | null;
  /**
   * Restarts the harness runtime after a saved settings change its settings
   * module flags (`requiresRuntimeReset`).
   */
  resetRuntime: (() => unknown) | null;
}

export interface BuiltinHarnessProviderSpec {
  fallbackLabel: string;
  fallbackDescription: string;
  capabilities: Record<string, boolean>;
  handler: HarnessChatHandler;
  handlerLabel: string;
  registerRoutes: (app: object, ctx: HarnessRoutesContext) => void;
  room: HarnessRoom;
  checkCreateReady: (ctx: HarnessCreateContext) => Promise<string | null>;
  chatTitlePrefix: string;
  historyStatusTail: boolean;
  resetRuntime?: () => unknown;
  processLifecycle?: HarnessProcessLifecycle;
}

export function defineBuiltinProvider(
  id: string,
  spec: BuiltinHarnessProviderSpec,
  origin: 'builtin' | 'builtin-optional' = 'builtin',
): BuiltinHarnessProvider {
  const meta = getHarnessMeta(id);
  return Object.freeze({
    id,
    origin,
    label: meta?.label || spec.fallbackLabel,
    description: meta?.description || spec.fallbackDescription,
    capabilities: buildCapabilities(spec.capabilities),
    handler: spec.handler,
    handlerLabel: spec.handlerLabel,
    registerRoutes: spec.registerRoutes,
    room: Object.freeze({ ...spec.room }),
    checkCreateReady: spec.checkCreateReady,
    chatTitlePrefix: spec.chatTitlePrefix,
    historyStatusTail: spec.historyStatusTail,
    resetRuntime: spec.resetRuntime || null,
    processLifecycle: spec.processLifecycle || null,
  });
}

/** Codex is a core built-in transport; the descriptor only centralizes its wiring. */
export const CODEX_HARNESS_PROVIDER = defineBuiltinProvider('codex', {
  fallbackLabel: 'Codex SDK',
  fallbackDescription: 'OpenAI Codex local agent harness.',
  capabilities: { chat: true, models: true },
  handler: handleCodexAgentWebSocket,
  handlerLabel: 'Codex agent handler',
  registerRoutes: (app) => registerCodexRoutes(app),
  room: { getDiag: getCodexRoomDiag, dispose: disposeCodexRoom, syncModel: syncCodexRoomModelFromChat },
  checkCreateReady: async () => {
    if (!hasCodexCredentials()) {
      return 'Codex chat requires ChatGPT sign-in or an API key in Settings → Harness → Codex.';
    }
    if (!(await isCodexSdkAvailable())) {
      return 'Codex SDK is not installed. Run npm install @openai/codex-sdk.';
    }
    if (!isCodexCliFound()) return getCodexCliMissingHint();
    return null;
  },
  chatTitlePrefix: 'Codex',
  historyStatusTail: true,
});

/**
 * Claude Code is a core built-in transport (its id is reserved against local
 * plugins); this descriptor only centralizes its existing wiring and does not
 * alter authentication or chat lifecycle.
 */
export const CLAUDE_HARNESS_PROVIDER = defineBuiltinProvider('claude', {
  fallbackLabel: 'Claude Code',
  fallbackDescription: 'Claude Agent SDK harness.',
  capabilities: { chat: true, models: true },
  handler: handleClaudeAgentWebSocket,
  handlerLabel: 'Claude agent handler',
  registerRoutes: (app) => registerClaudeRoutes(app),
  room: { getDiag: getClaudeRoomDiag, dispose: disposeClaudeRoom, syncModel: syncClaudeRoomModelFromChat },
  checkCreateReady: async () => {
    if (!isClaudeHarnessConfigured()) {
      return 'Claude chat requires Anthropic API/provider credentials: set ANTHROPIC_API_KEY or configure Bedrock, Vertex, or Foundry with your own provider credentials.';
    }
    if (!(await isClaudeSdkAvailable())) {
      return 'Claude Agent SDK is not installed. Run npm install @anthropic-ai/claude-agent-sdk.';
    }
    return null;
  },
  chatTitlePrefix: 'Claude',
  historyStatusTail: true,
});

/**
 * Order is the HTTP route registration order used before the registry existed;
 * keep it stable so route precedence does not change.
 */
const BUILTIN_HARNESS_PROVIDER_LIST: readonly BuiltinHarnessProvider[] = Object.freeze([
  CODEX_HARNESS_PROVIDER,
  CLAUDE_HARNESS_PROVIDER,
]);

const BUILTIN_HARNESS_PROVIDER_BY_ID: Readonly<Record<string, BuiltinHarnessProvider | undefined>> = Object.freeze(
  Object.fromEntries(BUILTIN_HARNESS_PROVIDER_LIST.map((provider) => [provider.id, provider])),
);

/**
 * Providers contributed by repo harness plugins (heavy entry), registered once
 * at boot after the built-ins. Empty unless a plugin is enabled.
 */
const OPTIONAL_HARNESS_PROVIDERS: BuiltinHarnessProvider[] = [];

/**
 * Add a plugin's provider. An id that is already served is refused.
 */
export function registerOptionalHarnessProvider(
  provider: BuiltinHarnessProvider,
): { ok: true } | { ok: false; code: 'id_collision'; error: string } {
  if (getBuiltinHarnessProvider(provider.id)) {
    return { ok: false, code: 'id_collision', error: `Harness provider "${provider.id}" is already registered` };
  }
  OPTIONAL_HARNESS_PROVIDERS.push(provider);
  return { ok: true };
}

/**
 * @returns A fresh array: built-ins first, then plugin providers.
 */
export function listBuiltinHarnessProviders(): BuiltinHarnessProvider[] {
  return [...BUILTIN_HARNESS_PROVIDER_LIST, ...OPTIONAL_HARNESS_PROVIDERS];
}

/**
 * Providers that expose a `processLifecycle` hook, in registration order.
 */
export function listProcessLifecycleProviders(): Array<BuiltinHarnessProvider & { processLifecycle: HarnessProcessLifecycle }> {
  return listBuiltinHarnessProviders().filter((provider) => provider.processLifecycle) as Array<BuiltinHarnessProvider & { processLifecycle: HarnessProcessLifecycle }>;
}

/**
 * Look up a built-in provider descriptor by id. Ids are matched case- and
 * whitespace-insensitively; unknown/blank ids return `null`.
 */
export function getBuiltinHarnessProvider(rawId: unknown): BuiltinHarnessProvider | null {
  const id = typeof rawId === 'string' ? rawId.trim().toLowerCase() : '';
  if (!id) return null;
  return BUILTIN_HARNESS_PROVIDER_BY_ID[id] || OPTIONAL_HARNESS_PROVIDERS.find((provider) => provider.id === id) || null;
}

/**
 * Return the declared chat handler for a built-in provider, or `null` when the
 * provider or its handler is missing/not callable.
 */
export function getBuiltinHarnessChatHandler(rawId: unknown): HarnessChatHandler | null {
  const provider = getBuiltinHarnessProvider(rawId);
  if (provider && typeof provider.handler === 'function') return provider.handler;
  return null;
}

/**
 * Resolve the chat handler for a built-in provider, falling back to the
 * caller-supplied handler when the descriptor is unavailable.
 */
export function resolveBuiltinHarnessChatHandler(
  rawId: unknown,
  fallbackHandler: HarnessChatHandler | null = null,
): HarnessChatHandler | null {
  const handler = getBuiltinHarnessChatHandler(rawId);
  if (handler) return handler;
  return typeof fallbackHandler === 'function' ? fallbackHandler : null;
}

/**
 * Register every built-in harness's HTTP routes, in list order.
 *
 * @param app Express app.
 */
export function registerBuiltinHarnessRoutes(app: object, ctx: HarnessRoutesContext): void {
  for (const provider of listBuiltinHarnessProviders()) provider.registerRoutes(app, ctx);
}
