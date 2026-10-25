/**
 * Lightweight per-transport backend descriptors: is the backend installed and
 * configured, where its Settings favorites live, its offline model catalog and
 * how to refresh that catalog (docs/ts-migration-and-core-harnesses-plan.md, B2).
 *
 * A composition root like builtin-harness-providers.js, but deliberately
 * light: it imports only credential, CLI/SDK-availability and model-listing
 * modules (plus filesystem reads of local caches) — never a harness WebSocket
 * module — so status and catalog code can
 * use it without joining the harness runtime's import graph (see the room-kernel
 * TDZ cycle noted in builtin-harness-providers.js).
 *
 * Unlike the provider list it covers every transport, `sdk` (Cursor) included.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getEffectiveCursorApiKey } from '../sdk/cursor-api-key.ts';
import { isCursorSdkAvailable, loadCursorSdk } from '../sdk/cursor-sdk.ts';
import { hasCodexCredentials } from '../codex/codex-credentials.ts';
import { isCodexCliFound } from '../codex/codex-cli.ts';
import { isCodexSdkAvailable } from '../codex/codex-sdk.ts';
import { catalogFromCodexModelsCache, listCodexModels, listFallbackCodexModels } from '../codex/codex-models.ts';
import { resolveCodexHomeDir } from '../codex/codex-home.ts';
import { isClaudeHarnessConfigured } from '../claude/claude-api-key.ts';
import { isClaudeSdkAvailable } from '../claude/claude-sdk.ts';
import { listClaudeModels, listFallbackClaudeModels } from '../claude/claude-models.ts';
import {
  catalogEntriesFromModelIds,
  expandSdkModelsToCatalog,
  FALLBACK_AGENT_MODELS,
  mergeModelCatalogEntries,
} from '../model-catalog.js';
import type { ModelCatalogEntry } from '../model-catalog.js';
import type { AgentTransport } from '../agent-transport.js';
import type { HarnessSettingsModule } from './harness-settings-patch.ts';

export type { ModelCatalogEntry };

export interface HarnessBackendStatus {
  available: boolean;
  configured: boolean;
}

/**
 * Test seams for a refresh: `list<Harness>Models`, `runCodexProbe`,
 * `codexHomeDir`, `loadCursorSdk`. Each backend reads only its own keys.
 */
export type HarnessRefreshDeps = Record<string, any>;

export interface HarnessListedModels {
  catalog?: ModelCatalogEntry[];
  modelsSource?: string;
  modelsWarning?: string;
  warning?: string;
}

/**
 * Catalog served without a vendor call (MCP model_list, delegation pickers).
 */
export interface HarnessOfflineCatalog {
  entries: readonly ModelCatalogEntry[];
  source: string;
  warning?: string;
}

export interface HarnessBackend {
  id: AgentTransport;
  /** Settings key holding this harness's favorite model ids. */
  enabledModelsKey: string;
  /** Harness-specific favorite id cleanup. */
  normalizeEnabledModels?: (ids: string[]) => string[];
  /**
   * A favorite also enables the variants the start validation resolves to it
   * (Claude effort variants).
   */
  favoritesMatchVariants?: boolean;
  /**
   * Sync credential/CLI probe for start-time gates; skips the awaited SDK
   * availability checks of `status()`.
   */
  credentialsReadySync: () => boolean;
  /**
   * This harness's GET/PATCH /api/settings fields; `null` for core harnesses
   * still handled in settings-routes.
   */
  settings: HarnessSettingsModule | null;
  /**
   * Offline catalog given the normalized favorites; `null` falls back to the
   * generic Settings-list catalog.
   */
  offlineCatalog: ((enabled: string[]) => HarnessOfflineCatalog) | null;
  /** Installed / has credentials (no secrets). */
  status: () => Promise<HarnessBackendStatus>;
  /**
   * Explicit catalog refresh; `null` when the shared refresh endpoint cannot
   * serve this harness.
   */
  refreshModels: ((deps: HarnessRefreshDeps) => Promise<HarnessListedModels>) | null;
  /** Why `refreshModels` is `null`. */
  notRefreshableReason?: string;
  /**
   * The refresh runs model inference, so a `live` result is reported as `cache`
   * and the caller is told it cost a network call.
   */
  refreshIsNetworkInference: boolean;
  /**
   * Plugin backends only: id of the backend (built-in or an earlier plugin) this
   * one precedes in the list (several ids: the first one present wins) (and so
   * in settings-patch order); default is after every built-in.
   */
  insertBefore?: string | string[];
}

function seam<T extends Function>(deps: HarnessRefreshDeps, key: string, fallback: T): T {
  return typeof deps[key] === 'function' ? deps[key] : fallback;
}

/**
 * Static fallback rows plus the Settings favorites they lack (live/dated vendor
 * ids, effort variants), so enabled models are listable before any snapshot.
 */
function fallbackWithFavorites(fallback: readonly ModelCatalogEntry[], enabled: string[]): HarnessOfflineCatalog {
  return {
    entries: mergeModelCatalogEntries(fallback, catalogEntriesFromModelIds(enabled)),
    source: enabled.length > 0 ? 'settings' : 'fallback',
  };
}

function readCachedCodexCatalog(): ModelCatalogEntry[] {
  const file = path.join(resolveCodexHomeDir(), 'models_cache.json');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return catalogFromCodexModelsCache(JSON.parse(raw));
  } catch {
    return [];
  }
}

async function refreshCursorSdkModels(deps: HarnessRefreshDeps): Promise<HarnessListedModels> {
  const apiKey = getEffectiveCursorApiKey();
  if (!apiKey) {
    return {
      catalog: mergeModelCatalogEntries(FALLBACK_AGENT_MODELS, []),
      modelsSource: 'fallback',
      modelsWarning: 'Missing Cursor API key',
    };
  }
  const { Cursor } = await seam(deps, 'loadCursorSdk', loadCursorSdk)();
  const sdkRows = await Cursor.models.list({ apiKey });
  const sdkCatalog = expandSdkModelsToCatalog(Array.isArray(sdkRows) ? sdkRows : []);
  if (sdkCatalog.length === 0) {
    return {
      catalog: mergeModelCatalogEntries(FALLBACK_AGENT_MODELS, []),
      modelsSource: 'fallback',
      modelsWarning: 'Cursor SDK returned an empty model list',
    };
  }
  return {
    catalog: mergeModelCatalogEntries(sdkCatalog, FALLBACK_AGENT_MODELS),
    modelsSource: 'sdk',
    modelsWarning: '',
  };
}

/**
 * Order is the key order of the Settings harness-status payload and the order
 * settings patches apply in. A plugin backend that must keep its old place declares
 * `insertBefore` (a built-in id).
 */
const BUILTIN_HARNESS_BACKENDS: readonly HarnessBackend[] = Object.freeze(([
  {
    id: 'sdk',
    settings: null,
    enabledModelsKey: 'chatEnabledModels',
    credentialsReadySync: () => !!getEffectiveCursorApiKey(),
    offlineCatalog(enabled) {
      const extra = catalogEntriesFromModelIds(enabled);
      return {
        entries: mergeModelCatalogEntries(FALLBACK_AGENT_MODELS, extra),
        source: extra.length > 0 ? 'settings' : 'fallback',
        warning: 'Live Cursor catalog was not fetched.',
      };
    },
    async status() {
      const available = await isCursorSdkAvailable();
      return { available, configured: available && !!getEffectiveCursorApiKey() };
    },
    refreshModels: refreshCursorSdkModels,
    refreshIsNetworkInference: false,
  },
  {
    id: 'codex',
    settings: null,
    enabledModelsKey: 'codexChatEnabledModels',
    credentialsReadySync: () => isCodexCliFound() && hasCodexCredentials(),
    offlineCatalog() {
      const cached = readCachedCodexCatalog();
      if (cached.length > 0) return { entries: cached, source: 'cache' };
      return {
        entries: listFallbackCodexModels(),
        source: 'fallback',
        warning: 'Codex models_cache.json was not present.',
      };
    },
    async status() {
      const available = (await isCodexSdkAvailable()) && isCodexCliFound();
      return { available, configured: available && hasCodexCredentials() };
    },
    refreshModels: (deps) => seam(deps, 'listCodexModels', listCodexModels)({
      refresh: true,
      runProbe: deps.runCodexProbe,
      homeDir: deps.codexHomeDir,
    }),
    refreshIsNetworkInference: true,
  },
  {
    id: 'claude',
    settings: null,
    enabledModelsKey: 'claudeChatEnabledModels',
    favoritesMatchVariants: true,
    credentialsReadySync: () => isClaudeHarnessConfigured(),
    // Settings may hold concrete live/session ids (including effort variants)
    // that the legacy Claude Code aliases do not cover.
    offlineCatalog: (enabled) => fallbackWithFavorites(listFallbackClaudeModels(), enabled),
    async status() {
      const available = await isClaudeSdkAvailable();
      return { available, configured: available && isClaudeHarnessConfigured() };
    },
    refreshModels: (deps) => seam(deps, 'listClaudeModels', listClaudeModels)({ refresh: true }),
    refreshIsNetworkInference: false,
  },
] as HarnessBackend[]).map((backend) => Object.freeze(backend)));

const BACKEND_BY_ID = new Map<string, HarnessBackend>(BUILTIN_HARNESS_BACKENDS.map((backend) => [backend.id, backend]));

/**
 * Backends contributed by repo harness plugins (`builtin-optional` origin),
 * registered once at boot. Empty unless a plugin is enabled.
 */
const OPTIONAL_HARNESS_BACKENDS: HarnessBackend[] = [];

/**
 * Side-effect-free collision check used before a multi-registry plugin load.
 */
export function hasHarnessBackend(id: string): boolean {
  return BACKEND_BY_ID.has(id);
}

/**
 * Add a plugin's light-entry backend. Refuses an id that is already served so a
 * plugin can never shadow a built-in or another plugin.
 */
export function registerOptionalHarnessBackend(
  backend: HarnessBackend,
): { ok: true } | { ok: false; code: 'id_collision'; error: string } {
  if (BACKEND_BY_ID.has(backend.id)) {
    return { ok: false, code: 'id_collision', error: `Harness backend "${backend.id}" is already registered` };
  }
  const frozen = Object.freeze({ ...backend });
  OPTIONAL_HARNESS_BACKENDS.push(frozen);
  BACKEND_BY_ID.set(frozen.id, frozen);
  return { ok: true };
}

/**
 * @returns A fresh array: built-ins first, then plugin backends; a plugin that declares `insertBefore` sits just before that backend.
 */
export function listBuiltinHarnessBackends(): HarnessBackend[] {
  const ordered: HarnessBackend[] = [...BUILTIN_HARNESS_BACKENDS];
  for (const optional of OPTIONAL_HARNESS_BACKENDS) {
    // The anchor may be a built-in or a plugin registered earlier; a missing one means "last".
    const anchors = ([] as string[]).concat(optional.insertBefore || []);
    const at = anchors.map((anchor) => ordered.findIndex((row) => row.id === anchor)).find((index) => index !== -1) ?? -1;
    if (at === -1) ordered.push(optional);
    else ordered.splice(at, 0, optional);
  }
  return ordered;
}

/**
 * @param id Exact transport id.
 */
export function getBuiltinHarnessBackend(id: string): HarnessBackend | null {
  return BACKEND_BY_ID.get(id) || null;
}
