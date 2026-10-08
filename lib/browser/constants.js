/**
 * Browser module limits and defaults (P0 plan values).
 * Kept in one place so routes, the session manager and tests share the numbers.
 */

export const BROWSER_LIMITS = Object.freeze({
  /** Maximum concurrent Browser sessions per Cretli session (user/instance). */
  MAX_SESSIONS_PER_OWNER: 3,
  /** Maximum tabs per Browser session. */
  MAX_TABS_PER_SESSION: 4,
  /** Idle timeout before a session is closed and its Chromium context torn down. */
  IDLE_TIMEOUT_MS: 15 * 60 * 1000,
  /** Screenshot mode is capped at 2 JPEG frames per second per tab. */
  MAX_SCREENSHOT_FPS: 2,
  SCREENSHOT_MIN_INTERVAL_MS: 500,
  /**
   * A client-supplied `force` flag never removes the cap: forced/manual frames
   * are still bounded by this interval so a public caller cannot stream.
   */
  SCREENSHOT_FORCE_MIN_INTERVAL_MS: 500,
  /** Maximum accepted JPEG frame size (1.2 MiB). */
  MAX_SCREENSHOT_BYTES: Math.floor(1.2 * 1024 * 1024),
  /** Maximum redirect hops the route policy follows and re-checks manually. */
  MAX_REDIRECTS: 10,
  /** Maximum redacted Console/Network event payload (64 KiB). */
  MAX_EVENT_BYTES: 64 * 1024,
  /** Bounded ring buffers per tab. */
  MAX_CONSOLE_ENTRIES: 200,
  MAX_NETWORK_ENTRIES: 200,
  /** Bounded record of JavaScript dialogs surfaced by the page. */
  MAX_DIALOG_ENTRIES: 50,
  /**
   * A native dialog blocks the page's JavaScript until it is resolved, so a
   * buffered dialog that nobody answers is dismissed automatically after this
   * long. Bounds the hang; the entry stays in the buffer with `action:
   * 'timed-out'` so a later read can tell it happened.
   */
  DIALOG_AUTO_DISMISS_MS: 60000,
  /** Per-entry text caps before the overall event cap is applied. */
  CONSOLE_TEXT_MAX: 16 * 1024,
  NETWORK_URL_MAX: 8 * 1024,
  /** Grace period between graceful close and kill-tree. */
  GRACE_CLOSE_MS: 2000,
  /** Hard upper bound for any single cleanup step (context/browser close). */
  CLOSE_HARD_TIMEOUT_MS: 3000,
  /** Minimum spacing between Browser input events accepted on /ws-browser. */
  INPUT_MIN_INTERVAL_MS: 40,
  /** How long a selector/role click or fill waits for the element before failing. */
  LOCATOR_TIMEOUT_MS: 5000,
  /**
   * Longest a `browser_input` kind `wait` may block. Input events are serialized
   * per tab on `tab.inputChain`, so an unbounded wait would wedge the tab for
   * every later input.
   */
  MAX_WAIT_TIMEOUT_MS: 30000,
  /** Upper bound for `key` + `action: 'type'` per-character delay. */
  MAX_INPUT_DELAY_MS: 1000,
  /** Maximum file paths accepted by one `browser_input` kind `upload`. */
  MAX_UPLOAD_FILES: 10,
  /** Maximum queued /ws-browser messages before new ones are rejected. */
  INPUT_QUEUE_MAX: 64,
  /** Default mobile viewport used when the client sends none. */
  DEFAULT_VIEWPORT: Object.freeze({ width: 390, height: 844, dpr: 2, hasTouch: true }),
  MIN_VIEWPORT: Object.freeze({ width: 120, height: 120 }),
  MAX_VIEWPORT: Object.freeze({ width: 4096, height: 4096 }),
  MAX_DPR: 4,

  /**
   * Experimental CDP `Page.startScreencast` live view. `off` keeps the
   * pull-based `screenshot` / `frame-ack` channel byte-for-byte as it behaved
   * before streaming existed; `experimental` lets a `/ws-browser` socket ask
   * for pushed binary frames. Overridden per deployment by
   * `CRETLI_BROWSER_SCREENCAST` and never by the client: a public caller must
   * not be able to escalate itself into the streaming mode.
   */
  SCREENCAST_MODE: 'off',
  /** Frames the compositor is asked to produce at, before adaptation kicks in. */
  SCREENCAST_DEFAULT_FPS: 3,
  SCREENCAST_MIN_FPS: 1,
  SCREENCAST_MAX_FPS: 5,
  /** JPEG quality bounds for pushed frames; separate from the pull default. */
  SCREENCAST_DEFAULT_QUALITY: 60,
  SCREENCAST_MIN_QUALITY: 30,
  SCREENCAST_MAX_QUALITY: 90,
  /**
   * Chromium's compositor cadence the `everyNthFrame` divisor is derived from.
   * `Page.startScreencast` has no fps parameter, so a target rate becomes
   * "emit every Nth composited frame" against this ceiling.
   */
  SCREENCAST_COMPOSITOR_FPS: 30,
  /**
   * Unacknowledged frames allowed in flight per tab. One is the honest minimum
   * for a live preview (the newest frame is the only one worth rendering), and a
   * bounded window is what keeps a stalled panel from pinning frame data.
   */
  SCREENCAST_MAX_UNACKED_FRAMES: 1,
  /** Sliding window the drop ratio is measured over for fps/quality adaptation. */
  SCREENCAST_ADAPT_WINDOW: 12,
  /** Fraction of collapsed frames that triggers one step down. */
  SCREENCAST_ADAPT_DROP_RATIO: 0.34,
  /** Clean windows required before stepping back up toward the caps. */
  SCREENCAST_ADAPT_UP_WINDOWS: 2,
  /** Restarts are throttled: re-issuing `Page.startScreencast` costs a frame gap. */
  SCREENCAST_RESTART_MIN_MS: 2000,
  /** No frame within this window means the stream stalled and must fall back. */
  SCREENCAST_STALL_TIMEOUT_MS: 4000,
  /** A pushed frame larger than this cannot be shown; fall back to the pull path. */
  SCREENCAST_MAX_FRAME_BYTES: Math.floor(1.2 * 1024 * 1024),

  /**
   * CDP Debugger (separate `debuggerCdpSession` per tab). Limits keep paused
   * pages from hanging forever and cap agent-visible payload size.
   */
  DEBUGGER_MAX_BREAKPOINTS: 20,
  DEBUGGER_MAX_STACK_DEPTH: 32,
  DEBUGGER_MAX_SCOPE_DEPTH: 8,
  DEBUGGER_MAX_SCOPE_PROPERTIES: 24,
  DEBUGGER_MAX_RESULT_BYTES: 64 * 1024,
  DEBUGGER_MAX_SCRIPT_SOURCE_BYTES: 64 * 1024,
  DEBUGGER_REDACT_MAX_DEPTH: 5,
  DEBUGGER_REDACT_MAX_ITEMS: 40,
  DEBUGGER_MAX_SOURCE_MAP_BYTES: 512 * 1024,
  DEBUGGER_SOURCE_MAP_FETCH_TIMEOUT_MS: 8000,
  DEBUGGER_MAX_SOURCE_MAP_CACHE: 32,
  /** Hard timeout for each CDP `send` on the debugger session. */
  DEBUGGER_CDP_SEND_TIMEOUT_MS: 8000,
  /**
   * When nobody consumes a pause, resume automatically so page JS is not wedged
   * (same intent as `DIALOG_AUTO_DISMISS_MS` for native dialogs).
   */
  DEBUGGER_AUTO_RESUME_MS: 60000,
});

/** Screenshot encoder defaults (plan: quality ~84). */
export const BROWSER_SCREENSHOT_QUALITY = 84;

/** Internal service ports Browser must not reach unless a workspace opts in. */
export const DEFAULT_BLOCKED_PORTS = Object.freeze([
  6379, // Redis
  6380,
  5432, // Postgres (common local service)
  3306, // MySQL
  27017, // MongoDB
]);

/** WebSocket path for the dedicated Browser channel (separate from widget page bridge). */
export const BROWSER_WS_PATH = '/ws-browser';

/** REST namespace for the Browser API. */
export const BROWSER_API_PREFIX = '/api/browser';

/** Browser-session ttl sweep interval (idle timeout enforcement). */
export const BROWSER_SWEEP_INTERVAL_MS = 60 * 1000;
