/** Mutable chat panel module state shared between chat.js and the modules split out of it. */
import { listLoadedWorkspaces } from '../services/voiceWorkspaces.js';

export const chatShell = {
  embedChatCreationPromise: null,
  /** Preferred chat id from widget host (plus / pin open) — wins over ensureEmbedChat fallback. */
  forcedEmbedChatId: null,
  listCloneFoldersForHeader: () => [],
  getPreferredWorkspaceFolderForChat: () => '',
  listWorkspaceContextsForChat: () => listLoadedWorkspaces(),
  sidebarRenderHook: null,
  /** @type {(() => void)|null} */
  sidebarTransientPatchHook: null,
  /** @type {(() => void)|null} */
  sidebarOpenHook: null,
  /** @type {(() => void)|null} */
  sidebarCloseHook: null,
  /**
   * True once any caller other than a plain chat selection asked for a sidebar
   * update in the current frame; such a frame needs the full render pass.
   */
  sidebarFullRenderPending: false,
  /** @type {Set<string>} */
  pendingSidebarDirtyIds: new Set(),
  chatResumeAdviceController: null,
  chatResumeAdviceScheduler: null,
  pinnedChatSelectionGuard: false,
  chatListLiveSyncApi: null,
  pushInboxConsumeInFlight: false,
  pushInboxConsumeQueued: false,
  chatDeleteConfirmModalApi: undefined,
  chatArchiveConfirmModalApi: undefined,
  pendingDeleteChatId: null,
  /** @type {{ chatId: string, options: object, resolve: (value: boolean) => void } | null} */
  pendingArchiveConfirm: null,
  /** @type {string[]} */
  recentChatPaneIds: [],
  chatTitlesSyncTimer: null,
  chatTitlesSyncInFlight: false,
  sdkRoomBusMode: 'local',
  /** Guards one-time registration of the modal's capture-phase keydown handling. */
  newChatKeydownCaptureBound: false,
  /** Set on the first cached-render attempt after page load; later chat switches never log. */
  coldBootCachedRenderAttempted: false,
  /** Keeps an explicit chat selection while its workspace switch refreshes the list. */
  workspaceRefreshPreserveDepth: 0,
  requestSummaryFromForkAsync: undefined,
  requestAutoTitleFromAgent: undefined,
  requestTitleFromFork: undefined,
  requestSummaryFromFork: undefined,
  /** @type {ReturnType<typeof import('../chatMetadataCrossTab.js').installChatMetadataCrossTabSync> | null} */
  chatMetadataCrossTabSync: null,
};
