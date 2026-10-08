/**
 * Bounded ring buffers for Browser Console/Network/Dialog diagnostics.
 *
 * MVP rules: max 200 entries per buffer (50 for dialogs), every entry is
 * redacted and capped to 64 KiB, buffers are cleared when the tab or session
 * closes.
 */

import { BROWSER_LIMITS } from './constants.js';
import { redactTextCapped, redactUrl, redactValue } from './redaction.js';

/**
 * @param {unknown} value
 * @returns {number}
 */
function eventBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
  } catch {
    return 0;
  }
}

/**
 * Coerces a possibly string-typed query value to a safe integer, or null when
 * it is absent/non-numeric. REST delivers `since`/`limit` as strings; `Number`
 * accepts them while `Number.isFinite("5")` would not.
 * @param {unknown} value
 * @returns {number|null}
 */
function coerceInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.floor(n);
}

export class BoundedRingBuffer {
  /**
   * @param {{ maxEntries?: number, maxBytes?: number }} [options]
   */
  constructor(options = {}) {
    this.maxEntries = Number.isFinite(options.maxEntries) && options.maxEntries > 0
      ? Math.floor(options.maxEntries)
      : BROWSER_LIMITS.MAX_CONSOLE_ENTRIES;
    this.maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0
      ? Math.floor(options.maxBytes)
      : BROWSER_LIMITS.MAX_EVENT_BYTES;
    /** @type {Array<Record<string, unknown>>} */
    this.entries = [];
    this.total = 0;
    this.dropped = 0;
    // Pull cursor: unlike `seq` (caller-provided, stable per entry), `rev` is
    // bumped on every stored write, so an in-place update re-appears for a
    // client whose cursor already passed the original row.
    this.rev = 0;
  }

  /**
   * @param {Record<string, unknown>} entry
   * @returns {Record<string, unknown>}
   */
  push(entry) {
    let bounded = entry;
    if (eventBytes(bounded) > this.maxBytes) {
      const capped = redactTextCapped(
        typeof bounded.text === 'string' ? bounded.text : JSON.stringify(bounded),
        this.maxBytes - 256,
      );
      bounded = { ...bounded, text: capped.value, truncated: true };
    }
    const stored = { ...bounded, rev: ++this.rev };
    this.entries.push(stored);
    this.total += 1;
    this.trim();
    return stored;
  }

  trim() {
    while (this.entries.length > this.maxEntries) {
      this.entries.shift();
      this.dropped += 1;
    }
    while (this.entries.length > 1) {
      const total = this.entries.reduce((sum, entry) => sum + eventBytes(entry), 0);
      if (total <= this.maxBytes) break;
      this.entries.shift();
      this.dropped += 1;
    }
  }

  /**
   * Pull entries newer than `since` (monotonic per-buffer revision cursor).
   * Selection is by `rev`, not `seq`, so a response/failure that mutated an
   * already-delivered request row is still handed to the caller. Rows are
   * sorted by `rev` before `limit` is applied so a cut can never strand a
   * higher-rev (updated) entry behind the returned page.
   * `since`/`limit` may arrive as query-string values over REST, so numeric
   * strings are coerced; anything non-numeric falls back to the default.
   * @param {{ since?: number|string, limit?: number|string }} [options]
   */
  pull(options = {}) {
    const sinceNum = coerceInt(options.since);
    const since = sinceNum === null ? 0 : Math.max(0, sinceNum);
    const limitNum = coerceInt(options.limit);
    const limit = limitNum === null
      ? this.maxEntries
      : Math.min(Math.max(1, limitNum), this.maxEntries);
    const rows = this.entries
      .filter((entry) => Number(entry.rev) > since)
      .sort((a, b) => Number(a.rev) - Number(b.rev))
      .slice(0, limit);
    let nextSince = since;
    for (const row of rows) nextSince = Math.max(nextSince, Number(row.rev));
    return {
      entries: rows,
      nextSince,
      dropped: this.dropped,
      total: this.total,
    };
  }

  clear() {
    this.entries = [];
    this.total = 0;
    this.dropped = 0;
    this.rev = 0;
  }
}

export class DialogBuffer extends BoundedRingBuffer {
  constructor(options = {}) {
    super({ maxEntries: BROWSER_LIMITS.MAX_DIALOG_ENTRIES, maxBytes: BROWSER_LIMITS.MAX_EVENT_BYTES, ...options });
  }

  /**
   * Records a JavaScript dialog surfaced by the page. The dialog is left open so
   * `browser_input` kind `dialog` can answer it; the manager dismisses it on a
   * bounded timer when nobody does, so a page can never hang on a native dialog.
   * @param {{ id?: string, type?: string, message?: string, defaultValue?: string, at?: number }} input
   * @returns {{ dialogId: string, seq: number }}
   */
  pushDialog(input) {
    const capped = redactTextCapped(input.message ?? '', BROWSER_LIMITS.CONSOLE_TEXT_MAX);
    const defaultCapped = redactTextCapped(input.defaultValue ?? '', 2048);
    const dialogId = String(input.id || `dialog-${this.total + 1}`);
    const entry = this.push({
      seq: this.total + 1,
      kind: 'dialog',
      dialogId,
      type: String(input.type || 'alert'),
      message: capped.value,
      truncated: capped.truncated,
      defaultValue: defaultCapped.value,
      handled: false,
      action: '',
      at: Number.isFinite(input.at) ? input.at : Date.now(),
    });
    return { dialogId, seq: Number(entry.seq) };
  }

  /**
   * Resolves a stored dialog in place (same `seq` and array position, fresh
   * `rev`) so a caller whose cursor already pulled the pending row also sees
   * how it ended.
   * @param {string} dialogId
   * @param {Record<string, unknown>} patch
   */
  mark(dialogId, patch) {
    const id = String(dialogId || '');
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      if (this.entries[i].dialogId !== id) continue;
      this.entries[i] = { ...this.entries[i], ...patch, rev: ++this.rev };
      return this.entries[i];
    }
    return null;
  }

  /** @returns {Array<Record<string, unknown>>} dialogs still waiting for an answer */
  pending() {
    return this.entries.filter((entry) => entry.handled !== true);
  }
}

export class ConsoleBuffer extends BoundedRingBuffer {
  constructor(options = {}) {
    super({ maxEntries: BROWSER_LIMITS.MAX_CONSOLE_ENTRIES, maxBytes: BROWSER_LIMITS.MAX_EVENT_BYTES, ...options });
  }

  /**
   * @param {{ level?: string, text?: string, location?: string, source?: string, at?: number }} input
   */
  pushConsole(input) {
    const capped = redactTextCapped(input.text ?? '', BROWSER_LIMITS.CONSOLE_TEXT_MAX);
    return this.push({
      seq: this.total + 1,
      kind: 'console',
      level: String(input.level || 'log'),
      text: capped.value,
      truncated: capped.truncated,
      location: input.location ? redactTextCapped(input.location, 2048).value : '',
      at: Number.isFinite(input.at) ? input.at : Date.now(),
    });
  }

  /**
   * @param {{ message?: string, stack?: string, at?: number }} input
   */
  pushPageError(input) {
    const capped = redactTextCapped(input.message ?? '', BROWSER_LIMITS.CONSOLE_TEXT_MAX);
    return this.push({
      seq: this.total + 1,
      kind: 'pageerror',
      level: 'error',
      text: capped.value,
      truncated: capped.truncated,
      stack: input.stack ? redactTextCapped(input.stack, BROWSER_LIMITS.CONSOLE_TEXT_MAX).value : '',
      at: Number.isFinite(input.at) ? input.at : Date.now(),
    });
  }
}

export class NetworkBuffer extends BoundedRingBuffer {
  constructor(options = {}) {
    super({ maxEntries: BROWSER_LIMITS.MAX_NETWORK_ENTRIES, maxBytes: BROWSER_LIMITS.MAX_EVENT_BYTES, ...options });
  }

  /**
   * Metadata-only network entry (plan: no bodies, no full headers).
   * @param {{ method?: string, url?: string, resourceType?: string, at?: number }} input
   * @returns {{ requestId: string, seq: number }}
   */
  recordRequest(input) {
    const requestId = String(input.requestId || `req-${this.total + 1}`);
    const entry = this.push({
      seq: this.total + 1,
      kind: 'network',
      requestId,
      phase: 'request',
      method: String(input.method || 'GET').toUpperCase(),
      url: redactTextCapped(redactUrl(input.url ?? ''), BROWSER_LIMITS.NETWORK_URL_MAX).value,
      resourceType: String(input.resourceType || 'other'),
      status: null,
      ok: null,
      failure: '',
      blocked: false,
      startedAt: Number.isFinite(input.at) ? input.at : Date.now(),
      finishedAt: null,
    });
    return { requestId, seq: Number(entry.seq) };
  }

  /**
   * @param {string} requestId
   * @param {{ status?: number, ok?: boolean, at?: number }} input
   */
  recordResponse(requestId, input = {}) {
    return this.update(requestId, {
      status: Number.isFinite(input.status) ? input.status : null,
      ok: input.ok === true,
      finishedAt: Number.isFinite(input.at) ? input.at : Date.now(),
    });
  }

  /**
   * @param {string} requestId
   * @param {{ errorText?: string, at?: number }} input
   */
  recordFailure(requestId, input = {}) {
    return this.update(requestId, {
      failure: redactTextCapped(input.errorText ?? '', 2048).value,
      finishedAt: Number.isFinite(input.at) ? input.at : Date.now(),
    });
  }

  /**
   * Mutates the stored request row in place (same `seq`, same array position)
   * and gives it a fresh `rev` so a cursor that already pulled the pending
   * request sees the response/failure on its next pull.
   * @param {string} requestId
   * @param {Record<string, unknown>} patch
   */
  update(requestId, patch) {
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      if (this.entries[i].requestId === requestId) {
        this.entries[i] = redactValue({ ...this.entries[i], ...patch });
        this.entries[i].rev = ++this.rev;
        return this.entries[i];
      }
    }
    return null;
  }
}
