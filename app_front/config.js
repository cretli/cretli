/** Constants: agent models, reconnect delays, WS paths */

export const AGENT_MODELS = [
  { value: 'auto', label: 'Auto' },
  { value: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
  { value: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
  { value: 'claude-opus-4-5', label: 'Claude Opus 4.5' },
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
  { value: 'gpt-5.5', label: 'GPT-5.5' },
  { value: 'gpt-5.4', label: 'GPT-5.4' },
  { value: 'gpt-5.2', label: 'GPT-5.2' },
  { value: 'gpt-5-mini', label: 'GPT-5 Mini' },
  { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
  { value: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' },
  { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
  { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { value: 'composer-2.5', label: 'Composer 2.5' },
  { value: 'composer-2', label: 'Composer 2' },
  { value: 'kimi-k2.5', label: 'Kimi K2.5' },
];

export const TERMINAL_RECONNECT_MAX = 6;
export const TERMINAL_RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 8000, 8000];

export const CHAT_RECONNECT_MAX = 6;
export const CHAT_RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 8000, 8000];

export const WS_PATH_TERMINAL = '/ws';
export const WS_PATH_AGENT = '/ws-agent';
/** Chat over @cursor/sdk — JSON event stream (requires CURSOR_API_KEY on the server). */
export const WS_PATH_AGENT_SDK = '/ws-agent-sdk';

/** Minimum agent PTY size sent on resize, so the CLI keeps a usable width/height. */
export const AGENT_PTY_MIN_COLS = 80;

/** Resize debounce for WS→server (ms) — fewer PTY changes mean fewer full TUI repaints (fewer duplicated blocks). */
export const CHAT_RESIZE_SEND_DEBOUNCE_MS = 180;
export const AGENT_PTY_MIN_ROWS = 24;

/** Mobile terminal viewport: minimum columns, so lines do not wrap. */
export const MOBILE_TERMINAL_MIN_COLS = 80;
export const MOBILE_TERMINAL_COL_WIDTH_PX = 10;
export const MOBILE_VIEWPORT_BREAKPOINT_PX = 768;
/** Width multiplier used when computing fontSize (0.9 leaves 10% headroom). */
export const MOBILE_TERMINAL_SCALE_SAFETY = 0.9;
/** High-DPR devices (phones) need more headroom, otherwise rounding breaks the grid alignment. */
export const MOBILE_TERMINAL_SCALE_SAFETY_HIGH_DPR = 0.85;
/** Default terminal font size (desktop). */
export const TERMINAL_DEFAULT_FONT_SIZE = 14;
/** Terminal font — monospace families that align box-drawing and pipe characters well. */
export const TERMINAL_FONT_FAMILY =
  "'Consolas', 'Monaco', 'Menlo', 'Ubuntu Mono', 'Courier New', monospace";

/** localStorage key for the terminal font size override (number, or empty for auto). */
export const TERMINAL_FONT_SIZE_KEY = 'cretli-terminal-font-size';
/** Font size presets: value and i18n key of the label (translated when the select is rendered). */
export const TERMINAL_FONT_SIZE_PRESETS = [
  { value: 0, labelKey: 'terminal.fontSizeAuto' },
  { value: 8, labelKey: 'terminal.fontSizeMicro' },
  { value: 9, labelKey: 'terminal.fontSizeMini' },
  { value: 10, labelKey: 'terminal.fontSizeVerySmall' },
  { value: 12, labelKey: 'terminal.fontSizeSmall' },
  { value: 14, labelKey: 'terminal.fontSizeMedium' },
  { value: 16, labelKey: 'terminal.fontSizeLarge' },
  { value: 18, labelKey: 'terminal.fontSizeVeryLarge' },
];

/** localStorage key: last selected workspace (path to the .code-workspace file). */
export const WORKSPACE_STORAGE_KEY = 'cretli-workspace-file';

/** localStorage key: ask the agent to name a new chat (answer returned as JSON). */
export const AUTO_NAME_CHAT_KEY = 'cretli-auto-name-chat';
/** Prompt sent to the agent — the answer must be a single JSON line: {"title": "Chat name"}. */
export const AUTO_TITLE_PROMPT =
  'Reply with a single line of JSON containing a "title" key (a short name for this chat, max 50 characters). Example: {"title": "Refactor module X"}. No other text.';

/** localStorage key: skip buffer replay (catchUp) when resuming a chat — avoids re-showing things like the plan dialog. */
export const SKIP_CATCHUP_ON_RESUME_KEY = 'cretli-skip-catchup-on-resume';

/** localStorage key: keep sessions alive (ping + reconnect after returning to the tab/app). */
export const MAINTAIN_SESSIONS_KEY = 'cretli-maintain-sessions';
/** localStorage key: on startup, connect to all chats in the background to collect their state. */
export const CONNECT_ALL_CHATS_ON_START_KEY = 'cretli-connect-all-chats-on-start';
/** Ping interval (ms) while the tab is visible — keeps the WebSocket alive. */
export const CHAT_PING_INTERVAL_MS = 25000;
/** Delay before the "Connection lost" modal after a short spell in the background (ms). */
export const BG_DISCONNECT_GRACE_MS = 8000;
/** Max background WebSocket connections excluding the active chat. */
export const CHAT_BACKGROUND_WS_MAX = 4;
/** Max parallel chat WebSocket handshakes (desktop). */
export const CHAT_WS_MAX_CONCURRENT_CONNECTS = 3;
/** Max parallel chat WebSocket handshakes on mobile/PWA. */
export const CHAT_WS_MAX_CONCURRENT_CONNECTS_MOBILE = 1;
/** Background reconnect drain batch size (desktop). */
export const CHAT_BACKGROUND_RECONNECT_BATCH_SIZE = 2;
/** Background reconnect drain batch size on mobile or right after resume. */
export const CHAT_BACKGROUND_RECONNECT_BATCH_SIZE_MOBILE = 1;
/** Delay between background reconnect batches (desktop, ms). */
export const CHAT_BACKGROUND_RECONNECT_BATCH_DELAY_MS = 400;
/** Delay between background reconnect batches on mobile (ms). */
export const CHAT_BACKGROUND_RECONNECT_BATCH_DELAY_MS_MOBILE = 900;
/** History pull page size for background revision poll (non-active chats). */
export const CHAT_HISTORY_BACKGROUND_PULL_LIMIT = 200;
/** Max history pull pages for background revision poll. */
export const CHAT_HISTORY_BACKGROUND_PULL_MAX_PAGES = 2;
/** Number of newest history events rendered when a chat is opened. */
export const CHAT_HISTORY_INITIAL_TAIL = 80;
/** Page size when loading older history after scrolling to the top. */
export const CHAT_HISTORY_OLDER_PAGE = 80;
/** Activity window for background chat monitoring (ms). */
export const CHAT_BACKGROUND_MONITOR_WINDOW_MS = 10 * 60 * 1000;

/** localStorage key: optional Canvas renderer in chat ('1' enables it). Off by default (plain xterm DOM). */
export const CHAT_CANVAS_ADDON_KEY = 'cretli-chat-canvas-addon';

/** Max length of the chat content buffer (characters) — used to generate a name from a fork. */
export const CHAT_BUFFER_MAX = 12000;
/** localStorage key prefix for the chat buffer: cretli-chat-buffer-<id>. */
export const CHAT_BUFFER_LOCALSTORAGE_PREFIX = 'cretli-chat-buffer-';
/** localStorage key: allow reading chat history from localStorage (fallback). Off by default. */
export const CHAT_READ_BUFFER_FROM_LOCALSTORAGE_KEY = 'cretli-chat-read-buffer-from-localstorage';

/** localStorage key: recently used commands/skills/agents in the context picker. */
export const CONTEXT_PICKER_RECENT_LS_KEY = 'cretli-context-picker-recent';
/** Max number of remembered entries in the context picker. */
export const CONTEXT_PICKER_RECENT_MAX = 24;
/** Max entries in the "Recently used" section. */
export const CONTEXT_PICKER_RECENT_SECTION_MAX = 10;
/** Timeout (ms) for the title fork response. */
export const TITLE_FORK_TIMEOUT_MS = 45000;
/** Timeout (ms) for the summary fork response — longer, as the agent may need more time to analyse a batch. */
export const SUMMARY_FORK_TIMEOUT_MS = 180000;

/** Prompt for the batch summary fork: JSON answer with "summary" and "title". */
export const SUMMARY_FORK_PROMPT_PREFIX = 'Here is a fragment of a chat conversation:\n\n';
export const SUMMARY_FORK_PROMPT_SUFFIX =
  '\n\nSummarize in 2-4 sentences what this part of the conversation is about. Reply with a single line of JSON containing the keys "summary" (the summary) and "title" (a short chat name, max 50 characters). Example: {"summary": "The user asks for a refactor of module X. The agent proposes a step-by-step approach.", "title": "Refactor module X"}. No other text.';
/** How many buffer characters go into a single summary batch. */
export const SUMMARY_BATCH_CHARS = 6000;
/** Max content characters in the title fork prompt. Very short input reduces the chance of a "Pasted text" UI block and is still enough for a sensible name. */
export const TITLE_FORK_PROMPT_MAX_CHARS = 600;
/** Max content characters in the summary fork prompt. */
export const SUMMARY_FORK_PROMPT_MAX_CHARS = 1200;
