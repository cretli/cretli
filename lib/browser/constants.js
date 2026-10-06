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
  /** Maximum queued /ws-browser messages before new ones are rejected. */
  INPUT_QUEUE_MAX: 64,
  /** Default mobile viewport used when the client sends none. */
  DEFAULT_VIEWPORT: Object.freeze({ width: 390, height: 844, dpr: 2, hasTouch: true }),
  MIN_VIEWPORT: Object.freeze({ width: 120, height: 120 }),
  MAX_VIEWPORT: Object.freeze({ width: 4096, height: 4096 }),
  MAX_DPR: 4,
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
