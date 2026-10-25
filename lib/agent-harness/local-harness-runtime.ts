/**
 * Runtime bridge for local harness plugins.
 *
 * This is the narrow production vertical slice that turns an explicitly enabled
 * and discovered local plugin into a running chat harness. It owns four
 * things and nothing else:
 *
 *  1. A per-process catalog cache so a WebSocket event never re-scans the
 *     plugin root (`discoverHarnessPlugins` runs at most once per root).
 *  2. A per-process module cache so a plugin entry is imported at most once per
 *     id. The import happens only after the id is currently discovered, listed
 *     in `settings.enabledLocalHarnesses`, declares `capabilities.chat === true`,
 *     and passes the shared `hostMin` host-version gate.
 *  3. The tiny chat entry contract: a loaded module must export
 *     `handleChatWebSocket({ ws, sessionKey, chat })` and
 *     `disposeSession(sessionKey)`. Missing exports are a hard failure; the
 *     dispatcher then closes the socket instead of ever falling back to the SDK.
 *     The handler speaks the existing `/ws-agent-sdk` protocol directly: the
 *     client sends `send`/`cancel`/`ping` and the plugin answers with
 *     `hello`/`sdkEvent`/`sdkRunFinished`/`sdkError`/`pong`. The runtime does not
 *     wrap or translate that protocol.
 *  4. A per-(id, sessionKey, module instance) live session refcount: every
 *     successful dispatch acquires one reference on the exact loaded module, and
 *     a socket close releases only its own reference. `disposeSession` runs
 *     exactly once, after the last live socket for that module/session closes.
 *     A replacement that resolves a different module instance forms its own
 *     group, so the old module is disposed when its own last socket closes while
 *     the new module stays pinned. An explicit dispose (chat DELETE) disposes
 *     every live module group for the key once and makes later closes no-ops.
 *     Groups are removed once they hold no live references, so nothing unbounded
 *     accumulates and a stale close can never dispose a replacement session's
 *     module.
 *
 * Trust model (unchanged from the loader): the root is an admin-controlled
 * environment variable, `import()` runs with full host privileges, and there is
 * no remote install. The catalog manifest is only an index hint — the loader
 * re-reads and re-validates `harness-plugin.json` from disk before importing.
 *
 * Deliberately out of scope: vendor resume, model lists, MCP, delegation,
 * server-run, and OAuth.
 */

import { readFileSync } from 'node:fs';
import type { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { parseKnownAgentTransport } from '../agent-transport.js';
import { loadSettings } from '../persist/settings.js';
import { noteRoomRunFinishedForAutoTitle } from '../chat-title-dispatcher.js';
import { notifyAgentFinished } from '../agent-finished-push.js';
import { resolveProjectPath } from '../runtime-paths.js';
import {
  HARNESS_PLUGIN_ID_PATTERN,
  HARNESS_RESERVED_IDS,
} from './harness-plugin-contract.ts';
import type { HarnessPluginManifest } from './harness-plugin-contract.ts';
import type { DiscoveredHarnessPlugin, SemverModule } from './harness-plugin-loader.ts';
import { normalizeEnabledLocalHarnesses } from './enabled-local-harnesses.ts';
import { discoverHarnessPlugins, loadHarnessPlugins } from './harness-plugin-loader.ts';

/** Server-controlled environment variable that selects the plugin root. */
export const HARNESS_PLUGIN_ROOT_ENV = 'CRETLI_HARNESS_PLUGIN_ROOT';

/** Exports a `capabilities.chat` plugin must provide. */
export const LOCAL_CHAT_PLUGIN_REQUIRED_EXPORTS = Object.freeze([
  'handleChatWebSocket',
  'disposeSession',
]);

/** Failure codes emitted by {@link loadLocalChatHarness}. */
export const LOCAL_HARNESS_LOAD_CODES = Object.freeze({
  unknown: 'unknown_harness',
  disabled: 'plugin_disabled',
  capability: 'plugin_capability',
  incompatible: 'host_incompatible',
  loadFailed: 'plugin_load_failed',
  exportMissing: 'plugin_export_missing',
});

/**
 * HTTP status for each load failure code. Import/export and host-gate problems
 * are server-side availability errors (503); identity problems are 400.
 */
export const LOCAL_HARNESS_LOAD_STATUS = Object.freeze({
  [LOCAL_HARNESS_LOAD_CODES.unknown]: 400,
  [LOCAL_HARNESS_LOAD_CODES.disabled]: 400,
  [LOCAL_HARNESS_LOAD_CODES.capability]: 400,
  [LOCAL_HARNESS_LOAD_CODES.exportMissing]: 400,
  [LOCAL_HARNESS_LOAD_CODES.incompatible]: 503,
  [LOCAL_HARNESS_LOAD_CODES.loadFailed]: 503,
});

/** Env-like object that may carry the plugin root. */
export type LocalHarnessEnv = NodeJS.ProcessEnv | Record<string, unknown>;

/** A loaded plugin module; its exports are validated at load time. */
export type LocalChatModule = Record<string, any>;

/** One discovered plugin row of the catalog. */
export type DiscoveredLocalPlugin = DiscoveredHarnessPlugin;

/** Discovery catalog as returned by `discoverHarnessPlugins`. */
export interface LocalHarnessCatalog {
  root?: string;
  plugins?: DiscoveredLocalPlugin[];
  [key: string]: unknown;
}

export interface LocalChatHarnessEntry {
  id: string;
  manifest: HarnessPluginManifest;
  module: LocalChatModule;
  source: string;
}

export interface LoadLocalChatHarnessOptions {
  settings?: { enabledLocalHarnesses?: unknown } | null;
  env?: LocalHarnessEnv;
  catalog?: LocalHarnessCatalog | null;
  hostVersion?: unknown;
  importer?: (specifier: string) => Promise<unknown>;
  semver?: SemverModule | null;
  reservedIds?: readonly string[];
}

export type LoadLocalChatHarnessResult =
  | ({ ok: true } & LocalChatHarnessEntry)
  | { ok: false, code: string, error: string, id: string };

export type DispatchLocalHarnessResult =
  | { ok: true, kind: 'local', module: LocalChatModule }
  | { ok: false, kind: 'unavailable' | 'error', code: string, error?: string };

interface SessionRef { module: LocalChatModule, refs: number, disposed: boolean }
interface SessionGroup { key: string, id: string, sessionKey: string, refs: Map<object, SessionRef> }
interface SessionPin { group: SessionGroup, ref: SessionRef, released: boolean }

let catalogCache: { root: string, promise: Promise<LocalHarnessCatalog | null> } | null = null;

/** Successfully loaded + export-validated modules, keyed by plugin id. */
const moduleCache: Map<string, LocalChatHarnessEntry> = new Map();

/**
 * Live session refcounts keyed by `(id, sessionKey)`.
 *
 * Each key owns one group per exact module instance that handled a dispatched
 * WebSocket session. A group counts the live sockets that share that
 * module/session; `disposeSession` runs exactly once, when the last reference is
 * released (or immediately on an explicit dispose). Refcounting makes both
 * close orders safe: a same-module replacement is one shared group, while a
 * different-module replacement forms a second group whose module is disposed
 * independently. Empty groups are removed, so nothing unbounded accumulates.
 * Cache invalidation never clears live groups (a live session keeps its
 * module); the full test reset does.
 */
const sessionGroups: Map<string, SessionGroup> = new Map();

/** Cached host version, read once from package.json. */
let hostVersionCache: string | undefined;

/**
 * Read the plugin root from a server-controlled environment object. The value
 * is only a path *candidate*; discovery re-validates it as an absolute,
 * non-symlink directory and never trusts it as an authority.
 */
export function readHarnessPluginRoot(env: LocalHarnessEnv | undefined = process.env): string {
  const raw = env ? env[HARNESS_PLUGIN_ROOT_ENV] : '';
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * Running host version, used for the `hostMin` gate. Read once and cached; a
 * missing/unreadable package.json yields `''`, which defers the comparison
 * (the loader never guesses with a partial comparator).
 */
export function readHostVersion(): string {
  if (hostVersionCache !== undefined) return hostVersionCache;
  try {
    const parsed = JSON.parse(readFileSync(resolveProjectPath('package.json'), 'utf8'));
    hostVersionCache = typeof parsed?.version === 'string' ? parsed.version.trim() : '';
  } catch {
    hostVersionCache = '';
  }
  return hostVersionCache as string;
}

/**
 * Memoized discovery for one root. Concurrent first calls share the promise.
 * Returns `null` for an unconfigured root and for a failed discovery, so a
 * broken plugin root can never remove the built-in catalog.
 */
export async function getLocalHarnessPluginCatalog(options: { env?: LocalHarnessEnv } = {}): Promise<LocalHarnessCatalog | null> {
  const root = readHarnessPluginRoot(options.env);
  if (!root) return null;
  if (catalogCache && catalogCache.root === root) return catalogCache.promise;
  const promise = discoverHarnessPlugins({ root }).catch(() => null);
  catalogCache = { root, promise };
  return promise;
}

/**
 * Drop the memoized discovery catalog only, so the next call re-scans the
 * plugin root. Loaded modules and live session pins are untouched. Used by the
 * explicit settings PATCH before membership validation.
 */
export function invalidateLocalHarnessDiscoveryCache(): void {
  catalogCache = null;
}

/**
 * Drop the loaded plugin/module cache so the next load re-imports. Live session
 * groups keep their exact module instance, so an active WebSocket is never
 * disrupted. Used by the explicit settings PATCH after a successful update.
 */
export function invalidateLocalHarnessModuleCache(): void {
  moduleCache.clear();
}

/**
 * Full reset: discovery, loaded modules, live session groups, and the cached
 * host version. Exposed for an explicit admin reload and for test isolation.
 */
export function invalidateLocalHarnessRuntimeCache(): void {
  invalidateLocalHarnessDiscoveryCache();
  invalidateLocalHarnessModuleCache();
  sessionGroups.clear();
  hostVersionCache = undefined;
}

/**
 * Classify a raw persisted transport string.
 */
export function rawHarnessTransportKind(raw: unknown): 'blank' | 'builtin' | 'local' {
  if (typeof raw !== 'string' || raw.trim() === '') return 'blank';
  const token = raw.trim().toLowerCase();
  if (token === 'cursor') return 'builtin';
  return parseKnownAgentTransport(token) ? 'builtin' : 'local';
}

/**
 * Whether the raw transport value names a local-candidate id (anything that is
 * neither blank, a built-in, nor the legacy `cursor` alias).
 */
export function isLocalHarnessTransport(raw: unknown): boolean {
  return rawHarnessTransportKind(raw) === 'local';
}

function normalizeHarnessId(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

function failure(id: string, error: string, code: string = LOCAL_HARNESS_LOAD_CODES.unknown): { ok: false, code: string, error: string, id: string } {
  return { ok: false, code, error, id };
}

function findDiscoveredPlugin(catalog: LocalHarnessCatalog | null, id: string): DiscoveredLocalPlugin | null {
  if (!catalog || !Array.isArray(catalog.plugins)) return null;
  return catalog.plugins.find(
    (plugin: DiscoveredLocalPlugin) => plugin && plugin.manifest && plugin.manifest.id === id,
  ) || null;
}

function sessionKeyOf(id: string, sessionKey: string | null | undefined): string {
  return `${id}\u0000${typeof sessionKey === 'string' ? sessionKey : ''}`;
}

/**
 * Load, gate, and export-validate one `capabilities.chat` local plugin.
 *
 * Order matters and is part of the security contract: the id must be a valid
 * non-reserved plugin id, currently discovered, explicitly enabled in
 * `settings.enabledLocalHarnesses`, declare `capabilities.chat === true`, and
 * pass the loader's disk-revalidated `hostMin` gate. Only then is the entry
 * imported. A successful module is cached per process; repeated calls for the
 * same id never re-import and never re-scan.
 *
 * Every outcome is a value (never a throw):
 *  - `{ ok: true, id, manifest, module, source }`
 *  - `{ ok: false, code, error, id }`
 */
export async function loadLocalChatHarness(rawId: unknown, options: LoadLocalChatHarnessOptions = {}): Promise<LoadLocalChatHarnessResult> {
  const id = normalizeHarnessId(rawId);
  const reserved = new Set(
    Array.isArray(options.reservedIds) ? options.reservedIds : HARNESS_RESERVED_IDS,
  );
  if (!id || reserved.has(id) || !HARNESS_PLUGIN_ID_PATTERN.test(id)) {
    return failure(id, `Unknown harness "${typeof rawId === 'string' ? rawId.trim() : rawId}"`);
  }

  // Discovery first so an id that is not on disk is reported as unknown, not as
  // disabled. The catalog is memoized, so this never scans per WS event.
  const catalog = options.catalog !== undefined
    ? options.catalog
    : await getLocalHarnessPluginCatalog({ env: options.env });
  const plugin = findDiscoveredPlugin(catalog, id);
  if (!plugin) {
    return failure(id, `Unknown harness "${id}"`);
  }

  // A missing/failed settings read means "no local plugin enabled"; it must
  // never be treated as an implicit enable. Checked before the module cache so a
  // plugin disabled after being loaded stops routing immediately.
  const settings = options.settings !== undefined ? options.settings : loadSettings();
  const enabledIds = new Set(normalizeEnabledLocalHarnesses(
    settings ? settings.enabledLocalHarnesses : null,
  ));
  if (!enabledIds.has(id)) {
    return failure(id, `Harness "${id}" is disabled`, LOCAL_HARNESS_LOAD_CODES.disabled);
  }

  if (!plugin.manifest.capabilities || plugin.manifest.capabilities.chat !== true) {
    return failure(
      id,
      `Harness "${id}" does not declare the chat capability`,
      LOCAL_HARNESS_LOAD_CODES.capability,
    );
  }

  const cached = moduleCache.get(id);
  if (cached) return { ok: true, ...cached };

  const hostVersion = options.hostVersion !== undefined ? options.hostVersion : readHostVersion();
  const loaded = await loadHarnessPlugins(catalog as LocalHarnessCatalog, {
    enabledIds: [id],
    ...(typeof options.importer === 'function' ? { importer: options.importer } : {}),
    hostVersion,
    ...(Object.prototype.hasOwnProperty.call(options, 'semver') ? { semver: options.semver } : {}),
    ...(Array.isArray(options.reservedIds) ? { reservedIds: options.reservedIds } : {}),
  });
  const row = Array.isArray(loaded.results)
    ? loaded.results.find((entry: any) => entry && entry.id === id)
    : null;
  if (!row || row.ok !== true || !row.module) {
    if (row && row.code === 'host_incompatible') {
      return failure(id, row.error || `Harness "${id}" requires a newer host`, LOCAL_HARNESS_LOAD_CODES.incompatible);
    }
    return failure(id, row?.error || `Harness "${id}" could not be loaded`, LOCAL_HARNESS_LOAD_CODES.loadFailed);
  }

  const missing = LOCAL_CHAT_PLUGIN_REQUIRED_EXPORTS.filter(
    (name: string) => typeof (row.module as LocalChatModule | undefined)?.[name] !== 'function',
  );
  if (missing.length > 0) {
    return failure(
      id,
      `Harness "${id}" must export ${missing.join(', ')}`,
      LOCAL_HARNESS_LOAD_CODES.exportMissing,
    );
  }

  const entry: LocalChatHarnessEntry = {
    id,
    manifest: plugin.manifest,
    module: row.module as LocalChatModule,
    source: typeof row.source === 'string' ? row.source : '',
  };
  moduleCache.set(id, entry);
  return { ok: true, ...entry };
}

/**
 * Synchronous cache peek. Used by tests and callers that already know the
 * plugin was loaded; never imports and never touches the filesystem.
 */
export function getCachedLocalChatHarness(rawId: unknown): LocalChatHarnessEntry | null {
  return moduleCache.get(normalizeHarnessId(rawId)) || null;
}

/**
 * Release one socket's reference to a live plugin session.
 *
 * Each dispatch owns its own token, so releasing is idempotent per socket and a
 * repeated close only decrements the reference once. The exact module's
 * `disposeSession` is called exactly once, when the last live reference for that
 * `(id, sessionKey, module)` is released. A reference that was already disposed
 * by an explicit chat DELETE is a no-op.
 *
 * @returns true when the call was handled (released or already released)
 */
function releaseLocalHarnessPin(pin: SessionPin | null | undefined): boolean {
  if (!pin || !pin.ref) return false;
  if (pin.released) return true;
  pin.released = true;

  const { group, ref } = pin;
  if (ref.disposed) return true;
  if (ref.refs > 1) {
    ref.refs -= 1;
    return true;
  }

  // Last live socket for this exact module/session: dispose exactly once.
  ref.refs = 0;
  ref.disposed = true;
  group.refs.delete(ref.module);
  if (group.refs.size === 0 && sessionGroups.get(group.key) === group) {
    sessionGroups.delete(group.key);
  }
  try {
    if (ref.module && typeof ref.module.disposeSession === 'function') {
      ref.module.disposeSession(group.sessionKey);
    }
  } catch {
    // Best effort: a throwing plugin cleanup must not break chat deletion.
  }
  return true;
}

/**
 * Acquire one reference on the exact module that just handled a session, keyed
 * by `(id, sessionKey)` and the module instance.
 *
 * Same-module replacements share one reference count, so the first close (in
 * either order) only releases its own reference. A replacement that resolved a
 * different module instance appends a second group under the same key; the old
 * group is disposed when its own last socket closes and the new group stays
 * pinned.
 */
function pinLocalHarnessSession(id: string, sessionKey: string, module: LocalChatModule): SessionPin {
  const key = sessionKeyOf(id, sessionKey);
  let group = sessionGroups.get(key);
  if (!group) {
    group = { key, id, sessionKey, refs: new Map() };
    sessionGroups.set(key, group);
  }
  let ref = group.refs.get(module);
  if (!ref) {
    ref = { module, refs: 0, disposed: false };
    group.refs.set(module, ref);
  }
  ref.refs += 1;
  return { group, ref, released: false };
}

/**
 * Explicitly dispose every live plugin session group for `(id, sessionKey)`.
 *
 * Best-effort and once per module instance: each live group's module is disposed
 * exactly once, then the whole key is dropped so a later socket close is a
 * no-op. Only currently live groups are disposed; a completed key leaves no
 * entry, so a later call is a safe no-op and never falls back to a freshly
 * re-imported module for an unrelated session.
 *
 * @returns true when at least one live session group was disposed
 */
export function disposeLocalHarnessSession(rawId: unknown, sessionKey: string | null | undefined): boolean {
  const id = normalizeHarnessId(rawId);
  if (!id || !sessionKey) return false;
  const key = sessionKeyOf(id, sessionKey);
  const group = sessionGroups.get(key);
  if (!group) return false;

  let disposed = false;
  for (const ref of group.refs.values()) {
    if (ref.disposed) continue;
    ref.disposed = true;
    disposed = true;
    try {
      if (ref.module && typeof ref.module.disposeSession === 'function') {
        ref.module.disposeSession(group.sessionKey);
      }
    } catch {
      // Best effort: a throwing plugin cleanup must not break chat deletion.
    }
  }
  sessionGroups.delete(key);
  return disposed;
}

function closeSocket(ws: WebSocket | null | undefined, code: number, reason: string): void {
  if (!ws || typeof ws.close !== 'function') return;
  try {
    ws.close(code, reason);
  } catch {
    // the socket may already be gone
  }
}

/**
 * Resolve the numeric `CLOSED` readyState without assuming one WebSocket
 * implementation: prefer an instance constant when present, then the global
 * class constant, then the protocol value 3.
 */
function closedReadyState(ws: { CLOSED?: unknown } | null | undefined): number {
  if (ws && typeof ws.CLOSED === 'number') return ws.CLOSED;
  const globalClosed = globalThis.WebSocket ? globalThis.WebSocket.CLOSED : undefined;
  if (typeof globalClosed === 'number') return globalClosed;
  return 3;
}

/**
 * Whether the socket has already reached CLOSED. A `close` event that fired
 * before this check can never fire again, so its pin must be released
 * synchronously instead of waiting for a listener that will never run.
 */
function isSocketClosed(ws: { CLOSED?: unknown, readyState?: number } | null | undefined): boolean {
  return !!ws && ws.readyState === closedReadyState(ws);
}

/**
 * Optional test seam for the deps passed to `notifyAgentFinished` from the local socket watcher.
 * Production leaves this null, so `notifyAgentFinished` runs with its own defaults; tests set it to
 * observe the push without loading `web-push` or touching the network. Mirrors the deps-injection
 * style already used by the auto-title dispatcher's test hook.
 */
let agentFinishedPushDepsForTest: object | null = null;

export function __setAgentFinishedPushDepsForTest(deps: object | null): void {
  agentFinishedPushDepsForTest = deps && typeof deps === 'object' ? deps : null;
}

/**
 * Local plugins speak the /ws-agent-sdk protocol directly on the socket and never go through the
 * room kernel, so the auto-title dispatcher and the shared agent-finished push watch the outgoing
 * `sdkRunFinished` frame here. Never throws and never alters what the plugin sends.
 *
 * The `data.includes(...)` checks are only a cheap prefilter to avoid `JSON.parse` on every frame;
 * the actual side effects are gated on the parsed `payload.type`, matching the room kernel, which
 * checks `payload.type === 'sdkRunFinished'` before notifying. Without that gate, a frame that only
 * mentions the token inside an unrelated payload (e.g. an `sdkEvent` whose text contains
 * "sdkRunFinished") would fire the push and set the dedupe flag, swallowing the real finish until the
 * next `sdkPromptStarted`. The push room is marked `_interactiveClientSeen` because this socket is an
 * interactive client connection; the per-room dedupe flag is reset only on a real `sdkPromptStarted`.
 */
function watchRunFinishedForSideEffects(ws: WebSocket, chat: { id?: string, title?: string }): void {
  const chatId = typeof chat?.id === 'string' ? chat.id : '';
  if (!chatId || typeof ws?.send !== 'function') return;
  const chatTitle = typeof chat?.title === 'string' ? chat.title : '';
  const pushRoom: Record<string, unknown> = { chatId, chatTitle, _interactiveClientSeen: true };
  const originalSend = ws.send;
  ws.send = function sendWithSideEffects(this: unknown, data: any, ...rest: any[]) {
    try {
      if (
        typeof data === 'string'
        && (data.includes('sdkRunFinished') || data.includes('sdkPromptStarted'))
      ) {
        const payload = JSON.parse(data);
        const type = payload && typeof payload === 'object' ? payload.type : undefined;
        if (type === 'sdkRunFinished') {
          noteRoomRunFinishedForAutoTitle({ chatId }, payload);
          notifyAgentFinished(
            {
              chatId,
              chatTitle,
              status: payload?.status,
              runId: payload?.runId,
              room: pushRoom,
            },
            agentFinishedPushDepsForTest || {},
          );
        } else if (type === 'sdkPromptStarted') {
          pushRoom._agentFinishedPushNotified = false;
          // Stable per-run discriminator for the notification fingerprint: reuse
          // the plugin's runId, or mint one at run start. Both are identical for
          // a replay of the same finish frame and different for a new run, so a
          // dismissed in-app notice is never resurrected and a new run still shows.
          //
          // Known limitation: when the plugin sends no `runId`, the minted UUID is
          // only stable for this socket. A reconnect creates a new `pushRoom`, so
          // replaying the same run mints a different discriminator and can produce
          // a second bell item. No stable per-run value exists on this path (the
          // local `sdkPromptStarted` frame carries only presentation fields and
          // the socket does not survive a reconnect), so this is left documented
          // rather than guessed at.
          pushRoom._runId = String(payload?.runId || '').trim() || randomUUID();
        }
      }
    } catch {
      // not JSON / dispatcher failure: titles and pushes are best-effort
    }
    return (originalSend as Function).call(this, data, ...rest);
  };
}

/**
 * WebSocket dispatch for a chat whose persisted transport is a local id.
 *
 * Selects the local handler when the exact id is currently discovered, enabled,
 * chat-capable, host-compatible, and exports the required functions. On any
 * failure it closes the socket with an explicit reason and NEVER calls the SDK
 * handler — `handleAgentSdkWebSocket` is not reachable from here. On success it
 * pins the exact module and disposes it once through the socket close or the
 * explicit dispose route, whichever runs first.
 *
 * The load awaits, so the socket can reach CLOSED first. A socket without a
 * usable close listener, or one already CLOSED after the pin is acquired, is
 * released immediately and the plugin handler is never invoked (`socket_closed`
 * / `socket_unsupported`). This closes the close-before-listener race that would
 * otherwise leak the refcount pin.
 */
export async function dispatchLocalHarnessWebSocket(
  ws: WebSocket,
  sessionKey: string,
  chat: { agentTransport?: string, id?: string, title?: string },
  options: LoadLocalChatHarnessOptions = {},
): Promise<DispatchLocalHarnessResult> {
  const id = normalizeHarnessId(chat?.agentTransport);
  const loaded = await loadLocalChatHarness(id, options);
  if (loaded.ok === false) {
    // Explicit close: a stale/disabled/missing plugin must never silently run
    // the SDK transport with the same session.
    closeSocket(ws, 4404, `Local harness "${id}" is unavailable`);
    return { ok: false, kind: 'unavailable', code: loaded.code, error: loaded.error };
  }

  // Pin the exact module for this live session before invoking the handler: a
  // handler may close the socket itself (protocol error) and the close event
  // must release through the same module instance. Each socket owns one
  // reference, and dispose runs only after the last live reference is released.
  //
  // A socket that cannot register a close listener can never release its pin,
  // so it is rejected before pinning: fail closed with no pin rather than
  // retain an unreleasable session.
  if (!ws || typeof ws.once !== 'function') {
    closeSocket(ws, 1011, 'Local harness socket cannot be tracked');
    return {
      ok: false,
      kind: 'error',
      code: 'socket_unsupported',
      error: 'WebSocket does not support a close listener',
    };
  }

  const pin = pinLocalHarnessSession(id, sessionKey, loaded.module);
  try {
    ws.once('close', () => {
      releaseLocalHarnessPin(pin);
    });
  } catch (err) {
    // Fail closed: a throwing listener registration must not retain the pin.
    releaseLocalHarnessPin(pin);
    closeSocket(ws, 1011, 'Local harness socket cannot be tracked');
    return {
      ok: false,
      kind: 'error',
      code: 'socket_unsupported',
      error: err && (err as Error).message ? String((err as Error).message) : String(err),
    };
  }

  // The import above awaited, so the socket may have reached CLOSED while it was
  // in flight. The `close` event in that case was already emitted and the
  // listener just attached will never fire; release the pin synchronously and
  // never hand a dead socket to the plugin handler.
  if (isSocketClosed(ws)) {
    releaseLocalHarnessPin(pin);
    return {
      ok: false,
      kind: 'unavailable',
      code: 'socket_closed',
      error: `Local harness "${id}" socket is already closed`,
    };
  }

  watchRunFinishedForSideEffects(ws, chat);
  try {
    await loaded.module.handleChatWebSocket({ ws, sessionKey, chat });
  } catch (err) {
    closeSocket(ws, 1011, 'Local harness handler failed');
    return {
      ok: false,
      kind: 'error',
      code: 'handler_failed',
      error: err && (err as Error).message ? String((err as Error).message) : String(err),
    };
  }

  return { ok: true, kind: 'local', module: loaded.module };
}
