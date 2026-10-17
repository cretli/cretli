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

/**
 * @typedef {{
 *   id: string,
 *   group: 'chat' | 'workspace' | 'agent' | 'session' | 'app',
 *   description: string,
 *   properties: Record<string, object>,
 *   required: string[],
 *   risk: 'safe' | 'confirm',
 *   handler: string,
 * }} VoiceAction
 */

/** @type {readonly VoiceAction[]} */
export const VOICE_ACTIONS = Object.freeze([
  {
    id: 'send_prompt',
    group: 'chat',
    description: "Send a prompt to the coding agent in the chat the user is currently looking at. Use this whenever the user asks for code work. Repeat the prompt back briefly before sending.",
    properties: {
      "text": {
        "type": "string",
        "description": "The prompt for the coding agent, written as the user would type it."
      }
    },
    required: ["text"],
    risk: 'safe',
    handler: 'send_prompt',
  },
  {
    id: 'stop_agent',
    group: 'chat',
    description: "Interrupt the run in progress in the active chat.",
    properties: {},
    required: [],
    risk: 'safe',
    handler: 'stop_agent',
  },
  {
    id: 'read_last_answer',
    group: 'chat',
    description: "Return the last agent answer as plain text so it can be read out. Code, diffs and paths are stripped.",
    properties: {
      "max_chars": {
        "type": "number",
        "description": "Upper bound on the returned length. Defaults to 1200."
      }
    },
    required: [],
    risk: 'safe',
    handler: 'read_last_answer',
  },
  {
    id: 'get_chat_status',
    group: 'chat',
    description: "State of the active chat: title, harness, plan/agent mode, and whether a run is in progress.",
    properties: {},
    required: [],
    risk: 'safe',
    handler: 'get_chat_status',
  },
  {
    id: 'list_chats',
    group: 'chat',
    description: "List the open chats with their ids, so one of them can be switched to.",
    properties: {},
    required: [],
    risk: 'safe',
    handler: 'list_chats',
  },
  {
    id: 'switch_chat',
    group: 'chat',
    description: "Switch to another chat by id, or by a spoken title when the id is unknown. \"chat\" and \"czat\" are the same word; a unique number from the title is enough.",
    properties: {
      "chat_id": {
        "type": "string",
        "description": "Chat id from list_chats."
      },
      "title": {
        "type": "string",
        "description": "Part of the chat title, used when no id is given."
      }
    },
    required: [],
    risk: 'safe',
    handler: 'switch_chat',
  },
  {
    id: 'delete_chat',
    group: 'chat',
    description: "Permanently delete a chat by id, by spoken title, or the active chat when neither is given. First call without confirm returns the title; call again with confirm=true to delete.",
    properties: {
      "chat_id": {
        "type": "string",
        "description": "Chat id from list_chats."
      },
      "title": {
        "type": "string",
        "description": "Spoken title fragment when the id is unknown."
      },
      "confirm": {
        "type": "boolean",
        "description": "Must be true to actually delete. Omit on the first call."
      }
    },
    required: [],
    risk: 'confirm',
    handler: 'delete_chat',
  },
  {
    id: 'create_chat',
    group: 'chat',
    description: "Create a new coding-agent chat and switch to it. Omit workspace to use the one already active. Pass a workspace name fragment when the user names another project.",
    properties: {
      "workspace": {
        "type": "string",
        "description": "Spoken workspace name or fragment (for example shop, libs, cretli). Empty means the active workspace."
      },
      "title": {
        "type": "string",
        "description": "Optional chat title. Leave empty to let the app name it."
      }
    },
    required: [],
    risk: 'safe',
    handler: 'create_chat',
  },
  {
    id: 'open_chat_sidebar',
    group: 'chat',
    description: "Open the sidebar that lists workspaces and chats. Use when the user asks to see chats, the chat list, or the sidebar.",
    properties: {},
    required: [],
    risk: 'safe',
    handler: 'open_chat_sidebar',
  },
  {
    id: 'close_chat_sidebar',
    group: 'chat',
    description: "Hide the sidebar that lists workspaces and chats. Use when the user asks to close, hide, or dismiss the sidebar.",
    properties: {},
    required: [],
    risk: 'safe',
    handler: 'close_chat_sidebar',
  },
  {
    id: 'set_chat_mode',
    group: 'chat',
    description: "Switch the active chat between plan and agent. Plan only designs; agent implements. Use when the user asks to change mode.",
    properties: {
      "mode": {
        "type": "string",
        "enum": [
          "plan",
          "agent"
        ],
        "description": "plan = design only, no file changes. agent = implement."
      }
    },
    required: ["mode"],
    risk: 'safe',
    handler: 'set_chat_mode',
  },
  {
    id: 'run_task',
    group: 'agent',
    description: "Start a workspace task by its label or a spoken fragment of the label. Call list_tasks first when the user is unsure of the name.",
    properties: {
      "label": {
        "type": "string",
        "description": "Task label or a spoken fragment of it."
      }
    },
    required: ["label"],
    risk: 'safe',
    handler: 'run_task',
  },
  {
    id: 'list_tasks',
    group: 'agent',
    description: "List workspace task labels so one of them can be started with run_task.",
    properties: {},
    required: [],
    risk: 'safe',
    handler: 'list_tasks',
  },
  {
    id: 'list_workspaces',
    group: 'workspace',
    description: "List projects/workspaces with their spoken names and which one is active.",
    properties: {},
    required: [],
    risk: 'safe',
    handler: 'list_workspaces',
  },
  {
    id: 'switch_workspace',
    group: 'workspace',
    description: "Switch the app to another project/workspace without creating a chat. Use a spoken name (cretli, libs, fade). Optional folder switches the cwd in that project.",
    properties: {
      "workspace": {
        "type": "string",
        "description": "Spoken workspace name or fragment (for example shop, libs, cretli)."
      },
      "folder": {
        "type": "string",
        "description": "Optional spoken folder name inside that workspace."
      }
    },
    required: ["workspace"],
    risk: 'safe',
    handler: 'switch_workspace',
  },
  {
    id: 'list_folders',
    group: 'workspace',
    description: "List folders in the active workspace so one of them can be switched to.",
    properties: {},
    required: [],
    risk: 'safe',
    handler: 'list_folders',
  },
  {
    id: 'switch_folder',
    group: 'workspace',
    description: "Switch the cwd folder inside the active workspace. Does not change project.",
    properties: {
      "folder": {
        "type": "string",
        "description": "Spoken folder name or path fragment."
      }
    },
    required: ["folder"],
    risk: 'safe',
    handler: 'switch_folder',
  },
  {
    id: 'close_chat',
    group: 'chat',
    description: "Archive (close) a chat without deleting it, by id, spoken title, or the active chat. Use delete_chat only when the user asks to permanently remove it.",
    properties: {
      "chat_id": {
        "type": "string",
        "description": "Chat id from list_chats."
      },
      "title": {
        "type": "string",
        "description": "Spoken title fragment when the id is unknown."
      }
    },
    required: [],
    risk: 'safe',
    handler: 'close_chat',
  },
  {
    id: 'rename_chat',
    group: 'chat',
    description: "Rename a chat. Defaults to the active chat when no id or title is given.",
    properties: {
      "title": {
        "type": "string",
        "description": "The new chat title."
      },
      "chat_id": {
        "type": "string",
        "description": "Chat id from list_chats."
      },
      "current_title": {
        "type": "string",
        "description": "Spoken current title when renaming a chat that is not active."
      }
    },
    required: ["title"],
    risk: 'safe',
    handler: 'rename_chat',
  },
  {
    id: 'send_nav',
    group: 'agent',
    description: "Send a key to a pending permission or question in the active chat: enter/y confirms once, escape/n rejects, arrows move a TUI. Spoken Polish góra/dół/tak/nie maps to these keys.",
    properties: {
      "key": {
        "type": "string",
        "description": "up, down, left, right, enter, escape, y, or n. Also accepts spoken aliases."
      }
    },
    required: ["key"],
    risk: 'safe',
    handler: 'send_nav',
  },
  {
    id: 'approval',
    group: 'agent',
    description: "Describe pending permission requests, then answer ONE with once or reject. Always/harness grants do not exist by voice. answer needs request_id from describe_pending.",
    properties: {
      "action": {
        "type": "string",
        "enum": ["describe_pending", "answer"],
        "description": "describe_pending lists them; answer decides one."
      },
      "request_id": {
        "type": "string",
        "description": "Required for answer; from describe_pending."
      },
      "chat_id": {
        "type": "string",
        "description": "chatId from describe_pending; must still be active."
      },
      "answer": {
        "type": "string",
        "enum": ["once", "reject"],
        "description": "once = allow one call; reject = deny."
      }
    },
    required: ["action"],
    risk: 'confirm',
    handler: 'approval',
  },
  {
    id: 'list_models',
    group: 'agent',
    description: "List a short page of models for the active harness. Use only when the user asks what is available. Pass query to search. Prefer set_model when they already named a model.",
    properties: {
      "query": {
        "type": "string",
        "description": "Optional spoken fragment to search (e.g. grok, gpt). Empty returns a short sample plus the current model."
      }
    },
    required: [],
    risk: 'safe',
    handler: 'list_models',
  },
  {
    id: 'set_model',
    group: 'agent',
    description: "Change the model of the active chat. Call this immediately when the user names a model — do not call list_models first. Accepts an id or a spoken fragment. Never claim the model changed until this returns ok:true; then call get_chat_status to verify.",
    properties: {
      "model": {
        "type": "string",
        "description": "Model id or a spoken fragment of the label."
      }
    },
    required: ["model"],
    risk: 'safe',
    handler: 'set_model',
  },
  {
    id: 'switch_harness',
    group: 'agent',
    description: "Create a new chat on another harness (cursor/sdk, opencode, openrouter, codebuddy, deepseek, codex, qwen, claude) and switch to it. First call without confirm returns from/to; call again with confirm=true. The current chat is archived unless keep_old is true. handoff=true (default) continues the work.",
    properties: {
      "harness": {
        "type": "string",
        "description": "Spoken harness name: cursor, sdk, opencode, openrouter, codebuddy, deepseek, codex, qwen, claude."
      },
      "confirm": {
        "type": "boolean",
        "description": "Must be true to actually switch. Omit on the first call."
      },
      "handoff": {
        "type": "boolean",
        "description": "When true (default), send the previous transcript so the new agent continues."
      },
      "keep_old": {
        "type": "boolean",
        "description": "When true, leave the current chat open instead of archiving it."
      }
    },
    required: ["harness"],
    risk: 'confirm',
    handler: 'switch_harness',
  },
  {
    id: 'fork_chat',
    group: 'chat',
    description: "Fork the active chat into a new one that continues from the current transcript. The source chat stays open. Optional title and harness; omit harness to keep the current one.",
    properties: {
      "title": {
        "type": "string",
        "description": "Optional title for the new chat."
      },
      "harness": {
        "type": "string",
        "description": "Optional spoken harness for the fork. Empty keeps the current harness."
      }
    },
    required: [],
    risk: 'safe',
    handler: 'fork_chat',
  },
  {
    id: 'set_read_mode',
    group: 'agent',
    description: "Set how the coding-agent answers are read aloud: off, final (after the run), or stream (sentence by sentence). Use off while voice mode is talking so two voices do not overlap. Spoken Polish: wyłącz, na końcu, na bieżąco.",
    properties: {
      "mode": {
        "type": "string",
        "description": "off, final, or stream. Also accepts spoken aliases."
      }
    },
    required: ["mode"],
    risk: 'safe',
    handler: 'set_read_mode',
  },
  {
    id: 'panel',
    group: 'app',
    description: "Open an app panel (tab) or report which panel is open and a short status of it. Use for \"open git\", \"show files\", \"which panel is open\".",
    properties: {
      "action": {
        "type": "string",
        "enum": ["open", "status"],
        "description": "open = switch to the panel. status = active panel (or the named one) with a short status line."
      },
      "panel": {
        "type": "string",
        "enum": ["chat", "todo", "files", "git", "github", "browser", "tasks", "terminal", "logs", "tests", "instances", "agents"],
        "description": "Panel to open. Required for open."
      }
    },
    required: ["action"],
    risk: 'safe',
    handler: 'panel',
  },
  {
    id: 'app_settings',
    group: 'app',
    description: "Change an app setting: color theme, interface language, or mute/unmute the microphone. Read-aloud mode is set_read_mode.",
    properties: {
      "action": {
        "type": "string",
        "enum": ["theme", "language", "mic"],
        "description": "Which setting to change."
      },
      "value": {
        "type": "string",
        "description": "theme: dark, light or system. language: en or pl. mic: mute or unmute. Spoken aliases are accepted."
      }
    },
    required: ["action", "value"],
    risk: 'safe',
    handler: 'app_settings',
  },
  {
    id: 'app_status',
    group: 'app',
    description: "Read-only app status: unread notifications, pending Scout findings, connection and harness health, or the active chat's context/usage.",
    properties: {
      "action": {
        "type": "string",
        "enum": ["notifications", "scout", "health", "context"],
        "description": "What to read. Results are short; summarize them aloud."
      }
    },
    required: ["action"],
    risk: 'safe',
    handler: 'app_status',
  },
  {
    id: 'get_cost',
    group: 'session',
    description: "Return the estimated USD cost of the current voice Live session.",
    properties: {},
    required: [],
    risk: 'safe',
    handler: 'get_cost',
  },
  {
    id: 'end_voice_mode',
    group: 'session',
    description: "End voice mode: stop the microphone and close the Live session. Say a brief goodbye, then call this. Do not use stop_agent — that interrupts the coding agent, not voice mode.",
    properties: {},
    required: [],
    risk: 'safe',
    handler: 'end_voice_mode',
  },
]);

/**
 * OpenAI Realtime function tools, derived from the registry.
 *
 * @returns {Array<{ type: 'function', name: string, description: string, parameters: object }>}
 */
export function buildRealtimeTools() {
  return VOICE_ACTIONS.map((action) => {
    const parameters = { type: 'object', properties: action.properties };
    if (action.required.length > 0) parameters.required = [...action.required];
    parameters.additionalProperties = false;
    return { type: 'function', name: action.id, description: action.description, parameters };
  });
}

/**
 * @returns {string[]} tool names in registry order
 */
export function listVoiceActionIds() {
  return VOICE_ACTIONS.map((action) => action.id);
}

/**
 * @param {unknown} name
 * @returns {boolean} whether the name belongs to a registered voice action
 */
export function isVoiceActionId(name) {
  return typeof name === 'string' && VOICE_ACTIONS.some((action) => action.id === name);
}

/**
 * @param {string} id
 * @returns {VoiceAction | null}
 */
export function getVoiceAction(id) {
  return VOICE_ACTIONS.find((action) => action.id === id) || null;
}
