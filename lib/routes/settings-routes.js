import { normalizeHarnessPermissionControls, patchHarnessPermissionControls } from '../approval/harness-permission-controls.ts';
import { findIntroducedSharedHomes } from '../todo-home.js';
import { listCanUseToolGrants, revokeCanUseToolGrants } from '../approval/can-use-tool-grants.ts';
import path from 'path';
import { loadWorkspace, listWorkspaceFilesRecursive } from '../workspace.js';
import { snapshotFileWorkspaceFolders } from '../persist/workspaces-store.js';
import { addFileWorkspace, findWorkspace, sanitizeWorkspaces } from '../persist/workspace-registry.js';
import {
  applyWorkspaceAddPath,
  applyWorkspaceConvertToSelf,
  applyWorkspaceExportToFile,
  applyWorkspaceRefreshFromFile,
  applyWorkspaceRemoveId,
  maybeSeedRegistry,
} from '../workspace-list.js';
import { resolveWorkspaceRouteContext } from '../workspace-route-context.js';
import {
  buildWorkspacesListWithRouteKeys,
  invalidateWorkspacesCache,
  readWorkspacesCache,
  storeWorkspacesCache,
} from '../workspace-registry-service.js';
import { foldersForWriteback, writeWorkspaceFoldersJsonc } from '../workspace-folders.js';
import { getConfiguredAdditionalCursorContextDirs, normalizeAdditionalCursorContextDirs } from '../sdk/shared-cursor-context.ts';
import { getServerInstanceId } from '../sdk/sdk-instance-id.ts';
import { getSdkRoomBusMode } from '../sdk/sdk-room-bus.ts';
import { getSdkRoomRegistryMode } from '../sdk/sdk-room-registry.ts';
import { getCursorApiKeyMetaForClient } from '../sdk/cursor-api-key.ts';
import { AGENT_TRANSPORTS } from '../agent-transport.js';
import { listBuiltinHarnessBackends } from '../agent-harness/builtin-harness-backends.ts';
import { CORE_SETTINGS_MODULES } from '../agent-harness/core-settings-modules.ts';
import { getBuiltinHarnessProvider } from '../agent-harness/builtin-harness-providers.ts';
import {
  getClaudeApiKeyMetaForClient,
  isClaudeHarnessConfigured,
  isClaudeThirdPartyProviderConfigured,
} from '../claude/claude-api-key.ts';
import { getClaudeAuthMode, normalizeClaudeAuthMode } from '../claude/claude-auth-mode.ts';
import { hasClaudeSubscriptionAuth } from '../claude/claude-subscription.ts';
import { normalizeClaudeAutocompactPct, resolveClaudeCacheSettings } from '../claude/claude-cache-settings.ts';
import { getCodexApiKeyMetaForClient } from '../codex/codex-api-key.ts';
import { getCodexAuthMode, normalizeCodexAuthMode } from '../codex/codex-auth-mode.ts';
import { getCodexChatGptAuthMetaForClient } from '../codex/codex-chatgpt-auth.ts';
import { getOpenAiApiKeyMetaForClient, isValidOpenAiApiKeyFormat } from '../voice/openai-api-key.ts';
import { getGeminiApiKeyMetaForClient, isValidGeminiApiKeyFormat } from '../voice/gemini-api-key.ts';
import {
  getAzureSpeechMetaForClient,
  isValidAzureSpeechKeyFormat,
  isValidAzureSpeechRegion,
} from '../voice/azure-speech-key.ts';
import { getGithubTokenMetaForClient } from '../github-token.js';
import { getHarnessStatus } from '../harness-status.js';
import {
  applyApprovalBrokerSettingsPatch,
  normalizeApprovalBrokerSettings,
} from '../approval/approval-broker.ts';
import {
  getApprovalAdvisorMetaForClient,
  APPROVAL_ADVISOR_SETTING_FIELD,
} from '../approval/approval-advisor.ts';
import { readApprovalAuditSummary } from '../approval/approval-audit.ts';
import { normalizeChatEnabledModels } from '../model-catalog.js';
import {
  listEnabledHarnesses,
  normalizeEnabledHarnesses,
  normalizeHarnessOrder,
} from '../harness-enabled.js';
import {
  normalizeEnabledLocalHarnesses,
  validateEnabledLocalHarnessesUpdate,
} from '../agent-harness/enabled-local-harnesses.ts';
import {
  invalidateHarnessDiscoveryCache,
  invalidateHarnessModuleCache,
  listLocalHarnessProviders,
} from '../agent-harness/harness-snapshot-registry.ts';
import { resolveConfiguredSdkRunIdleTimeoutMs } from '../sdk/sdk-run-idle-guard.ts';
import { isSdkRunAutoRecoveryForcedByEnv, resolveSdkRunAutoRecoveryEnabled } from '../sdk/sdk-run-auto-recovery.ts';
import {
  AUTO_TITLE_MODES,
  AUTO_TITLE_PROVIDERS,
  AUTO_TITLE_SOURCES,
  CHAT_AUTO_ARCHIVE_UNITS,
  chatAutoArchiveMaxValueForUnit,
  getAutoTitleSettings,
  getChatAutoArchiveSettings,
  getSdkCustomSystemPromptSettings,
  loadSettings,
  normalizeSdkCustomSystemPromptPatch,
  saveSettings,
} from '../persist/settings.js';
import { listTitleProviders, pickProviderModel, resolveTitleProvider } from '../chat-title-providers.js';
import { buildChatTitleRequest, sanitizeGeneratedTitle } from '../chat-title-service.js';
import { mergeWorkspaceSidebarConfig, sanitizeWorkspaceSidebarConfig } from '../persist/settings-sidebar.js';
import { readEnvAlias } from '../env-alias.js';
import { msg } from '../messages.js';
import {
  applyChatRestartRecoveryPatch,
  getChatRestartRecoverySettings,
} from '../recovery/recovery-policy.ts';
import { canRestartServer } from '../server-restart-policy.js';
import { getLoadedOptionalHarnessIds } from '../agent-harness/optional-harness-state.ts';
import {
  getNotificationCenterPreferences,
  validateNotificationCenterPreferencesPatch,
} from '../notifications/notification-preferences.ts';

const WORKSPACES_CACHE_TTL_MS = 30000;
/** Window in which GET /api/workspaces answers without re-reading settings. */
const WORKSPACES_FAST_TTL_MS = 2000;

/**
 * @param {Record<string, any>|null|undefined} settings
 * @returns {string}
 */
function resolveDefaultHarnessForClient(settings) {
  const enabled = listEnabledHarnesses(settings?.enabledHarnesses, settings?.harnessOrder);
  const raw = String(settings?.defaultNewChatHarness || '').trim();
  if (enabled.includes(raw)) return raw;
  return enabled[0] || 'sdk';
}

// Re-exported so existing importers of the route module keep working.
export { invalidateWorkspacesCache };

/**
 * @param {Record<string, any>} settings
 * @param {string} scanDir
 * @returns {string}
 */
function workspacesCacheKey(settings, scanDir) {
  return JSON.stringify({
    scanDir,
    workspaces: settings.workspaces || [],
    sidebar: settings.workspaceSidebarConfig || {},
    routeKeys: settings.workspaceRouteKeys || null,
  });
}

/**
 * @param {Record<string, any>|null|undefined} settings
 * @returns {boolean}
 */
export function isHttpTimingEnabled(settings = null) {
  const envRaw = readEnvAlias({
    current: 'CRETLI_DEBUG_HTTP_TIMING',
    legacy: 'CURSOR_REMOTE_DEBUG_HTTP_TIMING',
  });
  if (typeof envRaw === 'string') {
    const v = envRaw.trim().toLowerCase();
    if (v === '1' || v === 'true' || v === 'yes') return true;
    if (v === '0' || v === 'false' || v === 'no') return false;
  }
  const cfg = settings || loadSettings();
  return cfg && cfg.debugHttpTiming === true;
}

/**
 * @param {Record<string, any>} settings
 * @returns {{ sdkRunIdleTimeoutSeconds: number, sdkRunIdleTimeoutFromEnv: boolean }}
 */
function getSdkRunIdleTimeoutMeta(settings) {
  const configuredMs = resolveConfiguredSdkRunIdleTimeoutMs(settings.sdkRunIdleTimeoutSeconds);
  const envMs = Number.parseInt(
    String(readEnvAlias({
      current: 'CRETLI_SDK_RUN_IDLE_TIMEOUT_MS',
      legacy: 'CURSOR_REMOTE_SDK_RUN_IDLE_TIMEOUT_MS',
    }) || ''),
    10
  );
  return {
    sdkRunIdleTimeoutSeconds: configuredMs / 1000,
    sdkRunIdleTimeoutFromEnv: Number.isFinite(envMs) && envMs > 0,
  };
}

/**
 * @param {Record<string, any>} settings
 * @returns {{ sdkRunAutoRecovery: boolean, sdkRunAutoRecoveryFromEnv: boolean }}
 */
function getSdkRunAutoRecoveryMeta(settings) {
  return {
    sdkRunAutoRecovery: resolveSdkRunAutoRecoveryEnabled(settings),
    sdkRunAutoRecoveryFromEnv: isSdkRunAutoRecoveryForcedByEnv(),
  };
}

/**
 * @typedef {Object} SettingsRoutesContext
 * @property {number} port
 * @property {boolean} useHttps
 * @property {string} serverInstanceToken
 * @property {boolean} frontHotFallbackEnabled
 * @property {() => string|null} getLanHost
 * @property {(settings?: Record<string, any>|null) => Record<string, any>} getConfiguredWorkspaceSelection
 * @property {() => boolean} isSessionSyncEnabled
 * @property {unknown} [resolveFrontHmrEnabledFromSettings] Ignored (deprecated): in-process HMR was removed; kept so frozen callers (scripts/architecture-http-bench.mjs) still type-check.
 * @property {unknown} [frontHmrEnabled] Ignored (deprecated, HMR removed).
 * @property {unknown} [frontHmrForcedByEnv] Ignored (deprecated, HMR removed).
 */

/**
 * @param {SettingsRoutesContext} ctx
 * @param {Record<string, any>} settings
 * @returns {Record<string, any>}
 */
/**
 * Every built-in harness's own Settings fields (lib/<id>/<id>-settings.js).
 * Core harnesses without a settings module are listed in buildSettingsResponse.
 *
 * @param {Record<string, any>} settings
 */
function harnessClientSettings(settings) {
  return Object.assign(
    {},
    ...CORE_SETTINGS_MODULES.map((module) => module.readClientSettings(settings)),
    ...listBuiltinHarnessBackends().map((backend) => backend.settings?.readClientSettings(settings) || {}),
  );
}

/**
 * Applies every built-in harness's own PATCH fields, in backend list order.
 *
 * @param {Record<string, any> | null | undefined} body
 * @param {Record<string, any>} settings
 * @returns {{ changed: boolean, error?: { status: number, message: string } }}
 */
function applyHarnessSettingsPatches(body, settings) {
  let changed = false;
  const modules = [...CORE_SETTINGS_MODULES, ...listBuiltinHarnessBackends().map((backend) => backend.settings).filter(Boolean)];
  for (const module of modules) {
    const result = module.applySettingsPatch(body, settings);
    if (result.error) return { changed: false, error: result.error };
    if (result.changed) changed = true;
  }
  return { changed };
}

function buildSettingsResponse(ctx, settings) {
  const lan = ctx.getLanHost();
  const workspaceSelection = ctx.getConfiguredWorkspaceSelection(settings);
  const workspaceSidebarConfig = sanitizeWorkspaceSidebarConfig(settings.workspaceSidebarConfig);
  const claudeCacheSettings = resolveClaudeCacheSettings(settings);
  return {
    ok: true,
    chatRestartRecovery: getChatRestartRecoverySettings(settings),
    lanHost: settings.lanHost ?? '',
    lanUrl: lan ? `${ctx.useHttps ? 'https' : 'http'}://${lan}:${ctx.port}` : null,
    sessionSyncEnabled: ctx.isSessionSyncEnabled(),
    workspaceFile: workspaceSelection.workspaceFile || '',
    workspaceFolder: workspaceSelection.workspaceFolder || '',
    workspaces: sanitizeWorkspaces(settings.workspaces),
    workspaceSidebarConfig,
    additionalCursorContextDirs: getConfiguredAdditionalCursorContextDirs(),
    agentTitlePrint:
      process.env.CURSOR_AGENT_TITLE_PRINT === '1' ||
      process.env.CURSOR_AGENT_TITLE_PRINT === 'true' ||
      settings.agentTitlePrint === true,
    autoTitle: getAutoTitleSettings(settings),
    chatAutoArchive: getChatAutoArchiveSettings(settings),
    sdkCustomSystemPrompt: getSdkCustomSystemPromptSettings(settings.sdkCustomSystemPrompt),
    debugStartup: settings.debugStartup === true,
    debugApi: settings.debugApi === true,
    debugTasks: settings.debugTasks === true,
    debugOverlay: settings.debugOverlay === true,
    debugUiFreeze: settings.debugUiFreeze === true,
    debugRemote: settings.debugRemote === true,
    debugHttpTiming: isHttpTimingEnabled(settings),
    serverInstanceToken: ctx.serverInstanceToken,
    restoreGeneration: ctx.restoreGate?.snapshot?.().restoreGeneration || null,
    serverInstanceId: getServerInstanceId(),
    sdkRoomBus: getSdkRoomBusMode(),
    sdkRoomRegistry: getSdkRoomRegistryMode(),
    frontHotFallbackEnabled: ctx.frontHotFallbackEnabled,
    canRestartServer: canRestartServer(),
    ...getSdkRunIdleTimeoutMeta(settings),
    ...getSdkRunAutoRecoveryMeta(settings),
    ...getCursorApiKeyMetaForClient(),
    ...harnessClientSettings(settings),
    ...getClaudeApiKeyMetaForClient(),
    claudeCredentialsConfigured: isClaudeHarnessConfigured(),
    claudeProviderConfigured: isClaudeThirdPartyProviderConfigured(),
    claudeAuthMode: getClaudeAuthMode(),
    claudeSubscriptionSignedIn: hasClaudeSubscriptionAuth(),
    claudePromptCaching1h: claudeCacheSettings.promptCaching1h,
    claudeAutocompactPctOverride: claudeCacheSettings.autocompactPctOverride,
    claudeDisableAutoCompact: claudeCacheSettings.disableAutoCompact,
    ...getCodexApiKeyMetaForClient(),
    ...getCodexChatGptAuthMetaForClient(),
    codexAuthMode: getCodexAuthMode(),
    ...getOpenAiApiKeyMetaForClient(),
    ...getGeminiApiKeyMetaForClient(),
    ...getAzureSpeechMetaForClient(),
    ...getGithubTokenMetaForClient(),
    chatEnabledModels: normalizeChatEnabledModels(settings.chatEnabledModels),
    claudeChatEnabledModels: normalizeChatEnabledModels(settings.claudeChatEnabledModels),
    codexChatEnabledModels: normalizeChatEnabledModels(settings.codexChatEnabledModels),
    codexBin: typeof settings.codexBin === 'string' ? settings.codexBin : '',
    enabledHarnesses: listEnabledHarnesses(settings.enabledHarnesses, settings.harnessOrder),
    enabledLocalHarnesses: normalizeEnabledLocalHarnesses(settings.enabledLocalHarnesses),
    // Repo plugins registered at boot; the browser activates their static panels.
    optionalHarnesses: getLoadedOptionalHarnessIds(),
    harnessOrder: normalizeHarnessOrder(settings.harnessOrder),
    defaultNewChatHarness: resolveDefaultHarnessForClient(settings),
    firstRunSetupDismissed: settings.firstRunSetupDismissed === true,
    harnessPermissionControls: normalizeHarnessPermissionControls(settings.harnessPermissionControls),
    approvalBroker: normalizeApprovalBrokerSettings(settings.approvalBroker),
    ...getApprovalAdvisorMetaForClient(settings),
    notificationCenter: getNotificationCenterPreferences(settings),
    // External MCP clients at /mcp (lib/routes/mcp-external-routes.js); off by default.
    externalMcpEnabled: settings.externalMcpEnabled === true,
    externalMcpAllowLan: settings.externalMcpAllowLan === true,
  };
}

/**
 * Currently discovered local harness ids for PATCH validation. Discovery reads
 * only the server-controlled `CRETLI_HARNESS_PLUGIN_ROOT` env root (never a
 * request body/path) and never imports plugin code. A missing root or a
 * discovery failure yields `[]`, so a non-empty update is rejected without
 * leaking a path or env detail.
 *
 * @returns {Promise<string[]>}
 */
async function listDiscoveredLocalHarnessIds() {
  try {
    const rows = await listLocalHarnessProviders({ settings: {} });
    if (!Array.isArray(rows)) return [];
    return rows
      .map((/** @type {Record<string, any>} */ row) => (row && typeof row.id === 'string' ? row.id.trim() : ''))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * @param {import('express').Request} req
 * @param {Record<string, any>} settings
 * @returns {Promise<{ changed?: boolean, error?: { status: number, message: string, code?: string, existingId?: string } }>}
 */
async function applySettingsPatch(req, settings) {
  let changed = false;
  if (req.body && typeof req.body.lanHost !== 'undefined') {
    const v = String(req.body.lanHost).trim();
    settings.lanHost = v || undefined;
    if (settings.lanHost === undefined) delete settings.lanHost;
    changed = true;
  }
  if (req.body && typeof req.body.sessionSyncEnabled === 'boolean') {
    settings.sessionSyncEnabled = req.body.sessionSyncEnabled;
    changed = true;
  }
  if (req.body && typeof req.body.workspaceFile !== 'undefined') {
    const v = String(req.body.workspaceFile).trim();
    settings.workspaceFile = v || undefined;
    if (settings.workspaceFile === undefined) delete settings.workspaceFile;
    changed = true;
  }
  if (req.body && typeof req.body.workspaceFolder !== 'undefined') {
    const v = String(req.body.workspaceFolder).trim();
    settings.workspaceFolder = v || undefined;
    if (settings.workspaceFolder === undefined) delete settings.workspaceFolder;
    changed = true;
  }
  if (req.body && typeof req.body.workspaceSidebarConfig !== 'undefined') {
    const merged = mergeWorkspaceSidebarConfig(settings.workspaceSidebarConfig, req.body.workspaceSidebarConfig);
    // A pin must not make two workspaces share one todo home.
    const introduced = findIntroducedSharedHomes(/** @type {any} */ (settings).workspaces, /** @type {any} */ (settings).workspaceSidebarConfig, merged);
    if (introduced.length > 0) {
      return {
        changed: false,
        error: /** @type {any} */ ({ status: 409, message: msg(req, 'settings.todoHomeShared'), code: 'todo_home_shared', homes: introduced }),
      };
    }
    if (Object.keys(merged).length > 0) settings.workspaceSidebarConfig = merged;
    else settings.workspaceSidebarConfig = {};
    changed = true;
  }
  if (req.body && typeof req.body.workspaces !== 'undefined') {
    const next = sanitizeWorkspaces(req.body.workspaces);
    if (next.length > 0) settings.workspaces = next;
    else settings.workspaces = [];
    changed = true;
  }
  if (req.body && typeof req.body.workspaceAddPath === 'string') {
    const addResult = applyWorkspaceAddPath(settings, req.body.workspaceAddPath, {
      preferFolders: req.body.workspaceAddAs === 'folder',
      confirmDuplicate: req.body.workspaceAddConfirmDuplicate === true,
    });
    if (!addResult.ok) {
      if (addResult.error === 'duplicate_import') {
        return {
          changed: false,
          error: {
            status: 409,
            message: msg(req, 'settings.workspaceAlreadyImported'),
            code: 'duplicate_import',
            existingId: addResult.existingId,
          },
        };
      }
      return {
        changed: false,
        error: { status: 400, message: msg(req, 'settings.workspacePathInvalid') },
      };
    }
    changed = true;
  }
  if (req.body && typeof req.body.workspaceRemoveId === 'string') {
    const removeResult = applyWorkspaceRemoveId(settings, req.body.workspaceRemoveId);
    if (!removeResult.ok) {
      return {
        changed: false,
        error: { status: 400, message: msg(req, 'settings.workspacePathInvalid') },
      };
    }
    changed = true;
  }
  if (req.body && typeof req.body.additionalCursorContextDirs !== 'undefined') {
    const normalized = normalizeAdditionalCursorContextDirs(req.body.additionalCursorContextDirs);
    if (normalized.length > 0) settings.additionalCursorContextDirs = normalized;
    else settings.additionalCursorContextDirs = [];
    changed = true;
  }
  if (req.body && typeof req.body.agentTitlePrint === 'boolean') {
    settings.agentTitlePrint = req.body.agentTitlePrint;
    if (!settings.agentTitlePrint) delete settings.agentTitlePrint;
    changed = true;
  }
  if (req.body && req.body.autoTitle && typeof req.body.autoTitle === 'object') {
    const incoming = req.body.autoTitle;
    if (typeof incoming.provider !== 'undefined' && !AUTO_TITLE_PROVIDERS.includes(incoming.provider)) {
      return { error: { status: 400, message: `Unknown auto-title provider (allowed: ${AUTO_TITLE_PROVIDERS.join(', ')}).` } };
    }
    if (typeof incoming.source !== 'undefined' && !AUTO_TITLE_SOURCES.includes(incoming.source)) {
      return { error: { status: 400, message: `Unknown auto-title source (allowed: ${AUTO_TITLE_SOURCES.join(', ')}).` } };
    }
    const next = { ...(settings.autoTitle && typeof settings.autoTitle === 'object' ? settings.autoTitle : {}) };
    if (typeof incoming.mode === 'string' && AUTO_TITLE_MODES.includes(incoming.mode)) next.mode = incoming.mode;
    if (typeof incoming.source === 'string') {
      if (incoming.source === 'server') delete next.source;
      else next.source = incoming.source;
    }
    if (typeof incoming.provider === 'string') {
      if (incoming.provider === 'auto') delete next.provider;
      else next.provider = incoming.provider;
    }
    if (typeof incoming.model === 'string') {
      if (incoming.model.trim()) next.model = incoming.model.trim();
      else delete next.model;
    }
    settings.autoTitle = next;
    changed = true;
  }
  if (req.body && req.body.chatAutoArchive && typeof req.body.chatAutoArchive === 'object') {
    const incoming = req.body.chatAutoArchive;
    const next = { ...(settings.chatAutoArchive && typeof settings.chatAutoArchive === 'object' ? settings.chatAutoArchive : {}) };
    if (typeof incoming.enabled === 'boolean') next.enabled = incoming.enabled;
    if (typeof incoming.skipFavorites === 'boolean') next.skipFavorites = incoming.skipFavorites;
    if (typeof incoming.idleUnit !== 'undefined') {
      if (!CHAT_AUTO_ARCHIVE_UNITS.includes(incoming.idleUnit)) {
        return {
          error: {
            status: 400,
            message: `Unknown chatAutoArchive.idleUnit (allowed: ${CHAT_AUTO_ARCHIVE_UNITS.join(', ')}).`,
          },
        };
      }
      next.idleUnit = incoming.idleUnit;
    }
    // Validate the merged value/unit pair against the unit's range; an invalid
    // value would otherwise silently fall back to a different schedule.
    const resolved = getChatAutoArchiveSettings({ chatAutoArchive: next });
    const unit = CHAT_AUTO_ARCHIVE_UNITS.includes(next.idleUnit) ? next.idleUnit : resolved.idleUnit;
    if (typeof incoming.idleValue !== 'undefined') {
      const value = Math.round(Number(incoming.idleValue));
      const maxValue = chatAutoArchiveMaxValueForUnit(unit);
      if (!Number.isFinite(value) || value < 1 || value > maxValue) {
        return {
          error: {
            status: 400,
            message: `chatAutoArchive.idleValue must be between 1 and ${maxValue} for unit ${unit}.`,
          },
        };
      }
      next.idleValue = value;
    } else if (typeof next.idleValue === 'undefined') {
      next.idleValue = resolved.idleValue;
    }
    next.idleUnit = unit;
    settings.chatAutoArchive = next;
    changed = true;
  }
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'sdkCustomSystemPrompt')) {
    const normalized = normalizeSdkCustomSystemPromptPatch(req.body.sdkCustomSystemPrompt);
    if (normalized) {
      settings.sdkCustomSystemPrompt = normalized;
      changed = true;
    }
  }
  if (req.body && typeof req.body.debugHttpTiming === 'boolean') {
    settings.debugHttpTiming = req.body.debugHttpTiming;
    if (!settings.debugHttpTiming) delete settings.debugHttpTiming;
    changed = true;
  }
  const clientDebugKeys = ['debugStartup', 'debugApi', 'debugTasks', 'debugOverlay', 'debugUiFreeze', 'debugRemote'];
  for (const key of clientDebugKeys) {
    if (!req.body || typeof req.body[key] !== 'boolean') continue;
    settings[key] = req.body[key];
    if (!settings[key]) delete settings[key];
    changed = true;
  }
  if (req.body && typeof req.body.sdkRunIdleTimeoutSeconds !== 'undefined') {
    const seconds = Number(req.body.sdkRunIdleTimeoutSeconds);
    if (!Number.isInteger(seconds) || seconds < 15 || seconds > 86400) {
      return {
        changed: false,
        error: { status: 400, message: msg(req, 'settings.sdkTimeoutInvalid') },
      };
    }
    settings.sdkRunIdleTimeoutSeconds = seconds;
    changed = true;
  }
  {
    const recoveryPatch = applyChatRestartRecoveryPatch(settings, req.body);
    if (recoveryPatch.error) {
      return { changed: false, error: { status: 400, message: recoveryPatch.error } };
    }
    if (recoveryPatch.changed) changed = true;
  }
  if (req.body && typeof req.body.sdkRunAutoRecovery === 'boolean') {
    if (isSdkRunAutoRecoveryForcedByEnv()) {
      return {
        changed: false,
        error: { status: 400, message: 'Auto-recovery is controlled by environment variable (CRETLI_SDK_RUN_AUTO_RECOVERY / CURSOR_REMOTE_SDK_RUN_AUTO_RECOVERY).' },
      };
    }
    settings.sdkRunAutoRecovery = req.body.sdkRunAutoRecovery;
    changed = true;
  }
  if (req.body && req.body.clearCursorApiKey === true) {
    if (settings.cursorApiKey !== undefined) {
      delete settings.cursorApiKey;
      changed = true;
    }
  }
  if (req.body && typeof req.body.cursorApiKey === 'string') {
    const raw = req.body.cursorApiKey.trim();
    if (raw) {
      settings.cursorApiKey = raw;
      changed = true;
    }
  }
  {
    const harnessPatch = applyHarnessSettingsPatches(req.body, settings);
    if (harnessPatch.error) return harnessPatch;
    if (harnessPatch.changed) changed = true;
  }
  // Artificial Analysis benchmark API key: write-only, never echoed back.
  if (req.body && req.body.clearArtificialAnalysisApiKey === true) {
    if (settings.artificialAnalysisApiKey !== undefined) {
      delete settings.artificialAnalysisApiKey;
      changed = true;
    }
  }
  if (req.body && typeof req.body.artificialAnalysisApiKey === 'string') {
    const raw = req.body.artificialAnalysisApiKey.trim();
    if (raw) {
      settings.artificialAnalysisApiKey = raw;
      changed = true;
    }
  }
  if (req.body && typeof req.body.claudeApiKey === 'string') {
    const raw = req.body.claudeApiKey.trim();
    if (raw) settings.claudeApiKey = raw;
    else delete settings.claudeApiKey;
    changed = true;
  }
  if (req.body && typeof req.body.claudeAuthMode === 'string') {
    settings.claudeAuthMode = normalizeClaudeAuthMode(req.body.claudeAuthMode);
    changed = true;
  }
  if (req.body && req.body.clearClaudeApiKey === true) {
    delete settings.claudeApiKey;
    changed = true;
  }
  if (req.body && typeof req.body.claudePromptCaching1h === 'boolean') {
    settings.claudePromptCaching1h = req.body.claudePromptCaching1h;
    if (!settings.claudePromptCaching1h) delete settings.claudePromptCaching1h;
    changed = true;
  }
  if (req.body && typeof req.body.claudeDisableAutoCompact === 'boolean') {
    settings.claudeDisableAutoCompact = req.body.claudeDisableAutoCompact;
    if (!settings.claudeDisableAutoCompact) delete settings.claudeDisableAutoCompact;
    changed = true;
  }
  if (req.body && typeof req.body.claudeAutocompactPctOverride !== 'undefined') {
    const normalized = normalizeClaudeAutocompactPct(req.body.claudeAutocompactPctOverride);
    if (normalized !== null) settings.claudeAutocompactPctOverride = normalized;
    else delete settings.claudeAutocompactPctOverride;
    changed = true;
  }
  if (req.body && typeof req.body.codexApiKey === 'string') {
    const raw = req.body.codexApiKey.trim();
    if (raw) settings.codexApiKey = raw;
    else delete settings.codexApiKey;
    changed = true;
  }
  if (req.body && req.body.clearCodexApiKey === true) {
    delete settings.codexApiKey;
    changed = true;
  }
  if (req.body && typeof req.body.codexAuthMode === 'string') {
    settings.codexAuthMode = normalizeCodexAuthMode(req.body.codexAuthMode);
    changed = true;
  }
  if (req.body && typeof req.body.codexBin === 'string') {
    const raw = req.body.codexBin.trim();
    if (raw) settings.codexBin = raw;
    else delete settings.codexBin;
    changed = true;
  }
  if (req.body && req.body.clearOpenaiApiKey === true) {
    if (settings.openaiApiKey !== undefined) {
      delete settings.openaiApiKey;
      changed = true;
    }
  }
  if (req.body && typeof req.body.openaiApiKey === 'string') {
    const raw = req.body.openaiApiKey.trim();
    if (raw) {
      if (!isValidOpenAiApiKeyFormat(raw)) {
        return {
          changed: false,
          error: {
            status: 400,
            message: 'Invalid OpenAI API key — it must start with sk- (create one at platform.openai.com/api-keys).',
          },
        };
      }
      settings.openaiApiKey = raw;
      changed = true;
    }
  }
  if (req.body && req.body.clearGeminiApiKey === true) {
    if (settings.geminiApiKey !== undefined) {
      delete settings.geminiApiKey;
      changed = true;
    }
  }
  if (req.body && typeof req.body.geminiApiKey === 'string') {
    const raw = req.body.geminiApiKey.trim();
    if (raw) {
      if (!isValidGeminiApiKeyFormat(raw)) {
        return {
          changed: false,
          error: {
            status: 400,
            message: 'Invalid Gemini API key — it must start with AIza or AQ. (create one at aistudio.google.com/apikey).',
          },
        };
      }
      settings.geminiApiKey = raw;
      changed = true;
    }
  }
  if (req.body && req.body.clearAzureSpeech === true) {
    if (settings.azureSpeechKey !== undefined || settings.azureSpeechRegion !== undefined) {
      delete settings.azureSpeechKey;
      delete settings.azureSpeechRegion;
      changed = true;
    }
  }
  if (req.body && typeof req.body.azureSpeechKey === 'string') {
    const raw = req.body.azureSpeechKey.trim();
    if (raw) {
      if (!isValidAzureSpeechKeyFormat(raw)) {
        return {
          changed: false,
          error: {
            status: 400,
            message: 'Invalid Azure Speech key — copy KEY 1 from the Speech resource in the Azure portal.',
          },
        };
      }
      settings.azureSpeechKey = raw;
      changed = true;
    }
  }
  if (req.body && typeof req.body.azureSpeechRegion === 'string') {
    const raw = req.body.azureSpeechRegion.trim().toLowerCase();
    if (raw) {
      if (!isValidAzureSpeechRegion(raw)) {
        return {
          changed: false,
          error: {
            status: 400,
            message: 'Invalid Azure region — use the resource location id, e.g. westeurope or polandcentral.',
          },
        };
      }
      settings.azureSpeechRegion = raw;
      changed = true;
    }
  }
  if (req.body && req.body.clearGithubToken === true) {
    if (settings.githubToken !== undefined) {
      delete settings.githubToken;
      changed = true;
    }
  }
  if (req.body && typeof req.body.githubToken === 'string') {
    const raw = req.body.githubToken.trim();
    if (raw) {
      settings.githubToken = raw;
      changed = true;
    }
  }
  if (req.body && typeof req.body.chatEnabledModels !== 'undefined') {
    const normalized = normalizeChatEnabledModels(req.body.chatEnabledModels);
    if (normalized.length > 0) settings.chatEnabledModels = normalized;
    else delete settings.chatEnabledModels;
    changed = true;
  }
  if (req.body && typeof req.body.harnessPermissionControls !== 'undefined') {
    settings.harnessPermissionControls = patchHarnessPermissionControls(settings.harnessPermissionControls, req.body.harnessPermissionControls);
    changed = true;
  }
  if (req.body && typeof req.body.approvalBroker !== 'undefined') {
    applyApprovalBrokerSettingsPatch(settings, req.body.approvalBroker);
    changed = true;
  }
  if (req.body && req.body.clearApprovalAdvisorApiKey === true) {
    if (settings[APPROVAL_ADVISOR_SETTING_FIELD] !== undefined) {
      delete settings[APPROVAL_ADVISOR_SETTING_FIELD];
      changed = true;
    }
  }
  if (req.body && typeof req.body.approvalAdvisorApiKey === 'string') {
    const raw = req.body.approvalAdvisorApiKey.trim();
    if (raw) settings[APPROVAL_ADVISOR_SETTING_FIELD] = raw;
    else delete settings[APPROVAL_ADVISOR_SETTING_FIELD];
    changed = true;
  }
  if (req.body && typeof req.body.claudeChatEnabledModels !== 'undefined') {
    const normalized = normalizeChatEnabledModels(req.body.claudeChatEnabledModels);
    if (normalized.length > 0) settings.claudeChatEnabledModels = normalized;
    else delete settings.claudeChatEnabledModels;
    changed = true;
  }
  if (req.body && typeof req.body.codexChatEnabledModels !== 'undefined') {
    const normalized = normalizeChatEnabledModels(req.body.codexChatEnabledModels);
    if (normalized.length > 0) settings.codexChatEnabledModels = normalized;
    else delete settings.codexChatEnabledModels;
    changed = true;
  }
  if (req.body && typeof req.body.enabledHarnesses !== 'undefined') {
    const normalized = normalizeEnabledHarnesses(req.body.enabledHarnesses);
    if (normalized) settings.enabledHarnesses = normalized;
    else delete settings.enabledHarnesses;
    changed = true;
  }
  if (req.body && typeof req.body.enabledLocalHarnesses !== 'undefined') {
    // Membership validation must see the current disk, never a stale snapshot.
    invalidateHarnessDiscoveryCache();
    const update = validateEnabledLocalHarnessesUpdate(req.body.enabledLocalHarnesses, {
      discoveredLocalIds: await listDiscoveredLocalHarnessIds(),
    });
    if (!update.ok) {
      // Generic 400: never echo the plugin root, discovery error, or env detail.
      // A rejected update also leaves the loaded module cache untouched.
      return {
        changed: false,
        error: { status: 400, message: 'Invalid local harness selection' },
      };
    }
    if (update.ids.length > 0) settings.enabledLocalHarnesses = update.ids;
    else delete settings.enabledLocalHarnesses;
    // The next load re-imports; live session pins are intentionally preserved.
    invalidateHarnessModuleCache();
    changed = true;
  }
  if (req.body && typeof req.body.harnessOrder !== 'undefined') {
    settings.harnessOrder = normalizeHarnessOrder(req.body.harnessOrder);
    changed = true;
  }
  if (req.body && typeof req.body.defaultNewChatHarness !== 'undefined') {
    const raw = String(req.body.defaultNewChatHarness || '').trim();
    // Any built-in harness except the implicit default (sdk); anything else resets it.
    if (raw !== 'sdk' && AGENT_TRANSPORTS.includes(raw)) {
      settings.defaultNewChatHarness = raw;
    } else {
      delete settings.defaultNewChatHarness;
    }
    changed = true;
  }
  for (const key of ['externalMcpEnabled', 'externalMcpAllowLan']) {
    if (!req.body || typeof req.body[key] !== 'boolean') continue;
    if (req.body[key]) settings[key] = true;
    else delete settings[key];
    changed = true;
  }
  if (req.body && typeof req.body.firstRunSetupDismissed === 'boolean') {
    if (req.body.firstRunSetupDismissed) {
      settings.firstRunSetupDismissed = true;
    } else {
      delete settings.firstRunSetupDismissed;
    }
    changed = true;
  }
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'notificationCenter')) {
    const checked = validateNotificationCenterPreferencesPatch(req.body.notificationCenter);
    if (!checked.ok) {
      return { changed, error: { status: 400, message: 'Invalid notification center preferences' } };
    }
    settings.notificationCenter = checked.value;
    changed = true;
  }
  return { changed };
}

/**
 * @typedef {Object} WorkspaceRoutesContext
 * @property {string} projectRoot
 * @property {() => Record<string, any>|null} getCurrentWorkspace
 * @property {() => string|null} getCurrentWorkspaceFile
 * @property {(folderPath: string) => boolean} [folderExistsFn] test seam for
 *   the view-context route's folder availability check
 */

/**
 * @param {import('express').Express} app
 * @param {WorkspaceRoutesContext} ctx
 */
export function registerWorkspaceRoutes(app, ctx) {
  app.get('/api/workspace', (req, res) => {
    const workspace = ctx.getCurrentWorkspace();
    if (!workspace) {
      return res.json({ ok: false, error: msg(req, 'files.noWorkspace'), cwd: process.cwd() });
    }
    res.json({
      ok: true,
      workspaceDir: workspace.workspaceDir,
      workspaceFile: ctx.getCurrentWorkspaceFile() || '',
      folders: workspace.folders.map((f) => ({ name: f.name, path: f.path, resolvedPath: f.resolvedPath })),
    });
  });
  /**
   * Shared view-context resolver (navigation plan stage 2): maps the opaque
   * `ws`/`folder` route ids from a link onto the runtime workspace/folder
   * paths, using the same stable error vocabulary as the Git scope resolver.
   * A link id that was deleted or belongs to another workspace answers with
   * `ok:false` + a machine-readable code; it never re-points another project.
   */
  app.get('/api/workspace/context', (req, res) => {
    const settings = loadSettings();
    const resolveOptions = {};
    // Test seam (same precedent as `ctx.resolveScope` on the Git routes).
    if (typeof ctx.folderExistsFn === 'function') resolveOptions.existsFn = ctx.folderExistsFn;
    const resolved = resolveWorkspaceRouteContext(settings, {
      workspaceKey: req.query?.ws,
      folderKey: req.query?.folder,
    }, resolveOptions);
    if (!resolved.ok) {
      const status = resolved.error === 'folder-unavailable' ? 503 : 404;
      return res.status(status).json({ ok: false, error: resolved.error, workspace: null, folder: null });
    }
    /** @type {Record<string, any>} */
    const workspace = resolved.workspace || null;
    const folder = resolved.folder || null;
    return res.json({
      ok: true,
      workspaceKey: workspace?.workspaceKey || '',
      folderKey: folder?.folderKey || '',
      workspace: workspace
        ? {
          id: workspace.id,
          kind: workspace.kind,
          workspaceFile: workspace.workspaceFile,
          workspaceDir: workspace.workspaceDir,
          exists: workspace.exists === true,
        }
        : null,
      folder: folder ? { name: folder.name, resolvedPath: folder.resolvedPath } : null,
    });
  });
  app.get('/api/workspaces', (req, res) => {
    const startedAt = Date.now();
    const refresh = String(req.query.refresh || '') === '1';
    const scanNew = String(req.query.scan || '') === '1';
    const syncFolders = String(req.query.sync || '') === '1';
    // Hot path: skip settings load, registry seeding and cache-key hashing for a
    // very recent payload. Mutating routes call invalidateWorkspacesCache().
    if (!refresh && !scanNew && !syncFolders) {
      const recent = readWorkspacesCache();
      if (recent.payload && startedAt - recent.at < WORKSPACES_FAST_TTL_MS) return res.json(recent.payload);
    }
    const settings = loadSettings();
    const fallbackDir = path.resolve(ctx.projectRoot, '..');
    const current = ctx.getCurrentWorkspace();
    const defaultDir = current ? path.dirname(current.workspaceDir) : fallbackDir;
    const scanDir = process.env.WORKSPACES_SCAN_DIR ? path.resolve(process.env.WORKSPACES_SCAN_DIR) : defaultDir;
    let registryChanged = false;
    const extraFiles = [ctx.getCurrentWorkspaceFile(), process.env.WORKSPACE_FILE].filter(Boolean);
    if (sanitizeWorkspaces(settings.workspaces).length === 0) {
      const files = listWorkspaceFilesRecursive(scanDir);
      const seeded = maybeSeedRegistry([], files, extraFiles);
      if (seeded.seeded) {
        settings.workspaces = seeded.registry;
        registryChanged = true;
      }
    } else if (scanNew) {
      const files = listWorkspaceFilesRecursive(scanDir);
      const before = sanitizeWorkspaces(settings.workspaces);
      let next = before;
      for (const file of files) {
        next = addFileWorkspace(next, file);
      }
      if (next.length !== before.length) {
        settings.workspaces = next;
        registryChanged = true;
      }
    }
    if (registryChanged) {
      // Freshly seeded file entries become stored workspaces: copy their folders now.
      snapshotFileWorkspaceFolders(settings, loadWorkspace);
    }
    if (syncFolders) {
      // Explicit user action only: pull new folders from each imported file.
      for (const entry of sanitizeWorkspaces(settings.workspaces)) {
        if (!entry.importedFrom) continue;
        const refreshed = applyWorkspaceRefreshFromFile(settings, entry.id);
        if (refreshed.ok && refreshed.added) registryChanged = true;
      }
    }
    if (registryChanged) saveSettings(settings);
    const cacheKey = workspacesCacheKey(settings, scanDir);
    const now = Date.now();
    const workspacesCache = readWorkspacesCache();
    if (
      !refresh
      && !scanNew
      && !syncFolders
      && workspacesCache.payload
      && workspacesCache.key === cacheKey
      && now - workspacesCache.at < WORKSPACES_CACHE_TTL_MS
    ) {
      return res.json(workspacesCache.payload);
    }
    const built = buildWorkspacesListWithRouteKeys(settings);
    if (built.changed) saveSettings(settings);
    const list = built.list;
    const payload = { ok: true, workspaces: list };
    storeWorkspacesCache({ at: now, key: workspacesCacheKey(settings, scanDir), payload });
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs > 500) {
      console.warn('[api/workspaces] slow scan:', elapsedMs, 'ms', 'dir=', scanDir, 'count=', list.length);
    }
    res.json(payload);
  });
  app.post('/api/workspace-file/folders', (req, res) => {
    const workspaceFile = String(req.body?.workspaceFile || '').trim();
    const settings = loadSettings();
    const entry = findWorkspace(settings.workspaces, workspaceFile);
    if (!entry || entry.kind !== 'file' || !entry.workspaceFile) {
      return res.status(400).json({ ok: false, error: msg(req, 'settings.workspaceFileNotInRegistry') });
    }
    const overlay = sanitizeWorkspaceSidebarConfig(settings.workspaceSidebarConfig)[entry.id]?.folders;
    const folders = foldersForWriteback(overlay, path.posix.dirname(entry.workspaceFile));
    try {
      writeWorkspaceFoldersJsonc(entry.workspaceFile, folders);
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    invalidateWorkspacesCache();
    const built = buildWorkspacesListWithRouteKeys(settings);
    if (built.changed) saveSettings(settings);
    return res.json({ ok: true, workspaces: built.list });
  });
  /** Explicit "refresh from file": add folders of the imported file the workspace lacks. */
  app.post('/api/workspace/refresh-from-file', (req, res) => {
    const workspaceId = String(req.body?.workspaceId || req.body?.workspaceFile || '').trim();
    if (!workspaceId) {
      return res.status(400).json({ ok: false, error: msg(req, 'settings.workspacePathInvalid') });
    }
    const settings = loadSettings();
    const result = applyWorkspaceRefreshFromFile(settings, workspaceId);
    if (!result.ok) {
      const message = result.error === 'not_found'
        ? msg(req, 'settings.workspaceFileNotInRegistry')
        : (result.error === 'not_imported' || result.error === 'file_missing'
          ? msg(req, 'settings.workspaceRefreshUnavailable')
          : msg(req, 'settings.workspacePathInvalid'));
      return res.status(400).json({ ok: false, error: message, code: result.error });
    }
    saveSettings(settings);
    invalidateWorkspacesCache();
    const built = buildWorkspacesListWithRouteKeys(settings);
    if (built.changed) saveSettings(settings);
    return res.json({ ok: true, workspaceId: result.id, added: result.added || 0, workspaces: built.list });
  });
  /** Convert a .code-workspace (file) workspace into a self-config Cretli workspace. */
  app.post('/api/workspace/convert', (req, res) => {
    const workspaceFile = String(req.body?.workspaceFile || '').trim();
    if (!workspaceFile) {
      return res.status(400).json({ ok: false, error: msg(req, 'settings.workspacePathInvalid') });
    }
    const settings = loadSettings();
    const result = applyWorkspaceConvertToSelf(settings, workspaceFile);
    if (!result.ok) {
      const message = result.error === 'not_found'
        ? msg(req, 'settings.workspaceFileNotInRegistry')
        : msg(req, 'settings.workspacePathInvalid');
      return res.status(400).json({ ok: false, error: message });
    }
    saveSettings(settings);
    invalidateWorkspacesCache();
    const built = buildWorkspacesListWithRouteKeys(settings);
    if (built.changed) saveSettings(settings);
    const converted = built.list.find((item) => item.id === result.id) || null;
    return res.json({
      ok: true,
      workspaceId: result.id,
      workspaceKey: converted?.workspaceKey || result.id,
      workspaces: built.list,
    });
  });
  /** Export the enabled folders of a workspace into a .code-workspace file. */
  app.post('/api/workspace/export', (req, res) => {
    const workspaceFile = String(req.body?.workspaceFile || '').trim();
    if (!workspaceFile) {
      return res.status(400).json({ ok: false, error: msg(req, 'settings.workspacePathInvalid') });
    }
    const targetFile = String(req.body?.targetFile || '').trim();
    const settings = loadSettings();
    const result = applyWorkspaceExportToFile(settings, workspaceFile, { targetFile });
    if (!result.ok) {
      const message = result.error === 'not_found'
        ? msg(req, 'settings.workspaceFileNotInRegistry')
        : (result.error === 'write_failed' ? String(result.error) : msg(req, 'settings.workspacePathInvalid'));
      return res.status(400).json({ ok: false, error: message });
    }
    return res.json({ ok: true, file: result.file });
  });
}

/**
 * @param {import('express').Express} app
 * @param {SettingsRoutesContext} ctx
 */
export function registerSettingsRoutes(app, ctx) {
  app.get('/api/settings', async (_req, res) => {
    try {
      const startedAt = Date.now();
      const settings = loadSettings();
      const harnessStatus = await getHarnessStatus();
      res.json({ ...buildSettingsResponse(ctx, settings), harnessStatus });
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs > 1000) console.warn('[api/settings] slow response:', elapsedMs, 'ms');
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
  // Read-only counters from approval-audit.jsonl; never commands, paths or ids.
  app.get('/api/approval-broker/audit-summary', async (req, res) => {
    try {
      const summary = await readApprovalAuditSummary({ days: req.query?.days });
      res.json({ ok: true, ...summary });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
  app.get('/api/approval-broker/grants', (_req, res) => {
    try {
      res.json({ ok: true, grants: listCanUseToolGrants() });
    } catch {
      res.status(500).json({ ok: false, error: 'Could not load permission grants' });
    }
  });
  app.post('/api/approval-broker/grants/revoke', (req, res) => {
    try {
      const revoked = revokeCanUseToolGrants(req.body?.ids);
      res.json({ ok: true, revoked });
    } catch (error) {
      res.status(error instanceof TypeError ? 400 : 500).json({ ok: false, error: 'Could not revoke permission grants' });
    }
  });
  app.get('/api/settings/auto-title/providers', (_req, res) => {
    try {
      const settings = loadSettings();
      const selected = getAutoTitleSettings(settings);
      /** @type {Record<string, any>} */
      const resolved = resolveTitleProvider(selected, settings);
      res.json({
        ok: true,
        providers: listTitleProviders(settings),
        selected,
        effective: resolved.ok
          ? { provider: resolved.provider, model: resolved.model }
          : { provider: '', model: '', reason: resolved.reason, message: resolved.message },
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
  // Generates a sample title from fixed text. Writes no chat/history and never echoes a key.
  app.post('/api/settings/auto-title/test', async (req, res) => {
    const startedAt = Date.now();
    try {
      const settings = loadSettings();
      const stored = getAutoTitleSettings(settings);
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const provider = typeof body.provider === 'string' && body.provider.trim() ? body.provider.trim() : stored.provider;
      if (!AUTO_TITLE_PROVIDERS.includes(provider)) {
        return res.status(400).json({ ok: false, error: 'Unknown auto-title provider.' });
      }
      const requestedModel = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : stored.model;
      /** @type {Record<string, any>} */
      const resolved = resolveTitleProvider({ ...stored, provider, model: requestedModel }, settings);
      if (!resolved.ok) {
        return res.status(200).json({ ok: false, provider: resolved.provider, reason: resolved.reason, error: resolved.message });
      }
      const prompt = buildChatTitleRequest({
        chat: {},
        events: [{ seq: 1, rec: { kind: 'localUser', text: 'Napraw przycisk logowania, który nie działa na telefonie po aktualizacji.' } }],
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      try {
        const raw = await resolved.adapter.generate({
          prompt,
          model: pickProviderModel(resolved.adapter, requestedModel),
          signal: controller.signal,
        });
        const title = sanitizeGeneratedTitle(raw);
        return res.json({
          ok: !!title,
          provider: resolved.provider,
          model: resolved.model,
          title,
          ms: Date.now() - startedAt,
          ...(title ? {} : { reason: 'rejected_output', error: 'Provider answered, but the title was unusable.' }),
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      // Generator errors carry only status/abort text, never key material.
      return res.status(200).json({
        ok: false,
        reason: 'generate_failed',
        error: err?.name === 'AbortError' ? 'timeout' : String(err?.message || err).slice(0, 200),
        ms: Date.now() - startedAt,
      });
    }
  });
  app.patch('/api/settings', async (req, res) => {
    try {
      const startedAt = Date.now();
      const settings = loadSettings();
      const patchResult = await applySettingsPatch(req, settings);
      if (patchResult.error) {
        const { code, homes, existingId } = /** @type {any} */ (patchResult.error);
        return res.status(patchResult.error.status).json({
          ok: false,
          error: patchResult.error.message,
          ...(code ? { code } : {}),
          ...(homes ? { homes } : {}),
          ...(existingId ? { existingId } : {}),
        });
      }
      if (patchResult.changed) {
        saveSettings(settings);
        if (
          req.body
          && (
            typeof req.body.workspaces !== 'undefined'
            || typeof req.body.workspaceSidebarConfig !== 'undefined'
            || typeof req.body.workspaceAddPath === 'string'
            || typeof req.body.workspaceRemoveId === 'string'
            || typeof req.body.workspaceFile !== 'undefined'
            || typeof req.body.workspaceFolder !== 'undefined'
          )
        ) {
          invalidateWorkspacesCache();
        }
        for (const backend of listBuiltinHarnessBackends()) {
          if (backend.settings?.requiresRuntimeReset?.(req.body)) {
            getBuiltinHarnessProvider(backend.id)?.resetRuntime?.();
          }
        }
      }
      const harnessStatus = await getHarnessStatus();
      res.json({ ...buildSettingsResponse(ctx, settings), harnessStatus });
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs > 1000) console.warn('[api/settings PATCH] slow response:', elapsedMs, 'ms');
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}
