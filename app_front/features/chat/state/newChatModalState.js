/** Mutable state of the new-chat / fork / pass-message modal, shared with chat.js. */

export const newChatModalState = {
  chatNewModalApi: undefined,
  /** @type {string|null} */
  forkSourceChatId: null,
  /** Inclusive history cut for per-message fork; null means copy the full parent. */
  /** @type {string|null} */
  forkUpToCreatedAt: null,
  /** @type {string|null} */
  monitorSourceChatId: null,
  /** @type {string|null} */
  buildPlanSourceChatId: null,
  /** @type {string|null} */
  passMessageSourceChatId: null,
  /** @type {{ historySeq: number, createdAt: string, text: string }} */
  passMessageMeta: { historySeq: 0, createdAt: '', text: '' },
  chatNewModelDropdownApi: null,
  chatNewFolderDropdownApi: null,
  /** Element focused before the new-chat modal opened, restored on close. */
  /** @type {HTMLElement|null} */
  newChatModalReturnFocus: null,
  /** True while a chat is being created from the “New chat” modal — blocks double-submit. */
  chatCreateInFlight: false,
  /** True once the user changed the harness in an open new-chat modal — async defaults must not override it. */
  newChatHarnessUserTouched: false,
  /** True when the open modal already resolved an explicit harness (source chat / last delegation executor / last used). */
  newChatHarnessExplicitChoice: false,
  /** True once the user changed the model in an open new-chat modal — async workspace loads must not override it. */
  newChatModelUserTouched: false,
  todoAgentModalSubmit: null,
  /** When true, the new-chat modal shows plan-reviewer cooperation mode (refine loop). */
  todoAgentModalPlanReviewerMode: false,
  newChatUsageCheckPending: false,
  newChatUsageCheckSequence: 0,
  newChatLimitExpiryTimer: null,
  newChatModelCatalogLoadSequence: 0,
  /**
   * Open the new-chat modal. Fork/monitor/build-plan modes reuse the harness+model form.
   *
   * @param {{
   *   forkFromChatId?: string,
   *   upToCreatedAt?: string,
   *   monitorFromChatId?: string,
   *   buildPlanFromChatId?: string,
   *   passMessageFromChatId?: string,
   *   historySeq?: number,
   *   createdAt?: string,
   *   text?: string,
   *   workspaceFile?: string,
   *   workspaceFolder?: string,
   * }} [options]
   */
  /**
   * Worktree preselected from the active chat (todo id + its workspace), or
   * null. The select itself is filled from `GET /api/worktrees`.
   */
  newChatWorktreeTarget: null,
  /** Bumps per modal open so a late worktree list cannot repaint a newer modal. */
  newChatWorktreeLoadSeq: 0,
  newChatLocationGeneration: 0,
  newChatLocationUserTouched: false,
  newChatWorktreeScope: '',
};
