/** Chat panel runtime state shared between chat.js and the modules split out of it. */
import { readLastSelectedModel, readLastSelectedHarness } from '../chatSettingsPrefs.js';

export const chats = [];

/** Chat ids removed locally this session; stale GET responses must not resurrect them. */
export const removedChatIds = new Set();

export const chatRuntime = {
  /** Modal APIs (chat settings, new chat) from lib/modal.js */
  chatSettingsModalApi: undefined,
  chatSettingsVoiceRead: undefined,
  chatContextDetailsModalApi: undefined,
  sharedSdkModeBar: null,
  switchHarnessInFlight: false,
  /** @type {{ chatId: string, harness: string } | null} */
  pendingWidgetHarnessSwitch: null,
  resolveChatTextForFork: async () => '',
  /** @type {ReturnType<typeof import('../chatModelSelect.js').createChatModelSelect>|null} */
  chatModelSelectApi: null,
  /** @type {ReturnType<typeof import('../chatDiagnostics.js').createChatDiagnostics>|null} */
  chatDiagnosticsApi: null,
  activeChatId: null,
  workspaces: [],
  selectedWorkspaceFile: null,
  selectedWorkspaceFolder: null,
  /** Workspace folder from server settings — OpenCode is usually ready here. */
  serverSettingsWorkspaceFolder: '',
  /** @type {Promise<unknown>|null} */
  pendingOpenCodeCatalogFetch: null,
  selectedModel: readLastSelectedModel(),
  selectedHarness: readLastSelectedHarness(),
  /** @type {((workspaceFile: string, workspaceFolder?: string) => Promise<boolean>|boolean)|null} */
  workspaceSwitchHook: null,
};
