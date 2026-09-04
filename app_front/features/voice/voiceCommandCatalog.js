/**
 * Spoken-command catalog for the voice panel help list.
 *
 * Ids must stay in lockstep with `REALTIME_TOOLS` in
 * `lib/voice/realtime-session-config.js`. Example phrases live in i18n
 * (`voice.command.<id>`). The Live model still accepts natural speech — this
 * list is a cheat-sheet, not a grammar.
 */

/** @typedef {{ id: string, group: 'chat' | 'workspace' | 'agent' | 'session' }} VoiceCommandEntry */

export const VOICE_COMMAND_GROUPS = /** @type {const} */ ([
  'chat',
  'workspace',
  'agent',
  'session',
]);

/** @type {readonly VoiceCommandEntry[]} */
export const VOICE_COMMAND_CATALOG = [
  { id: 'send_prompt', group: 'chat' },
  { id: 'stop_agent', group: 'chat' },
  { id: 'read_last_answer', group: 'chat' },
  { id: 'get_chat_status', group: 'chat' },
  { id: 'list_chats', group: 'chat' },
  { id: 'switch_chat', group: 'chat' },
  { id: 'create_chat', group: 'chat' },
  { id: 'close_chat', group: 'chat' },
  { id: 'delete_chat', group: 'chat' },
  { id: 'rename_chat', group: 'chat' },
  { id: 'fork_chat', group: 'chat' },
  { id: 'open_chat_sidebar', group: 'chat' },
  { id: 'close_chat_sidebar', group: 'chat' },
  { id: 'set_chat_mode', group: 'chat' },
  { id: 'list_workspaces', group: 'workspace' },
  { id: 'switch_workspace', group: 'workspace' },
  { id: 'list_folders', group: 'workspace' },
  { id: 'switch_folder', group: 'workspace' },
  { id: 'list_tasks', group: 'agent' },
  { id: 'run_task', group: 'agent' },
  { id: 'list_models', group: 'agent' },
  { id: 'set_model', group: 'agent' },
  { id: 'switch_harness', group: 'agent' },
  { id: 'send_nav', group: 'agent' },
  { id: 'set_read_mode', group: 'agent' },
  { id: 'get_cost', group: 'session' },
  { id: 'end_voice_mode', group: 'session' },
];

/**
 * @returns {string[]}
 */
export function listVoiceCommandIds() {
  return VOICE_COMMAND_CATALOG.map((entry) => entry.id);
}

/**
 * @returns {Array<{ id: string, commands: VoiceCommandEntry[] }>}
 */
export function listVoiceCommandGroups() {
  return VOICE_COMMAND_GROUPS.map((group) => ({
    id: group,
    commands: VOICE_COMMAND_CATALOG.filter((entry) => entry.group === group),
  })).filter((group) => group.commands.length > 0);
}
