/**
 * Lightweight chat list DTO (docs/architecture-list-sync-contract.md, vertical V2).
 *
 * An allowlist projection of a persisted chat row for the sidebar: no history, no
 * summaries, no provider session ids and no local execution paths. Pure and
 * synchronous; the transport decides who may see which row.
 */

export const CHAT_LIST_DTO_VERSION = 1;

/** Persisted row fields copied verbatim into the DTO (scalars only). */
export const CHAT_LIST_DTO_FIELDS = Object.freeze([
  'id',
  'title',
  'titleSource',
  'titleRev',
  'workspaceFolder',
  'workspaceFile',
  'model',
  'agentTransport',
  'sdkMode',
  'sdkUiMode',
  'createdAt',
  'updatedAt',
  'archivedAt',
  'forkParentChatId',
  'forkKind',
  'todoId',
  'delegationParentChatId',
  'delegationId',
  'delegationDepth',
  'delegationRootChatId',
  'delegationAssignment',
  'pickPurpose',
  'lastFinishedAt',
  'lastSeenAt',
  'widgetInstallationId',
  'widgetPageSessionId',
  'widgetPinnedUrl',
  'watcherPinned',
  'isTemporary',
]);

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isScalar(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

/**
 * @param {Record<string, any> | null | undefined} chat Persisted chat row.
 * @param {{ onWorktree?: boolean }} [extras] Derived flags the row itself does not carry.
 * @returns {Record<string, any> | null} DTO, or null for a row without a string id.
 */
export function toChatListDto(chat, extras = {}) {
  if (!chat || typeof chat !== 'object' || typeof chat.id !== 'string' || !chat.id) return null;
  const dto = {};
  for (const field of CHAT_LIST_DTO_FIELDS) {
    const value = chat[field];
    if (value !== undefined && isScalar(value)) dto[field] = value;
  }
  if (extras.onWorktree === true) dto.onWorktree = true;
  return dto;
}

/**
 * @param {Iterable<Record<string, any>>} chats
 * @param {{ worktreeTodoIds?: Set<string> }} [options]
 * @returns {Record<string, any>[]}
 */
export function toChatListDtos(chats, options = {}) {
  const worktreeTodoIds = options.worktreeTodoIds instanceof Set ? options.worktreeTodoIds : null;
  const out = [];
  for (const chat of chats) {
    const todoId = worktreeTodoIds && chat && typeof chat.todoId === 'string' ? chat.todoId.trim() : '';
    const dto = toChatListDto(chat, { onWorktree: Boolean(todoId && worktreeTodoIds.has(todoId)) });
    if (dto) out.push(dto);
  }
  return out;
}
