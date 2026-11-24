/**
 * Results shared by the voice command adapters. Family-specific payloads keep
 * their own fields; these are the fields read by the send and read-back paths.
 *
 * @typedef {{
 *   ok?: boolean,
 *   code?: string,
 *   error?: string,
 *   message?: string,
 *   pending_undo?: boolean,
 *   chat?: string,
 *   degraded?: boolean,
 *   candidates?: string[],
 *   total?: number,
 *   agents?: Array<{ chat_id: string, title: string, workspace: string, status: string, active: boolean }>,
 *   workspace?: string,
 *   status?: string,
 *   needsConfirm?: boolean,
 *   option?: number,
 *   label?: string,
 *   cardId?: string,
 *   position?: number,
 *   title?: string,
 *   cancelled?: boolean,
 *   optionId?: string,
 *   window_seconds?: number,
 *   text?: string,
 * }} VoiceCommandResult
 *
 * The chat module's public send-bar declaration only describes its multiline
 * controls. Voice also uses the input and the shared submit action.
 *
 * @typedef {{ input?: HTMLTextAreaElement | HTMLInputElement, submit?: (options?: { actionId: string }) => boolean | void | Promise<boolean | void> }} VoiceSendBar
 * @typedef {{ id: string, title?: string, workspaceFile?: string, archived?: boolean, archivedAt?: string, agentTransport?: string }} VoiceChat
 * @typedef {Omit<typeof import('../chat/index.js'), 'getActiveSendBar' | 'getChatsList'> & {
 *   getActiveSendBar: () => VoiceSendBar | null,
 *   getChatsList: () => VoiceChat[],
 * }} VoiceChatModule
 */
export {};
