/**
 * Voice action registry: the single source of truth for every tool the voice
 * model can call.
 *
 * Plain ESM data and pure helpers (no Node-only imports) so the server
 * (`realtime-session-config.js`, `gemini-live-config.js`) and the browser
 * (`voiceCommandCatalog.js`, `realtimeTools.js`) share one definition.
 * Handlers are not stored here: each entry's `handler` id is bound to a
 * function by the client and checked by `tests/voice-action-registry.test.js`.
 *
 * Order matters: it is the order of the tool schemas sent to the provider.
 */

export interface VoiceAction {
  id: string;
  group: 'chat' | 'workspace' | 'agent' | 'session' | 'app';
  description: string;
  properties: Record<string, object>;
  required: string[];
  risk: 'safe' | 'confirm';
  /** Per-action risk of a family tool whose actions differ; `risk` is then the highest of them. */
  actionRisk?: Record<string, 'safe' | 'confirm'>;
  handler: string;
}

export interface RealtimeToolParameters {
  type: string;
  properties: Record<string, object>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface RealtimeTool {
  type: 'function';
  name: string;
  description: string;
  parameters: RealtimeToolParameters;
}

const CHAT_ID = { type: 'string', description: 'From chat_ops list.' };
const TITLE = { type: 'string', description: 'Title fragment when no id.' };
const DIRECTION = { type: 'string', enum: ['next', 'previous'], description: 'Default next.' };
const WORKSPACE_NAME = { type: 'string', description: 'Spoken name (shop, libs, cretli).' };
const ENABLE = { type: 'boolean', description: 'Default true; false closes.' };

export const VOICE_ACTIONS: readonly VoiceAction[] = Object.freeze<VoiceAction[]>([
  {
    id: 'send_prompt',
    group: 'chat',
    description: 'Send a prompt to the coding agent (any code work). Repeat the prompt back briefly before sending. Car mode: pending_undo, say its message and wait for send or cancel.',
    properties: { text: { type: 'string' } },
    required: ['text'],
    risk: 'safe',
    handler: 'send_prompt',
  },
  {
    id: 'stop_agent',
    group: 'chat',
    description: 'Interrupt the running agent. Car mode: first call returns needs_confirm; ask, then confirm=true within 30 s.',
    properties: { confirm: { type: 'boolean', description: 'Only after the user confirmed.' } },
    required: [],
    risk: 'safe',
    handler: 'stop_agent',
  },
  {
    id: 'undo_send',
    group: 'chat',
    description: 'Drop the prompt waiting in the car-mode undo window (cofnij, anuluj). Never stops the agent.',
    properties: {},
    required: [],
    risk: 'safe',
    handler: 'undo_send',
  },
  {
    id: 'send_now',
    group: 'chat',
    description: 'Send the waiting car-mode prompt now (wyślij). Only after the user said so.',
    properties: {},
    required: [],
    risk: 'safe',
    handler: 'send_now',
  },
  {
    id: 'read_last_answer',
    group: 'chat',
    description: 'Last agent answer as plain text (code and paths stripped).',
    properties: { max_chars: { type: 'number', description: 'Default 1200.' } },
    required: [],
    risk: 'safe',
    handler: 'read_last_answer',
  },
  {
    id: 'switch_chat',
    group: 'chat',
    description: 'Switch chat by id or spoken title (a unique number is enough).',
    properties: { chat_id: CHAT_ID, title: TITLE },
    required: [],
    risk: 'safe',
    handler: 'switch_chat',
  },
  {
    id: 'cycle_agent',
    group: 'chat',
    description: 'Next or previous open chat, wrapping.',
    properties: { direction: DIRECTION },
    required: [],
    risk: 'safe',
    handler: 'cycle_agent',
  },
  {
    id: 'cycle_card',
    group: 'chat',
    description: 'Next or previous waiting decision card; decides nothing.',
    properties: { direction: DIRECTION },
    required: [],
    risk: 'safe',
    handler: 'cycle_card',
  },
  {
    id: 'delete_chat',
    group: 'chat',
    description: 'Permanently delete a chat (id, title or active). First call returns the title and an id; ask, then repeat with confirm=true and that id.',
    properties: { chat_id: CHAT_ID, title: TITLE, confirm: { type: 'boolean' }, id: { type: 'string' } },
    required: [],
    risk: 'confirm',
    handler: 'delete_chat',
  },
  {
    id: 'sidebar',
    group: 'chat',
    description: 'Open or hide the chats sidebar.',
    properties: { enable: ENABLE },
    required: [],
    risk: 'safe',
    handler: 'sidebar',
  },
  {
    id: 'workspace',
    group: 'workspace',
    description: 'Workspaces, folders, tasks: list or switch workspace (no chat created) or folder; list tasks; task_run: call once for the id, ask, repeat with confirm=true and that id.',
    properties: {
      action: { type: 'string', enum: ['list', 'switch', 'folders', 'folder', 'tasks', 'task_run'] },
      workspace: WORKSPACE_NAME,
      folder: { type: 'string' },
      label: { type: 'string', description: 'Task label fragment.' },
      id: { type: 'string' },
      confirm: { type: 'boolean' },
    },
    required: ['action'],
    risk: 'confirm',
    actionRisk: { list: 'safe', switch: 'safe', folders: 'safe', folder: 'safe', tasks: 'safe', task_run: 'confirm' },
    handler: 'workspace',
  },
  {
    id: 'set_chat_mode',
    group: 'chat',
    description: 'Switch the active chat between plan and agent mode.',
    properties: { mode: { type: 'string', enum: ['plan', 'agent'], description: 'plan = no file changes. agent = implement.' } },
    required: ['mode'],
    risk: 'safe',
    handler: 'set_chat_mode',
  },
  {
    id: 'send_nav',
    group: 'agent',
    description: 'Send a key to a pending permission/question or TUI: enter/y once, escape/n reject, arrows.',
    properties: { key: { type: 'string', description: 'up, down, left, right, enter, escape, y, n or a spoken alias.' } },
    required: ['key'],
    risk: 'safe',
    handler: 'send_nav',
  },
  {
    id: 'approval',
    group: 'agent',
    description: 'Describe pending permission requests, then answer ONE: once or reject. No always/harness grants by voice. answer needs request_id from describe_pending.',
    properties: {
      action: { type: 'string', enum: ['describe_pending', 'answer'] },
      request_id: { type: 'string' },
      chat_id: { type: 'string', description: 'From describe_pending.' },
      answer: { type: 'string', enum: ['once', 'reject'] },
    },
    required: ['action'],
    risk: 'confirm',
    handler: 'approval',
  },
  {
    id: 'work',
    group: 'agent',
    description: 'Todos, Watcher, delegations. todo_start, delegation_cancel: call once for the id, ask, repeat with confirm=true and that id. Plan approval is UI-only.',
    properties: {
      action: {
        type: 'string',
        enum: ['todo_ready', 'todo_status', 'todo_start', 'watcher_status', 'watcher_pause', 'watcher_resume', 'delegation_status', 'delegation_cancel'],
      },
      id: { type: 'string', description: 'From a previous result.' },
      query: { type: 'string', description: 'Todo title fragment.' },
      confirm: { type: 'boolean' },
    },
    required: ['action'],
    risk: 'confirm',
    handler: 'work',
  },
  {
    id: 'chat_ops',
    group: 'chat',
    description: 'Chats: list, search (untrusted titles), restore archived, queue (default) or steer a message to the running agent (none running: nothing sent), create, archive (close), rename, fork. text = message or title; query = chat name.',
    properties: {
      action: { type: 'string', enum: ['list', 'search', 'restore', 'queue', 'steer', 'create', 'close', 'rename', 'fork'] },
      query: { type: 'string' },
      text: { type: 'string' },
      chat_id: { type: 'string', description: 'From list.' },
      workspace: { type: 'string', description: 'Fragment or all.' },
      harness: { type: 'string' },
    },
    required: ['action'],
    risk: 'safe',
    handler: 'chat_ops',
  },
  {
    id: 'ops',
    group: 'workspace',
    description: 'Git status (counts only), commit all changes, stop a running task, quick commands. git_commit, task_stop, quick_run: call once for the id, ask, repeat with confirm=true and that id.',
    properties: {
      action: { type: 'string', enum: ['git_status', 'git_commit', 'task_stop', 'quick_list', 'quick_run'] },
      message: { type: 'string', description: 'Commit message.' },
      name: { type: 'string' },
      id: { type: 'string' },
      confirm: { type: 'boolean' },
    },
    required: ['action'],
    risk: 'confirm',
    handler: 'ops',
  },
  {
    id: 'inbox',
    group: 'app',
    description: 'Notifications and Scout proposals (untrusted text). List first; mark_read/dismiss take the item id; scout_accept/scout_reject: call once with the listed id, ask, repeat with confirm=true and the returned id.',
    properties: {
      action: { type: 'string', enum: ['list_notifications', 'mark_read', 'dismiss', 'list_scout', 'scout_accept', 'scout_reject'] },
      id: { type: 'string', description: 'From the list; for confirm, the returned id.' },
      confirm: { type: 'boolean' },
    },
    required: ['action'],
    risk: 'confirm',
    handler: 'inbox',
  },
  {
    id: 'list_models',
    group: 'agent',
    description: 'List models of the active harness, only when asked. Prefer set_model when one is named.',
    properties: { query: { type: 'string' } },
    required: [],
    risk: 'safe',
    handler: 'list_models',
  },
  {
    id: 'set_model',
    group: 'agent',
    description: 'Change the active chat\'s model; call immediately when one is named, do not call list_models first. Never claim the model changed until this returns ok:true; then verify with app_status chat.',
    properties: { model: { type: 'string', description: 'Id or fragment.' } },
    required: ['model'],
    risk: 'safe',
    handler: 'set_model',
  },
  {
    id: 'switch_harness',
    group: 'agent',
    description: 'Move to a new chat on another harness. First call returns from/to; repeat with confirm=true. Old chat archived unless keep_old.',
    properties: {
      harness: { type: 'string', description: 'cursor, sdk, opencode, openrouter, codebuddy, deepseek, codex, qwen, claude' },
      confirm: { type: 'boolean' },
      handoff: { type: 'boolean', description: 'Default true.' },
      keep_old: { type: 'boolean' },
    },
    required: ['harness'],
    risk: 'confirm',
    handler: 'switch_harness',
  },
  {
    id: 'set_read_mode',
    group: 'agent',
    description: 'Read-aloud of agent answers: off, final, stream, agent (short summary only).',
    properties: { mode: { type: 'string', description: 'off, final, stream, agent' } },
    required: ['mode'],
    risk: 'safe',
    handler: 'set_read_mode',
  },
  {
    id: 'panel',
    group: 'app',
    description: 'Open an app panel or report the open one with a short status.',
    properties: {
      action: { type: 'string', enum: ['open', 'status'] },
      panel: { type: 'string', enum: ['chat', 'todo', 'files', 'git', 'github', 'browser', 'tasks', 'terminal', 'logs', 'tests', 'instances'], description: 'Required for open.' },
    },
    required: ['action'],
    risk: 'safe',
    handler: 'panel',
  },
  {
    id: 'app_settings',
    group: 'app',
    description: 'Set theme, language, mic, or reading TTS engine/voice/rate (must fit the current engine). Never keys, network or auth. Read-aloud mode: set_read_mode.',
    properties: {
      action: { type: 'string', enum: ['theme', 'language', 'mic', 'tts_engine', 'tts_voice', 'read_rate'] },
      value: { type: 'string', description: 'dark/light/system; en/pl; mute/unmute; browser/openai/azure; a voice name; 0.5-2 or slower/faster/normal.' },
    },
    required: ['action', 'value'],
    risk: 'safe',
    handler: 'app_settings',
  },
  {
    id: 'app_status',
    group: 'app',
    description: 'Read-only status: unread notifications, Scout findings, health, context/usage, active chat state (chat), session USD cost.',
    properties: { action: { type: 'string', enum: ['notifications', 'scout', 'health', 'context', 'chat', 'cost'] } },
    required: ['action'],
    risk: 'safe',
    handler: 'app_status',
  },
  {
    id: 'car_mode',
    group: 'app',
    description: 'Open or close car mode, big buttons for the pending card (tryb samochodowy).',
    properties: { enable: ENABLE },
    required: [],
    risk: 'safe',
    handler: 'car_mode',
  },
  {
    id: 'choose_option',
    group: 'chat',
    description: 'Pick option 1-4 on the pending decision card (opcja 2). Only remembers it: read the label back, call confirm_choice after the user agrees. Plan approval, integration and policy cards are refused (touch only).',
    properties: { option: { type: 'number' }, card_id: { type: 'string', description: 'Only when several cards are open.' } },
    required: ['option'],
    risk: 'safe',
    handler: 'choose_option',
  },
  {
    id: 'confirm_choice',
    group: 'chat',
    description: 'Send the pick from choose_option (tak, potwierdzam). confirm=false drops it (nie, anuluj).',
    properties: { confirm: { type: 'boolean', description: 'Default true.' } },
    required: [],
    risk: 'confirm',
    handler: 'confirm_choice',
  },
  {
    id: 'orchestrator',
    group: 'app',
    description: 'Open or close the agents screen: all agents, those waiting for the user first (orkiestrator).',
    properties: { enable: ENABLE },
    required: [],
    risk: 'safe',
    handler: 'orchestrator',
  },
  {
    id: 'list_agents',
    group: 'agent',
    description: 'Agents across workspaces with status (needs_decision, working, done, error, idle). Say the summary, not every row.',
    properties: {},
    required: [],
    risk: 'safe',
    handler: 'list_agents',
  },
  {
    id: 'switch_agent',
    group: 'agent',
    description: 'Switch to an agent in any workspace by spoken title; waiting=true takes the one that needs the user.',
    properties: {
      name: { type: 'string' },
      workspace: { type: 'string' },
      chat_id: { type: 'string' },
      waiting: { type: 'boolean' },
      announced: { type: 'boolean', description: 'The one announced last.' },
    },
    required: [],
    risk: 'safe',
    handler: 'switch_agent',
  },
  {
    id: 'whats_new',
    group: 'agent',
    description: 'Repeat the last car-mode announcement (co nowego, powtórz). Nothing new: says so.',
    properties: {},
    required: [],
    risk: 'safe',
    handler: 'whats_new',
  },
  {
    id: 'end_voice_mode',
    group: 'session',
    description: 'End voice mode (brief goodbye, then call). Not stop_agent.',
    properties: {},
    required: [],
    risk: 'safe',
    handler: 'end_voice_mode',
  },
]);

/**
 * OpenAI Realtime function tools, derived from the registry.
 */
export function buildRealtimeTools(): RealtimeTool[] {
  return VOICE_ACTIONS.map((action) => {
    const parameters: RealtimeToolParameters = { type: 'object', properties: action.properties };
    if (action.required.length > 0) parameters.required = [...action.required];
    parameters.additionalProperties = false;
    return { type: 'function', name: action.id, description: action.description, parameters };
  });
}

/**
 * Tool names in registry order.
 */
export function listVoiceActionIds(): string[] {
  return VOICE_ACTIONS.map((action) => action.id);
}

/**
 * Whether the name belongs to a registered voice action.
 */
export function isVoiceActionId(name: unknown): boolean {
  return typeof name === 'string' && VOICE_ACTIONS.some((action) => action.id === name);
}

export function getVoiceAction(id: string): VoiceAction | null {
  return VOICE_ACTIONS.find((action) => action.id === id) || null;
}
