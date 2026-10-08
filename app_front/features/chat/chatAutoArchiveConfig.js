/**
 * Cached chat auto-archive configuration for synchronous UI reads.
 *
 * The Settings section owns the settings fetch (`chatAutoArchiveSettings.js`)
 * and pushes the normalized value here; the sidebar countdown reads it while
 * patching rows, where awaiting a fetch is not an option. Disabled until the
 * first successful load, so no countdown can appear before the operator opts in.
 */

/**
 * @typedef {{ enabled: boolean, idleMs: number }} ChatAutoArchiveConfig
 */

const UNIT_MS = Object.freeze({
  minutes: 60_000,
  hours: 60 * 60_000,
  days: 24 * 60 * 60_000,
});

/** @type {ChatAutoArchiveConfig} */
const DISABLED = Object.freeze({ enabled: false, idleMs: 0 });

/** @type {ChatAutoArchiveConfig} */
let current = DISABLED;
/** @type {Set<(config: ChatAutoArchiveConfig) => void>} */
const listeners = new Set();

/**
 * Accept either a server settings block (`idleMs`) or a `{ idleValue, idleUnit }`
 * pair, and always return a safe `{ enabled, idleMs }`.
 *
 * @param {object | null | undefined} input
 * @returns {ChatAutoArchiveConfig}
 */
export function normalizeChatAutoArchiveConfig(input) {
  const cfg = input && typeof input === 'object' ? input : {};
  let idleMs = Number(cfg.idleMs);
  if (!Number.isFinite(idleMs) || idleMs <= 0) {
    const unitMs = UNIT_MS[cfg.idleUnit];
    const value = Math.round(Number(cfg.idleValue));
    idleMs = unitMs && Number.isFinite(value) && value > 0 ? value * unitMs : 0;
  }
  if (!Number.isFinite(idleMs) || idleMs <= 0) idleMs = 0;
  return { enabled: cfg.enabled === true, idleMs };
}

/**
 * Store the latest configuration and notify listeners when it actually changed.
 *
 * @param {object | null | undefined} input
 * @returns {void}
 */
export function setChatAutoArchiveConfig(input) {
  const next = normalizeChatAutoArchiveConfig(input);
  if (next.enabled === current.enabled && next.idleMs === current.idleMs) return;
  current = next;
  for (const listener of listeners) {
    try {
      listener(current);
    } catch (_) {
      // A bad listener must never break the settings save path.
    }
  }
}

/**
 * @returns {ChatAutoArchiveConfig}
 */
export function getChatAutoArchiveConfig() {
  return current;
}

/**
 * @param {(config: ChatAutoArchiveConfig) => void} listener
 * @returns {() => void}
 */
export function subscribeChatAutoArchiveConfig(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test seam: restore the disabled default. */
export function __resetChatAutoArchiveConfigForTest() {
  current = DISABLED;
}
