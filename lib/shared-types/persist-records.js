/**
 * Record shapes stored by lib/persist/* (typedef-only module, no runtime code).
 *
 * The persist modules (todos-persist, chats-persist, delegations-persist) are
 * still loosely typed; these typedefs describe the fields that every reader can
 * rely on after normalization. Records are open: extra keys written by newer
 * versions or feature flags are kept, hence the `unknown` index signature.
 * Plan: docs/ts-migration-and-core-harnesses-plan.md, A1 point 2.
 */

/** @typedef {'idea' | 'ready' | 'doing' | 'done' | 'deferred'} TodoStatus */

/**
 * One todo as returned by lib/persist/todos-persist.js after normalization.
 * Optional fields are only present when set.
 *
 * @typedef {{
 *   id: string,
 *   title: string,
 *   body: string,
 *   status: TodoStatus,
 *   deferredUntil?: string,
 *   deferredReason?: string,
 *   createdAt: string,
 *   updatedAt: string,
 *   chatId?: string,
 *   createdByChatId?: string,
 *   parentId?: string,
 *   siblingIndex?: number,
 *   assignee?: { harness: string, model?: string, role: string },
 *   runMode?: 'sequential' | 'parallel',
 *   nonBlocking?: boolean,
 *   executionMode?: 'inherit' | 'worktree' | 'project',
 *   linkedChatIds?: string[],
 *   [key: string]: unknown,
 * }} TodoRecord
 */

/**
 * One chat as returned by lib/persist/chats-persist.js. `agentTransport` is the
 * string form of AgentTransport (lib/agent-transport.js) so the record can carry
 * values from older or optional harnesses.
 *
 * @typedef {{
 *   id: string,
 *   title: string,
 *   cursorSessionId: string,
 *   createdAt: string,
 *   updatedAt?: string,
 *   agentTransport?: string,
 *   workspaceFile?: string,
 *   workspaceFolder?: string,
 *   executionFolder?: string,
 *   model?: string,
 *   todoId?: string,
 *   archivedAt?: string,
 *   forkParentChatId?: string,
 *   widgetInstallationId?: string,
 *   widgetPinnedUrl?: string,
 *   sdkAgentId?: string,
 *   sdkMode?: string,
 *   codexThreadId?: string,
 *   [key: string]: any,
 * }} ChatRecord
 */

/**
 * One item of a delegation outbox (undelivered reports to the parent chat).
 *
 * @typedef {{
 *   deliveredAt?: string,
 *   [key: string]: unknown,
 * }} DelegationOutboxItem
 */

/**
 * Delegation row as stored by lib/persist/delegations-persist.js (fields that
 * the index and tick helpers read; the full row carries many more).
 *
 * @typedef {{
 *   id: string,
 *   status: string,
 *   parentChatId: string,
 *   childChatId?: string,
 *   rootChatId?: string,
 *   rootDelegationId?: string,
 *   controllerChatId?: string,
 *   leafId?: string,
 *   revision?: number,
 *   runStoppingAt?: string,
 *   outbox?: DelegationOutboxItem[],
 *   attempts?: Array<Record<string, unknown>>,
 *   errors?: Array<Record<string, unknown>>,
 *   [key: string]: unknown,
 * }} DelegationRecord
 */

export {};
