import path from 'path';
import { loadWorkspace, listWorkspaceFilesRecursive } from '../workspace.js';
import { addFileWorkspace, findWorkspace, sanitizeWorkspaces } from '../persist/workspace-registry.js';
import {
  applyWorkspaceAddPath,
  applyWorkspaceConvertToSelf,
  applyWorkspaceExportToFile,
  applyWorkspaceRemoveId,
  buildWorkspacesList,
  maybeSeedRegistry,
} from '../workspace-list.js';
import { foldersForWriteback, syncFoldersFromFile, writeWorkspaceFoldersJsonc } from '../workspace-folders.js';
import { getConfiguredAdditionalCursorContextDirs, normalizeAdditionalCursorContextDirs } from '../sdk/shared-cursor-context.js';
import { getServerInstanceId } from '../sdk/sdk-instance-id.js';
import { getSdkRoomBusMode } from '../sdk/sdk-room-bus.js';
import { getSdkRoomRegistryMode } from '../sdk/sdk-room-registry.js';
import { getCursorApiKeyMetaForClient } from '../sdk/cursor-api-key.js';
import { getOpenRouterApiKeyMetaForClient, isValidOpenRouterApiKeyFormat } from '../openrouter/openrouter-api-key.js';
import {
  getOpenCodeApiKeyMetaForClient,
  isValidOpenCodeApiKeyFormat,
} from '../opencode/opencode-api-key.js';
import {
  getOpenCodeZaiApiKeyMetaForClient,
  isValidOpenCodeZaiApiKeyFormat,
  normalizeOpenCodeZaiProvider,
} from '../opencode/opencode-zai-api-key.js';
import { getCodeBuddyApiKeyMetaForClient } from '../codebuddy/codebuddy-api-key.js';
import { invalidateCodeBuddyModelsCache } from '../codebuddy/codebuddy-models.js';
import { getDeepSeekApiKeyMetaForClient } from '../deepseek/deepseek-api-key.js';
import { getQwenApiKeyMetaForClient, normalizeQwenEndpoint, resolveQwenBaseUrl } from '../qwen/qwen-api-key.js';
import { getCodexApiKeyMetaForClient } from '../codex/codex-api-key.js';
import { getCodexAuthMode, normalizeCodexAuthMode } from '../codex/codex-auth-mode.js';
import { getCodexChatGptAuthMetaForClient } from '../codex/codex-chatgpt-auth.js';
import { getOpenAiApiKeyMetaForClient, isValidOpenAiApiKeyFormat } from '../voice/openai-api-key.js';
import { getGeminiApiKeyMetaForClient, isValidGeminiApiKeyFormat } from '../voice/gemini-api-key.js';
import {
  getAzureSpeechMetaForClient,
  isValidAzureSpeechKeyFormat,
  isValidAzureSpeechRegion,
} from '../voice/azure-speech-key.js';
import { getGithubTokenMetaForClient } from '../github-token.js';
import { getHarnessStatus } from '../harness-status.js';
import { normalizeChatEnabledModels } from '../model-catalog.js';
import { resolveConfiguredSdkRunIdleTimeoutMs } from '../sdk/sdk-run-idle-guard.js';
import { isSdkRunAutoRecoveryForcedByEnv, resolveSdkRunAutoRecoveryEnabled } from '../sdk/sdk-run-auto-recovery.js';
import { loadSettings, saveSettings } from '../persist/settings.js';
import { disposeAllOpenCodeInstances } from '../opencode/opencode-server-manager.js';
import { mergeWorkspaceSidebarConfig, sanitizeWorkspaceSidebarConfig } from '../persist/settings-sidebar.js';
import { readEnvAlias } from '../env-alias.js';
import { msg } from '../messages.js';
import { canRestartServer } from '../server-restart-policy.js';

const WORKSPACES_CACHE_TTL_MS = 30000;
/** @type {{ at: number, key: string, payload: object|null }} */
let workspacesCache = { at: 0, key: '', payload: null };

/**
 * Drop the in-memory GET /api/workspaces cache.
 */
export function invalidateWorkspacesCache() {
  workspacesCache = { at: 0, key: '', payload: null };
}

/**
 * @param {object|null|undefined} settings
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
 * @param {object} settings
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
 * @param {object} settings
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
 * @property {boolean} frontHmrEnabled
 * @property {boolean} frontHmrForcedByEnv
 * @property {boolean} frontHotFallbackEnabled
 * @property {() => string|null} getLanHost
 * @property {(settings?: object|null) => object} getConfiguredWorkspaceSelection
 * @property {() => boolean} isSessionSyncEnabled
 * @property {(settings?: object|null) => boolean} resolveFrontHmrEnabledFromSettings
 */

/**
 * @param {SettingsRoutesContext} ctx
 * @param {object} settings
 * @returns {object}
 */
function buildSettingsResponse(ctx, settings) {
  const lan = ctx.getLanHost();
  const workspaceSelection = ctx.getConfiguredWorkspaceSelection(settings);
  const workspaceSidebarConfig = sanitizeWorkspaceSidebarConfig(settings.workspaceSidebarConfig);
  return {
    ok: true,
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
    debugStartup: settings.debugStartup === true,
    debugApi: settings.debugApi === true,
    debugTasks: settings.debugTasks === true,
    debugOverlay: settings.debugOverlay === true,
    debugUiFreeze: settings.debugUiFreeze === true,
    debugRemote: settings.debugRemote === true,
    debugHttpTiming: isHttpTimingEnabled(settings),
    serverInstanceToken: ctx.serverInstanceToken,
    serverInstanceId: getServerInstanceId(),
    sdkRoomBus: getSdkRoomBusMode(),
    sdkRoomRegistry: getSdkRoomRegistryMode(),
    frontHmrEnabled: ctx.frontHmrEnabled,
    frontHmrConfigEnabled: ctx.resolveFrontHmrEnabledFromSettings(settings),
    frontHmrForcedByEnv: ctx.frontHmrForcedByEnv,
    frontHotFallbackEnabled: ctx.frontHotFallbackEnabled,
    canRestartServer: canRestartServer(),
    ...getSdkRunIdleTimeoutMeta(settings),
    ...getSdkRunAutoRecoveryMeta(settings),
    ...getCursorApiKeyMetaForClient(),
    ...getOpenRouterApiKeyMetaForClient(),
    ...getOpenCodeApiKeyMetaForClient(),
    ...getOpenCodeZaiApiKeyMetaForClient(),
    ...getCodeBuddyApiKeyMetaForClient(),
    ...getDeepSeekApiKeyMetaForClient(),
    ...getQwenApiKeyMetaForClient(),
    ...getCodexApiKeyMetaForClient(),
    ...getCodexChatGptAuthMetaForClient(),
    codexAuthMode: getCodexAuthMode(),
    ...getOpenAiApiKeyMetaForClient(),
    ...getGeminiApiKeyMetaForClient(),
    ...getAzureSpeechMetaForClient(),
    ...getGithubTokenMetaForClient(),
    chatEnabledModels: normalizeChatEnabledModels(settings.chatEnabledModels),
    openrouterChatEnabledModels: normalizeChatEnabledModels(settings.openrouterChatEnabledModels),
    opencodeChatEnabledModels: normalizeChatEnabledModels(settings.opencodeChatEnabledModels),
    codebuddyChatEnabledModels: normalizeChatEnabledModels(settings.codebuddyChatEnabledModels),
    deepseekChatEnabledModels: normalizeChatEnabledModels(settings.deepseekChatEnabledModels),
    qwenChatEnabledModels: normalizeChatEnabledModels(settings.qwenChatEnabledModels),
    codexChatEnabledModels: normalizeChatEnabledModels(settings.codexChatEnabledModels),
    codebuddyBin: typeof settings.codebuddyBin === 'string' ? settings.codebuddyBin : '',
    deepseekBin: typeof settings.deepseekBin === 'string' ? settings.deepseekBin : '',
    qwenBin: typeof settings.qwenBin === 'string' ? settings.qwenBin : '',
    qwenBaseUrl: typeof settings.qwenBaseUrl === 'string' ? settings.qwenBaseUrl : '',
    qwenEndpoint: normalizeQwenEndpoint(settings.qwenEndpoint),
    qwenResolvedBaseUrl: resolveQwenBaseUrl(),
    codexBin: typeof settings.codexBin === 'string' ? settings.codexBin : '',
    opencodeBin: typeof settings.opencodeBin === 'string' ? settings.opencodeBin : '',
    opencodePortBase: Number.isFinite(Number(settings.opencodePortBase)) ? Number(settings.opencodePortBase) : undefined,
    defaultNewChatHarness:
      settings.defaultNewChatHarness === 'openrouter'
        ? 'openrouter'
        : settings.defaultNewChatHarness === 'opencode'
          ? 'opencode'
          : settings.defaultNewChatHarness === 'codebuddy'
            ? 'codebuddy'
            : settings.defaultNewChatHarness === 'deepseek'
              ? 'deepseek'
              : settings.defaultNewChatHarness === 'codex'
                ? 'codex'
                : settings.defaultNewChatHarness === 'qwen'
                  ? 'qwen'
                : 'sdk',
    firstRunSetupDismissed: settings.firstRunSetupDismissed === true,
  };
}

/**
 * @param {import('express').Request} req
 * @param {object} settings
 * @returns {{ changed: boolean, error?: { status: number, message: string } }}
 */
function applySettingsPatch(req, settings) {
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
    if (Object.keys(merged).length > 0) settings.workspaceSidebarConfig = merged;
    else delete settings.workspaceSidebarConfig;
    changed = true;
  }
  if (req.body && typeof req.body.workspaces !== 'undefined') {
    const next = sanitizeWorkspaces(req.body.workspaces);
    if (next.length > 0) settings.workspaces = next;
    else delete settings.workspaces;
    changed = true;
  }
  if (req.body && typeof req.body.workspaceAddPath === 'string') {
    const addResult = applyWorkspaceAddPath(settings, req.body.workspaceAddPath, {
      preferFolders: req.body.workspaceAddAs === 'folder',
    });
    if (!addResult.ok) {
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
    else delete settings.additionalCursorContextDirs;
    changed = true;
  }
  if (req.body && typeof req.body.agentTitlePrint === 'boolean') {
    settings.agentTitlePrint = req.body.agentTitlePrint;
    if (!settings.agentTitlePrint) delete settings.agentTitlePrint;
    changed = true;
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
  if (req.body && typeof req.body.frontHmrEnabled === 'boolean') {
    settings.frontHmrEnabled = req.body.frontHmrEnabled;
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
  if (req.body && req.body.clearOpenrouterApiKey === true) {
    if (settings.openrouterApiKey !== undefined) {
      delete settings.openrouterApiKey;
      changed = true;
    }
  }
  if (req.body && typeof req.body.openrouterApiKey === 'string') {
    const raw = req.body.openrouterApiKey.trim();
    if (raw) {
      if (!isValidOpenRouterApiKeyFormat(raw)) {
        return {
          changed: false,
          error: {
            status: 400,
            message: 'Invalid OpenRouter API key — it must start with sk-or-v1- (create one at openrouter.ai/keys).',
          },
        };
      }
      settings.openrouterApiKey = raw;
      changed = true;
    }
  }
  if (req.body && typeof req.body.openrouterSiteUrl === 'string') {
    const raw = req.body.openrouterSiteUrl.trim();
    if (raw) settings.openrouterSiteUrl = raw;
    else delete settings.openrouterSiteUrl;
    changed = true;
  }
  if (req.body && typeof req.body.openrouterAppTitle === 'string') {
    const raw = req.body.openrouterAppTitle.trim();
    if (raw) settings.openrouterAppTitle = raw;
    else delete settings.openrouterAppTitle;
    changed = true;
  }
  if (req.body && typeof req.body.opencodeApiKey === 'string') {
    const raw = req.body.opencodeApiKey.trim();
    if (raw) {
      if (!isValidOpenCodeApiKeyFormat(raw)) {
        return {
          changed: false,
          error: {
            status: 400,
            message: 'Invalid OpenCode API key format — use your OpenCode Zen key (opencode.ai/zen).',
          },
        };
      }
      settings.opencodeApiKey = raw;
      const misfiled = typeof settings.openrouterApiKey === 'string' ? settings.openrouterApiKey.trim() : '';
      if (misfiled && misfiled === raw) {
        delete settings.openrouterApiKey;
      }
    } else {
      delete settings.opencodeApiKey;
    }
    changed = true;
  }
  if (req.body && req.body.clearOpenCodeApiKey === true) {
    delete settings.opencodeApiKey;
    changed = true;
  }
  if (req.body && typeof req.body.opencodeZaiApiKey === 'string') {
    const raw = req.body.opencodeZaiApiKey.trim();
    if (raw) {
      if (!isValidOpenCodeZaiApiKeyFormat(raw)) {
        return {
          changed: false,
          error: {
            status: 400,
            message: 'Invalid Z.AI API key format — paste a Z.AI key (not an OpenCode Zen or OpenRouter sk- key).',
          },
        };
      }
      settings.opencodeZaiApiKey = raw;
    } else {
      delete settings.opencodeZaiApiKey;
    }
    changed = true;
  }
  if (req.body && req.body.clearOpenCodeZaiApiKey === true) {
    delete settings.opencodeZaiApiKey;
    changed = true;
  }
  if (req.body && typeof req.body.opencodeZaiProvider === 'string') {
    settings.opencodeZaiProvider = normalizeOpenCodeZaiProvider(req.body.opencodeZaiProvider);
    changed = true;
  }
  if (req.body && typeof req.body.codebuddyApiKey === 'string') {
    const raw = req.body.codebuddyApiKey.trim();
    if (raw) settings.codebuddyApiKey = raw;
    else delete settings.codebuddyApiKey;
    changed = true;
    invalidateCodeBuddyModelsCache();
  }
  if (req.body && req.body.clearCodeBuddyApiKey === true) {
    delete settings.codebuddyApiKey;
    changed = true;
    invalidateCodeBuddyModelsCache();
  }
  if (req.body && typeof req.body.codebuddyBin === 'string') {
    const raw = req.body.codebuddyBin.trim();
    if (raw) settings.codebuddyBin = raw;
    else delete settings.codebuddyBin;
    changed = true;
    invalidateCodeBuddyModelsCache();
  }
  if (req.body && typeof req.body.deepseekApiKey === 'string') {
    const raw = req.body.deepseekApiKey.trim();
    if (raw) settings.deepseekApiKey = raw;
    else delete settings.deepseekApiKey;
    changed = true;
  }
  if (req.body && req.body.clearDeepSeekApiKey === true) {
    delete settings.deepseekApiKey;
    changed = true;
  }
  if (req.body && typeof req.body.deepseekBin === 'string') {
    const raw = req.body.deepseekBin.trim();
    if (raw) settings.deepseekBin = raw;
    else delete settings.deepseekBin;
    changed = true;
  }
  if (req.body && typeof req.body.qwenApiKey === 'string') {
    const raw = req.body.qwenApiKey.trim();
    if (raw) settings.qwenApiKey = raw;
    else delete settings.qwenApiKey;
    changed = true;
  }
  if (req.body && req.body.clearQwenApiKey === true) {
    delete settings.qwenApiKey;
    changed = true;
  }
  if (req.body && typeof req.body.qwenBin === 'string') {
    const raw = req.body.qwenBin.trim();
    if (raw) settings.qwenBin = raw;
    else delete settings.qwenBin;
    changed = true;
  }
  if (req.body && typeof req.body.qwenBaseUrl === 'string') {
    const raw = req.body.qwenBaseUrl.trim();
    if (raw) settings.qwenBaseUrl = raw;
    else delete settings.qwenBaseUrl;
    changed = true;
  }
  if (req.body && typeof req.body.qwenEndpoint === 'string') {
    settings.qwenEndpoint = normalizeQwenEndpoint(req.body.qwenEndpoint);
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
  if (req.body && typeof req.body.openrouterChatEnabledModels !== 'undefined') {
    const normalized = normalizeChatEnabledModels(req.body.openrouterChatEnabledModels);
    if (normalized.length > 0) settings.openrouterChatEnabledModels = normalized;
    else delete settings.openrouterChatEnabledModels;
    changed = true;
  }
  if (req.body && typeof req.body.opencodeChatEnabledModels !== 'undefined') {
    const normalized = normalizeChatEnabledModels(req.body.opencodeChatEnabledModels);
    if (normalized.length > 0) settings.opencodeChatEnabledModels = normalized;
    else delete settings.opencodeChatEnabledModels;
    changed = true;
  }
  if (req.body && typeof req.body.codebuddyChatEnabledModels !== 'undefined') {
    const normalized = normalizeChatEnabledModels(req.body.codebuddyChatEnabledModels);
    if (normalized.length > 0) settings.codebuddyChatEnabledModels = normalized;
    else delete settings.codebuddyChatEnabledModels;
    changed = true;
  }
  if (req.body && typeof req.body.deepseekChatEnabledModels !== 'undefined') {
    const normalized = normalizeChatEnabledModels(req.body.deepseekChatEnabledModels);
    if (normalized.length > 0) settings.deepseekChatEnabledModels = normalized;
    else delete settings.deepseekChatEnabledModels;
    changed = true;
  }
  if (req.body && typeof req.body.qwenChatEnabledModels !== 'undefined') {
    const normalized = normalizeChatEnabledModels(req.body.qwenChatEnabledModels);
    if (normalized.length > 0) settings.qwenChatEnabledModels = normalized;
    else delete settings.qwenChatEnabledModels;
    changed = true;
  }
  if (req.body && typeof req.body.codexChatEnabledModels !== 'undefined') {
    const normalized = normalizeChatEnabledModels(req.body.codexChatEnabledModels);
    if (normalized.length > 0) settings.codexChatEnabledModels = normalized;
    else delete settings.codexChatEnabledModels;
    changed = true;
  }
  if (req.body && typeof req.body.opencodeBin === 'string') {
    const raw = req.body.opencodeBin.trim();
    if (raw) settings.opencodeBin = raw;
    else delete settings.opencodeBin;
    changed = true;
  }
  if (req.body && typeof req.body.opencodePortBase !== 'undefined') {
    const parsed = Number.parseInt(String(req.body.opencodePortBase), 10);
    if (Number.isFinite(parsed) && parsed > 0) settings.opencodePortBase = parsed;
    else delete settings.opencodePortBase;
    changed = true;
  }
  if (req.body && typeof req.body.defaultNewChatHarness !== 'undefined') {
    const raw = String(req.body.defaultNewChatHarness || '').trim();
    if (raw === 'openrouter') {
      settings.defaultNewChatHarness = 'openrouter';
    } else if (raw === 'opencode') {
      settings.defaultNewChatHarness = 'opencode';
    } else if (raw === 'codebuddy') {
      settings.defaultNewChatHarness = 'codebuddy';
    } else if (raw === 'deepseek') {
      settings.defaultNewChatHarness = 'deepseek';
    } else if (raw === 'codex') {
      settings.defaultNewChatHarness = 'codex';
    } else if (raw === 'qwen') {
      settings.defaultNewChatHarness = 'qwen';
    } else {
      delete settings.defaultNewChatHarness;
    }
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
  return { changed };
}

/**
 * @typedef {Object} WorkspaceRoutesContext
 * @property {string} projectRoot
 * @property {() => object|null} getCurrentWorkspace
 * @property {() => string|null} getCurrentWorkspaceFile
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
  app.get('/api/workspaces', (req, res) => {
    const startedAt = Date.now();
    const refresh = String(req.query.refresh || '') === '1';
    const scanNew = String(req.query.scan || '') === '1';
    const syncFolders = String(req.query.sync || '') === '1';
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
    if (syncFolders) {
      const sidebar = sanitizeWorkspaceSidebarConfig(settings.workspaceSidebarConfig);
      for (const entry of sanitizeWorkspaces(settings.workspaces)) {
        if (entry.kind !== 'file' || !entry.workspaceFile) continue;
        const loaded = loadWorkspace(entry.workspaceFile);
        const synced = syncFoldersFromFile(loaded?.folders || [], sidebar[entry.id]?.folders);
        sidebar[entry.id] = { ...(sidebar[entry.id] || {}), folders: synced };
      }
      settings.workspaceSidebarConfig = sidebar;
      registryChanged = true;
    }
    if (registryChanged) saveSettings(settings);
    const cacheKey = JSON.stringify({
      scanDir,
      workspaces: settings.workspaces || [],
      sidebar: settings.workspaceSidebarConfig || {},
    });
    const now = Date.now();
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
    const list = buildWorkspacesList({
      registry: settings.workspaces,
      sidebarConfig: settings.workspaceSidebarConfig,
      loadWorkspaceFn: loadWorkspace,
    });
    const payload = { ok: true, workspaces: list };
    workspacesCache = { at: now, key: cacheKey, payload };
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
    const list = buildWorkspacesList({
      registry: settings.workspaces,
      sidebarConfig: settings.workspaceSidebarConfig,
      loadWorkspaceFn: loadWorkspace,
    });
    return res.json({ ok: true, workspaces: list });
  });
  /** Convert a .code-workspace (file) workspace into a self-config Cretli workspace. */
  app.post('/api/workspace/convert', (req, res) => {
    const workspaceFile = String(req.body?.workspaceFile || '').trim();
    if (!workspaceFile) {
      return res.status(400).json({ ok: false, error: msg(req, 'settings.workspacePathInvalid') });
    }
    const settings = loadSettings();
    const result = applyWorkspaceConvertToSelf(settings, workspaceFile, { loadWorkspaceFn: loadWorkspace });
    if (!result.ok) {
      const message = result.error === 'not_found'
        ? msg(req, 'settings.workspaceFileNotInRegistry')
        : msg(req, 'settings.workspacePathInvalid');
      return res.status(400).json({ ok: false, error: message });
    }
    saveSettings(settings);
    invalidateWorkspacesCache();
    const list = buildWorkspacesList({
      registry: settings.workspaces,
      sidebarConfig: settings.workspaceSidebarConfig,
      loadWorkspaceFn: loadWorkspace,
    });
    return res.json({ ok: true, workspaceId: result.id, workspaces: list });
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
  app.patch('/api/settings', async (req, res) => {
    try {
      const startedAt = Date.now();
      const settings = loadSettings();
      const patchResult = applySettingsPatch(req, settings);
      if (patchResult.error) {
        return res.status(patchResult.error.status).json({ ok: false, error: patchResult.error.message });
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
        const shouldResetOpenCode =
          (req.body && typeof req.body.opencodeApiKey === 'string')
          || (req.body && req.body.clearOpenCodeApiKey === true)
          || (req.body && typeof req.body.opencodeZaiApiKey === 'string')
          || (req.body && req.body.clearOpenCodeZaiApiKey === true)
          || (req.body && typeof req.body.opencodeZaiProvider === 'string');
        if (shouldResetOpenCode) {
          disposeAllOpenCodeInstances();
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
