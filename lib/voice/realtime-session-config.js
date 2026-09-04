/**
 * Session configuration pinned to every minted Realtime client secret.
 *
 * The browser receives only an ephemeral `ek_...` token; instructions, tools and
 * audio settings are decided here so a client cannot widen its own permissions.
 * Tool names must stay in sync with the executor in
 * `app_front/features/voice/realtimeTools.js`.
 */

/**
 * Mini is the default because the flagship (`gpt-realtime-2.1`) bills audio at
 * roughly 3× the mini rate. The client may still ask for the flagship.
 */
export const DEFAULT_REALTIME_MODEL = 'gpt-realtime-2.1-mini';
export const REALTIME_FLAGSHIP_MODEL = 'gpt-realtime-2.1';
export const REALTIME_MINI_MODEL = 'gpt-realtime-2.1-mini';
export const REALTIME_OPENAI_MODELS = [REALTIME_MINI_MODEL, REALTIME_FLAGSHIP_MODEL];
export const DEFAULT_REALTIME_VOICE = 'marin';
/** Spoken answers should stay short — output audio is the expensive half. */
export const REALTIME_MAX_OUTPUT_TOKENS = 220;
/** How many recent conversation items survive a turn. Audio history is the leak. */
export const REALTIME_KEEP_RECENT_ITEMS = 4;
export const REALTIME_VOICES = [
  'marin',
  'cedar',
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'sage',
  'shimmer',
  'verse',
];

/** Short-lived on purpose: a leaked token must not be reusable for long. */
export const CLIENT_SECRET_TTL_SECONDS = 600;

/** @type {Array<{ type: 'function', name: string, description: string, parameters: object }>} */
export const REALTIME_TOOLS = [
  {
    type: 'function',
    name: 'send_prompt',
    description:
      'Send a prompt to the coding agent in the chat the user is currently looking at. Use this whenever the user asks for code work. Repeat the prompt back briefly before sending.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The prompt for the coding agent, written as the user would type it.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'stop_agent',
    description: 'Interrupt the run in progress in the active chat.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'read_last_answer',
    description:
      'Return the last agent answer as plain text so it can be read out. Code, diffs and paths are stripped.',
    parameters: {
      type: 'object',
      properties: {
        max_chars: {
          type: 'number',
          description: 'Upper bound on the returned length. Defaults to 1200.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_chat_status',
    description: 'State of the active chat: title, harness, plan/agent mode, and whether a run is in progress.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'list_chats',
    description: 'List the open chats with their ids, so one of them can be switched to.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'switch_chat',
    description:
      'Switch to another chat by id, or by a spoken title when the id is unknown. "chat" and "czat" are the same word; a unique number from the title is enough.',
    parameters: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Chat id from list_chats.' },
        title: { type: 'string', description: 'Part of the chat title, used when no id is given.' },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'delete_chat',
    description:
      'Permanently delete a chat by id, by spoken title, or the active chat when neither is given. First call without confirm returns the title; call again with confirm=true to delete.',
    parameters: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Chat id from list_chats.' },
        title: { type: 'string', description: 'Spoken title fragment when the id is unknown.' },
        confirm: {
          type: 'boolean',
          description: 'Must be true to actually delete. Omit on the first call.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'create_chat',
    description:
      'Create a new coding-agent chat and switch to it. Omit workspace to use the one already active. Pass a workspace name fragment when the user names another project.',
    parameters: {
      type: 'object',
      properties: {
        workspace: {
          type: 'string',
          description:
            'Spoken workspace name or fragment (for example shop, libs, cretli). Empty means the active workspace.',
        },
        title: {
          type: 'string',
          description: 'Optional chat title. Leave empty to let the app name it.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'open_chat_sidebar',
    description:
      'Open the sidebar that lists workspaces and chats. Use when the user asks to see chats, the chat list, or the sidebar.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'close_chat_sidebar',
    description:
      'Hide the sidebar that lists workspaces and chats. Use when the user asks to close, hide, or dismiss the sidebar.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'set_chat_mode',
    description:
      'Switch the active chat between plan and agent. Plan only designs; agent implements. Use when the user asks to change mode.',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['plan', 'agent'],
          description: 'plan = design only, no file changes. agent = implement.',
        },
      },
      required: ['mode'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'run_task',
    description:
      'Start a workspace task by its label or a spoken fragment of the label. Call list_tasks first when the user is unsure of the name.',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Task label or a spoken fragment of it.' },
      },
      required: ['label'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'list_tasks',
    description: 'List workspace task labels so one of them can be started with run_task.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'list_workspaces',
    description: 'List projects/workspaces with their spoken names and which one is active.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'switch_workspace',
    description:
      'Switch the app to another project/workspace without creating a chat. Use a spoken name (cretli, libs, fade). Optional folder switches the cwd in that project.',
    parameters: {
      type: 'object',
      properties: {
        workspace: {
          type: 'string',
          description: 'Spoken workspace name or fragment (for example shop, libs, cretli).',
        },
        folder: {
          type: 'string',
          description: 'Optional spoken folder name inside that workspace.',
        },
      },
      required: ['workspace'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'list_folders',
    description: 'List folders in the active workspace so one of them can be switched to.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'switch_folder',
    description: 'Switch the cwd folder inside the active workspace. Does not change project.',
    parameters: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Spoken folder name or path fragment.' },
      },
      required: ['folder'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'close_chat',
    description:
      'Archive (close) a chat without deleting it, by id, spoken title, or the active chat. Use delete_chat only when the user asks to permanently remove it.',
    parameters: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Chat id from list_chats.' },
        title: { type: 'string', description: 'Spoken title fragment when the id is unknown.' },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'rename_chat',
    description: 'Rename a chat. Defaults to the active chat when no id or title is given.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The new chat title.' },
        chat_id: { type: 'string', description: 'Chat id from list_chats.' },
        current_title: {
          type: 'string',
          description: 'Spoken current title when renaming a chat that is not active.',
        },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'send_nav',
    description:
      'Send a key to a pending permission or question in the active chat: enter/y confirms once, escape/n rejects, arrows move a TUI. Spoken Polish góra/dół/tak/nie maps to these keys.',
    parameters: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'up, down, left, right, enter, escape, y, or n. Also accepts spoken aliases.',
        },
      },
      required: ['key'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'list_models',
    description:
      'List models enabled for the active chat harness so one of them can be selected with set_model.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'set_model',
    description:
      'Change the model of the active chat. Use a model id from list_models, or a spoken fragment of the label.',
    parameters: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Model id or a spoken fragment of the label.' },
      },
      required: ['model'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'switch_harness',
    description:
      'Create a new chat on another harness (cursor/sdk, opencode, openrouter, codebuddy, deepseek, codex, qwen) and switch to it. First call without confirm returns from/to; call again with confirm=true. The current chat is archived unless keep_old is true. handoff=true (default) continues the work.',
    parameters: {
      type: 'object',
      properties: {
        harness: {
          type: 'string',
          description: 'Spoken harness name: cursor, sdk, opencode, openrouter, codebuddy, deepseek, codex, qwen.',
        },
        confirm: {
          type: 'boolean',
          description: 'Must be true to actually switch. Omit on the first call.',
        },
        handoff: {
          type: 'boolean',
          description: 'When true (default), send the previous transcript so the new agent continues.',
        },
        keep_old: {
          type: 'boolean',
          description: 'When true, leave the current chat open instead of archiving it.',
        },
      },
      required: ['harness'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'fork_chat',
    description:
      'Fork the active chat into a new one that continues from the current transcript. The source chat stays open. Optional title and harness; omit harness to keep the current one.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Optional title for the new chat.' },
        harness: {
          type: 'string',
          description: 'Optional spoken harness for the fork. Empty keeps the current harness.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'set_read_mode',
    description:
      'Set how the coding-agent answers are read aloud: off, final (after the run), or stream (sentence by sentence). Use off while voice mode is talking so two voices do not overlap. Spoken Polish: wyłącz, na końcu, na bieżąco.',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          description: 'off, final, or stream. Also accepts spoken aliases.',
        },
      },
      required: ['mode'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_cost',
    description: 'Return the estimated USD cost of the current voice Live session.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'end_voice_mode',
    description:
      'End voice mode: stop the microphone and close the Live session. Say a brief goodbye, then call this. Do not use stop_agent — that interrupts the coding agent, not voice mode.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
];

/**
 * @param {{ lang?: string }} [options]
 * @returns {string}
 */
export function buildRealtimeInstructions(options = {}) {
  const lang = options.lang === 'pl' ? 'Polish' : 'English';
  return [
    'You are the voice interface of Cretli, a self-hosted app that runs coding agents on the user\'s own machine.',
    `Speak ${lang} unless the user switches language. Keep answers short — this is a spoken conversation, not a document.`,
    'You do not write code yourself. When the user wants code work done, phrase it as a prompt and call send_prompt; the coding agent does the work.',
    'Never read code, diffs, file paths or URLs out loud. Summarise them instead ("changed three files in the voice module").',
    'Before sending a prompt, repeat it back in one sentence so the user can stop you if it is wrong.',
    'When the user asks what the agent said, call read_last_answer and summarise the result.',
    'If a tool fails, say so plainly and suggest what to do next. Never invent tool results.',
    'When the user wants a new chat, call create_chat. Use the active workspace unless they name another one. After it succeeds, further send_prompt calls go to that new chat.',
    'When the user asks to see the chat list or open the sidebar, call open_chat_sidebar. When they ask to hide or close the sidebar, call close_chat_sidebar.',
    'When the user asks to switch to plan or agent mode, call set_chat_mode. Spoken Polish like planowanie or tryb planu means plan.',
    'When the user asks to delete a chat, name it, call delete_chat without confirm, then call again with confirm=true only if they agree. close_chat archives instead of deleting.',
    'When the user asks which projects or workspaces they have, call list_workspaces. To switch project, call switch_workspace — do not create a chat just to switch.',
    'When the user asks about folders in the current project, call list_folders. To change folder, call switch_folder.',
    'When the user asks which tasks exist, call list_tasks. run_task accepts a spoken fragment of the label.',
    'When the user asks to rename a chat, call rename_chat with the new title.',
    'When the user wants to confirm or reject a permission, or navigate a terminal prompt, call send_nav. enter or tak confirms once, escape or nie rejects, arrows move.',
    'When the user asks which models they can use, call list_models. set_model accepts a spoken fragment of the model name.',
    'When the user wants to switch the coding harness (Cursor, OpenCode, Codex, and so on), call switch_harness without confirm first, then again with confirm=true if they agree. handoff=true continues the work in the new chat.',
    'When the user wants to continue this conversation in a new chat, call fork_chat. The current chat stays open.',
    'When the user asks to change read-aloud of coding-agent answers, call set_read_mode. off / wyłącz silences chat TTS; final reads after the run; stream reads sentence by sentence.',
    'When the user asks how much this voice session costs, call get_cost and say the amount.',
    'When the user wants to end, stop, or close voice mode (Polish: zakończ tryb głosowy, wyłącz głos), say a brief goodbye and call end_voice_mode. Never use stop_agent for that.',
  ].join(' ');
}

/**
 * @param {unknown} requested
 * @returns {string}
 */
export function resolveRealtimeModel(requested) {
  const raw = String(requested || '').trim();
  if (REALTIME_OPENAI_MODELS.includes(raw)) return raw;
  if (raw === 'gpt-realtime' || raw === 'gpt-realtime-2' || raw === 'flagship') {
    return REALTIME_FLAGSHIP_MODEL;
  }
  if (raw === 'mini' || raw === 'gpt-realtime-mini') return REALTIME_MINI_MODEL;
  return process.env.CRETLI_REALTIME_MODEL || DEFAULT_REALTIME_MODEL;
}

/**
 * @param {{ lang?: string, voice?: string, model?: string }} [options]
 * @returns {object} body for POST /v1/realtime/client_secrets
 */
export function buildRealtimeClientSecretBody(options = {}) {
  const requestedVoice = String(options.voice || '').trim();
  const voice = REALTIME_VOICES.includes(requestedVoice)
    ? requestedVoice
    : process.env.CRETLI_REALTIME_VOICE || DEFAULT_REALTIME_VOICE;
  const lang = options.lang === 'pl' ? 'pl' : 'en';
  return {
    expires_after: { anchor: 'created_at', seconds: CLIENT_SECRET_TTL_SECONDS },
    session: {
      type: 'realtime',
      model: resolveRealtimeModel(options.model),
      instructions: buildRealtimeInstructions({ lang }),
      tools: REALTIME_TOOLS,
      tool_choice: 'auto',
      output_modalities: ['audio'],
      // Without a cap the model will keep talking, and audio output is $64/M.
      max_output_tokens: REALTIME_MAX_OUTPUT_TOKENS,
      audio: {
        input: {
          noise_reduction: { type: 'near_field' },
          turn_detection: { type: 'semantic_vad' },
          transcription: { model: 'gpt-4o-mini-transcribe', language: lang },
        },
        output: { voice },
      },
    },
  };
}
