/**
 * Pure, deterministic core for slimming the per-turn harness prompt decoration.
 *
 * Every outbound user message used to be prefixed with the full decoration
 * block: skills catalog, workspace/shared rules, mode hint, chat plan,
 * delegation reports and the title hint. Only the outgoing message changes, but
 * the block stays in history and is re-sent once per past turn, so repeating it
 * every turn is pure token overhead.
 *
 * This module decides which blocks must be prepended on the current turn:
 *
 * - static blocks (skills catalog + workspace/shared rules) on the first turn of
 *   a session, when their content hash changes, or after a session restart;
 * - volatile blocks (page context, mode hint, chat plan, delegation reports,
 *   title hint) only when their content hash changed since the previous turn.
 *
 * The decision is pure: given the previous state and the current block content
 * it returns the parts to prepend plus the next state. No I/O, no clock, no
 * mutation of the inputs. Hashing and the token estimate are O(n) over the
 * block text and run once per turn.
 */

export const PROMPT_DECORATION_BLOCK = Object.freeze({
  STATIC: 'static',
  PAGE_CONTEXT: 'pageContext',
  MODE_HINT: 'modeHint',
  CHAT_PLAN: 'chatPlan',
  DELEGATION_REPORTS: 'delegationReports',
  TITLE_HINT: 'titleHint',
});

/**
 * Volatile blocks in stable output order. The static block is always emitted
 * before any of them.
 */
export const PROMPT_DECORATION_VOLATILE_ORDER = Object.freeze([
  PROMPT_DECORATION_BLOCK.PAGE_CONTEXT,
  PROMPT_DECORATION_BLOCK.MODE_HINT,
  PROMPT_DECORATION_BLOCK.CHAT_PLAN,
  PROMPT_DECORATION_BLOCK.DELEGATION_REPORTS,
  PROMPT_DECORATION_BLOCK.TITLE_HINT,
]);

/**
 * Volatile blocks that must be emitted on every turn while non-empty. The mode
 * hint is a safety instruction: the active Plan/Ask restriction has to be
 * visible to the model on every turn, not only on the turn that switched to it.
 * Deduping it like the other volatile blocks would silently drop the guard.
 */
export const PROMPT_DECORATION_ALWAYS_VOLATILE = Object.freeze([
  PROMPT_DECORATION_BLOCK.MODE_HINT,
]);

/**
 * How the static block is emitted.
 *
 * - `dedupe` (default): first turn of a session, on a content hash change, or
 *   after a session restart.
 * - `always`: re-emit the full static block on every turn. This is the safe
 *   fallback for harnesses whose "session" is only the room's in-memory
 *   conversation and which expose no restart signal; a rebuild can otherwise
 *   drop the earlier copy silently.
 */
export const PROMPT_DECORATION_STATIC_MODE = Object.freeze({
  DEDUPE: 'dedupe',
  ALWAYS: 'always',
});

/**
 * Short stand-in emitted when the static block is unchanged so the model keeps
 * a pointer to the earlier copy instead of silently losing it.
 */
export const PROMPT_DECORATION_DELTA_HINT =
  '[Earlier skills and workspace/shared rules still apply.]';

/** Hash used for an absent/empty block. */
const EMPTY_HASH = '0';

/** Fast membership test for the always-emitted volatile blocks. */
const ALWAYS_VOLATILE_BLOCKS = new Set(PROMPT_DECORATION_ALWAYS_VOLATILE);

/** Upper bound for tracked sessions so the store cannot grow without limit. */
const MAX_TRACKED_SESSIONS = 500;

/**
 * Cheap, deterministic FNV-1a 32-bit hash. Good enough to detect content
 * changes; not a security primitive.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function hashPromptContent(text) {
  const value = String(text || '');
  if (!value) return EMPTY_HASH;
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

/**
 * Approximate token count, matching the chars/4 convention used for cheap
 * budgeting. Never negative.
 *
 * @param {unknown} text
 * @returns {number}
 */
export function estimatePromptTokens(text) {
  const value = String(text || '');
  if (!value) return 0;
  return Math.ceil(value.length / 4);
}

/**
 * @typedef {{
 *   sessionKey: string,
 *   staticHash: string,
 *   volatileHashes: Record<string, string>,
 *   turns: number,
 * }} PromptDecorationState
 */

/**
 * Pure decision for one turn.
 *
 * @param {PromptDecorationState | null | undefined} previous
 * @param {{
 *   sessionKey?: string,
 *   staticBlock?: string,
 *   staticMode?: 'dedupe' | 'always',
 *   volatile?: Record<string, string>,
 * }} [current]
 * @returns {{
 *   parts: string[],
 *   state: PromptDecorationState,
 *   staticIncluded: boolean,
 *   staticDeltaIncluded: boolean,
 *   volatileIncluded: string[],
 *   measurement: {
 *     staticTokens: number,
 *     fullTokens: number,
 *     includedTokens: number,
 *     omittedTokens: number,
 *     staticIncluded: boolean,
 *     staticDeltaIncluded: boolean,
 *     staticMode: string,
 *     volatileIncluded: string[],
 *   },
 * }}
 */
export function decidePromptDecoration(previous, current = {}) {
  const sessionKey = String(current.sessionKey || '');
  const staticBlock = String(current.staticBlock || '');
  const volatile = current.volatile && typeof current.volatile === 'object' ? current.volatile : {};
  const staticMode = current.staticMode === PROMPT_DECORATION_STATIC_MODE.ALWAYS
    ? PROMPT_DECORATION_STATIC_MODE.ALWAYS
    : PROMPT_DECORATION_STATIC_MODE.DEDUPE;
  const staticAlways = staticMode === PROMPT_DECORATION_STATIC_MODE.ALWAYS;
  const sessionChanged = !previous || String(previous.sessionKey || '') !== sessionKey;
  const staticHash = staticBlock ? hashPromptContent(staticBlock) : EMPTY_HASH;
  const previousStaticHash = previous && typeof previous.staticHash === 'string'
    ? previous.staticHash
    : EMPTY_HASH;
  const staticIncluded = Boolean(staticBlock)
    && (staticAlways || sessionChanged || previousStaticHash !== staticHash);
  const staticDeltaIncluded = !staticIncluded
    && Boolean(staticBlock)
    && !sessionChanged
    && previousStaticHash === staticHash;

  const parts = [];
  if (staticIncluded) parts.push(staticBlock);
  else if (staticDeltaIncluded) parts.push(PROMPT_DECORATION_DELTA_HINT);

  const previousHashes = previous && previous.volatileHashes && typeof previous.volatileHashes === 'object'
    ? previous.volatileHashes
    : {};
  const volatileHashes = {};
  const volatileIncluded = [];
  let fullTokens = estimatePromptTokens(staticBlock);
  let includedTokens = staticIncluded
    ? estimatePromptTokens(staticBlock)
    : staticDeltaIncluded
      ? estimatePromptTokens(PROMPT_DECORATION_DELTA_HINT)
      : 0;

  for (const key of PROMPT_DECORATION_VOLATILE_ORDER) {
    const value = String(volatile[key] || '');
    const hash = value ? hashPromptContent(value) : EMPTY_HASH;
    volatileHashes[key] = hash;
    // Always-volatile blocks (the mode hint) are re-sent every turn while
    // active; the rest only when their content hash changes.
    const changed = sessionChanged || ALWAYS_VOLATILE_BLOCKS.has(key)
      || String(previousHashes[key] || EMPTY_HASH) !== hash;
    fullTokens += estimatePromptTokens(value);
    if (value && changed) {
      parts.push(value);
      volatileIncluded.push(key);
      includedTokens += estimatePromptTokens(value);
    }
  }

  const state = {
    sessionKey,
    staticHash,
    volatileHashes,
    turns: (previous && !sessionChanged ? Number(previous.turns) || 0 : 0) + 1,
  };

  return {
    parts,
    state,
    staticIncluded,
    staticDeltaIncluded,
    volatileIncluded,
    measurement: {
      staticTokens: estimatePromptTokens(staticBlock),
      fullTokens,
      includedTokens,
      omittedTokens: Math.max(0, fullTokens - includedTokens),
      staticIncluded,
      staticDeltaIncluded,
      staticMode,
      volatileIncluded,
    },
  };
}

/**
 * In-memory store keyed by the harness session identity. Rooms also keep their
 * state on the room object; this map is the default for callers without a room.
 *
 * @type {Map<string, PromptDecorationState>}
 */
const decorationStates = new Map();

/**
 * @param {unknown} sessionKey
 * @returns {PromptDecorationState | null}
 */
export function readPromptDecorationState(sessionKey) {
  const key = String(sessionKey || '');
  if (!key) return null;
  return decorationStates.get(key) || null;
}

/**
 * @param {unknown} sessionKey
 * @param {PromptDecorationState | null | undefined} state
 * @returns {void}
 */
export function writePromptDecorationState(sessionKey, state) {
  const key = String(sessionKey || '');
  if (!key) return;
  if (!state) {
    decorationStates.delete(key);
    return;
  }
  decorationStates.set(key, state);
  if (decorationStates.size > MAX_TRACKED_SESSIONS) {
    const oldest = decorationStates.keys().next().value;
    if (oldest !== undefined && oldest !== key) decorationStates.delete(oldest);
  }
}

/**
 * Drop the tracked state for one session identity so the next turn re-sends the
 * full static block. Harmless when the key is unknown.
 *
 * @param {unknown} sessionKey
 * @returns {void}
 */
export function resetPromptDecorationState(sessionKey) {
  const key = String(sessionKey || '');
  if (key) decorationStates.delete(key);
}

/**
 * Test-only reset. Never called from production paths.
 *
 * @returns {void}
 */
export function resetPromptDecorationStatesForTests() {
  decorationStates.clear();
}

/**
 * Debug logging is opt-in and suppressed in isolated test runs so suites stay
 * quiet. No prompt text is logged, only sizes and hashes.
 *
 * @returns {boolean}
 */
export function isPromptDecorationLogEnabled() {
  if (process.env.CRETLI_TEST_DATA_DIR) return false;
  return process.env.CRETLI_DEBUG_PROMPT_DECORATION === '1';
}

/**
 * @param {ReturnType<typeof decidePromptDecoration>['measurement']} measurement
 * @param {{ harness?: string, chatId?: string, sessionKey?: string, turn?: number }} [meta]
 * @returns {void}
 */
export function logPromptDecorationMeasurement(measurement, meta = {}) {
  if (!isPromptDecorationLogEnabled()) return;
  console.debug('[prompt-decoration]', JSON.stringify({
    harness: String(meta.harness || ''),
    chatId: String(meta.chatId || ''),
    sessionKey: String(meta.sessionKey || ''),
    turn: Number(meta.turn) || 0,
    staticTokens: measurement.staticTokens,
    fullTokens: measurement.fullTokens,
    includedTokens: measurement.includedTokens,
    omittedTokens: measurement.omittedTokens,
    staticIncluded: measurement.staticIncluded,
    staticDeltaIncluded: measurement.staticDeltaIncluded,
    staticMode: measurement.staticMode,
    volatileIncluded: measurement.volatileIncluded,
  }));
}
