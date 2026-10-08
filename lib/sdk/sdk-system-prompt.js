/**
 * Custom system prompt for the `sdk` (Cursor SDK) harness.
 *
 * `AgentOptions.systemPrompt` replaces Cursor's built-in harness prompt for the
 * main loop only. Tool JSON schemas and ambient context (project rules, skills,
 * `<user_info>`) are unaffected, so Cretli must keep loading them — the caller
 * replaces the assistant identity, not the tooling.
 *
 * Constraints enforced here because the SDK makes them fatal:
 * - local agents only; combining `systemPrompt` with `cloud` throws;
 * - must be non-empty (whitespace-only throws at create/resume);
 * - not persisted on the agent, so it has to be re-supplied whenever Cretli
 *   binds a new agent object (create or resume) for the room.
 * Server access is gated per account: an unauthorized caller gets an
 * `InvalidArgument` naming `--system-prompt` on the first `send`.
 */

/** Text length cap so one settings field cannot bloat every turn's prompt. */
export const SDK_SYSTEM_PROMPT_MAX_CHARS = 32_000;

/** Error code surfaced to the client when the account is not entitled. */
export const SDK_SYSTEM_PROMPT_UNAUTHORIZED_CODE = 'system_prompt_unauthorized';

/**
 * @param {{ sdkCustomSystemPrompt?: { enabled?: boolean, text?: string } } | null | undefined} settings
 * @returns {boolean}
 */
export function isSdkCustomSystemPromptEnabled(settings) {
  if (!settings || typeof settings !== 'object') return false;
  const config = settings.sdkCustomSystemPrompt;
  if (!config || typeof config !== 'object') return false;
  return config.enabled === true;
}

/**
 * Trims and bounds the raw text. Returns '' for anything unusable so callers
 * never hand a whitespace-only string to the SDK.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeSdkSystemPromptText(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  return trimmed.length > SDK_SYSTEM_PROMPT_MAX_CHARS
    ? trimmed.slice(0, SDK_SYSTEM_PROMPT_MAX_CHARS)
    : trimmed;
}

/**
 * Resolves the prompt for one room binding. The account gate is checked first
 * and on every call, so flipping it off takes effect on the next turn without
 * restarting the server.
 *
 * @param {{
 *   settings?: { sdkCustomSystemPrompt?: { enabled?: boolean, text?: string } } | null,
 *   chat?: { sdkSystemPrompt?: unknown } | null,
 *   isLocalAgent?: boolean,
 * }} [input]
 * @returns {{ text: string, source: 'chat' | 'settings' | '', enabled: boolean, local: boolean }}
 */
export function resolveSdkSystemPrompt(input = {}) {
  const settings = input.settings || null;
  const enabled = isSdkCustomSystemPromptEnabled(settings);
  const local = input.isLocalAgent !== false;
  if (!enabled || !local) {
    return { text: '', source: '', enabled, local };
  }
  const chatText = normalizeSdkSystemPromptText(input.chat?.sdkSystemPrompt);
  if (chatText) {
    return { text: chatText, source: 'chat', enabled, local };
  }
  const configuredText = normalizeSdkSystemPromptText(settings?.sdkCustomSystemPrompt?.text);
  if (configuredText) {
    return { text: configuredText, source: 'settings', enabled, local };
  }
  return { text: '', source: '', enabled, local };
}

/**
 * Identity for the resolved prompt, used as part of the cached-agent key so a
 * changed prompt forces a create/resume that re-supplies it.
 *
 * @param {{ text?: string } | null | undefined} resolved
 * @returns {string}
 */
export function sdkSystemPromptCacheKey(resolved) {
  const text = typeof resolved?.text === 'string' ? resolved.text : '';
  if (!text) return 'default';
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `custom:${hash.toString(16)}:${text.length}`;
}

/**
 * @param {Record<string, unknown>} options Agent.create / Agent.resume options
 * @param {{ text?: string } | null | undefined} resolved
 * @returns {Record<string, unknown>}
 */
export function applySdkSystemPromptOptions(options, resolved) {
  const text = typeof resolved?.text === 'string' ? resolved.text.trim() : '';
  if (!text) {
    delete options.systemPrompt;
    return options;
  }
  options.systemPrompt = text;
  return options;
}

/**
 * The server rejects an unauthorized custom prompt on the first `send` with an
 * `InvalidArgument` that names `--system-prompt`. Match on the flag as well as
 * the error class name: the SDK surfaces transport errors as plain messages.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isSdkSystemPromptUnauthorizedError(err) {
  const message =
    err && typeof err === 'object' && typeof err.message === 'string'
      ? err.message
      : String(err ?? '');
  if (!/--system-prompt/.test(message)) return false;
  const code = err && typeof err === 'object' && typeof err.code === 'string'
    ? err.code.trim().toLowerCase()
    : '';
  if (code) return code.includes('invalid_argument') || code.includes('invalidargument');
  return /invalidargument|invalid argument/i.test(message);
}

/**
 * True when the room must fall back to the built-in harness prompt: the error
 * is the entitlement rejection and the room is currently running a custom one.
 *
 * @param {unknown} err
 * @param {{ text?: string } | null | undefined} resolved
 * @returns {boolean}
 */
export function shouldDropSdkSystemPromptAfterError(err, resolved) {
  if (!resolved || typeof resolved.text !== 'string' || !resolved.text.trim()) return false;
  return isSdkSystemPromptUnauthorizedError(err);
}

/**
 * @param {unknown} err
 * @returns {string}
 */
export function readSdkSystemPromptErrorDetail(err) {
  const message =
    err && typeof err === 'object' && typeof err.message === 'string'
      ? err.message.trim()
      : '';
  return message || 'The account is not allowed to override the system prompt.';
}
