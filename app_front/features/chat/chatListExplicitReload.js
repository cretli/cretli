/** TTL for archive/restore WS suppression after an explicit list reload starts. */
const EXPLICIT_RELOAD_SUPPRESS_TTL_MS = 15000;

/**
 * While this client runs an explicit `GET /api/chats` after archive or restore,
 * ignore matching `chatsChanged` frames so one user action stays one full reload.
 * Does not cancel unrelated pending live-sync timers.
 *
 * The in-flight `begin`..`end` window covers the HTTP round trip, but the server
 * broadcasts the archive/restore echo from `updateChat` BEFORE it returns, so that
 * frame can still reach this client's socket AFTER `end()` cleared the TTL. It is
 * the echo of the reload we already applied, so it must not start a second GET.
 * It is recognized by list STATE, not a wall-clock window: when the current list
 * already reflects the frame's state, the frame is redundant and suppressed. A
 * genuinely independent archive/restore of the same id (whose state is not yet in
 * the list) still reloads — an arbitrary post-reload TTL would swallow it.
 *
 * @param {{
 *   nowFn?: () => number,
 *   ttlMs?: number,
 *   isChatStateAlreadyApplied?: (reason: string, chatId: string) => boolean,
 * }} [options]
 */
export function createChatListExplicitReloadGuard(options = {}) {
  const nowFn = typeof options.nowFn === 'function' ? options.nowFn : () => Date.now();
  const ttlMs = Number.isFinite(Number(options.ttlMs))
    ? Number(options.ttlMs)
    : EXPLICIT_RELOAD_SUPPRESS_TTL_MS;
  // Reports whether the live chat list already reflects a frame's archive/restore
  // state. Defaults to "not applied" so the in-flight TTL is the only signal when the
  // caller cannot read the list (e.g. unit isolation), which keeps the base behaviour.
  const isChatStateAlreadyApplied = typeof options.isChatStateAlreadyApplied === 'function'
    ? options.isChatStateAlreadyApplied
    : () => false;
  /** @type {Map<string, number>} chatId -> expiresAtMs */
  const suppressedUntil = new Map();

  function normalizeIds(chatIds) {
    if (!Array.isArray(chatIds)) return [];
    return [...new Set(
      chatIds
        .map((id) => String(id || '').trim())
        .filter(Boolean)
    )];
  }

  function purgeExpired() {
    const now = nowFn();
    for (const [id, expiresAt] of suppressedUntil) {
      if (expiresAt <= now) suppressedUntil.delete(id);
    }
  }

  function begin(chatIds) {
    purgeExpired();
    const expiresAt = nowFn() + ttlMs;
    for (const id of normalizeIds(chatIds)) {
      suppressedUntil.set(id, expiresAt);
    }
  }

  function end(chatIds) {
    if (chatIds == null) {
      suppressedUntil.clear();
      return;
    }
    for (const id of normalizeIds(chatIds)) {
      suppressedUntil.delete(id);
    }
  }

  /**
   * @param {{ reason?: string, chatId?: string | null }} frame
   * @returns {boolean}
   */
  function shouldSuppressChatsChanged(frame) {
    purgeExpired();
    const reason = typeof frame?.reason === 'string' ? frame.reason.trim() : '';
    if (reason !== 'archive' && reason !== 'restore') return false;
    const chatId = typeof frame?.chatId === 'string' ? frame.chatId.trim() : '';
    if (!chatId) return false;
    // Trailing echo of our own action: the reload already applied this state, so the
    // frame is redundant even after end() cleared the in-flight TTL. Checked before the
    // TTL so a late frame is caught; a frame the list has NOT applied falls through to
    // the TTL (and reloads once it expires), keeping independent same-id changes live.
    if (isChatStateAlreadyApplied(reason, chatId) === true) return true;
    const expiresAt = suppressedUntil.get(chatId);
    if (!expiresAt) return false;
    if (expiresAt <= nowFn()) {
      suppressedUntil.delete(chatId);
      return false;
    }
    return true;
  }

  return { begin, end, shouldSuppressChatsChanged };
}
