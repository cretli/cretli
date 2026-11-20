import { loadSettings } from '../persist/settings.js';
import { resolveExecutionSettingsView } from '../execution-settings.js';
import { resolveDelegationSettingsView } from '../delegation-settings.js';

const DENIED_FIELD = /(?:secret|token|api.?key|credential|account|auth|role|approval|human.?gate|allowSelfOrigin|browser|network)/i;

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, DENIED_FIELD.test(key) ? '[REDACTED]' : redact(child)]));
}

const SECTIONS = Object.freeze({
  general: {
    description: 'General session and agent title display settings.',
    read: ({ settings }) => ({ sessionSyncEnabled: settings.sessionSyncEnabled ?? null, agentTitlePrint: settings.agentTitlePrint ?? null }),
  },
  autoTitle: {
    description: 'Automatic chat title behavior.',
    read: ({ settings }) => ({ autoTitle: settings.autoTitle ?? null }),
  },
  chatAutoArchive: {
    description: 'Automatic chat archive behavior.',
    read: ({ settings }) => ({ chatAutoArchive: settings.chatAutoArchive ?? null }),
  },
  debug: {
    description: 'Debug logging and diagnostic switches.',
    read: ({ settings }) => Object.fromEntries(['debugHttpTiming', 'debugStartup', 'debugApi', 'debugTasks', 'debugOverlay', 'debugUiFreeze', 'debugRemote'].map((key) => [key, settings[key] ?? null])),
  },
  sdk: {
    description: 'SDK run timeout and recovery behavior.',
    read: ({ settings }) => ({ sdkRunIdleTimeoutSeconds: settings.sdkRunIdleTimeoutSeconds ?? null, sdkRunAutoRecovery: settings.sdkRunAutoRecovery ?? null }),
  },
  execution: {
    description: 'Effective workspace execution mode and worktree behavior.',
    read: ({ workspaceFolder, dataDir }) => {
      const view = resolveExecutionSettingsView({ workspaceFolder, dataDir });
      return { saved: view.saved && { executionMode: view.saved.executionMode ?? null, worktree: view.saved.worktree ?? null }, effective: view.effective };
    },
  },
  delegation: {
    description: 'Effective delegation limits and reviewer configuration.',
    read: ({ workspaceFolder, dataDir }) => {
      const view = resolveDelegationSettingsView({ workspaceFolder, dataDir });
      return { effective: view.effective, source: view.source, scope: view.scope, recovery: /** @type {Record<string, any>} */ (view).recovery };
    },
  },
});

const WRITE_FIELDS = Object.freeze({
  general: ['sessionSyncEnabled', 'agentTitlePrint'],
  autoTitle: ['autoTitle'],
  chatAutoArchive: ['chatAutoArchive'],
  debug: ['debugHttpTiming', 'debugStartup', 'debugApi', 'debugTasks', 'debugOverlay', 'debugUiFreeze', 'debugRemote'],
  sdk: ['sdkRunIdleTimeoutSeconds', 'sdkRunAutoRecovery'],
});

export const OPERATOR_SETTINGS_SECTIONS = Object.freeze(Object.entries(SECTIONS).map(([id, value]) => Object.freeze({ id, description: value.description })));

export function readOperatorSettingsSection(section, { workspaceFolder, dataDir }) {
  if (!Object.hasOwn(SECTIONS, section)) return null;
  const value = SECTIONS[section].read({ settings: loadSettings(), workspaceFolder, dataDir });
  return redact(value);
}

export function operatorSettingsWriteFields(section) {
  return WRITE_FIELDS[section] || null;
}
