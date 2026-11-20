/**
 * Tuning constants for the Browser panel (browserPanel.js): pull sizes, live-view
 * cadence, viewport presets, gesture thresholds and rate-limit retries. Kept apart
 * so the panel module holds behaviour only.
 */
export const PULL_LIMIT = 100;
/** Client-side cap for text typed into the page per request. */
export const TYPE_TEXT_MAX = 1000;
/** Dynamic console/network entries kept in the DOM per channel. */
export const PULL_RENDER_MAX = 200;
/**
 * Live view frame cadence. The server caps a tab at 2 fps, so a 1 s interval
 * never trips `rate-limited` even when the user also hits Refresh.
 */
export const LIVE_FRAME_INTERVAL_MS = 1000;
export const LIVE_PULL_INTERVAL_MS = 2000;

/**
 * Phone and desktop viewports for the panel's mobile/desktop toggle. The
 * Browser session already defaults to a phone viewport, so the toggle lets the
 * user widen the page to a desktop layout and back. Sizes stay inside the
 * server's MIN/MAX_VIEWPORT bounds.
 */
export const PHONE_VIEWPORT = Object.freeze({ width: 390, height: 844 });
export const DESKTOP_VIEWPORT = Object.freeze({ width: 1280, height: 800 });
/** A drag past this many on-screen px is a scroll, below it a tap. */
export const GESTURE_TAP_SLOP_PX = 10;
/** Throttle for the REST screenshot refresh after a scroll burst. */
export const FRAME_REFRESH_THROTTLE_MS = 600;
/**
 * A 429 on the screenshot endpoint means the per-tab frame cap is still open,
 * not that the tab is broken. Wait out the cap and pull once more instead of
 * leaving the previous picture on screen with no explanation.
 */
export const FRAME_RATE_LIMIT_RETRY_MS = 520;
/** Retry budget for one frame; a fresh frame or a new view resets it. */
export const FRAME_RATE_LIMIT_RETRY_MAX = 2;
/** Matches server `INPUT_MIN_INTERVAL_MS` so scroll bursts stay under the tab input cap. */
export const SCROLL_INPUT_MIN_INTERVAL_MS = 40;
