/**
 * Context management for Antigravity ACP sessions.
 *
 * Antigravity reports occupancy (`usage_update`) but no explicit compaction or
 * session-reset signal, so the room tracks three facts itself:
 * - a native slash command (`/compact`, `/goal`, …) only works as the very
 *   first text of the prompt, so it must be sent without the Cretli prefix;
 * - `/compact` (or a large occupancy drop, which is how auto-compaction shows)
 *   rewrites the prompt prefix: the meter and the cache are reset;
 * - `session/load` of an unknown id silently creates an empty session, so a
 *   resume that replayed nothing means the model lost the whole history.
 */

/** Commands the CLI advertised in agy 1.5.x; replaced by the live `available_commands_update`. */
export const ANTIGRAVITY_DEFAULT_COMMANDS = Object.freeze([
  'goal', 'compact', 'schedule', 'browser', 'plan', 'grill-me', 'learn',
]);

/** An occupancy drop below this share of the previous reading counts as auto-compaction. */
export const ANTIGRAVITY_COMPACTION_DROP_RATIO = 0.7;
/** Small contexts fluctuate; only a drop from at least this many tokens is a compaction. */
export const ANTIGRAVITY_COMPACTION_MIN_TOKENS = 20000;

/**
 * Name of the native command the prompt starts with, or '' for normal text.
 * A path such as `/home/x` is not a command: the name must end at whitespace.
 *
 * @param {unknown} text
 * @param {readonly string[]|null|undefined} [commands] advertised command names
 * @returns {string}
 */
export function parseAntigravityNativeCommand(text, commands) {
  const match = /^\/([A-Za-z][\w-]*)(?:\s|$)/.exec(String(text || '').trim());
  if (!match) return '';
  const name = match[1].toLowerCase();
  const known = Array.isArray(commands) && commands.length ? commands : ANTIGRAVITY_DEFAULT_COMMANDS;
  return known.some((item) => String(item).toLowerCase() === name) ? name : '';
}

/**
 * Command names from an ACP `available_commands_update`.
 *
 * @param {any} update
 * @returns {string[]}
 */
export function readAntigravityCommandNames(update) {
  const list = Array.isArray(update?.availableCommands) ? update.availableCommands : [];
  return list.map((item) => String(item?.name || '').trim()).filter(Boolean);
}

/**
 * What a turn's context reading means for the meter.
 *
 * @param {{ previousTotal?: number|null, event: Record<string, any>, command?: string }} input
 * @returns {'compacted_by_command' | 'compacted' | 'measured'}
 */
export function classifyAntigravityContextReading({ previousTotal = null, event, command = '' }) {
  // The `/compact` turn reports the pre-compaction prompt plus the summary call;
  // the next turn is the first real reading of the new context.
  if (command === 'compact') return 'compacted_by_command';
  const total = Number(event?.usage?.totalTokens);
  const previous = Number(previousTotal);
  if (Number.isFinite(total) && Number.isFinite(previous)
    && previous >= ANTIGRAVITY_COMPACTION_MIN_TOKENS
    && total < previous * ANTIGRAVITY_COMPACTION_DROP_RATIO) {
    return 'compacted';
  }
  return 'measured';
}
