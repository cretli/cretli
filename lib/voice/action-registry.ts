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

export const VOICE_ACTIONS: readonly VoiceAction[] = Object.freeze<VoiceAction[]>([
  {
    id: 'send_prompt',
    group: 'chat',
    description: "Send a prompt to the coding agent in the active chat. Use for any code work. Repeat the prompt back briefly before sending.",
    properties: {
      "text": {
        "type": "string",
        "description": "The prompt, as the user would type it."
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
    description: "Last agent answer as plain text (code, diffs, paths stripped).",
    properties: {
      "max_chars": {
        "type": "number",
        "description": "Max length, default 1200."
      }
    },
    required: [],
    risk: 'safe',
    handler: 'read_last_answer',
  },
  {
    id: 'get_chat_status',
    group: 'chat',
    description: "Active chat state: title, harness, mode, run in progress.",
    properties: {},
    required: [],
    risk: 'safe',
    handler: 'get_chat_status',
  },
  {
    id: 'list_chats',
    group: 'chat',
    description: "List open chats with ids.",
    properties: {},
    required: [],
    risk: 'safe',
    handler: 'list_chats',
  },
  {
    id: 'switch_chat',
    group: 'chat',
    description: "Switch chat by id or spoken title; \"chat\"=\"czat\"; a unique number from the title is enough.",
    properties: {
      "chat_id": {
        "type": "string",
        "description": "Chat id from list_chats."
      },
      "title": {
        "type": "string",
        "description": "Title fragment when no id."
      }
    },
    required: [],
    risk: 'safe',
    handler: 'switch_chat',
  },
  {
    id: 'delete_chat',
    group: 'chat',
    description: "Permanently delete a chat (id, spoken title, or active). First call without confirm returns the title; repeat with confirm=true.",
    properties: {
      "chat_id": {
        "type": "string",
        "description": "Chat id from list_chats."
      },
      "title": {
        "type": "string",
        "description": "Title fragment when no id."
      },
      "confirm": {
        "type": "boolean",
        "description": "true to delete; omit on first call."
      }
    },
    required: [],
    risk: 'confirm',
    handler: 'delete_chat',
  },
  {
    id: 'create_chat',
    group: 'chat',
    description: "Create a chat and switch to it. Omit workspace for the active one; pass a name fragment when the user names another project.",
    properties: {
      "workspace": {
        "type": "string",
        "description": "Spoken workspace name or fragment (for example shop, libs, cretli)."
      },
      "title": {
        "type": "string",
        "description": "Optional title."
      }
    },
    required: [],
    risk: 'safe',
    handler: 'create_chat',
  },
  {
    id: 'open_chat_sidebar',
    group: 'chat',
    description: "Open the workspaces/chats sidebar.",
    properties: {},
    required: [],
    risk: 'safe',
    handler: 'open_chat_sidebar',
  },
  {
    id: 'close_chat_sidebar',
    group: 'chat',
    description: "Hide the workspaces/chats sidebar.",
    properties: {},
    required: [],
    risk: 'safe',
    handler: 'close_chat_sidebar',
  },
  {
    id: 'set_chat_mode',
    group: 'chat',
    description: "Switch the active chat between plan and agent mode.",
    properties: {
      "mode": {
        "type": "string",
        "enum": [
          "plan",
          "agent"
        ],
        "description": "plan = no file changes. agent = implement."
      }
    },
    required: ["mode"],
    risk: 'safe',
    handler: 'set_chat_mode',
  },
  {
    id: 'run_task',
    group: 'agent',
    description: "Start a workspace task by label or spoken fragment.",
    properties: {
      "label": {
        "type": "string",
        "description": "Task label fragment."
      }
    },
    required: ["label"],
    risk: 'safe',
    handler: 'run_task',
  },
  {
    id: 'list_tasks',
    group: 'agent',
    description: "List workspace task labels.",
    properties: {},
    required: [],
    risk: 'safe',
    handler: 'list_tasks',
  },
  {
    id: 'list_workspaces',
    group: 'workspace',
    description: "List workspaces and the active one.",
    properties: {},
    required: [],
    risk: 'safe',
    handler: 'list_workspaces',
  },
  {
    id: 'switch_workspace',
    group: 'workspace',
    description: "Switch workspace without creating a chat. Optional folder.",
    properties: {
      "workspace": {
        "type": "string",
        "description": "Spoken workspace name or fragment (for example shop, libs, cretli)."
      },
      "folder": {
        "type": "string",
        "description": "Optional folder."
      }
    },
    required: ["workspace"],
    risk: 'safe',
    handler: 'switch_workspace',
  },
  {
    id: 'list_folders',
    group: 'workspace',
    description: "List folders in the active workspace.",
    properties: {},
    required: [],
    risk: 'safe',
    handler: 'list_folders',
  },
  {
    id: 'switch_folder',
    group: 'workspace',
    description: "Switch cwd folder in the active workspace.",
    properties: {
      "folder": {
        "type": "string",
        "description": "Folder name fragment."
      }
    },
    required: ["folder"],
    risk: 'safe',
    handler: 'switch_folder',
  },
  {
    id: 'close_chat',
    group: 'chat',
    description: "Archive (not delete) a chat: id, spoken title, or active.",
    properties: {
      "chat_id": {
        "type": "string",
        "description": "Chat id from list_chats."
      },
      "title": {
        "type": "string",
        "description": "Title fragment when no id."
      }
    },
    required: [],
    risk: 'safe',
    handler: 'close_chat',
  },
  {
    id: 'rename_chat',
    group: 'chat',
    description: "Rename a chat; defaults to the active one.",
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
        "description": "Current title of a non-active chat."
      }
    },
    required: ["title"],
    risk: 'safe',
    handler: 'rename_chat',
  },
  {
    id: 'send_nav',
    group: 'agent',
    description: "Send a key to a pending permission/question or TUI: enter/y confirm once, escape/n reject, arrows. Polish góra/dół/tak/nie ok.",
    properties: {
      "key": {
        "type": "string",
        "description": "up, down, left, right, enter, escape, y, n. Also accepts spoken aliases."
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
    id: 'work',
    group: 'agent',
    description: "Todos, Watcher, delegations. todo_start and delegation_cancel: run once to get the id, ask the user, then repeat with confirm=true and that id. Plan approval is UI-only.",
    properties: {
      "action": {
        "type": "string",
        "enum": ["todo_ready", "todo_status", "todo_start", "watcher_status", "watcher_pause", "watcher_resume", "delegation_status", "delegation_cancel"]
      },
      "id": { "type": "string", "description": "todo/delegation id from a previous result." },
      "query": { "type": "string", "description": "Todo title fragment when the id is unknown." },
      "confirm": { "type": "boolean" }
    },
    required: ["action"],
    risk: 'confirm',
    handler: 'work',
  },
  {
    id: 'list_models',
    group: 'agent',
    description: "List models of the active harness only when asked. Prefer set_model when one is named.",
    properties: {
      "query": {
        "type": "string",
        "description": "Search fragment."
      }
    },
    required: [],
    risk: 'safe',
    handler: 'list_models',
  },
  {
    id: 'set_model',
    group: 'agent',
    description: "Change the active chat's model; call immediately when one is named, do not call list_models first. Id or spoken fragment. Never claim the model changed until this returns ok:true; then verify with get_chat_status.",
    properties: {
      "model": {
        "type": "string",
        "description": "Model id or fragment."
      }
    },
    required: ["model"],
    risk: 'safe',
    handler: 'set_model',
  },
  {
    id: 'switch_harness',
    group: 'agent',
    description: "Create a chat on another harness and switch to it. First call without confirm returns from/to; repeat with confirm=true. The old chat is archived unless keep_old.",
    properties: {
      "harness": {
        "type": "string",
        "description": "cursor, sdk, opencode, openrouter, codebuddy, deepseek, codex, qwen, claude."
      },
      "confirm": {
        "type": "boolean",
        "description": "true to switch; omit on first call."
      },
      "handoff": {
        "type": "boolean",
        "description": "Default true: send the transcript to the new agent."
      },
      "keep_old": {
        "type": "boolean",
        "description": "true: keep the old chat open."
      }
    },
    required: ["harness"],
    risk: 'confirm',
    handler: 'switch_harness',
  },
  {
    id: 'fork_chat',
    group: 'chat',
    description: "Fork the active chat into a new one; the source stays open.",
    properties: {
      "title": {
        "type": "string",
        "description": "Optional title."
      },
      "harness": {
        "type": "string",
        "description": "Optional harness; empty keeps current."
      }
    },
    required: [],
    risk: 'safe',
    handler: 'fork_chat',
  },
  {
    id: 'set_read_mode',
    group: 'agent',
    description: "Read-aloud of agent answers: off, final (after the run), stream. Polish: wyłącz, na końcu, na bieżąco.",
    properties: {
      "mode": {
        "type": "string",
        "description": "off, final, stream. Also accepts spoken aliases."
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
    description: "End voice mode (brief goodbye, then call). Not stop_agent.",
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
