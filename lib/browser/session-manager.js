/**
 * BrowserSessionManager — server-side Chromium sessions for the Browser module.
 *
 * Responsibilities (P0 plan):
 * - one BrowserContext per session, one Page per tab, isolated per owner;
 * - auth/workspace scoping contract (foreign session/workspace => 403);
 * - per-session and per-tab limits;
 * - URL/SSRF policy applied to every request/redirect/subresource;
 * - redacted bounded Console/Network/Dialog buffers;
 * - idle timeout + explicit cleanup on close/shutdown.
 *
 * SSRF enforcement: Playwright does not re-invoke route handlers for server
 * redirects and Chromium resolves hostnames in its own network stack, so every
 * request is fetched with `maxRedirects: 0` and each hop is re-checked by the
 * URL policy; Chromium additionally gets a default-deny `--host-resolver-rules`
 * map and non-proxied WebRTC UDP is disabled at launch. This bounds, but does
 * not fully eliminate, DNS-rebinding/IP-literal and WebSocket bypasses (see
 * url-policy.js and SECURITY.md).
 *
 * All Chromium access goes through an injected `driver` (see runtime-detect.js)
 * so the manager is testable without a real browser.
 */

import { randomUUID } from 'crypto';
import path from 'path';
import { realpathSync } from 'fs';
import { BROWSER_LIMITS, BROWSER_SCREENSHOT_QUALITY, DEFAULT_BLOCKED_PORTS } from './constants.js';
import { ConsoleBuffer, DialogBuffer, NetworkBuffer } from './buffers.js';
import {
  evaluateUrlPolicy,
  buildHostResolverRules,
  normalizeNavigationUrl,
  parseHttpUrl,
  normalizeHostname,
  normalizeOrigin,
} from './url-policy.js';
import { redactText, redactTextCapped, redactUrl, redactValue, isSensitiveHeaderName } from './redaction.js';
import { HarRecorder } from './har.js';
import { killProcessTree } from './process-tree.js';
import {
  BrowserMetrics,
  createPidStore,
  resolveLifecycleLimits,
  defaultIsProcessAlive,
  defaultLooksLikeChromium,
} from './lifecycle.js';
import { removeBrowserScreenshots } from './screenshot-file.js';
import { probeBrowserProxy } from './proxy-health.js';
import { getLocalLoginToken, LOCAL_LOGIN_HEADER } from '../local-login.js';
import {
  normalizeScreencastMode,
  isExperimentalMode,
  buildStartScreencastParams,
  buildScreencastFrameHeader,
  decodeScreencastFrame,
  createScreencastGate,
} from './screencast.js';
import { createScreencastMetrics } from './screencast-metrics.js';
import { createDebuggerController } from './debugger.js';
import {
  getConsent,
  readStorageState,
  saveStorageState,
  publicStorageStateStatus,
  sweepExpiredStorageState,
} from './storage-state.js';
import { BrowserError } from './errors.js';

export { BrowserError };

/**
 * Streaming mode is a deployment flag, never a client request: the env var wins
 * over the constant default so a build can flip it without a code change, and an
 * empty value is treated as "not set" instead of "off", which would otherwise
 * silently outrank a configured default.
 * @param {unknown} explicit
 * @param {Record<string, any>} limits
 * @returns {'off' | 'experimental'}
 */
function resolveScreencastMode(explicit, limits) {
  const fromEnv = String(
    (typeof process !== 'undefined' ? process.env?.CRETLI_BROWSER_SCREENCAST : '') || '',
  ).trim();
  const candidate = explicit ?? (fromEnv || null) ?? limits?.SCREENCAST_MODE;
  return normalizeScreencastMode(candidate);
}

/** Bound for the fallback audit trail so a flapping stream cannot grow a list. */
const SCREENCAST_FALLBACK_LOG_MAX = 20;

/**
 * Best-effort: pid of the Chromium process behind a tab, when the driver exposes
 * it. Only used to label the metrics surface, so a missing value stays `null`
 * rather than becoming a fake `0`.
 * @param {any} tab
 * @returns {number|null}
 */
function browserProcessPid(tab) {
  try {
    const context = typeof tab?.page?.context === 'function' ? tab.page.context() : null;
    const browser = typeof context?.browser === 'function' ? context.browser() : null;
    const child = typeof browser?.process === 'function' ? browser.process() : null;
    return Number.isFinite(Number(child?.pid)) ? Number(child.pid) : null;
  } catch {
    return null;
  }
}

/**
 * Reads one Playwright accessor in an event handler without letting a hostile
 * page throw out of it. Used only for opt-in HAR capture.
 * @param {() => unknown} read
 * @param {unknown} [fallback]
 * @returns {unknown}
 */
function safeRead(read, fallback = null) {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/**
 * How long a proxy reachability result is trusted before the manager probes
 * again. Kept short so a recovered or newly-dead proxy is noticed quickly.
 */
export const PROXY_HEALTH_DEFAULT_TTL_MS = 30000;

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/**
 * Maps a preview-space point to page viewport coordinates.
 * @param {{ x: number, y: number }} point
 * @param {{ width: number, height: number } | null} preview
 * @param {{ width: number, height: number } | null} viewport
 * @returns {{ x: number, y: number }}
 */
export function mapPreviewPoint(point, preview, viewport) {
  const x = Number(point?.x);
  const y = Number(point?.y);
  if (!preview?.width || !preview?.height || !viewport?.width || !viewport?.height) {
    return { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 };
  }
  return {
    x: Math.round((x / preview.width) * viewport.width),
    y: Math.round((y / preview.height) * viewport.height),
  };
}

/**
 * Selector for the interactive elements an agent can meaningfully act on.
 * Playwright's CSS engine pierces open shadow roots, so a listing built from it
 * also sees controls inside Lit/custom elements (not just the light DOM).
 */
export const BROWSER_ELEMENTS_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="option"]',
  '[contenteditable=""]',
  '[contenteditable="true"]',
].join(', ');

/** Default and hard cap for one `browser_elements` listing. */
export const BROWSER_ELEMENTS_DEFAULT_LIMIT = 80;
export const BROWSER_ELEMENTS_MAX_LIMIT = 200;

/**
 * Truncation marker for a `browser_dom` snapshot. Its UTF-8 size is subtracted
 * from the byte budget up front so the returned `bytes` never exceed the
 * advertised `maxBytes`, and `truncated` is decided by the byte cut itself —
 * never by looking for this character at the end of the page's own HTML.
 */
const DOM_TRUNCATION_MARKER = '…';
const DOM_TRUNCATION_MARKER_BYTES = Buffer.byteLength(DOM_TRUNCATION_MARKER, 'utf8');

/** Answers accepted by `browser_input` kind `dialog`. */
export const BROWSER_DIALOG_ACTIONS = Object.freeze(['accept', 'dismiss']);

/**
 * BrowserError codes that mean a chat binding points at something this chat can
 * no longer use (closed, swept, lost in a restart, or scoped elsewhere), so the
 * caller may drop the pointer and fall through to the adopt/create flow.
 */
export const BROWSER_STALE_BINDING_CODES = Object.freeze([
  'not-found',
  'forbidden-owner',
  'forbidden-workspace',
  'forbidden-chat',
  'chat-bind-conflict',
]);

/**
 * Page-side pass over the interactive elements of a tab. Runs inside the browser
 * through `locator.evaluateAll`, so it must be self-contained (no Node closures)
 * and must never be fed caller-provided code: it only reads attributes/text and
 * builds a best-effort CSS selector. Doing visibility, bounds and the descriptor
 * in this single pass is what keeps `browser_elements` at one round trip instead
 * of three per element.
 *
 * @param {any[]} nodes
 * @param {{ maxText?: number, cap?: number, limit?: number, requireSize?: boolean }} [arg]
 * @returns {{ total: number, scanned: number, rows: Array<{ descriptor: object, bounds: {x: number, y: number, width: number, height: number}|null }> }}
 */
export function describePageElementsBatch(nodes, arg = {}) {
  const maxText = Number.isFinite(Number(arg.maxText)) && Number(arg.maxText) > 0 ? Number(arg.maxText) : 120;
  const cap = Number.isFinite(Number(arg.cap)) && Number(arg.cap) > 0 ? Number(arg.cap) : 0;
  const limit = Number.isFinite(Number(arg.limit)) && Number(arg.limit) > 0 ? Number(arg.limit) : 0;
  const requireSize = arg.requireSize !== false;
  const list = Array.isArray(nodes) ? nodes : [];
  const trim = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  const attr = (node, name) => (typeof node?.getAttribute === 'function' ? node.getAttribute(name) : null);

  const escape = (value) => {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(String(value));
    return String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
  };

  const segment = (el) => {
    if (el.id) return `#${escape(el.id)}`;
    let selector = String(el.tagName || '').toLowerCase();
    const classes = trim(el.getAttribute && el.getAttribute('class')).split(' ').filter(Boolean).slice(0, 2);
    for (const cls of classes) selector += `.${escape(cls)}`;
    const parent = el.parentElement;
    if (parent && parent.children) {
      const sameTag = Array.from(parent.children).filter((child) => child.tagName === el.tagName);
      if (sameTag.length > 1) selector += `:nth-of-type(${sameTag.indexOf(el) + 1})`;
    }
    return selector;
  };

  const describe = (node) => {
    const limit = maxText;
    const tag = String(node?.tagName || '').toLowerCase();
    const type = trim(attr(node, 'type')).toLowerCase();
    const text = trim(node?.innerText || node?.textContent).slice(0, limit);
    const role = trim(attr(node, 'role'))
      || ({ a: 'link', button: 'button', select: 'combobox', textarea: 'textbox', summary: 'button' }[tag] || '')
      || (tag === 'input'
        ? (type === 'checkbox' ? 'checkbox'
          : type === 'radio' ? 'radio'
            : (type === 'submit' || type === 'button' || type === 'reset') ? 'button' : 'textbox')
        : '');
    const name = trim(attr(node, 'aria-label'))
      || trim(attr(node, 'placeholder'))
      || trim(attr(node, 'name'))
      || trim(attr(node, 'title'))
      || text;

    const parts = [];
    let current = node;
    let guard = 0;
    while (current && current.nodeType === 1 && guard < 12) {
      parts.unshift(segment(current));
      guard += 1;
      const root = typeof current.getRootNode === 'function' ? current.getRootNode() : null;
      const host = root && root.host ? root.host : null;
      if (host) {
        // `>>` is Playwright's shadow-piercing chain operator.
        parts.unshift('>>');
        current = host;
      } else {
        current = current.parentElement;
      }
    }

    return {
      tag,
      role,
      type: type || undefined,
      name: name.slice(0, limit),
      text,
      id: trim(attr(node, 'id')) || undefined,
      selector: parts.join(' ').slice(0, 512),
      disabled: node?.disabled === true || attr(node, 'aria-disabled') === 'true',
      checked: typeof node?.checked === 'boolean' ? node.checked : undefined,
    };
  };

  const rectOf = (node) => {
    try {
      const rect = typeof node?.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null;
      if (!rect) return null;
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    } catch {
      return null;
    }
  };

  const isVisible = (node, rect) => {
    if (!node || node.nodeType !== 1 || node.isConnected === false || node.hidden === true) return false;
    try {
      const style = typeof getComputedStyle === 'function' ? getComputedStyle(node) : null;
      if (style && (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)) {
        return false;
      }
    } catch {
      // No computed style (orphaned node): fall back to the layout box below.
    }
    // Without a layout box there is nothing to reject the node on; the manager
    // still drops rows whose bounds are missing or smaller than 1px.
    if (!rect) return true;
    return rect.width >= 1 && rect.height >= 1;
  };

  const rows = [];
  let scanned = 0;
  for (const node of list) {
    if ((cap > 0 && scanned >= cap) || (limit > 0 && rows.length >= limit)) break;
    scanned += 1;
    const bounds = rectOf(node);
    if (!isVisible(node, bounds)) continue;
    // `requireSize: false` keeps a node with no layout box: the single-element
    // entry point below is used for nodes a caller already resolved.
    if (requireSize && (!bounds || bounds.width < 1 || bounds.height < 1)) continue;
    rows.push({ descriptor: describe(node), bounds });
  }
  return { total: list.length, scanned, rows };
}

/**
 * Describes one element with the same page-side logic as
 * `describePageElementsBatch` (kept as the single-element entry point for tests
 * and callers that already hold a node). Never mutates the page and never runs
 * caller code.
 *
 * @param {any} node
 * @param {number} maxText
 */
export function describePageElement(node, maxText) {
  const { rows } = describePageElementsBatch([node], {
    maxText,
    cap: 1,
    limit: 1,
    requireSize: false,
  });
  return rows[0] ? rows[0].descriptor : null;
}

/**
 * Closed allowlist of `browser_input` event kinds handled by `performInput()`.
 * Anything else fails with `unsupported-input`. The MCP tool schema enumerates
 * the same list so a schema-driven harness can discover every kind.
 */
export const BROWSER_INPUT_KINDS = Object.freeze([
  'pointer',
  'scroll',
  'key',
  'click',
  'fill',
  'resize',
  'select',
  'check',
  'uncheck',
  'hover',
  'drag',
  'upload',
  'wait',
  'dialog',
]);

/** Closed allowlist for `navigate`'s `waitUntil` — never a raw caller string. */
export const BROWSER_NAVIGATION_WAIT_UNTIL = Object.freeze([
  'domcontentloaded',
  'load',
  'networkidle',
  'commit',
]);

/** Element states accepted by kind `wait` (Playwright `waitFor` states). */
export const BROWSER_WAIT_STATES = Object.freeze(['attached', 'detached', 'visible', 'hidden']);

/** Load states accepted by kind `wait` (subset of the navigation states). */
export const BROWSER_LOAD_STATES = Object.freeze(['load', 'domcontentloaded', 'networkidle']);

/**
 * `nth`/`index` picks which match an input event acts on. Absent means "use the
 * first match"; anything that is not an integer >= 0 is rejected instead of
 * silently falling back, so a typo cannot target the wrong element.
 * @param {unknown} value
 * @returns {number|null}
 */
function parseLocatorIndex(value) {
  if (value === undefined || value === null || value === '') return null;
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0) {
    throw new BrowserError(
      'locator-index-invalid',
      'browser_input `nth`/`index` must be an integer >= 0',
      400,
    );
  }
  return index;
}

/**
 * Resolves the element an input event targets. Uses Playwright locators only
 * (no arbitrary script evaluation); role/text/label/placeholder locators pierce
 * open shadow roots, so Lit components work without a hand-written selector.
 * `nth` (or its alias `index`, matching the `index` field `browser_elements`
 * returns) selects which match to act on; without either the first match wins.
 * Returns null when the event carries no target.
 * @param {any} page
 * @param {Record<string, any>} event
 * @returns {any|null}
 */
function resolvePageLocator(page, event = {}) {
  const text = (value) => String(value ?? '').trim();
  const index = parseLocatorIndex(event.nth ?? event.index);
  const at = (locator) => (index === null ? locator.first() : locator.nth(index));
  const selector = text(event.selector);
  if (selector) return at(page.locator(selector));
  const role = text(event.role);
  if (role) {
    const name = text(event.name);
    return at(page.getByRole(role, name ? { name } : undefined));
  }
  const byText = text(event.text);
  if (byText) return at(page.getByText(byText));
  const label = text(event.label);
  if (label) return at(page.getByLabel(label));
  const placeholder = text(event.placeholder);
  if (placeholder) return at(page.getByPlaceholder(placeholder));
  return null;
}

/**
 * Navigation waitUntil for `navigate()`: an empty value keeps the historical
 * default, an unknown one fails closed rather than reaching Playwright.
 * @param {unknown} value
 * @returns {string}
 */
function normalizeWaitUntil(value) {
  const waitUntil = String(value ?? '').trim();
  if (!waitUntil) return 'domcontentloaded';
  if (!BROWSER_NAVIGATION_WAIT_UNTIL.includes(waitUntil)) {
    throw new BrowserError(
      'invalid-wait-until',
      `Unknown waitUntil: ${waitUntil}. Use ${BROWSER_NAVIGATION_WAIT_UNTIL.join('|')}`,
      400,
    );
  }
  return waitUntil;
}

/**
 * Builds the Playwright `selectOption` argument for kind `select`. `optionIndex`
 * wins over `optionLabel`, which wins over `value`. The option label is a
 * separate field because `label` already names a locator target.
 * @param {Record<string, any>} event
 * @returns {any}
 */
function buildSelectOption(event) {
  const present = (value) => value !== undefined && value !== null && value !== '';
  const asArray = (value) => (Array.isArray(value) ? value : [value]);
  const unwrap = (options) => (options.length === 1 ? options[0] : options);
  if (present(event.optionIndex)) {
    const indexes = asArray(event.optionIndex).map((value) => Number(value));
    if (indexes.some((value) => !Number.isInteger(value) || value < 0)) {
      throw new BrowserError(
        'select-option-invalid',
        'browser_input select `optionIndex` must be an integer >= 0 (or an array of them)',
        400,
      );
    }
    return unwrap(indexes.map((index) => ({ index })));
  }
  if (present(event.optionLabel)) {
    const labels = asArray(event.optionLabel);
    if (labels.some((value) => typeof value !== 'string' || !value.trim())) {
      throw new BrowserError(
        'select-option-invalid',
        'browser_input select `optionLabel` must be a non-empty string or an array of them',
        400,
      );
    }
    return unwrap(labels.map((label) => ({ label })));
  }
  if (present(event.value)) {
    const values = asArray(event.value);
    if (values.some((value) => typeof value !== 'string' || !value.length)) {
      throw new BrowserError(
        'select-option-invalid',
        'browser_input select `value` must be a string or an array of strings '
        + '(use `optionLabel` for visible text, `optionIndex` for position)',
        400,
      );
    }
    return unwrap(values);
  }
  throw new BrowserError(
    'select-option-required',
    'browser_input select needs an option: `value`, `optionLabel` or `optionIndex`',
    400,
  );
}

/**
 * The destination of a `drag` uses its own `to*` field set so the source keeps
 * the standard target fields and can never be silently reused as the target.
 * @param {Record<string, any>} event
 * @returns {Record<string, any>}
 */
function dragDestinationFields(event) {
  return {
    selector: event.toSelector,
    role: event.toRole,
    name: event.toName,
    text: event.toText,
    label: event.toLabel,
    placeholder: event.toPlaceholder,
    nth: event.toNth ?? event.toIndex,
  };
}

/**
 * Header names that carry credentials. They must never be replayed to a
 * different origin when a redirect is followed manually (route.fetch copies the
 * original request's headers otherwise). Matched case-insensitively; the
 * sensitive-header detector covers vendor variants such as `x-*-token`.
 */
const CREDENTIAL_HEADER_NAMES = Object.freeze(['cookie', 'authorization', 'proxy-authorization']);

/**
 * Builds the header set for a cross-origin redirect hop: non-sensitive headers
 * are preserved, every credential-bearing header is forced to the empty string
 * so Playwright's `route.fetch` overrides (rather than re-sends) the original
 * value. The credential headers are cleared unconditionally so a missing or
 * unreadable original header set can never leak them.
 * @param {Record<string, string>|null|undefined} baseHeaders
 * @returns {Record<string, string>}
 */
function buildCrossOriginHeaders(baseHeaders) {
  /** @type {Record<string, string>} */
  const out = {};
  const source = baseHeaders && typeof baseHeaders === 'object' ? baseHeaders : {};
  for (const [name, value] of Object.entries(source)) {
    out[name] = isSensitiveHeaderName(name) ? '' : String(value ?? '');
  }
  for (const name of CREDENTIAL_HEADER_NAMES) out[name] = '';
  return out;
}

export class BrowserSessionManager {
  /**
   * @param {{
   *   driver?: object|null,
   *   driverStatus?: { status?: string, reason?: string, version?: string|null, executablePath?: string|null, sandboxWarning?: string|null },
   *   instanceId?: string,
   *   limits?: typeof BROWSER_LIMITS,
   *   dataDir?: string,
   *   resolvePolicy?: (workspaceKey: string) => object,
   *   blockedPorts?: number[],
   *   selfOrigins?: string[],
   *   lookup?: Function,
   *   realpath?: (target: string) => string,
   *   now?: () => number,
   *   setIntervalFn?: Function,
   *   clearIntervalFn?: Function,
   *   setTimeoutFn?: Function,
   *   clearTimeoutFn?: Function,
   *   proxyProbe?: (proxyServer: string) => Promise<{ ok: boolean, code: string, reason: string, latencyMs: number }>,
   *   proxyHealthTtlMs?: number,
   *   screencastMode?: string,
   *   screencastMetrics?: { sampleResource?: (() => any)|null, windowMs?: number },
   *   har?: { dataDir?: string, maxBytes?: number, maxEntries?: number, enabled?: boolean },
   *   metrics?: object,
   *   lifecycleLimits?: object,
   *   respawn?: object|null,
   *   relaunch?: (() => Promise<unknown>|unknown)|null,
   *   pidStore?: object,
   *   isProcessAlive?: (pid: number) => boolean,
   *   looksLikeChromium?: (pid: number) => boolean,
   *   multiInstanceGuard?: (() => void)|null,
   * }} [options]
   */
  constructor(options = {}) {
    this.driver = options.driver || null;
    this.driverStatus = options.driverStatus || {};
    this.instanceId = options.instanceId || randomUUID();
    this.limits = options.limits || BROWSER_LIMITS;
    // Experimental CDP screencast (`off` | `experimental`). Resolved once here so
    // no request path can widen it; `off` leaves the pull channel untouched.
    this.screencastMode = resolveScreencastMode(options.screencastMode, this.limits);
    /** @type {Map<string, any>} tabId -> live screencast state (gate, sinks, timers) */
    this.screencasts = new Map();
    /**
     * Bounded audit trail of automatic fallbacks to the pull path, newest last.
     * This is R5's observability: every switch out of streaming carries a reason.
     * @type {Array<{ at: number, browserTabId: string, reason: string }>}
     */
    this.screencastFallbacks = [];
    this.screencastMetricsOptions = options.screencastMetrics || null;
    /** @type {Map<string, any>} tabId -> debugger runtime (controller + dedicated CDP) */
    this.debuggers = new Map();
    this.dataDir = options.dataDir || '';
    // P2c lifecycle: bounded metrics, global/per-workspace caps, respawn wiring
    // and a PID store that survives a server crash so an orphan is swept on boot.
    this.metrics = options.metrics || new BrowserMetrics();
    this.lifecycleLimits = {
      ...resolveLifecycleLimits(process.env, this.limits),
      ...(options.lifecycleLimits && typeof options.lifecycleLimits === 'object' ? options.lifecycleLimits : {}),
    };
    this.respawn = options.respawn || null;
    this.relaunch = typeof options.relaunch === 'function' ? options.relaunch : null;
    this.pidStore = options.pidStore || createPidStore(this.dataDir);
    this.isProcessAlive = typeof options.isProcessAlive === 'function' ? options.isProcessAlive : defaultIsProcessAlive;
    this.looksLikeChromium = typeof options.looksLikeChromium === 'function' ? options.looksLikeChromium : defaultLooksLikeChromium;
    /**
     * Live session PIDs mirrored into `pidStore`. Kept in memory so a concurrent
     * registration cannot race a read-modify-write of the JSON file.
     * @type {Map<number, { pid: number, executablePath: string, recordedAt: number }>}
     */
    this.registeredPids = new Map();
    // Persistent `storageState` is strictly opt-in: without a config the manager
    // stays fully ephemeral and never reads or writes cookies to disk. The
    // actual consent check lives in storage-state.js (default off per workspace).
    const storageConfig = options.storageState && typeof options.storageState === 'object'
      ? options.storageState
      : null;
    this.storageStateConfig = storageConfig;
    this.storageStateEnv = storageConfig?.env || process.env;
    this.storageStateSecret = storageConfig?.secret;
    this.storageStateDataDir = String(storageConfig?.dataDir || options.dataDir || '');
    const storageTtl = Number(storageConfig?.ttlMs);
    this.storageStateTtlMs = Number.isFinite(storageTtl) && storageTtl > 0 ? storageTtl : undefined;
    this.storageStateEnabled = Boolean(storageConfig && storageConfig.enabled !== false && this.storageStateDataDir);
    // HAR recording is an explicit opt-in (per session `recordHar` or the
    // workspace policy flag). `har` config only supplies the capability/data
    // dir; without it the manager never builds a recorder, so no HAR can be
    // written even when a caller asks for one.
    const harConfig = options.har && typeof options.har === 'object' ? options.har : null;
    this.harConfig = harConfig;
    this.harDataDir = harConfig && harConfig.enabled !== false
      ? String(harConfig.dataDir || options.dataDir || '')
      : '';
    const harMaxBytes = Number(harConfig?.maxBytes);
    this.harMaxBytes = Number.isFinite(harMaxBytes) && harMaxBytes > 0 ? Math.floor(harMaxBytes) : undefined;
    const harMaxEntries = Number(harConfig?.maxEntries);
    this.harMaxEntries = Number.isFinite(harMaxEntries) && harMaxEntries > 0 ? Math.floor(harMaxEntries) : undefined;
    this.resolvePolicy = typeof options.resolvePolicy === 'function'
      ? options.resolvePolicy
      : () => ({ allowedOrigins: [], blockedPorts: [], unblockedPorts: [] });
    this.blockedPorts = Array.isArray(options.blockedPorts) ? options.blockedPorts : [];
    // Cretli's own origin(s) (direct loopback URL and configured public origin)
    // are always denied, even when a workspace allowlists them.
    this.selfOrigins = Array.isArray(options.selfOrigins)
      ? options.selfOrigins.map((origin) => normalizeOrigin(origin)).filter(Boolean)
      : [];
    this.multiInstanceGuard = typeof options.multiInstanceGuard === 'function' ? options.multiInstanceGuard : null;
    this.lookup = typeof options.lookup === 'function' ? options.lookup : undefined;
    // Used by `browser_input` upload to authorize paths off the host. Injectable
    // so tests can model a symlink escape without needing symlink privileges.
    this.realpath = typeof options.realpath === 'function' ? options.realpath : realpathSync;
    this.killTree = typeof options.killTree === 'function' ? options.killTree : killProcessTree;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.setIntervalFn = options.setIntervalFn || setInterval;
    this.clearIntervalFn = options.clearIntervalFn || clearInterval;
    this.setTimeoutFn = options.setTimeoutFn || setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
    // Proxy reachability is injectable so tests never open a real socket.
    this.proxyProbe = typeof options.proxyProbe === 'function' ? options.proxyProbe : probeBrowserProxy;
    const requestedProxyTtl = Number(options.proxyHealthTtlMs);
    this.proxyHealthTtlMs = Number.isFinite(requestedProxyTtl) && requestedProxyTtl >= 0
      ? requestedProxyTtl
      : PROXY_HEALTH_DEFAULT_TTL_MS;
    /** @type {object|null} Last proxy reachability result, when a probe has run. */
    this.proxyHealth = null;
    /** @type {number} `now()` timestamp of `proxyHealth`. */
    this.proxyHealthCheckedAt = 0;
    /** @type {string} Non-fatal `proxy`-mode warning for the status surface. */
    this.proxyWarning = '';
    /** @type {Map<string, any>} */
    this.sessions = new Map();
    /** @type {Map<string, string>} chatId -> browserSessionId */
    this.chatBindings = new Map();
    /**
     * Per-owner creation chains. Two concurrent createSession calls must not
     * both pass the MAX_SESSIONS_PER_OWNER capacity check before either has
     * committed its session, so creation is serialized per owner.
     * @type {Map<string, Promise<void>>}
     */
    this.createChains = new Map();
    /**
     * Per-session tab creation chains, for the same reason as `createChains`:
     * the capacity check, `newPage()` and the tab registration must not
     * interleave, or two parallel createTab calls both pass the check and the
     * session ends up over MAX_TABS_PER_SESSION.
     * @type {Map<string, Promise<void>>}
     */
    this.tabChains = new Map();
    /**
     * Live `/ws-browser` subscriber count per browser session id. A panel or an
     * agent that only reads state must not look idle to the sweep, so the WS
     * channel registers here and `sweepIdle()` skips any session still watched.
     * @type {Map<string, number>}
     */
    this.wsSubscribers = new Map();
    this.sweepTimer = null;
  }

  /** @returns {boolean} */
  isAvailable() {
    return Boolean(this.driver);
  }

  /** @returns {object} */
  getRuntimeStatus() {
    const configuredBoundary = this.driverStatus.networkBoundary
      || { mode: 'mvp-defense-in-depth', configured: true };
    // Expose the last proxy probe only when one has run; the base boundary
    // shape stays unchanged for every existing consumer.
    const networkBoundary = this.proxyHealth
      ? { ...configuredBoundary, proxyHealth: this.proxyHealth }
      : configuredBoundary;
    return {
      available: Boolean(this.driver),
      status: this.driver ? 'available' : (this.driverStatus.status || 'browser-unavailable'),
      reason: this.driver ? 'ok' : (this.driverStatus.reason || 'Browser runtime unavailable'),
      version: this.driverStatus.version || null,
      executablePath: this.driverStatus.executablePath || null,
      sandboxWarning: this.driverStatus.sandboxWarning || null,
      networkBoundary,
      limits: { ...this.limits },
    };
  }

  /**
   * Aggregated health for the operator surface: driver availability, the root
   * Chromium process liveness, proxy state, respawn state and live session
   * counts per workspace.
   * @returns {object}
   */
  healthcheck() {
    const checkedAt = this.now();
    const driverAvailable = Boolean(this.driver);
    const respawn = this.respawn && typeof this.respawn.status === 'function' ? this.respawn.status() : null;
    const pid = this._firstRegisteredPid();
    let alive = false;
    if (pid !== null) {
      try {
        alive = this.isProcessAlive(pid) === true;
      } catch {
        alive = false;
      }
    }
    let status = 'ok';
    if (!driverAvailable) status = 'unavailable';
    else if (respawn?.exhausted === true || Boolean(this.proxyWarning)) status = 'degraded';
    return {
      checkedAt,
      status,
      driver: {
        available: driverAvailable,
        status: this.driver ? 'available' : (this.driverStatus.status || 'browser-unavailable'),
        reason: this.driver ? 'ok' : (this.driverStatus.reason || 'Browser runtime unavailable'),
        version: this.driverStatus.version || null,
      },
      process: { alive, pid },
      proxy: this.proxyHealth,
      respawn,
      sessions: {
        global: this.sessions.size,
        maxGlobal: Number.isInteger(this.lifecycleLimits?.maxSessionsGlobal) ? this.lifecycleLimits.maxSessionsGlobal : null,
        workspaces: this._sessionCountsByWorkspace().map(({ workspaceKey, active }) => ({
          workspaceKey,
          active,
          max: Number.isInteger(this.lifecycleLimits?.maxSessionsPerWorkspace) ? this.lifecycleLimits.maxSessionsPerWorkspace : null,
        })),
      },
    };
  }

  /** Metrics snapshot plus the live session counts the counters cannot know. */
  metricsSnapshot() {
    const base = this.metrics && typeof this.metrics.snapshot === 'function'
      ? this.metrics.snapshot()
      : { generatedAt: this.now(), global: {}, workspaces: [] };
    return {
      ...base,
      live: {
        globalSessions: this.sessions.size,
        workspaces: this._sessionCountsByWorkspace().map(({ workspaceKey, active }) => ({ workspaceKey, active })),
      },
    };
  }

  /**
   * @returns {Array<{ workspaceKey: string, active: number }>}
   */
  _sessionCountsByWorkspace() {
    const counts = new Map();
    for (const session of this.sessions.values()) {
      const key = String(session?.workspaceKey || '');
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()].map(([workspaceKey, active]) => ({ workspaceKey, active }));
  }

  /**
   * First PID this manager registered for a live Chromium, or `null`.
   * @returns {number|null}
   */
  _firstRegisteredPid() {
    for (const pid of this.registeredPids.keys()) {
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
    for (const session of this.sessions.values()) {
      const pid = Number.isInteger(session?.rootPid) ? session.rootPid : Number(session?.processId);
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
    return null;
  }

  /**
   * Applies the policy for one proxy health result.
   *
   * `mvp-defense-in-depth` is filtered out before this is called. A `proxy`
   * failure only records a warning (the operator asked for a proxy, not for the
   * session to be blocked); a `required` failure throws so the session is never
   * created behind a proxy that does not answer.
   * @param {{ ok: boolean, code: string, reason: string, mode: string, proxyServer: string }} health
   * @returns {object} the same health result when it does not throw
   */
  _enforceProxyHealth(health) {
    if (health.ok) {
      this.proxyWarning = '';
      return health;
    }
    const message = `Browser network boundary '${health.mode}' cannot reach proxy ${health.proxyServer} (${health.code}: ${health.reason})`;
    if (health.mode === 'required') {
      throw new BrowserError('browser-unavailable', `${message}. Refusing to start a Browser session.`, 503);
    }
    this.proxyWarning = `${message}; continuing because the boundary is 'proxy' (warn only).`;
    return health;
  }

  /**
   * Probes the configured proxy once per TTL and enforces the boundary policy.
   *
   * `mvp-defense-in-depth` never probes (there is no proxy and the mode makes no
   * isolation claim), and a boundary without a proxy is already rejected by
   * `resolveBrowserNetworkBoundary` before the manager exists.
   * @returns {Promise<object|null>} the health result, or `null` when not applicable
   */
  async _ensureProxyHealth() {
    const boundary = this.driverStatus.networkBoundary || {};
    const mode = String(boundary.mode || 'mvp-defense-in-depth');
    if (mode !== 'proxy' && mode !== 'required') return null;
    const proxyServer = String(boundary.proxyServer || '').trim();
    if (!proxyServer) return null;

    const now = this.now();
    if (this.proxyHealth && (now - this.proxyHealthCheckedAt) < this.proxyHealthTtlMs) {
      return this._enforceProxyHealth(this.proxyHealth);
    }

    const result = await this.proxyProbe(proxyServer);
    const health = {
      ok: result?.ok === true,
      code: String(result?.code || (result?.ok ? 'proxy-ok' : 'proxy-unreachable')),
      reason: String(result?.reason || ''),
      latencyMs: Number.isFinite(Number(result?.latencyMs)) ? Number(result.latencyMs) : 0,
      mode,
      proxyServer,
      checkedAt: now,
    };
    this.proxyHealth = health;
    this.proxyHealthCheckedAt = now;
    return this._enforceProxyHealth(health);
  }

  startSweep() {
    if (this.sweepTimer) return;
    const interval = Math.max(5000, Math.floor(this.limits.IDLE_TIMEOUT_MS / 4));
    this.sweepTimer = this.setIntervalFn(() => { this.sweepIdle(); }, interval);
    if (this.sweepTimer && typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref();
  }

  stopSweep() {
    if (!this.sweepTimer) return;
    this.clearIntervalFn(this.sweepTimer);
    this.sweepTimer = null;
  }

  /**
   * @param {unknown} workspaceKey
   * @returns {object}
   */
  policyFor(workspaceKey) {
    try {
      return this.resolvePolicy(String(workspaceKey || ''));
    } catch {
      return { allowedOrigins: [], blockedPorts: [], unblockedPorts: [] };
    }
  }

  /**
   * A Browser session always has one unambiguous workspace key. Missing scope
   * is never treated as "any workspace".
   * @param {{ workspaceFile?: unknown, cwd?: unknown }} [scope]
   * @returns {string}
   */
  resolveWorkspaceKey(scope = {}) {
    const file = String(scope?.workspaceFile || '').trim();
    if (file) return file;
    return String(scope?.cwd || '').trim();
  }

  /**
   * Resolves a promise but never waits longer than `timeoutMs`. Cleanup must
   * always finish, even when a Playwright call hangs.
   * @param {Promise<unknown>|unknown} promise
   * @param {number} timeoutMs
   * @returns {Promise<void>}
   */
  withHardTimeout(promise, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const timer = this.setTimeoutFn(finish, Math.max(0, Number(timeoutMs) || 0));
      // Deliberately not unref'd: a hard cleanup timeout must fire even when no
      // other handle keeps the event loop alive.
      void timer;
      Promise.resolve(promise).then(finish, finish);
    });
  }

  /**
   * Same bound as `withHardTimeout`, but keeps the resolved value (used to read
   * `context.storageState()` without letting a wedged page stall teardown).
   * @template T
   * @param {Promise<T>|(() => Promise<T>)} promise
   * @param {number} timeoutMs
   * @param {T} fallback
   * @returns {Promise<T>}
   */
  withResultTimeout(promise, timeoutMs, fallback) {
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (timer !== null && timer !== undefined) {
          try {
            this.clearTimeoutFn(timer);
          } catch {
            // ignore
          }
        }
        resolve(value);
      };
      timer = this.setTimeoutFn(() => finish(fallback), Math.max(0, Number(timeoutMs) || 0));
      Promise.resolve(typeof promise === 'function' ? promise() : promise)
        .then((value) => finish(value), () => finish(fallback));
    });
  }

  /**
   * Reads the persisted `storageState` for a workspace when persistence is
   * enabled and the user consented. Returns null otherwise, so the context
   * stays ephemeral (the default). Never throws.
   * @param {string} workspaceKey
   * @returns {unknown|null}
   */
  sessionStorageState(workspaceKey) {
    if (!this.storageStateEnabled) return null;
    try {
      const result = readStorageState(this.storageStateDataDir, workspaceKey, {
        secret: this.storageStateSecret,
        env: this.storageStateEnv,
        now: this.now(),
      });
      return result.ok ? result.state : null;
    } catch {
      return null;
    }
  }

  /**
   * Whether persistent storage is enabled and the workspace owner consented.
   * Consent — not the presence of an already persisted payload — is the
   * activation gate, so the very first session (no stored state yet, after TTL
   * expiry or after `clear(..., { keepConsent: true })`) still bootstraps the
   * store on close. Never throws.
   * @param {string} workspaceKey
   * @returns {boolean}
   */
  sessionStorageConsented(workspaceKey) {
    if (!this.storageStateEnabled) return false;
    try {
      return getConsent(this.storageStateDataDir, workspaceKey) === true;
    } catch {
      return false;
    }
  }

  /**
   * Metadata-only status for a workspace (consent, TTL, counters). Never
   * returns cookies/tokens, so it is safe for the status API and the UI.
   * @param {string} workspaceKey
   * @returns {object}
   */
  getStorageStateStatus(workspaceKey) {
    if (!this.storageStateEnabled) return { enabled: false };
    try {
      const status = publicStorageStateStatus(this.storageStateDataDir, workspaceKey, {
        secret: this.storageStateSecret,
        env: this.storageStateEnv,
        now: this.now(),
      });
      return { enabled: true, ...status };
    } catch {
      return { enabled: true, workspace: '', consent: false, keyAvailable: false, hasState: false };
    }
  }

  /**
   * Best-effort save of the live context's `storageState` before teardown. A
   * failure never propagates: closing a session must not depend on this write.
   * @param {any} session
   * @returns {Promise<object|null>}
   */
  async persistSessionStorageState(session) {
    if (!this.storageStateEnabled || session?.storageStateActive !== true) return null;
    const context = session.context;
    if (!context || typeof context.storageState !== 'function') return null;
    const hard = Number(this.limits.CLOSE_HARD_TIMEOUT_MS) > 0
      ? Number(this.limits.CLOSE_HARD_TIMEOUT_MS)
      : 3000;
    try {
      const state = await this.withResultTimeout(
        () => context.storageState(),
        hard,
        null,
      );
      if (!state) return null;
      return saveStorageState(this.storageStateDataDir, session.workspaceKey, state, {
        secret: this.storageStateSecret,
        env: this.storageStateEnv,
        ttlMs: this.storageStateTtlMs,
        now: this.now(),
      });
    } catch {
      // Best-effort: an unreadable/undecryptable state stays unwritten.
      return null;
    }
  }

  /**
   * Removes expired persisted entries. Called on startup so a stale entry never
   * outlives its TTL even if no read touches it.
   * @returns {{ removed: number, profiles: string[] }}
   */
  sweepStorageState() {
    if (!this.storageStateEnabled) return { removed: 0, profiles: [] };
    try {
      return sweepExpiredStorageState(this.storageStateDataDir, { now: this.now() });
    } catch {
      return { removed: 0, profiles: [] };
    }
  }

  /**
   * Builds a HAR recorder for a session only when the caller opted in and the
   * server wiring supplied a HAR data dir. Returns null (no recorder, no file)
   * in every other case, so the default is "no HAR at all".
   * @param {any} session
   * @param {boolean} requested
   * @returns {HarRecorder|null}
   */
  buildHarRecorder(session, requested) {
    if (requested !== true || !this.harDataDir) return null;
    try {
      return new HarRecorder({
        enabled: true,
        dataDir: this.harDataDir,
        id: session.id,
        workspaceKey: session.workspaceKey,
        maxBytes: this.harMaxBytes,
        maxEntries: this.harMaxEntries,
        now: this.now,
      });
    } catch {
      return null;
    }
  }

  /**
   * Metadata-only HAR status for a workspace. Never contains entries, headers,
   * cookies or the filesystem path.
   * @param {unknown} workspaceKey
   * @returns {{ enabled: boolean, workspaceOptIn?: boolean }}
   */
  getHarStatus(workspaceKey) {
    if (!this.harDataDir) return { enabled: false };
    let workspaceOptIn = false;
    try {
      workspaceOptIn = this.policyFor(String(workspaceKey || '')).recordHar === true;
    } catch {
      workspaceOptIn = false;
    }
    return { enabled: true, workspaceOptIn };
  }

  /**
   * Best-effort flush of a session's redacted HAR before teardown. Closing a
   * session must never depend on this write, so a failure is swallowed.
   * @param {any} session
   * @returns {object|null}
   */
  persistSessionHar(session) {
    if (!session?.har) return null;
    try {
      return session.har.flush();
    } catch {
      return null;
    }
  }

  /**
   * Detaches only the shared navigation/screencast CDP session (`tab.cdpSession`).
   * Never touches `tab.debuggerCdpSession` — stale navigation reads must not kill the debugger.
   * @param {any} tab
   */
  async detachNavigationCdpSession(tab) {
    // A live screencast rides on this exact session, so teardown has to end the
    // stream (listener removed, `Page.stopScreencast` sent, window drained) here.
    await this.stopScreencastForTab(tab, {
      reason: 'detached',
      recordFallback: false,
    });
    const cdp = tab?.cdpSession;
    if (tab) tab.cdpSession = null;
    if (!cdp || typeof cdp.detach !== 'function') return;
    const timeout = Number(this.limits.CLOSE_HARD_TIMEOUT_MS) > 0
      ? Number(this.limits.CLOSE_HARD_TIMEOUT_MS)
      : 3000;
    await this.withHardTimeout(Promise.resolve().then(() => cdp.detach()), timeout);
  }

  /**
   * Full tab CDP teardown (debugger + navigation/screencast). Used on explicit tab/session close.
   * @param {any} tab
   */
  async detachCdpSession(tab) {
    await this.detachDebuggerForTab(tab);
    await this.detachNavigationCdpSession(tab);
  }

  /**
   * Same bound the click/fill locator actions use, resolved from the injectable
   * limits so a test or a tuned deployment can move it.
   * @returns {number}
   */
  locatorTimeoutMs() {
    return Number.isFinite(this.limits.LOCATOR_TIMEOUT_MS) && this.limits.LOCATOR_TIMEOUT_MS > 0
      ? Number(this.limits.LOCATOR_TIMEOUT_MS)
      : BROWSER_LIMITS.LOCATOR_TIMEOUT_MS;
  }

  /**
   * Bounds a page read that Playwright exposes no `timeout` option for
   * (`page.content()`, `locator.count()`, `locator.evaluateAll()`), with the
   * same `LOCATOR_TIMEOUT_MS` the input actions already use. Without it one
   * wedged page holds the tool open forever, and on `/ws-browser` every queued
   * message behind it too.
   * @param {Promise<unknown>|unknown} promise
   * @param {string} what Label for the error message.
   * @param {string} code BrowserError code for the timeout.
   * @returns {Promise<unknown>}
   */
  withReadTimeout(promise, what, code) {
    const timeout = this.locatorTimeoutMs();
    let timer = null;
    const guard = new Promise((resolve, reject) => {
      timer = this.setTimeoutFn(
        () => reject(new BrowserError(code, `${what} timed out after ${timeout}ms`, 504)),
        timeout,
      );
      Promise.resolve(promise).then(resolve, reject);
    });
    return guard.finally(() => {
      if (timer !== null && timer !== undefined) {
        try {
          this.clearTimeoutFn(timer);
        } catch {
          // ignore
        }
      }
    });
  }

  /**
   * Evaluates the URL policy for a request, feeding the addresses pinned by
   * earlier requests for the same hostname back into the policy so a hostname
   * cannot silently change answers inside one session.
   * @param {any} session
   * @param {string} url
   * @returns {Promise<import('./url-policy.js').UrlPolicyResult>}
   */
  async evaluateRequestPolicy(session, url) {
    const hostname = parseHttpUrl(url)?.hostname || '';
    const pinned = hostname && session.dnsPins?.has(hostname)
      ? [...session.dnsPins.get(hostname)]
      : [];
    const decision = await evaluateUrlPolicy({
      url,
      policy: this.policyFor(session.workspaceKey || session.workspaceFile || session.cwd),
      blockedPorts: [...DEFAULT_BLOCKED_PORTS, ...this.blockedPorts],
      blockedOrigins: this.selfOrigins,
      lookup: this.lookup,
      pinnedAddresses: pinned,
    });
    if (decision.allowed) {
      this.rememberAddresses(session, hostname || decision.hostname, decision.resolvedIps);
    }
    return decision;
  }

  /**
   * @param {any} session
   * @param {string} hostname
   * @param {string[]} addresses
   */
  rememberAddresses(session, hostname, addresses) {
    const host = normalizeHostname(hostname);
    if (!host || !Array.isArray(addresses) || addresses.length === 0) return;
    if (!(session.dnsPins instanceof Map)) session.dnsPins = new Map();
    if (session.dnsPins.has(host)) return;
    session.dnsPins.set(host, new Set(addresses.map((address) => normalizeHostname(address))));
  }

  /**
   * @param {any} session
   * @returns {number|null}
   */
  processIdFor(session) {
    try {
      const own = session?.browser && typeof session.browser.process === 'function'
        ? session.browser.process()
        : null;
      if (own && Number.isInteger(own.pid)) return own.pid;
    } catch {
      // ignore
    }
    try {
      const fromDriver = this.driver?.getProcessId?.(session?.browser);
      if (Number.isInteger(fromDriver)) return fromDriver;
    } catch {
      // ignore
    }
    return Number.isInteger(session?.processId) ? session.processId : null;
  }

  /**
   * Kills the Chromium process tree when a graceful close did not finish.
   * @param {any} session
   * @returns {boolean}
   */
  killBrowserTree(session) {
    let connected = true;
    try {
      connected = session?.browser?.isConnected?.() !== false;
    } catch {
      connected = true;
    }
    if (!connected) return false;
    const pid = this.processIdFor(session);
    if (!pid) return false;
    try {
      return this.killTree(pid) === true;
    } catch {
      return false;
    }
  }

  /**
   * Records a session's Chromium root PID in the persistent store so a later
   * process can sweep it if this one crashes. Best-effort only.
   * @param {any} session
   */
  _registerPid(session) {
    try {
      const pid = Number(session?.rootPid);
      if (!Number.isInteger(pid) || pid <= 0) return;
      this.registeredPids.set(pid, {
        pid,
        executablePath: String(this.driverStatus?.executablePath || this.driver?.executablePath || ''),
        recordedAt: this.now(),
      });
      this._persistPids();
    } catch {
      // PID bookkeeping must never break session creation.
    }
  }

  /**
   * @param {any} session
   */
  _removePid(session) {
    try {
      const pid = Number(session?.rootPid);
      if (!Number.isInteger(pid) || pid <= 0) return;
      if (this.registeredPids.delete(pid)) this._persistPids();
    } catch {
      // best-effort
    }
  }

  /** Mirrors the in-memory PID map into the store. Never throws. */
  _persistPids() {
    try {
      this.pidStore?.write?.([...this.registeredPids.values()]);
    } catch {
      // best-effort
    }
  }

  /**
   * Swaps the active driver from a `detectBrowserRuntime()`-shaped object.
   * @param {object|null} runtimeOrNull
   * @returns {boolean} true when an available driver is now installed
   */
  setDriver(runtimeOrNull) {
    if (!runtimeOrNull || typeof runtimeOrNull !== 'object') {
      this.driver = null;
      this.driverStatus = {};
      return false;
    }
    try {
      this.driver = runtimeOrNull.driver || null;
      this.driverStatus = runtimeOrNull;
      return Boolean(this.driver);
    } catch {
      return false;
    }
  }

  /**
   * Handles a driver `disconnected` event by asking the respawn controller for a
   * relaunch. A missing controller is a no-op, and no failure escapes.
   * @param {unknown} [reason]
   * @param {any} [session]
   * @returns {Promise<boolean>}
   */
  async handleDriverCrash(reason = 'driver-crash', session = null) {
    try {
      if (!this.respawn || typeof this.respawn.schedule !== 'function') return false;
      const workspaceKey = String(session?.workspaceKey || this._crashWorkspaceKey() || '');
      let ok = false;
      try {
        ok = await this.respawn.schedule(reason) === true;
      } catch {
        ok = false;
      }
      try {
        this.metrics?.recordRespawn(workspaceKey, { ok });
      } catch {
        // metrics must never break recovery
      }
      if (ok && typeof this.relaunch === 'function') {
        try {
          const next = await this.relaunch();
          // A callback that re-detects the runtime may return the descriptor; a
          // boolean-returning callback has already swapped the driver itself.
          if (next && typeof next === 'object') this.setDriver(next);
        } catch {
          // a failed relaunch leaves the old (dead) driver in place
        }
      }
      return ok;
    } catch {
      return false;
    }
  }

  /** @returns {string} workspace key of the first live session, else ''. */
  _crashWorkspaceKey() {
    for (const session of this.sessions.values()) {
      const key = String(session?.workspaceKey || '');
      if (key) return key;
    }
    return '';
  }

  /**
   * @param {string} sessionId
   * @param {string} ownerSessionId
   * @param {{ workspaceFile?: string, cwd?: string }} [scope]
   */
  requireSession(sessionId, ownerSessionId, scope = {}) {
    const session = this.sessions.get(String(sessionId || ''));
    if (!session) throw new BrowserError('not-found', 'Browser session not found', 404);
    if (!ownerSessionId || session.ownerSessionId !== ownerSessionId) {
      throw new BrowserError('forbidden-owner', 'Browser session belongs to another Cretli session', 403);
    }
    // A session is always bound to one workspace key; a request without a scope
    // cannot touch it, and a request from another workspace is rejected.
    const sessionKey = String(session.workspaceKey || '').trim();
    const reqKey = this.resolveWorkspaceKey(scope);
    if (sessionKey) {
      if (!reqKey) {
        throw new BrowserError('forbidden-workspace', 'Browser session requires an explicit workspace scope', 403);
      }
      if (reqKey !== sessionKey) {
        throw new BrowserError('forbidden-workspace', 'Browser session belongs to another workspace', 403);
      }
    } else if (reqKey) {
      throw new BrowserError('forbidden-workspace', 'Browser session has no workspace scope to match', 403);
    }
    return session;
  }

  /**
   * @param {string} sessionId
   * @param {string} ownerSessionId
   * @param {{ workspaceFile?: string, cwd?: string }} [scope]
   * @returns {any}
   */
  requireTab(sessionId, tabId, ownerSessionId, scope = {}) {
    const session = this.requireSession(sessionId, ownerSessionId, scope);
    const tab = session.tabs.get(String(tabId || ''));
    if (!tab) throw new BrowserError('tab-not-found', 'Browser tab not found', 404);
    return { session, tab };
  }

  /**
   * Public entry point. Validates the owner, then serializes creation per owner
   * so two concurrent calls cannot both pass the MAX_SESSIONS_PER_OWNER capacity
   * check before either commits its session. The heavy lifting runs in
   * `_createSessionLocked`, one owner at a time.
   * @param {{ ownerSessionId?: string, workspaceFile?: string, cwd?: string }} input
   */
  async createSession(input) {
    if (!this.driver) {
      throw new BrowserError('browser-unavailable', this.driverStatus.reason || 'Browser runtime unavailable', 503);
    }
    const ownerSessionId = String(input?.ownerSessionId || '').trim();
    if (!ownerSessionId) throw new BrowserError('invalid-owner', 'Missing Cretli session id', 401);
    if (this.multiInstanceGuard) this.multiInstanceGuard();
    const previous = this.createChains.get(ownerSessionId) || Promise.resolve();
    const next = previous.then(() => this._createSessionLocked(input), () => this._createSessionLocked(input));
    // Keep the chain alive regardless of the outcome (a rejected creation must
    // not poison later ones), then drop the entry once this call is the tail so
    // the map cannot grow unbounded.
    const tail = next.then(() => undefined, () => undefined);
    this.createChains.set(ownerSessionId, tail);
    void tail.then(() => {
      if (this.createChains.get(ownerSessionId) === tail) this.createChains.delete(ownerSessionId);
    });
    return next;
  }

  /**
   * @param {{
   *   ownerSessionId: string,
   *   workspaceFile?: string,
   *   workspaceFolder?: string,
   *   cwd?: string,
   *   chatId?: string,
   *   viewport?: { width?: number, height?: number, dpr?: number, hasTouch?: boolean },
   * }} input
   */
  async _createSessionLocked(input) {
    if (!this.driver) {
      throw new BrowserError('browser-unavailable', this.driverStatus.reason || 'Browser runtime unavailable', 503);
    }
    const ownerSessionId = String(input?.ownerSessionId || '').trim();
    if (!ownerSessionId) throw new BrowserError('invalid-owner', 'Missing Cretli session id', 401);
    const workspaceKey = this.resolveWorkspaceKey(input);
    if (!workspaceKey) {
      throw new BrowserError(
        'no-workspace',
        'A Browser session requires an explicit workspace (workspaceFile or cwd)',
        400,
      );
    }

    // A `required` boundary must not launch Chromium behind a proxy that does
    // not answer; `proxy` warns but continues, and mvp never probes. Runs before
    // the first Chromium launch so a dead proxy cannot leave an orphan process.
    await this._ensureProxyHealth();

    const owned = [...this.sessions.values()].filter((session) => session.ownerSessionId === ownerSessionId);
    if (owned.length >= this.limits.MAX_SESSIONS_PER_OWNER) {
      throw new BrowserError(
        'session-limit',
        `Maximum ${this.limits.MAX_SESSIONS_PER_OWNER} active Browser sessions per user/instance`,
        409,
      );
    }

    // Deployment-wide ceiling: a single workspace must not be able to pin every
    // Chromium process the host can hold.
    const maxSessionsGlobal = this.lifecycleLimits?.maxSessionsGlobal;
    if (Number.isInteger(maxSessionsGlobal) && maxSessionsGlobal > 0 && this.sessions.size >= maxSessionsGlobal) {
      throw new BrowserError(
        'global-session-limit',
        `Maximum ${maxSessionsGlobal} active Browser sessions across all workspaces`,
        409,
      );
    }
    // Per-workspace ceiling: the limiter cannot be sidestepped by opening many
    // owner sessions inside one workspace.
    const maxSessionsPerWorkspace = this.lifecycleLimits?.maxSessionsPerWorkspace;
    if (Number.isInteger(maxSessionsPerWorkspace) && maxSessionsPerWorkspace > 0) {
      const workspaceSessions = [...this.sessions.values()]
        .filter((session) => session.workspaceKey === workspaceKey).length;
      if (workspaceSessions >= maxSessionsPerWorkspace) {
        throw new BrowserError(
          'workspace-session-limit',
          `Maximum ${maxSessionsPerWorkspace} active Browser sessions per workspace`,
          409,
        );
      }
    }

    // A session may be created already bound to a chat (agent tools). Register
    // the reverse binding here so a later lookup finds the same session instead
    // of creating a second one and hitting the per-owner limit.
    const requestedChatId = String(input?.chatId || '').trim();
    if (requestedChatId) {
      const boundSessionId = this.chatBindings.get(requestedChatId);
      if (boundSessionId && this.sessions.has(boundSessionId)) {
        throw new BrowserError('chat-bind-conflict', 'Chat is already bound to another Browser session', 409);
      }
      if (boundSessionId) this.chatBindings.delete(requestedChatId);
    }

    // Defense in depth only: map allowlisted hostnames to the IPv4 addresses
    // validated here and make Chromium default-deny every other hostname. This
    // narrows (but does not close) the DNS-rebinding window; the per-request
    // route policy that re-checks every request and redirect hop is the
    // enforced boundary.
    let hostResolverArgs = [];
    const dnsPins = new Map();
    const workspacePolicy = this.policyFor(workspaceKey);
    // HAR is opt-in: either an explicit per-session `recordHar` or the persisted
    // per-workspace policy flag. Default off, and absent capability still wins.
    const recordHar = input?.recordHar === true || workspacePolicy.recordHar === true;
    try {
      const { rules, pins } = await buildHostResolverRules({
        policy: workspacePolicy,
        blockedOrigins: this.selfOrigins,
        lookup: this.lookup,
      });
      if (rules.length > 0) hostResolverArgs = [`--host-resolver-rules=${rules.join(',')}`];
      for (const [host, addresses] of Object.entries(pins || {})) {
        if (Array.isArray(addresses) && addresses.length > 0) {
          dnsPins.set(host, new Set(addresses.map((address) => normalizeHostname(address))));
        }
      }
    } catch {
      hostResolverArgs = [];
    }

    let browser;
    try {
      // The driver decides on --no-sandbox from its explicit opt-in; the manager
      // never weakens the sandbox on its own.
      browser = await this.driver.launch({ args: hostResolverArgs });
    } catch (err) {
      try {
        this.metrics?.recordSessionError(workspaceKey, err?.code || 'launch-failed');
      } catch {
        // metrics must never replace the launch error
      }
      const sandbox = this.driverStatus.sandboxWarning ? ` ${this.driverStatus.sandboxWarning}` : '';
      throw new BrowserError(
        'browser-unavailable',
        `Could not launch Chromium: ${err?.message || String(err)}.${sandbox}`,
        503,
      );
    }

    const viewport = this.normalizeViewport(input?.viewport);
    // Consent is checked here, not at save time only: without an explicit
    // opt-in the context never receives a persisted state and stays ephemeral.
    const persistedStorageState = this.sessionStorageState(workspaceKey);
    let context;
    try {
      context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: viewport.dpr,
        hasTouch: viewport.hasTouch,
        isMobile: viewport.hasTouch,
        acceptDownloads: false,
        ignoreHTTPSErrors: workspacePolicy.allowInsecureTls === true,
        // No `extraHTTPHeaders` here on purpose: the local-login token is a
        // passwordless credential, and a context-wide header would be sent to
        // every origin this session is allowed to reach. It is attached per
        // request in `handleRoute`, only when the hop targets Cretli's origin.

        // A Service Worker would bypass context.route(), so the SSRF policy
        // could not see its requests. Block them for the whole MVP.
        serviceWorkers: 'block',
        // Only present with per-workspace consent; a decrypted payload never
        // leaves the session manager.
        ...(persistedStorageState ? { storageState: persistedStorageState } : {}),
      });
    } catch (err) {
      await this.safeCloseBrowser(browser);
      throw new BrowserError('browser-unavailable', `Could not create Browser context: ${err?.message || String(err)}`, 503);
    }

    const session = {
      id: randomUUID(),
      ownerSessionId,
      workspaceKey,
      workspaceFile: String(input.workspaceFile || ''),
      workspaceFolder: String(input.workspaceFolder || ''),
      cwd: String(input.cwd || ''),
      chatId: String(input.chatId || ''),
      createdAt: this.now(),
      lastActivityAt: this.now(),
      browser,
      context,
      viewport,
      // Whether this context may write its storage back. Consent is the gate
      // (not a previously persisted payload), so the first consented session
      // bootstraps the store; an unconsented session stays ephemeral.
      storageStateActive: this.sessionStorageConsented(workspaceKey),
      tabs: new Map(),
      pageTabs: new WeakMap(),
      activeTabId: null,
      closing: false,
      idleTimer: null,
      processId: this.driver?.getProcessId?.(browser) ?? null,
      dnsPins,
      hostResolverArgs,
    };
    this.sessions.set(session.id, session);
    if (session.chatId) this.chatBindings.set(session.chatId, session.id);
    // Attached after the id exists so the HAR file can be named per session.
    session.har = this.buildHarRecorder(session, recordHar);
    // Registration succeeded: count the session, remember its Chromium root PID
    // for the next process's orphan sweep and hook the crash signal.
    session.rootPid = this.processIdFor(session);
    this._registerPid(session);
    try {
      this.metrics?.recordSessionStart(workspaceKey, this.now());
    } catch {
      // metrics must never break session creation
    }
    if (browser && typeof browser.on === 'function') {
      try {
        browser.on('disconnected', () => {
          if (session.closing) return;
          void this.handleDriverCrash('chromium-disconnected', session).catch(() => {});
        });
      } catch {
        // A driver without a usable event emitter must not break creation.
      }
    }

    await this.installRoutePolicy(session);
    this.attachContextEvents(session);
    try {
      await this.createTab(session.id, ownerSessionId, {}, {
        internal: true,
        scope: { workspaceFile: session.workspaceFile, cwd: session.cwd },
      });
    } catch (err) {
      await this.closeSession(session.id, ownerSessionId, { reason: 'init-failed' });
      throw err;
    }

    this.touch(session);
    return this.summarizeSession(session);
  }

  /**
   * @param {{ width?: number, height?: number, dpr?: number, hasTouch?: boolean }|null|undefined} raw
   */
  normalizeViewport(raw) {
    const fallback = this.limits.DEFAULT_VIEWPORT;
    return {
      width: Math.round(clampNumber(raw?.width, this.limits.MIN_VIEWPORT.width, this.limits.MAX_VIEWPORT.width, fallback.width)),
      height: Math.round(clampNumber(raw?.height, this.limits.MIN_VIEWPORT.height, this.limits.MAX_VIEWPORT.height, fallback.height)),
      dpr: clampNumber(raw?.dpr, 1, this.limits.MAX_DPR, fallback.dpr),
      hasTouch: raw?.hasTouch === undefined ? fallback.hasTouch : raw.hasTouch === true,
    };
  }

  /**
   * Installs the per-request SSRF policy on the session context.
   * The allowlist is re-read per request so a workspace policy update applies
   * to the running session without a restart.
   *
   * Every request — navigation, subresource, XHR, redirect hop — is fetched with
   * `maxRedirects: 0` and redirects are followed manually so each hop is
   * checked. Playwright/Chromium does not re-invoke `route` for server
   * redirects (the network stack follows them internally), so relying on
   * `route.continue()` alone would leave a redirect-to-metadata SSRF hole for
   * subresources as well as top-level navigations.
   * @param {any} session
   */
  async installRoutePolicy(session) {
    await session.context.route('**/*', async (route, request) => {
      // Re-evaluate on every single request: the policy is read fresh and DNS
      // answers are pinned per hostname for the lifetime of the session.
      const evaluate = (targetUrl) => this.evaluateRequestPolicy(session, targetUrl);
      await this.handleRoute(session, route, request, evaluate);
    });
  }

  /**
   * True when a fetch hop targets one of Cretli's own origins.
   * `selfOrigins` is normalized in the constructor, so a plain `includes` is
   * enough here.
   * @param {string} origin
   * @returns {boolean}
   */
  targetsSelfOrigin(origin) {
    return Boolean(origin) && this.selfOrigins.includes(origin);
  }

  /**
   * Header set for a hop toward Cretli's own origin: the headers we already
   * decided to send, plus the local-login token.
   *
   * The token logs the built-in Browser in without a password, so it is a
   * credential and may only ever leave toward Cretli's own origin — never to an
   * allowlisted third-party site, a subresource or a foreign redirect hop. The
   * set is built explicitly rather than relying on undocumented `route.fetch`
   * header-merge semantics, and `baseHeaders` may be null when the intercepted
   * request exposes no `headers()`.
   * @param {Record<string, string>|null|undefined} baseHeaders
   * @returns {Record<string, string>}
   */
  localLoginHeaders(baseHeaders) {
    return { ...(baseHeaders || {}), [LOCAL_LOGIN_HEADER]: getLocalLoginToken() };
  }

  /**
   * Manually follows a request (and its redirects) through the URL policy.
   * Every hop is checked before it is fetched; a blocked hop aborts the route.
   * Applies to navigation and subresources alike because Playwright does not
   * expose server redirects to route handlers.
   * @param {any} session
   * @param {any} route
   * @param {any} request
   * @param {(url: string) => Promise<{ allowed: boolean, code?: string, reason?: string }>} evaluate
   */
  async handleRoute(session, route, request, evaluate) {
    const maxRedirects = Number.isInteger(this.limits.MAX_REDIRECTS) && this.limits.MAX_REDIRECTS > 0
      ? this.limits.MAX_REDIRECTS
      : 10;
    let currentUrl = request.url();
    let method = String(request.method?.() || 'GET').toUpperCase();
    // The original request origin: a redirect that leaves it must not carry the
    // original credentials. Captured once so every hop is compared to the first.
    const originalOrigin = parseHttpUrl(currentUrl)?.origin || '';
    let baseHeaders = null;
    try {
      baseHeaders = typeof request.headers === 'function' ? request.headers() : null;
    } catch {
      baseHeaders = null;
    }
    let postData;
    try {
      postData = typeof request.postDataBuffer === 'function' ? request.postDataBuffer() : undefined;
    } catch {
      postData = undefined;
    }
    let hops = 0;
    try {
      let decision = await evaluate(currentUrl);
      if (!decision.allowed) {
        this.recordBlockedRequest(session, request, decision, currentUrl);
        await route.abort('blockedbyclient');
        return;
      }
      // The first hop reuses the original request, but never forwards a body
      // for GET/HEAD. Some Playwright/Chromium combinations expose an empty
      // navigation body as the literal JSON value `null`; omitting postData
      // when replaying the request can send that value to Express and make its
      // json parser reject an otherwise normal GET with 400.
      const firstFetchOptions = {
        maxRedirects: 0,
        method,
        postData: method === 'GET' || method === 'HEAD' ? '' : postData,
      };
      // A first hop toward Cretli's own origin is the preview case and needs the
      // token; any other first hop gets no `headers` key at all so the original
      // request is replayed untouched.
      if (this.targetsSelfOrigin(originalOrigin)) {
        firstFetchOptions.headers = this.localLoginHeaders(baseHeaders);
      }
      let response = await route.fetch(firstFetchOptions);
      while (response.status() >= 300 && response.status() < 400 && hops < maxRedirects) {
        const location = response.headers()?.location;
        if (!location) break;
        let target;
        try {
          target = new URL(location, currentUrl).toString();
        } catch {
          break;
        }
        decision = await evaluate(target);
        if (!decision.allowed) {
          this.recordBlockedRequest(session, request, decision, target);
          await route.abort('blockedbyclient');
          return;
        }
        const status = response.status();
        // 303 (and the common 301/302 POST case) degrade to GET; 307/308 keep
        // the method and body.
        if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
          method = 'GET';
          postData = undefined;
        }
        currentUrl = target;
        hops += 1;
        const fetchOptions = {
          url: currentUrl,
          maxRedirects: 0,
          method,
          ...(postData !== undefined ? { postData } : {}),
        };
        const targetOrigin = parseHttpUrl(currentUrl)?.origin || '';
        if (targetOrigin && originalOrigin && targetOrigin !== originalOrigin) {
          // Cross-origin redirect: `route.fetch` would otherwise replay the
          // original Cookie/Authorization to the new origin. Strip them.
          fetchOptions.headers = buildCrossOriginHeaders(baseHeaders);
        }
        // After the strip, never before: a redirect that lands on Cretli's own
        // origin still has to authenticate, while one that leaves it must not
        // take the credential along.
        if (this.targetsSelfOrigin(targetOrigin)) {
          fetchOptions.headers = this.localLoginHeaders(fetchOptions.headers || baseHeaders);
        }
        response = await route.fetch(fetchOptions);
      }
      if (response.status() >= 300 && response.status() < 400 && hops >= maxRedirects) {
        // Never hand an unchecked redirect chain back to the browser.
        this.recordBlockedRequest(
          session,
          request,
          { code: 'too-many-redirects', reason: 'Too many redirects' },
          currentUrl,
        );
        await route.abort('failed');
        return;
      }
      await route.fulfill({ response });
    } catch {
      // Fail closed for anything we could not policy-check; never continue to an
      // unchecked URL.
      try {
        await route.abort('failed');
      } catch {
        // route may already be handled
      }
    }
  }

  /**
   * @param {any} session
   * @param {any} request
   * @param {{ code?: string, reason?: string }} decision
   * @param {string} [blockedUrl] - Overrides the URL recorded in the buffer (redirect target).
   */
  recordBlockedRequest(session, request, decision, blockedUrl) {
    let requestPage = null;
    try {
      requestPage = request.frame?.()?.page?.() || null;
    } catch {
      requestPage = null;
    }
    const tab = (requestPage && session.pageTabs?.get(requestPage))
      || session.tabs.get(session.activeTabId)
      || [...session.tabs.values()][0];
    if (!tab) return;
    const blockedReason = String(decision?.code || 'blocked');
    // `page.on('request')` has usually already stored a row for this request and
    // keyed it in `tab.requestIds` (a WeakMap on the request object). Inserting a
    // second row here duplicated every blocked request in the Network buffer, so
    // the existing row is patched instead and only a never-seen request is new.
    const knownRequestId = typeof tab.requestIds?.get === 'function' ? tab.requestIds.get(request) : null;
    if (knownRequestId) {
      tab.network.update(knownRequestId, {
        blocked: true,
        blockedReason,
        ...(blockedUrl ? { blockedUrl: redactUrl(blockedUrl) } : {}),
      });
    } else {
      const { requestId } = tab.network.recordRequest({
        method: request.method?.() || 'GET',
        url: blockedUrl || request.url?.() || '',
        resourceType: request.resourceType?.() || 'other',
        at: this.now(),
      });
      tab.network.update(requestId, {
        blocked: true,
        blockedReason,
      });
    }
    // Chromium can hang a top-level navigation after a blocked redirect, so
    // fail the pending navigate() immediately instead of waiting for a timeout.
    let isNavigation = false;
    try {
      isNavigation = request.isNavigationRequest?.() === true;
    } catch {
      isNavigation = false;
    }
    if (isNavigation && typeof tab.navigationAbort === 'function') {
      tab.navigationAbort(decision?.reason || decision?.code || 'blocked');
    }
  }

  /**
   * @param {any} session
   */
  attachContextEvents(session) {
    session.context.on?.('page', (page) => {
      // Popups are mapped to tabs when capacity allows; otherwise closed.
      if (session.tabs.size >= this.limits.MAX_TABS_PER_SESSION) {
        Promise.resolve(page.close()).catch(() => {});
        return;
      }
      this.attachPage(session, page, { isPopup: true });
    });
  }

  /**
   * Registers a Playwright page as a tab. Returns `null` when the page must not
   * become a tab: an already closed page would be permanently unusable, and the
   * capacity check here is the single choke point every path (createTab and
   * popups) passes through, so the limit cannot be raced.
   * @param {any} session
   * @param {any} page
   * @param {{ isPopup?: boolean }} [options]
   */
  attachPage(session, page, options = {}) {
    if (!page) return null;
    let closed = false;
    try {
      closed = typeof page.isClosed === 'function' ? page.isClosed() === true : false;
    } catch {
      closed = true;
    }
    if (closed) {
      // A closed page has no target: registering it would hand out a tab id that
      // fails on every later read, screenshot or input.
      return null;
    }
    const existing = session.pageTabs?.get(page);
    if (existing) return existing;
    if (session.tabs.size >= this.limits.MAX_TABS_PER_SESSION) {
      Promise.resolve(page.close?.()).catch(() => {});
      return null;
    }
    const tabId = randomUUID();
    const tab = {
      id: tabId,
      page,
      createdAt: this.now(),
      lastActivityAt: this.now(),
      lastScreenshotAt: 0,
      lastInputAt: 0,
      screenshotInFlight: false,
      /** Serializes input operations for this tab (REST and WS share it). */
      inputChain: Promise.resolve(),
      cdpSession: null,
      /**
       * Dedicated CDP session for the debugger namespace. Intentionally not
       * `cdpSession` (screencast / navigation history) so reload and screencast
       * teardown do not drop debugger listeners or leave the page paused.
       * @type {any}
       */
      debuggerCdpSession: null,
      /**
       * Live screencast state while this tab is streaming, else null. Created by
       * `startScreencast()` and always cleared by `stopScreencast()` so a stream
       * can never outlive the CDP session it rides on.
       * @type {any}
       */
      screencast: null,
      isPopup: options.isPopup === true,
      console: new ConsoleBuffer(),
      network: new NetworkBuffer(),
      dialogs: new DialogBuffer(),
      /**
       * dialogId -> { dialog, timer }. A native dialog blocks the page's own
       * JavaScript until it is resolved, so every pending entry also carries the
       * bounded auto-dismiss timer documented on `DIALOG_AUTO_DISMISS_MS`:
       * an unwatched page is never left hanging on a dialog forever, while a
       * watcher still gets the window to answer it.
       * @type {Map<string, { dialog: any, timer: any }>}
       */
      pendingDialogs: new Map(),
      requestIds: new WeakMap(),
      userAgent: '',
      title: '',
      url: '',
      /** Set while a navigation awaits; lets the route policy fail fast on a blocked redirect. */
      navigationAbort: null,
    };
    session.tabs.set(tabId, tab);
    session.pageTabs?.set(page, tab);
    if (!session.activeTabId) session.activeTabId = tabId;
    try {
      this.metrics?.recordTabOpen(session.workspaceKey, this.now());
    } catch {
      // metrics must never break tab creation
    }

    page.on?.('console', (message) => {
      try {
        tab.console.pushConsole({
          level: typeof message.type === 'function' ? message.type() : 'log',
          text: typeof message.text === 'function' ? message.text() : '',
          location: typeof message.location === 'function' ? JSON.stringify(message.location()) : '',
          at: this.now(),
        });
      } catch {
        // ignore console serialization errors
      }
    });
    page.on?.('pageerror', (error) => {
      tab.console.pushPageError({
        message: error?.message || String(error),
        stack: error?.stack || '',
        at: this.now(),
      });
    });
    page.on?.('request', (request) => {
      const requestId = randomUUID();
      tab.requestIds.set(request, requestId);
      const method = request.method?.() || 'GET';
      const url = request.url?.() || '';
      const resourceType = request.resourceType?.() || 'other';
      tab.network.recordRequest({
        requestId,
        method,
        url,
        resourceType,
        at: this.now(),
      });
      // Opt-in only: redacted HAR capture (URL, headers, body) never raises.
      if (session.har) {
        session.har.recordRequest({
          requestId,
          method,
          url,
          resourceType,
          headers: safeRead(() => request.headers?.(), {}),
          postData: safeRead(() => request.postData?.(), null),
          at: this.now(),
        });
      }
    });
    page.on?.('response', (response) => {
      const request = response.request?.();
      const requestId = request ? tab.requestIds.get(request) : null;
      if (!requestId) return;
      const status = response.status?.();
      const ok = response.ok?.();
      const at = this.now();
      tab.network.recordResponse(requestId, { status, ok, at });
      // Response bodies are never read; only status/headers metadata is stored.
      if (session.har) {
        session.har.recordResponse(requestId, {
          status,
          statusText: safeRead(() => response.statusText?.(), ''),
          headers: safeRead(() => response.headers?.(), {}),
          mimeType: safeRead(() => response.headers?.()?.['content-type'], ''),
          at,
        });
      }
    });
    page.on?.('requestfailed', (request) => {
      const requestId = tab.requestIds.get(request);
      if (!requestId) return;
      const errorText = request.failure?.()?.errorText || 'request failed';
      const at = this.now();
      tab.network.recordFailure(requestId, { errorText, at });
      if (session.har) session.har.recordFailure(requestId, { errorText, at });
    });
    page.on?.('dialog', (dialog) => {
      this.bufferDialog(session, tab, dialog);
    });
    page.on?.('download', (download) => {
      tab.console.pushConsole({
        level: 'warning',
        text: `Download blocked in MVP: ${download?.suggestedFilename?.() || 'file'}`,
      });
      Promise.resolve(download.cancel?.()).catch(() => {});
    });
    page.on?.('framenavigated', (frame) => {
      try {
        if (frame === page.mainFrame?.()) {
          tab.url = frame.url?.() || tab.url;
          void this.resetDebuggerForMainFrameNavigation(tab);
        }
      } catch {
        // ignore
      }
    });
    page.on?.('close', () => {
      this.clearPendingDialogs(tab, 'page-closed');
      void this.detachDebuggerForTab(tab);
      if (session.closing) return;
      session.tabs.delete(tabId);
      if (session.activeTabId === tabId) {
        session.activeTabId = session.tabs.size > 0 ? [...session.tabs.keys()][0] : null;
      }
    });

    return tab;
  }

  /**
   * Records a JavaScript dialog instead of dismissing it, so `confirm()` and
   * `prompt()` can be answered by a watcher. The page's own script stays blocked
   * until the dialog is resolved, which is why the entry is bounded: after
   * `DIALOG_AUTO_DISMISS_MS` with no answer it is dismissed automatically, so a
   * session nobody is watching cannot hang on a native dialog forever. The
   * buffered row survives either way, with `action` saying how it ended.
   * @param {any} session
   * @param {any} tab
   * @param {any} dialog
   */
  bufferDialog(session, tab, dialog) {
    let stored = null;
    try {
      stored = tab.dialogs.pushDialog({
        type: typeof dialog?.type === 'function' ? dialog.type() : '',
        message: typeof dialog?.message === 'function' ? dialog.message() : '',
        defaultValue: typeof dialog?.defaultValue === 'function' ? dialog.defaultValue() : '',
        at: this.now(),
      });
    } catch {
      Promise.resolve(dialog?.dismiss?.()).catch(() => {});
      return null;
    }
    const dialogId = stored.dialogId;
    const timeout = Number.isFinite(this.limits.DIALOG_AUTO_DISMISS_MS)
      && Number(this.limits.DIALOG_AUTO_DISMISS_MS) > 0
      ? Number(this.limits.DIALOG_AUTO_DISMISS_MS)
      : BROWSER_LIMITS.DIALOG_AUTO_DISMISS_MS;
    let timer = null;
    try {
      timer = this.setTimeoutFn(() => {
        void this.resolveDialog(tab, dialogId, { action: 'dismiss', reason: 'timeout' }).catch(() => {});
      }, timeout);
    } catch {
      timer = null;
    }
    if (timer && typeof timer.unref === 'function') {
      // The bounded auto-dismiss must not keep a shutting-down process alive.
      timer.unref();
    }
    tab.pendingDialogs.set(dialogId, { dialog, timer });
    this.touch(session);
    return stored;
  }

  /**
   * Answers one pending dialog and marks its buffered row.
   * @param {any} tab
   * @param {string} dialogId
   * @param {{ action?: string, promptText?: string, reason?: string }} input
   * @returns {Promise<{ ok: boolean, error: string }|null>} null when the id is
   *   not pending (already answered, timed out, or never existed).
   */
  async resolveDialog(tab, dialogId, input = {}) {
    const id = String(dialogId || '');
    const pending = tab?.pendingDialogs?.get(id);
    if (!pending) return null;
    tab.pendingDialogs.delete(id);
    if (pending.timer) {
      try {
        this.clearTimeoutFn(pending.timer);
      } catch {
        // ignore
      }
    }
    const action = input.action === 'accept' ? 'accept' : 'dismiss';
    let error = '';
    try {
      if (action === 'accept') {
        const text = typeof input.promptText === 'string' ? input.promptText : undefined;
        await Promise.resolve(text === undefined ? pending.dialog?.accept?.() : pending.dialog?.accept?.(text));
      } else {
        await Promise.resolve(pending.dialog?.dismiss?.());
      }
    } catch (err) {
      // The page can dismiss its own dialog first; the buffered row still has to
      // say the dialog is gone rather than stay pending forever.
      error = String(err?.message || err);
    }
    const reason = String(input.reason || '');
    tab.dialogs.mark(id, {
      handled: true,
      action: reason === 'timeout' ? 'timed-out' : action,
      resolvedAt: this.now(),
    });
    return { ok: !error, error };
  }

  /**
   * Drops every pending dialog for a tab (tab closed, page closed, session
   * closing) so no timer can later answer a dialog that no longer exists.
   * @param {any} tab
   * @param {string} reason
   */
  clearPendingDialogs(tab, reason = 'closed') {
    if (!tab?.pendingDialogs) return;
    for (const id of [...tab.pendingDialogs.keys()]) {
      void this.resolveDialog(tab, id, { action: 'dismiss', reason }).catch(() => {});
    }
    tab.pendingDialogs.clear();
  }

  /**
   * @param {string} sessionId
   * @param {string} ownerSessionId
   * @param {{ url?: string, activate?: boolean }} [input]
   * @param {{ internal?: boolean, scope?: object }} [options]
   */
  async createTab(sessionId, ownerSessionId, input = {}, options = {}) {
    const session = this.requireSession(sessionId, ownerSessionId, options.scope || {});
    if (session.tabs.size >= this.limits.MAX_TABS_PER_SESSION) {
      throw new BrowserError(
        'tab-limit',
        `Maximum ${this.limits.MAX_TABS_PER_SESSION} tabs per Browser session`,
        409,
      );
    }
    // Same serialization as `createSession`: the capacity check, `newPage()` and
    // `attachPage()` must not interleave, or two parallel callers both pass the
    // check and the session ends up over MAX_TABS_PER_SESSION.
    const previous = this.tabChains.get(session.id) || Promise.resolve();
    const create = () => this._createTabLocked(session, input, ownerSessionId, options);
    const next = previous.then(create, create);
    const tail = next.then(() => undefined, () => undefined);
    this.tabChains.set(session.id, tail);
    void tail.then(() => {
      if (this.tabChains.get(session.id) === tail) this.tabChains.delete(session.id);
    });
    return next;
  }

  /**
   * @param {any} session
   * @param {{ url?: string, activate?: boolean }} input
   * @param {string} ownerSessionId
   * @param {{ internal?: boolean, scope?: object }} options
   */
  async _createTabLocked(session, input, ownerSessionId, options) {
    const page = await session.context.newPage();
    const tab = this.attachPage(session, page);
    if (!tab) {
      let closed = false;
      try {
        closed = typeof page.isClosed === 'function' ? page.isClosed() === true : false;
      } catch {
        closed = true;
      }
      if (closed) {
        throw new BrowserError('page-closed', 'The new tab closed before it could be registered', 502);
      }
      // A popup took the last free slot while `newPage()` was in flight.
      throw new BrowserError(
        'tab-limit',
        `Maximum ${this.limits.MAX_TABS_PER_SESSION} tabs per Browser session`,
        409,
      );
    }
    if (input.activate !== false) session.activeTabId = tab.id;
    if (input.url) {
      await this.navigate(session.id, tab.id, input.url, ownerSessionId, options.scope || {});
    }
    this.touch(session);
    if (options.internal) return tab;
    return this.summarizeTab(session, tab);
  }

  /**
   * @param {string} sessionId
   * @param {string} ownerSessionId
   * @param {{ workspaceFile?: string, cwd?: string }} [scope]
   */
  listTabs(sessionId, ownerSessionId, scope = {}) {
    const session = this.requireSession(sessionId, ownerSessionId, scope);
    // Listing is activity: a panel that only watches the tab strip must not look
    // idle to `sweepIdle()` and lose the preview it is showing.
    this.touch(session);
    return [...session.tabs.values()].map((tab) => this.summarizeTab(session, tab));
  }

  /**
   * @param {string} sessionId
   * @param {string} tabId
   * @param {string} ownerSessionId
   * @param {{ workspaceFile?: string, cwd?: string }} [scope]
   */
  selectTab(sessionId, tabId, ownerSessionId, scope = {}) {
    const { session, tab } = this.requireTab(sessionId, tabId, ownerSessionId, scope);
    session.activeTabId = tab.id;
    this.touch(session);
    return this.summarizeTab(session, tab);
  }

  /**
   * @param {string} sessionId
   * @param {string} tabId
   * @param {string} ownerSessionId
   * @param {{ workspaceFile?: string, cwd?: string }} [scope]
   */
  async closeTab(sessionId, tabId, ownerSessionId, scope = {}) {
    const { session, tab } = this.requireTab(sessionId, tabId, ownerSessionId, scope);
    session.tabs.delete(tab.id);
    tab.console.clear();
    tab.network.clear();
    this.clearPendingDialogs(tab, 'tab-closed');
    tab.dialogs?.clear?.();
    await this.detachCdpSession(tab);
    if (session.activeTabId === tab.id) {
      session.activeTabId = session.tabs.size > 0 ? [...session.tabs.keys()][0] : null;
    }
    try {
      await tab.page.close();
    } catch {
      // page may already be closed
    }
    this.touch(session);
    return { closedTabId: tabId, activeTabId: session.activeTabId };
  }

  /**
   * @param {string} sessionId
   * @param {string} tabId
   * @param {unknown} rawUrl
   * @param {string} ownerSessionId
   * @param {{ workspaceFile?: string, cwd?: string }} [scope]
   * @param {{ waitUntil?: string }} [options] optional navigation wait state;
   *   validated against a closed allowlist, default `domcontentloaded`.
   */
  async navigate(sessionId, tabId, rawUrl, ownerSessionId, scope = {}, options = {}) {
    const { session, tab } = this.requireTab(sessionId, tabId, ownerSessionId, scope);
    // Normalize once and reuse the result for the policy *and* `page.goto`:
    // a bare host typed into the panel (`example.com`) is otherwise allowlisted
    // as `https://example.com` and then handed to Chromium without a scheme,
    // which `goto` rejects as an invalid URL.
    const url = normalizeNavigationUrl(rawUrl);
    if (!url) throw new BrowserError('invalid-url', 'Missing URL', 400);
    const waitUntil = normalizeWaitUntil(options?.waitUntil);

    const decision = await this.evaluateRequestPolicy(session, url);
    if (!decision.allowed) {
      throw new BrowserError('navigation-blocked', `Navigation blocked: ${decision.reason}`, 403);
    }
    let abortNavigation = null;
    const blockedDuringNavigation = new Promise((_, reject) => {
      abortNavigation = (reason) => reject(new BrowserError('navigation-blocked', `Navigation blocked: ${reason}`, 403));
    });
    tab.navigationAbort = abortNavigation;
    try {
      await Promise.race([
        tab.page.goto(url, { waitUntil, timeout: 30000 }),
        blockedDuringNavigation,
      ]);
    } catch (err) {
      if (err instanceof BrowserError) throw err;
      const message = err?.message || String(err);
      if (/ERR_BLOCKED_BY_CLIENT|blockedbyclient/i.test(message)) {
        throw new BrowserError('navigation-blocked', 'Navigation blocked by the URL policy', 403);
      }
      throw new BrowserError('navigation-failed', `Navigation failed: ${message}`, 502);
    } finally {
      tab.navigationAbort = null;
    }
    tab.lastActivityAt = this.now();
    this.touch(session);
    return this.getState(sessionId, tabId, ownerSessionId, scope);
  }

  /**
   * @param {string} sessionId
   * @param {string} tabId
   * @param {string} ownerSessionId
   * @param {'back'|'forward'|'reload'} action
   * @param {{ workspaceFile?: string, cwd?: string }} [scope]
   */
  async historyAction(sessionId, tabId, ownerSessionId, action, scope = {}) {
    const { session, tab } = this.requireTab(sessionId, tabId, ownerSessionId, scope);
    let abortNavigation = null;
    const blockedDuringNavigation = new Promise((_, reject) => {
      abortNavigation = (reason) => reject(new BrowserError('navigation-blocked', `Navigation blocked: ${reason}`, 403));
    });
    tab.navigationAbort = abortNavigation;
    try {
      const options = { waitUntil: 'domcontentloaded', timeout: 30000 };
      if (action === 'back') await Promise.race([tab.page.goBack(options), blockedDuringNavigation]);
      else if (action === 'forward') await Promise.race([tab.page.goForward(options), blockedDuringNavigation]);
      else await Promise.race([tab.page.reload(options), blockedDuringNavigation]);
    } catch (err) {
      if (err instanceof BrowserError) throw err;
      throw new BrowserError('navigation-failed', `Navigation failed: ${err?.message || String(err)}`, 502);
    } finally {
      tab.navigationAbort = null;
    }
    this.touch(session);
    return this.getState(sessionId, tabId, ownerSessionId, scope);
  }

  /**
   * Reads Chromium's real navigation-history state for a tab via a single CDP
   * `Page.getNavigationHistory` call. Playwright has no `canGoBack()` API, and
   * checking `typeof page.goBack === 'function'` is always true, so this is the
   * only honest source. Fails closed to {false,false} when CDP is unavailable.
   * @param {any} tab
   * @returns {Promise<{ canGoBack: boolean, canGoForward: boolean }>}
   */
  async readNavigationHistory(tab) {
    try {
      const page = tab?.page;
      const context = typeof page?.context === 'function' ? page.context() : null;
      if (!context || typeof context.newCDPSession !== 'function') {
        return { canGoBack: false, canGoForward: false };
      }
      if (!tab.cdpSession) tab.cdpSession = await context.newCDPSession(page);
      const history = await tab.cdpSession.send('Page.getNavigationHistory');
      const index = Number(history?.currentIndex);
      const count = Array.isArray(history?.entries) ? history.entries.length : 0;
      if (!Number.isInteger(index) || count <= 0) return { canGoBack: false, canGoForward: false };
      return { canGoBack: index > 0, canGoForward: index < count - 1 };
    } catch {
      // A CDP session goes stale when its target is destroyed. The reference has
      // to go with it, or every later read reuses the dead session and the panel
      // loses back/forward forever instead of recovering on the next call.
      void this.detachNavigationCdpSession(tab);
      return { canGoBack: false, canGoForward: false };
    }
  }

  /**
   * @param {string} sessionId
   * @param {string} tabId
   * @param {string} ownerSessionId
   * @param {{ workspaceFile?: string, cwd?: string }} [scope]
   */
  async getState(sessionId, tabId, ownerSessionId, scope = {}) {
    const { session, tab } = this.requireTab(sessionId, tabId, ownerSessionId, scope);
    let title = '';
    try {
      title = await tab.page.title();
    } catch {
      title = '';
    }
    const rawUrl = tab.url || (() => { try { return tab.page.url(); } catch { return ''; } })();
    const viewportSize = typeof tab.page.viewportSize === 'function' ? tab.page.viewportSize() : null;
    const history = await this.readNavigationHistory(tab);
    const pendingDialogs = typeof tab.dialogs?.pending === 'function'
      ? tab.dialogs.pending().map((row) => ({
        dialogId: row.dialogId,
        type: row.type,
        message: row.message,
        defaultValue: row.defaultValue,
        at: row.at,
      }))
      : [];
    // Reading the state keeps the preview honest, so it counts as activity: a
    // panel or agent that only polls state was otherwise swept as idle.
    this.touch(session);
    return {
      browserSessionId: session.id,
      browserTabId: tab.id,
      active: session.activeTabId === tab.id,
      url: redactUrl(rawUrl),
      title: redactText(title),
      viewport: viewportSize || { width: session.viewport.width, height: session.viewport.height },
      dpr: session.viewport.dpr,
      hasTouch: session.viewport.hasTouch,
      canGoBack: history.canGoBack,
      canGoForward: history.canGoForward,
      consoleCount: tab.console.entries.length,
      networkCount: tab.network.entries.length,
      // A page blocks its own script on a native dialog, so every read path has
      // to say one is open and hand back the id `browser_input` kind `dialog`
      // answers with.
      dialogCount: typeof tab.dialogs?.entries?.length === 'number' ? tab.dialogs.entries.length : pendingDialogs.length,
      pendingDialogCount: pendingDialogs.length,
      pendingDialogs,
      // Only present when a stream exists or the deployment enabled one. With the
      // flag off the state payload is exactly what pull-mode clients already parse.
      ...(this.screencasts.has(tab.id) || isExperimentalMode(this.screencastMode)
        ? { screencast: this.screencastStatus({ browserTabId: tab.id }) }
        : {}),
    };
  }

  /**
   * Returns a bounded, redacted HTML snapshot. This is intentionally a
   * read-only page.content() operation; browser_evaluate is not exposed.
   * @param {string} sessionId
   * @param {string} tabId
   * @param {string} ownerSessionId
   * @param {{ workspaceFile?: string, cwd?: string, maxBytes?: number }} [scope]
   */
  async getDom(sessionId, tabId, ownerSessionId, scope = {}) {
    const { session, tab } = this.requireTab(sessionId, tabId, ownerSessionId, scope);
    let html = '';
    try {
      html = typeof tab.page.content === 'function'
        ? await this.withReadTimeout(tab.page.content(), 'DOM read', 'dom-timeout')
        : '';
    } catch (err) {
      if (err instanceof BrowserError) throw err;
      throw new BrowserError('dom-failed', `DOM read failed: ${err?.message || String(err)}`, 502);
    }
    const withoutExecutableContent = String(html)
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/\s(?:on[a-z]+|srcdoc)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    const maxBytes = Math.min(256 * 1024, Math.max(1024, Number(scope.maxBytes) || 128 * 1024));
    // The budget is in UTF-8 bytes, so the cut must be too: slicing by
    // `String.slice` counts UTF-16 code units and let CJK/emoji payloads exceed
    // the advertised limit. The marker is paid for up front and `truncated`
    // comes from the byte comparison itself, never from the page's own HTML
    // happening to end with the same character.
    const capped = redactTextCapped(
      redactText(withoutExecutableContent),
      Math.max(1, maxBytes - DOM_TRUNCATION_MARKER_BYTES),
    );
    const data = capped.truncated ? `${capped.value}${DOM_TRUNCATION_MARKER}` : capped.value;
    this.touch(session);
    return {
      browserSessionId: session.id,
      browserTabId: tab.id,
      html: data,
      truncated: capped.truncated,
      bytes: Buffer.byteLength(data, 'utf8'),
    };
  }

  /**
   * Lists the visible interactive elements of a tab so an agent can act on them
   * by role/name/text instead of guessing screenshot coordinates. Playwright's
   * CSS engine pierces open shadow roots, so controls inside Lit components are
   * included. Read-only: it queries the DOM and never runs page script of its
   * own (only the fixed descriptor below, through one `locator.evaluateAll`).
   * @param {string} sessionId
   * @param {string} tabId
   * @param {string} ownerSessionId
   * @param {{ workspaceFile?: string, cwd?: string, limit?: number, maxText?: number }} [scope]
   */
  async getVisibleElements(sessionId, tabId, ownerSessionId, scope = {}) {
    const { session, tab } = this.requireTab(sessionId, tabId, ownerSessionId, scope);
    if (typeof tab.page?.locator !== 'function') {
      throw new BrowserError('elements-unavailable', 'Element inspection is not supported here', 501);
    }
    const limit = Math.round(clampNumber(scope.limit, 1, BROWSER_ELEMENTS_MAX_LIMIT, BROWSER_ELEMENTS_DEFAULT_LIMIT));
    const maxText = Math.round(clampNumber(scope.maxText, 20, 500, 120));
    const locator = tab.page.locator(BROWSER_ELEMENTS_SELECTOR);
    if (typeof locator.evaluateAll !== 'function') {
      // The single-pass scan is the only supported shape: the per-element
      // isVisible/boundingBox/evaluate loop it replaced cost three CDP round
      // trips per node (150 elements was ~1.65 s on a live page).
      throw new BrowserError('elements-unavailable', 'Element inspection is not supported here', 501);
    }
    let total = 0;
    try {
      total = await this.withReadTimeout(locator.count(), 'Element scan', 'elements-timeout');
    } catch (err) {
      if (err instanceof BrowserError) throw err;
      throw new BrowserError('elements-failed', `Element scan failed: ${err?.message || String(err)}`, 502);
    }
    // Bound the scan even when the page is huge: at most 4x the requested limit.
    const scanCap = Math.min(total, limit * 4, 1000);
    let rows = [];
    let scanned = 0;
    if (total > 0) {
      let report = null;
      try {
        report = await this.withReadTimeout(
          locator.evaluateAll(describePageElementsBatch, { maxText, cap: scanCap, limit }),
          'Element scan',
          'elements-timeout',
        );
      } catch (err) {
        if (err instanceof BrowserError) throw err;
        throw new BrowserError('elements-failed', `Element scan failed: ${err?.message || String(err)}`, 502);
      }
      scanned = Math.min(Number(report?.scanned) || 0, scanCap);
      rows = Array.isArray(report?.rows) ? report.rows : [];
    }
    const elements = [];
    for (const row of rows) {
      if (!row?.descriptor || !row.bounds) continue;
      elements.push({
        index: elements.length,
        ...row.descriptor,
        bounds: {
          x: Math.round(row.bounds.x),
          y: Math.round(row.bounds.y),
          width: Math.round(row.bounds.width),
          height: Math.round(row.bounds.height),
        },
      });
      if (elements.length >= limit) break;
    }
    this.touch(session);
    return {
      browserSessionId: session.id,
      browserTabId: tab.id,
      channel: 'elements',
      elements,
      count: elements.length,
      scanned,
      total,
      truncated: scanned < total,
    };
  }

  /**
   * @param {string} sessionId
   * @param {string} tabId
   * @param {string} ownerSessionId
   * @param {{ quality?: number, force?: boolean, workspaceFile?: string, cwd?: string }} [options]
   */
  async screenshot(sessionId, tabId, ownerSessionId, options = {}) {
    const { session, tab } = this.requireTab(sessionId, tabId, ownerSessionId, options);
    const now = this.now();
    // `force` is a hint for a user-driven refresh, never a rate-limit bypass:
    // forced frames are bounded by their own minimum interval and the same
    // in-flight guard as the WS channel.
    const minInterval = options.force
      ? (Number(this.limits.SCREENSHOT_FORCE_MIN_INTERVAL_MS) > 0
        ? Number(this.limits.SCREENSHOT_FORCE_MIN_INTERVAL_MS)
        : this.limits.SCREENSHOT_MIN_INTERVAL_MS)
      : this.limits.SCREENSHOT_MIN_INTERVAL_MS;
    if (now - tab.lastScreenshotAt < minInterval) {
      throw new BrowserError('rate-limited', `Screenshot mode is capped at ${this.limits.MAX_SCREENSHOT_FPS} frames/s`, 429);
    }
    if (tab.screenshotInFlight) {
      throw new BrowserError('screenshot-busy', 'A screenshot is already in progress for this tab', 429);
    }
    tab.screenshotInFlight = true;
    try {
      const quality = Math.round(clampNumber(options.quality, 10, 100, BROWSER_SCREENSHOT_QUALITY));
      let buffer;
      try {
        // `scale: 'css'` makes one image pixel equal one CSS pixel, the same
        // space `viewportSize()`/`mapPreviewPoint` use for clicks. Without it a
        // DPR=2 phone viewport returns a 2x image and an agent that reads pixel
        // coordinates from the frame misses every target by a factor of two.
        buffer = await tab.page.screenshot({ type: 'jpeg', quality, fullPage: false, scale: 'css' });
      } catch (err) {
        throw new BrowserError('screenshot-failed', `Screenshot failed: ${err?.message || String(err)}`, 502);
      }
      const bytes = Buffer.isBuffer(buffer) ? buffer.length : Buffer.byteLength(buffer);
      if (bytes > this.limits.MAX_SCREENSHOT_BYTES) {
        throw new BrowserError('screenshot-too-large', `Screenshot exceeds ${this.limits.MAX_SCREENSHOT_BYTES} bytes`, 413);
      }
      tab.lastScreenshotAt = now;
      this.touch(session);
      const viewportSize = typeof tab.page.viewportSize === 'function' ? tab.page.viewportSize() : null;
      return {
        browserSessionId: session.id,
        browserTabId: tab.id,
        mimeType: 'image/jpeg',
        quality,
        bytes,
        width: viewportSize?.width || session.viewport.width,
        height: viewportSize?.height || session.viewport.height,
        dpr: session.viewport.dpr,
        data: Buffer.isBuffer(buffer) ? buffer.toString('base64') : Buffer.from(buffer).toString('base64'),
        at: now,
      };
    } finally {
      tab.screenshotInFlight = false;
    }
  }

  /* --------------------------------------------------------------------- *
   * Experimental CDP screencast (`Page.startScreencast`)                  *
   *                                                                     *
   * The pull path above is untouched by any of this: with the flag off   *
   * `startScreencast()` answers `{ ok:false, reason:'mode-off' }` and the *
   * `/ws-browser` channel keeps its existing message sequence.           *
   * --------------------------------------------------------------------- */

  /**
   * Streaming status, safe to answer before any stream exists. This is the
   * client-visible half of the flag: `available` tells the panel whether it may
   * ask for binary frames, and `lastFallback` says why it must not right now.
   * @param {{ browserTabId?: string }} [forTab]
   */
  screencastStatus(forTab = {}) {
    const state = this.screencasts.get(String(forTab?.browserTabId || '')) || null;
    const last = this.screencastFallbacks[this.screencastFallbacks.length - 1] || null;
    return {
      mode: this.screencastMode,
      available: isExperimentalMode(this.screencastMode),
      running: state?.running === true,
      target: state?.gate ? state.gate.target() : null,
      applied: state?.applied || null,
      sinks: state ? state.sinks.size : 0,
      lastFallback: last,
      fallbackCount: this.screencastFallbacks.length,
      metrics: state?.metrics ? state.metrics.snapshot(this.now()) : null,
    };
  }

  /**
   * One entry per automatic switch back to the pull cycle. Bounded, newest last,
   * and always carries a reason, because a silent fallback is unmeasurable.
   * @param {string} tabId
   * @param {string} reason
   */
  noteScreencastFallback(tabId, reason) {
    const at = this.now();
    const entry = {
      at,
      browserTabId: String(tabId || ''),
      reason: String(reason || 'unknown'),
    };
    this.screencastFallbacks.push(entry);
    while (this.screencastFallbacks.length > SCREENCAST_FALLBACK_LOG_MAX) {
      this.screencastFallbacks.shift();
    }
    return entry;
  }

  /**
   * Creates and reuses the tab's CDP session, mirroring `readNavigationHistory`.
   * Returns `null` (never throws) when the driver cannot speak CDP, which is the
   * documented trigger for falling back to the pull path.
   * @param {any} tab
   */
  async ensureCdpSession(tab) {
    try {
      const page = tab?.page;
      const context = typeof page?.context === 'function' ? page.context() : null;
      if (!context || typeof context.newCDPSession !== 'function') return null;
      if (!tab.cdpSession) tab.cdpSession = await context.newCDPSession(page);
      return tab.cdpSession || null;
    } catch {
      void this.detachNavigationCdpSession(tab);
      return null;
    }
  }

  /**
   * Starts pushing frames for one tab.
   * @param {string} sessionId
   * @param {string} tabId
   * @param {string} ownerSessionId
   * @param {{ allowBinary?: boolean, fps?: number, quality?: number, sink?: (control: any, binary: Uint8Array|null) => void }} [options]
   * @param {{ workspaceFile?: string, cwd?: string }} [scope]
   */
  async startScreencast(sessionId, tabId, ownerSessionId, options = {}, scope = {}) {
    const { session, tab } = this.requireTab(sessionId, tabId, ownerSessionId, scope);
    if (!isExperimentalMode(this.screencastMode)) {
      return { ok: false, reason: 'mode-off', mode: this.screencastMode };
    }
    const existing = this.screencasts.get(tab.id);
    if (existing?.running) {
      if (options.allowBinary !== true) {
        return { ok: false, reason: 'client-no-binary', mode: this.screencastMode };
      }
      // A second viewer joins the producer that already exists instead of
      // starting a second CDP stream on the same tab.
      if (typeof options.sink === 'function') existing.sinks.add(options.sink);
      return { ok: true, resumed: true, status: this.screencastStatus({ browserTabId: tab.id }) };
    }
    if (options.allowBinary !== true) {
      this.noteScreencastFallback(tab.id, 'client-no-binary');
      return { ok: false, reason: 'client-no-binary', mode: this.screencastMode };
    }
    const cdp = await this.ensureCdpSession(tab);
    if (!cdp || typeof cdp.send !== 'function' || typeof cdp.on !== 'function') {
      this.noteScreencastFallback(tab.id, 'cdp-unavailable');
      return { ok: false, reason: 'cdp-unavailable', mode: this.screencastMode };
    }
    const viewport = typeof tab.page?.viewportSize === 'function'
      ? (tab.page.viewportSize() || null)
      : null;
    const fps = Number(options.fps) > 0
      ? Math.min(
        Number(this.limits.SCREENCAST_MAX_FPS) || 5,
        Math.max(Number(this.limits.SCREENCAST_MIN_FPS) || 1, Number(options.fps)),
      )
      : Number(this.limits.SCREENCAST_DEFAULT_FPS) || 3;
    const state = {
      running: true,
      session,
      tab,
      tabId: tab.id,
      sessionId: session.id,
      cdp,
      gate: createScreencastGate({ now: this.now, limits: this.limits }),
      metrics: createScreencastMetrics({
        now: this.now,
        limits: this.limits,
        ...(this.screencastMetricsOptions || {}),
      }),
      /** @type {Set<(control: any, binary: Uint8Array|null) => void>} */
      sinks: new Set(typeof options.sink === 'function' ? [options.sink] : []),
      applied: null,
      startedAt: this.now(),
      lastFrameAt: null,
      lastHeapAt: 0,
      stallTimer: null,
      handler: null,
      restarting: false,
      width: viewport?.width || session.viewport?.width || null,
      height: viewport?.height || session.viewport?.height || null,
    };
    state.metrics.noteStarted();
    state.metrics.noteBrowserPid(browserProcessPid(tab));
    this.screencasts.set(tab.id, state);
    tab.screencast = state;

    // Registered before `Page.startScreencast` so the very first frame is not
    // lost in the gap, and kept on `state` so teardown can remove the exact one.
    const handler = (frame) => { void this.handleScreencastFrame(state, frame); };
    state.handler = handler;
    try {
      cdp.on('Page.screencastFrame', handler);
    } catch {
      await this.stopScreencastState(state, { reason: 'listener-failed' });
      return { ok: false, reason: 'listener-failed', mode: this.screencastMode };
    }

    const params = buildStartScreencastParams({
      width: state.width,
      height: state.height,
      quality: options.quality ?? Number(this.limits.SCREENCAST_DEFAULT_QUALITY) ?? 60,
      everyNthFrame: state.gate.target().everyNthFrame,
    }, this.limits);
    try {
      await cdp.send('Page.startScreencast', params);
    } catch (err) {
      await this.stopScreencastState(state, { reason: 'start-failed' });
      return {
        ok: false,
        reason: 'start-failed',
        error: redactText(String(err?.message || 'startScreencast failed')),
        mode: this.screencastMode,
      };
    }
    state.applied = params;
    this.armScreencastStall(state);
    this.touch(session);
    return { ok: true, status: this.screencastStatus({ browserTabId: tab.id }) };
  }

  /**
   * Answers Chromium for one frame. Every frame that arrives gets exactly one of
   * these — on client acknowledgement, on collapse, or on teardown — because a
   * missing ack is what makes Chromium stop producing.
   * @param {any} state
   * @param {number|null} frameIndex
   */
  async ackScreencastFrameIndex(state, frameIndex) {
    const cdp = state?.cdp;
    if (!cdp || typeof cdp.send !== 'function') return false;
    const index = Number(frameIndex);
    if (!Number.isFinite(index)) return false;
    try {
      await cdp.send('Page.screencastFrameAck', { frameIndex: index });
      return true;
    } catch {
      // A detached session cannot answer; the stall watchdog ends the stream.
      return false;
    }
  }

  /**
   * Client acknowledgement of one pushed frame: frees the window slot and lets
   * Chromium produce the next one.
   * @param {string} sessionId
   * @param {string} tabId
   * @param {string} ownerSessionId
   * @param {number} seq
   * @param {{ workspaceFile?: string, cwd?: string }} [scope]
   */
  async ackScreencastFrame(sessionId, tabId, ownerSessionId, seq, scope = {}) {
    const { tab } = this.requireTab(sessionId, tabId, ownerSessionId, scope);
    const state = this.screencasts.get(tab.id);
    if (!state?.running) return { ok: false, reason: 'no-stream' };
    const resolved = state.gate.resolve(seq);
    if (!resolved) return { ok: false, reason: 'unknown-seq', seq: Number(seq) };
    const latencyMs = state.metrics.noteFrameAcked({ seq: resolved.seq });
    await this.ackScreencastFrameIndex(state, resolved.frameIndex);
    this.touch(state.session);
    return { ok: true, seq: resolved.seq, latencyMs };
  }

  /**
   * Explicit stop requested by the viewer (or the panel switching mode). Not a
   * fallback, so nothing is recorded in the audit trail.
   * @param {string} sessionId
   * @param {string} tabId
   * @param {string} ownerSessionId
   */
  async stopScreencast(sessionId, tabId, ownerSessionId, options = {}, scope = {}) {
    const { tab } = this.requireTab(sessionId, tabId, ownerSessionId, scope);
    return this.stopScreencastForTab(tab, {
      reason: options.reason || 'stopped',
      recordFallback: options.recordFallback === true,
    });
  }

  /**
   * Removes one viewer from a stream, stopping it when nobody is left. The
   * `/ws-browser` socket calls this on close so an abandoned panel never keeps
   * Chromium producing frames.
   * @param {string} tabId
   * @param {(control: any, binary: Uint8Array|null) => void} sink
   */
  async releaseScreencastSink(tabId, sink) {
    const state = this.screencasts.get(String(tabId || ''));
    if (!state) return false;
    state.sinks.delete(sink);
    if (state.sinks.size > 0) return false;
    await this.stopScreencastForTab(state.tab, { reason: 'no-viewers', recordFallback: false });
    return true;
  }

  /** @param {any} tab */
  async stopScreencastForTab(tab, options = {}) {
    const state = tab?.screencast || this.screencasts.get(tab?.id);
    return this.stopScreencastState(state, options);
  }

  /**
   * Idempotent teardown, and the only place that touches a stream's listeners.
   * Order matters: the listener goes first (no frame may arrive mid-teardown),
   * then every unacked frame is answered, then Chromium is told to stop.
   * @param {any} state
   */
  async stopScreencastState(state, options = {}) {
    if (!state) return false;
    if (state.running !== true) return false;
    if (state.stallTimer != null) {
      try {
        this.clearTimeoutFn(state.stallTimer);
      } catch {
        // ignore
      }
      state.stallTimer = null;
    }
    const wasRunning = state.running === true;
    state.running = false;
    if (state.handler) {
      try {
        if (typeof state.cdp?.off === 'function') state.cdp.off('Page.screencastFrame', state.handler);
        else if (typeof state.cdp?.removeListener === 'function') {
          state.cdp.removeListener('Page.screencastFrame', state.handler);
        }
      } catch {
        // A dead session has no listeners left to remove by definition.
      }
      state.handler = null;
    }
    for (const row of state.gate.drain()) {
      await this.ackScreencastFrameIndex(state, row.frameIndex);
    }
    try {
      if (typeof state.cdp?.send === 'function') await state.cdp.send('Page.stopScreencast');
    } catch {
      // ignore: the session is going away regardless.
    }
    this.screencasts.delete(state.tabId);
    if (state.tab && state.tab.screencast === state) state.tab.screencast = null;
    const reason = options.reason || 'stopped';
    if (options.recordFallback === true || (options.recordFallback !== false && wasRunning)) {
      this.noteScreencastFallback(state.tabId, reason);
    }
    const control = {
      type: 'screencast-mode',
      mode: 'pull',
      reason,
      browserTabId: state.tabId,
    };
    for (const sink of state.sinks) {
      try {
        sink(control, null);
      } catch {
        // ignore
      }
    }
    state.sinks.clear();
    return true;
  }

  /**
   * Arms the per-stream stall watchdog. A host that injects a no-op timer (the
   * tests do) still gets a fallback, because `expireScreencasts()` is also driven
   * by the `/ws-browser` status poll.
   * @param {any} state
   */
  armScreencastStall(state) {
    const timeout = Number(this.limits?.SCREENCAST_STALL_TIMEOUT_MS) > 0
      ? Number(this.limits.SCREENCAST_STALL_TIMEOUT_MS)
      : 4000;
    if (state.stallTimer != null) {
      try {
        this.clearTimeoutFn(state.stallTimer);
      } catch {
        // ignore
      }
      state.stallTimer = null;
    }
    state.stallTimer = this.setTimeoutFn(() => {
      state.stallTimer = null;
      if (state.running) void this.expireScreencasts();
    }, timeout);
  }

  /**
   * Stops every stream whose newest frame is older than the stall bound and
   * refreshes the tab heap sample. Returns the tab ids that fell back.
   * @param {number} [at]
   */
  async expireScreencasts(at = this.now()) {
    const timeout = Number(this.limits?.SCREENCAST_STALL_TIMEOUT_MS) > 0
      ? Number(this.limits.SCREENCAST_STALL_TIMEOUT_MS)
      : 4000;
    const stopped = [];
    for (const state of [...this.screencasts.values()]) {
      if (!state.running) continue;
      const origin = state.lastFrameAt ?? state.startedAt ?? at;
      if (at - origin >= timeout) {
        await this.stopScreencastState(state, { reason: 'stall' });
        stopped.push(state.tabId);
        continue;
      }
      if (at - (state.lastHeapAt || 0) >= timeout) {
        state.lastHeapAt = at;
        void this.sampleScreencastHeap(state);
      }
    }
    return stopped;
  }

  /**
   * Best-effort renderer heap sample via CDP. A dimension that cannot be measured
   * stays `null` in the snapshot instead of reporting an idle-looking `0`.
   * @param {any} state
   */
  async sampleScreencastHeap(state) {
    if (!state?.running || typeof state.cdp?.send !== 'function') return false;
    try {
      const usage = await state.cdp.send('Runtime.getHeapUsage');
      return state.metrics.noteHeapUsage(usage || {});
    } catch {
      return false;
    }
  }

  /**
   * Handles one `Page.screencastFrame` event: decode, gate, announce with a JSON
   * control message, hand the raw bytes to the sink, and adapt the rate.
   * @param {any} state
   * @param {any} frame
   */
  async handleScreencastFrame(state, frame) {
    // A late event after teardown must not resurrect a dead stream.
    if (!state?.running) return false;
    state.lastFrameAt = this.now();
    this.armScreencastStall(state);
    const decoded = decodeScreencastFrame(frame, this.now, this.limits);
    if (decoded.byteLength <= 0) {
      await this.ackScreencastFrameIndex(state, decoded.frameIndex);
      return false;
    }
    if (decoded.oversized) {
      await this.ackScreencastFrameIndex(state, decoded.frameIndex);
      await this.stopScreencastState(state, { reason: 'frame-too-large' });
      return false;
    }
    const admitted = state.gate.admit({ frameIndex: decoded.frameIndex });
    for (const row of admitted.collapsed) {
      state.metrics.noteFrameDropped();
      this.notifyScreencastSinks(state, {
        type: 'screencast-dropped',
        seq: row.seq,
        browserTabId: state.tabId,
      }, null);
      await this.ackScreencastFrameIndex(state, row.frameIndex);
    }
    const header = buildScreencastFrameHeader({
      seq: admitted.seq,
      browserTabId: state.tabId,
      frameIndex: decoded.frameIndex,
      byteLength: decoded.byteLength,
      width: Number(frame?.width) || state.width || null,
      height: Number(frame?.height) || state.height || null,
      capturedAt: decoded.capturedAt,
    });
    state.metrics.noteFrameSent({ seq: admitted.seq, capturedAt: decoded.capturedAt });
    this.touch(state.session);
    this.notifyScreencastSinks(state, header, decoded.bytes);
    await this.restartScreencastIfAdapted(state);
    return true;
  }

  /**
   * @param {any} state
   * @param {any} control
   * @param {Uint8Array|null} [binary]
   */
  notifyScreencastSinks(state, control, binary = null) {
    if (!state?.sinks?.size) return 0;
    let delivered = 0;
    for (const sink of [...state.sinks]) {
      try {
        sink(control, binary);
        delivered += 1;
      } catch {
        // A socket that throws on send is closing; the close handler releases it.
      }
    }
    return delivered;
  }

  /**
   * Applies a new rate target when the gate asked for one. A restart costs a
   * frame gap, so it is throttled and never overlaps itself.
   * @param {any} state
   */
  async restartScreencastIfAdapted(state) {
    if (!state?.running || state.restarting) return false;
    if (!state.gate.needsRestart(state.applied)) return false;
    state.restarting = true;
    try {
      const target = state.gate.markRestart();
      const params = buildStartScreencastParams({
        width: state.width,
        height: state.height,
        quality: target.quality,
        everyNthFrame: target.everyNthFrame,
      }, this.limits);
      try {
        await state.cdp.send('Page.stopScreencast');
      } catch {
        // ignore: a restart with a live producer is still worth attempting.
      }
      if (!state.running) return false;
      await state.cdp.send('Page.startScreencast', params);
      state.applied = params;
      this.notifyScreencastSinks(state, {
        type: 'screencast-target',
        browserTabId: state.tabId,
        target,
        applied: params,
      }, null);
      return true;
    } catch {
      await this.stopScreencastState(state, { reason: 'restart-failed' });
      return false;
    } finally {
      state.restarting = false;
    }
  }

  /**
   * @param {string} sessionId
   * @param {string} tabId
   * @param {string} ownerSessionId
   * @param {{ workspaceFile?: string, cwd?: string }} [scope]
   */
  async screencastStatusForTab(sessionId, tabId, ownerSessionId, scope = {}) {
    const { tab } = this.requireTab(sessionId, tabId, ownerSessionId, scope);
    await this.expireScreencasts();
    return this.screencastStatus({ browserTabId: tab.id });
  }

  /***************************************************************************
   * CDP Debugger (dedicated session per tab)                                 *
   ***************************************************************************/

  /**
   * Creates or reuses the tab's debugger CDP session (never `tab.cdpSession`).
   * @param {any} tab
   */
  async ensureDebuggerCdpSession(tab) {
    try {
      const page = tab?.page;
      const context = typeof page?.context === 'function' ? page.context() : null;
      if (!context || typeof context.newCDPSession !== 'function') return null;
      if (!tab.debuggerCdpSession) {
        const cdp = await context.newCDPSession(page);
        tab.debuggerCdpSession = cdp;
        this.bindDebuggerCdpSessionLifecycle(tab, cdp);
      }
      return tab.debuggerCdpSession || null;
    } catch {
      void this.detachDebuggerForTab(tab);
      return null;
    }
  }

  /**
   * Clears debugger controller state when the main frame navigates (reload / new document).
   * @param {any} tab
   */
  async resetDebuggerForMainFrameNavigation(tab) {
    const tabId = String(tab?.id || '');
    const state = tabId ? this.debuggers.get(tabId) : null;
    if (!state?.controller || typeof state.controller.resetForNavigation !== 'function') return;
    await state.controller.resetForNavigation();
  }

  /**
   * @param {any} tab
   * @param {any} cdp
   */
  bindDebuggerCdpSessionLifecycle(tab, cdp) {
    if (!tab || !cdp || typeof cdp.on !== 'function') return;
    if (tab._debuggerCdpLifecycleBound) return;
    tab._debuggerCdpLifecycleBound = true;
    const onDetached = () => {
      void this.detachDebuggerForTab(tab);
    };
    tab._debuggerCdpDetachedHandler = onDetached;
    cdp.on('Inspector.detached', onDetached);
  }

  /**
   * Fetches a source map JSON for debugger original-position mapping (URL policy enforced).
   * @param {any} session
   * @param {any} tab
   * @param {string} sourceMapUrl
   * @returns {Promise<Record<string, unknown>|null>}
   */
  async fetchDebuggerSourceMap(session, tab, sourceMapUrl, scriptUrl = '') {
    const raw = String(sourceMapUrl || '').trim();
    if (!raw) return null;
    let resolved = raw;
    const baseUrl = String(scriptUrl || tab?.url || 'https://example.invalid/').trim();
    try {
      resolved = new URL(raw, baseUrl).href;
    } catch {
      return null;
    }
    const decision = await this.evaluateRequestPolicy(session, resolved);
    if (!decision.allowed) return null;
    const maxBytes = Number(this.limits.DEBUGGER_MAX_SOURCE_MAP_BYTES) > 0
      ? Number(this.limits.DEBUGGER_MAX_SOURCE_MAP_BYTES)
      : 512 * 1024;
    const timeoutMs = Number(this.limits.DEBUGGER_SOURCE_MAP_FETCH_TIMEOUT_MS) > 0
      ? Number(this.limits.DEBUGGER_SOURCE_MAP_FETCH_TIMEOUT_MS)
      : 8000;
    const controller = new AbortController();
    const timer = this.setTimeoutFn(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(resolved, { redirect: 'manual', signal: controller.signal });
      if (!response.ok || !response.body) return null;
      const chunks = [];
      let total = 0;
      for await (const chunk of response.body) {
        const piece = Buffer.from(chunk);
        total += piece.length;
        if (total > maxBytes) return null;
        chunks.push(piece);
      }
      const buf = Buffer.concat(chunks);
      const parsed = JSON.parse(buf.toString('utf8'));
      return parsed && typeof parsed === 'object' ? /** @type {Record<string, unknown>} */ (parsed) : null;
    } catch {
      return null;
    } finally {
      this.clearTimeoutFn(timer);
    }
  }

  /**
   * @param {any} tab
   */
  async detachDebuggerForTab(tab) {
    const tabId = String(tab?.id || '');
    const state = tabId ? this.debuggers.get(tabId) : null;
    if (state?.controller && typeof state.controller.detach === 'function') {
      const timeout = Number(this.limits.CLOSE_HARD_TIMEOUT_MS) > 0
        ? Number(this.limits.CLOSE_HARD_TIMEOUT_MS)
        : 3000;
      await this.withHardTimeout(Promise.resolve().then(() => state.controller.detach()), timeout);
    }
    if (tabId) this.debuggers.delete(tabId);
    const cdp = tab?.debuggerCdpSession;
    if (cdp && typeof cdp.off === 'function' && tab?._debuggerCdpDetachedHandler) {
      try {
        cdp.off('Inspector.detached', tab._debuggerCdpDetachedHandler);
      } catch {
        // ignore
      }
    }
    if (tab) {
      tab.debuggerCdpSession = null;
      tab._debuggerCdpLifecycleBound = false;
      tab._debuggerCdpDetachedHandler = null;
    }
    if (!cdp || typeof cdp.detach !== 'function') return;
    const timeout = Number(this.limits.CLOSE_HARD_TIMEOUT_MS) > 0
      ? Number(this.limits.CLOSE_HARD_TIMEOUT_MS)
      : 3000;
    await this.withHardTimeout(Promise.resolve().then(() => cdp.detach()), timeout);
  }

  /**
   * @param {any} session
   * @param {any} tab
   */
  async requireDebuggerController(session, tab) {
    const existing = this.debuggers.get(tab.id);
    if (existing?.controller) return existing.controller;
    const cdp = await this.ensureDebuggerCdpSession(tab);
    if (!cdp || typeof cdp.send !== 'function' || typeof cdp.on !== 'function') {
      throw new BrowserError('debugger-unavailable', 'Debugger CDP session is unavailable', 503);
    }
    const sessionId = session.id;
    const controller = createDebuggerController({
      limits: this.limits,
      now: () => this.now(),
      setTimeoutFn: this.setTimeoutFn.bind(this),
      clearTimeoutFn: this.clearTimeoutFn.bind(this),
      send: (method, params) => cdp.send(method, params),
      on: (event, handler) => cdp.on(event, handler),
      off: (event, handler) => {
        if (typeof cdp.off === 'function') cdp.off(event, handler);
        else if (typeof cdp.removeListener === 'function') cdp.removeListener(event, handler);
      },
      fetchSourceMap: (sourceMapUrl, scriptUrl) => this.fetchDebuggerSourceMap(session, tab, sourceMapUrl, scriptUrl),
      onEvent: (payload) => {
        this.pushDebuggerEvent(sessionId, tab.id, payload);
      },
    });
    const state = { controller, cdp, tab, sessionId };
    this.debuggers.set(tab.id, state);
    await controller.attach();
    return controller;
  }

  /**
   * @param {string} sessionId
   * @param {string} tabId
   * @param {Record<string, unknown>} payload
   */
  pushDebuggerEvent(sessionId, tabId, payload) {
    const hooks = this.debuggerEventHooks;
    if (typeof hooks !== 'function') return;
    try {
      hooks(sessionId, tabId, payload);
    } catch {
      // ignore hook errors
    }
  }

  /**
   * @param {string} sessionId
   * @param {string} tabId
   * @param {string} ownerSessionId
   * @param {{ workspaceFile?: string, cwd?: string }} [scope]
   */
  async debuggerState(sessionId, tabId, ownerSessionId, scope = {}) {
    const { session, tab } = this.requireTab(sessionId, tabId, ownerSessionId, scope);
    const state = this.debuggers.get(tab.id);
    if (!state?.controller) {
      return {
        ok: true,
        attached: false,
        runState: 'none',
        paused: false,
        breakpointCount: 0,
        breakpoints: [],
      };
    }
    return { ok: true, ...state.controller.getState() };
  }

  /**
   * @param {string} sessionId
   * @param {string} tabId
   * @param {string} ownerSessionId
   * @param {{ workspaceFile?: string, cwd?: string }} [scope]
   */
  async debuggerPause(sessionId, tabId, ownerSessionId, scope = {}) {
    const { session, tab } = this.requireTab(sessionId, tabId, ownerSessionId, scope);
    const controller = await this.requireDebuggerController(session, tab);
    return controller.pause();
  }

  /**
   * @param {string} sessionId
   * @param {string} tabId
   * @param {string} ownerSessionId
   * @param {{ workspaceFile?: string, cwd?: string }} [scope]
   */
  async debuggerResume(sessionId, tabId, ownerSessionId, scope = {}) {
    const { session, tab } = this.requireTab(sessionId, tabId, ownerSessionId, scope);
    const controller = await this.requireDebuggerController(session, tab);
    return controller.resume();
  }

  /**
   * @param {string} sessionId
   * @param {string} tabId
   * @param {string} ownerSessionId
   * @param {Record<string, unknown>} input
   * @param {{ workspaceFile?: string, cwd?: string }} [scope]
   */
  async debuggerSetBreakpoint(sessionId, tabId, ownerSessionId, input, scope = {}) {
    const { session, tab } = this.requireTab(sessionId, tabId, ownerSessionId, scope);
    const controller = await this.requireDebuggerController(session, tab);
    return controller.setBreakpoint(input);
  }

  /**
   * @param {string} sessionId
   * @param {string} tabId
   * @param {string} ownerSessionId
   * @param {string} breakpointId
   * @param {{ workspaceFile?: string, cwd?: string }} [scope]
   */
  async debuggerRemoveBreakpoint(sessionId, tabId, ownerSessionId, breakpointId, scope = {}) {
    const { session, tab } = this.requireTab(sessionId, tabId, ownerSessionId, scope);
    const controller = await this.requireDebuggerController(session, tab);
    return controller.removeBreakpoint(breakpointId);
  }

  /**
   * @param {string} sessionId
   * @param {string} tabId
   * @param {string} ownerSessionId
   * @param {{ callFrameId?: string, workspaceFile?: string, cwd?: string }} [options]
   */
  async debuggerStack(sessionId, tabId, ownerSessionId, options = {}) {
    const { session, tab } = this.requireTab(sessionId, tabId, ownerSessionId, this.scopeFromOptions(options));
    const state = this.debuggers.get(tab.id);
    if (!state?.controller) {
      return { ok: true, frames: [], truncated: false, paused: false };
    }
    return state.controller.getStack(options.callFrameId);
  }

  /**
   * @param {string} sessionId
   * @param {string} tabId
   * @param {string} ownerSessionId
   * @param {{ callFrameId?: string, workspaceFile?: string, cwd?: string }} [options]
   */
  async debuggerScopes(sessionId, tabId, ownerSessionId, options = {}) {
    const { session, tab } = this.requireTab(sessionId, tabId, ownerSessionId, this.scopeFromOptions(options));
    const state = this.debuggers.get(tab.id);
    if (!state?.controller) {
      return { ok: true, scopes: [], truncated: false, paused: false };
    }
    return state.controller.getScopes(options.callFrameId);
  }

  /**
   * @param {string} sessionId
   * @param {string} tabId
   * @param {string} ownerSessionId
   * @param {string} scriptId
   * @param {{ workspaceFile?: string, cwd?: string }} [scope]
   */
  async debuggerScriptSource(sessionId, tabId, ownerSessionId, scriptId, scope = {}) {
    const { session, tab } = this.requireTab(sessionId, tabId, ownerSessionId, scope);
    const controller = await this.requireDebuggerController(session, tab);
    return controller.getScriptSource(scriptId);
  }

  /**
   * @param {string} sessionId
   * @param {string} tabId
   * @param {string} ownerSessionId
   * @param {string} expression
   * @param {{ callFrameId?: string, workspaceFile?: string, cwd?: string }} [options]
   */
  async debuggerWatch(sessionId, tabId, ownerSessionId, expression, options = {}) {
    const { session, tab } = this.requireTab(sessionId, tabId, ownerSessionId, this.scopeFromOptions(options));
    const controller = await this.requireDebuggerController(session, tab);
    return controller.watch(expression, options.callFrameId);
  }

  /**
   * @param {{ workspaceFile?: string, cwd?: string }} [options]
   */
  scopeFromOptions(options = {}) {
    return {
      workspaceFile: options.workspaceFile,
      cwd: options.cwd,
    };
  }

  /**
   * @param {string} sessionId
   * @param {string} tabId
   * @param {string} ownerSessionId
   * @param {{ workspaceFile?: string, cwd?: string }} [scope]
   */
  async dispatchInput(sessionId, tabId, ownerSessionId, event, scope = {}) {
    const { session, tab } = this.requireTab(sessionId, tabId, ownerSessionId, scope);
    const now = this.now();
    const minInterval = Number.isFinite(this.limits.INPUT_MIN_INTERVAL_MS)
      ? Math.max(0, Number(this.limits.INPUT_MIN_INTERVAL_MS))
      : BROWSER_LIMITS.INPUT_MIN_INTERVAL_MS;
    if (now - Number(tab.lastInputAt || 0) < minInterval) {
      throw new BrowserError(
        'input-rate-limited',
        `Input events are capped at ${Math.max(1, Math.round(1000 / Math.max(1, minInterval)))}/s`,
        429,
      );
    }
    tab.lastInputAt = now;
    // Serialize per tab: REST requests and the WS FIFO queue share this chain so
    // they cannot interleave and race the same page.
    const run = () => this.performInput(session, tab, event, scope);
    const previous = tab.inputChain instanceof Promise ? tab.inputChain : Promise.resolve();
    const next = previous.then(run, run);
    tab.inputChain = next.then(() => undefined, () => undefined);
    return next;
  }

  /**
   * @param {any} session
   * @param {any} tab
   * @param {Record<string, any>} event
   * @param {{ workspaceFile?: string, cwd?: string }} [scope]
   */
  async performInput(session, tab, event, scope = {}) {
    const kind = String(event?.kind || '').trim();
    const preview = event?.preview || null;
    const viewportSize = typeof tab.page.viewportSize === 'function' ? tab.page.viewportSize() : null;
    this.touch(session);

    if (kind === 'pointer') {
      const mapped = mapPreviewPoint(event.point || {}, preview, viewportSize);
      const action = String(event.action || 'click');
      if (action === 'move') await tab.page.mouse.move(mapped.x, mapped.y);
      else if (action === 'down') await tab.page.mouse.down({ button: event.button || 'left' });
      else if (action === 'up') await tab.page.mouse.up({ button: event.button || 'left' });
      else if (action === 'tap' && session.viewport.hasTouch && typeof tab.page.touchscreen?.tap === 'function') {
        await tab.page.touchscreen.tap(mapped.x, mapped.y);
      } else {
        await tab.page.mouse.click(mapped.x, mapped.y, { button: event.button || 'left', clickCount: Number(event.clickCount) || 1 });
      }
      return { ok: true, x: mapped.x, y: mapped.y };
    }

    if (kind === 'scroll') {
      const mapped = mapPreviewPoint(event.point || { x: 0, y: 0 }, preview, viewportSize);
      await tab.page.mouse.move(mapped.x, mapped.y);
      await tab.page.mouse.wheel(Number(event.deltaX) || 0, Number(event.deltaY) || 0);
      return { ok: true };
    }

    if (kind === 'key') {
      const action = String(event.action || 'press');
      if (action === 'type') {
        const maxDelay = Number.isFinite(this.limits.MAX_INPUT_DELAY_MS) && this.limits.MAX_INPUT_DELAY_MS > 0
          ? Number(this.limits.MAX_INPUT_DELAY_MS)
          : BROWSER_LIMITS.MAX_INPUT_DELAY_MS;
        await tab.page.keyboard.type(String(event.text || ''), { delay: clampNumber(event.delay, 0, maxDelay, 0) });
      } else if (action === 'down') await tab.page.keyboard.down(String(event.key || ''));
      else if (action === 'up') await tab.page.keyboard.up(String(event.key || ''));
      else await tab.page.keyboard.press(String(event.key || 'Enter'));
      return { ok: true };
    }

    if (kind === 'dialog') {
      // A buffered JavaScript dialog is the one input that is not aimed at the
      // page: it answers the page. Without it `confirm()`/`prompt()` could only
      // ever be dismissed by the bounded auto-dismiss timer.
      const action = String(event.action || 'dismiss').trim().toLowerCase();
      if (!BROWSER_DIALOG_ACTIONS.includes(action)) {
        throw new BrowserError(
          'dialog-action-invalid',
          `browser_input dialog needs action ${BROWSER_DIALOG_ACTIONS.join('|')}, got: ${action || '(empty)'}`,
          400,
        );
      }
      const requested = String(event.dialogId || '').trim();
      const pendingIds = tab.pendingDialogs instanceof Map ? [...tab.pendingDialogs.keys()] : [];
      const dialogId = requested || pendingIds[0] || '';
      if (!dialogId || !tab.pendingDialogs?.has?.(dialogId)) {
        throw new BrowserError(
          'dialog-not-found',
          requested
            ? `No pending dialog ${requested} on this tab`
            : 'No pending dialog to answer on this tab',
          404,
        );
      }
      const resolved = await this.resolveDialog(tab, dialogId, {
        action,
        promptText: typeof event.promptText === 'string' ? event.promptText : undefined,
      });
      if (!resolved) {
        throw new BrowserError('dialog-not-found', `Dialog ${dialogId} was already answered`, 404);
      }
      if (!resolved.ok) {
        throw new BrowserError('dialog-failed', `dialog ${action} failed: ${resolved.error}`, 502);
      }
      return { ok: true, kind: 'dialog', dialogId, action };
    }

    if (kind === 'click' || kind === 'fill') {
      const locator = resolvePageLocator(tab.page, event);
      if (!locator) {
        throw new BrowserError(
          'locator-required',
          `browser_input ${kind} needs a target: selector, or role (+name), text, label or placeholder`,
          400,
        );
      }
      const timeout = Number.isFinite(this.limits.LOCATOR_TIMEOUT_MS) && this.limits.LOCATOR_TIMEOUT_MS > 0
        ? Number(this.limits.LOCATOR_TIMEOUT_MS)
        : BROWSER_LIMITS.LOCATOR_TIMEOUT_MS;
      try {
        if (kind === 'click') {
          await locator.click({
            button: event.button || 'left',
            clickCount: Number(event.clickCount) || 1,
            timeout,
          });
          return { ok: true, kind: 'click' };
        }
        await locator.fill(String(event.value ?? ''), { timeout });
        return { ok: true, kind: 'fill' };
      } catch (err) {
        throw new BrowserError('locator-failed', `${kind} failed: ${err?.message || String(err)}`, 502);
      }
    }

    if (kind === 'resize') {
      // `setViewportSize` only changes width/height: deviceScaleFactor and touch
      // are fixed when the context is created. Preserve them instead of letting
      // normalizeViewport() silently reset DPR/touch to the defaults, which made
      // later clicks and `getState` report values the page did not have.
      const viewport = {
        ...session.viewport,
        width: Math.round(clampNumber(
          event.viewport?.width,
          this.limits.MIN_VIEWPORT.width,
          this.limits.MAX_VIEWPORT.width,
          session.viewport.width,
        )),
        height: Math.round(clampNumber(
          event.viewport?.height,
          this.limits.MIN_VIEWPORT.height,
          this.limits.MAX_VIEWPORT.height,
          session.viewport.height,
        )),
      };
      session.viewport = viewport;
      await tab.page.setViewportSize({ width: viewport.width, height: viewport.height });
      return { ok: true, viewport };
    }

    const locatorTimeout = Number.isFinite(this.limits.LOCATOR_TIMEOUT_MS) && this.limits.LOCATOR_TIMEOUT_MS > 0
      ? Number(this.limits.LOCATOR_TIMEOUT_MS)
      : BROWSER_LIMITS.LOCATOR_TIMEOUT_MS;
    const requireTarget = (what) => {
      const locator = resolvePageLocator(tab.page, event);
      if (!locator) {
        throw new BrowserError(
          'locator-required',
          `browser_input ${what} needs a target: selector, or role (+name), text, label or placeholder`,
          400,
        );
      }
      return locator;
    };
    const asLocatorFailure = (what, err) => new BrowserError(
      'locator-failed',
      `${what} failed: ${err?.message || String(err)}`,
      502,
    );

    if (kind === 'select') {
      const locator = requireTarget('select');
      const option = buildSelectOption(event);
      try {
        await locator.selectOption(option, { timeout: locatorTimeout });
        return { ok: true, kind: 'select' };
      } catch (err) {
        throw asLocatorFailure('select', err);
      }
    }

    if (kind === 'check' || kind === 'uncheck' || kind === 'hover') {
      const locator = requireTarget(kind);
      try {
        if (kind === 'hover') await locator.hover({ timeout: locatorTimeout });
        else if (kind === 'check') await locator.check({ timeout: locatorTimeout });
        else await locator.uncheck({ timeout: locatorTimeout });
        return { ok: true, kind };
      } catch (err) {
        throw asLocatorFailure(kind, err);
      }
    }

    if (kind === 'drag') {
      const source = requireTarget('drag');
      // A missing destination is a 400, never a drop back onto the source.
      const target = resolvePageLocator(tab.page, dragDestinationFields(event));
      if (!target) {
        throw new BrowserError(
          'drag-target-required',
          'browser_input drag needs a destination: toSelector, or toRole (+toName), toText, toLabel or toPlaceholder',
          400,
        );
      }
      try {
        await source.dragTo(target, { timeout: locatorTimeout });
        return { ok: true, kind: 'drag' };
      } catch (err) {
        throw asLocatorFailure('drag', err);
      }
    }

    if (kind === 'upload') {
      const locator = requireTarget('upload');
      const files = this.resolveUploadPaths(event, scope, session);
      try {
        await locator.setInputFiles(files, { timeout: locatorTimeout });
        // Only the count is returned: the resolved paths stay on the host.
        return { ok: true, kind: 'upload', count: files.length };
      } catch (err) {
        throw asLocatorFailure('upload', err);
      }
    }

    if (kind === 'wait') {
      const maxWait = Number.isFinite(this.limits.MAX_WAIT_TIMEOUT_MS) && this.limits.MAX_WAIT_TIMEOUT_MS > 0
        ? Number(this.limits.MAX_WAIT_TIMEOUT_MS)
        : BROWSER_LIMITS.MAX_WAIT_TIMEOUT_MS;
      // Input events are serialized per tab, so the wait is always bounded (and
      // never 0, which would disable Playwright's timeout).
      const timeout = clampNumber(event.timeout, 1, maxWait, locatorTimeout);
      const selector = String(event.selector || '').trim();
      const byText = String(event.text || '').trim();
      const loadState = String(event.loadState || '').trim();
      const url = String(event.url || '').trim();
      if (!selector && !byText && !loadState && !url) {
        throw new BrowserError(
          'wait-target-required',
          'browser_input wait needs a condition: selector (+state), text, loadState or url. '
          + 'Arbitrary script evaluation is not supported.',
          400,
        );
      }
      const state = String(event.state || 'visible').trim();
      if ((selector || byText) && !BROWSER_WAIT_STATES.includes(state)) {
        throw new BrowserError(
          'wait-state-invalid',
          `Unknown wait state: ${state}. Use ${BROWSER_WAIT_STATES.join('|')}`,
          400,
        );
      }
      if (loadState && !BROWSER_LOAD_STATES.includes(loadState)) {
        throw new BrowserError(
          'wait-loadstate-invalid',
          `Unknown loadState: ${loadState}. Use ${BROWSER_LOAD_STATES.join('|')}`,
          400,
        );
      }
      try {
        if (loadState) await tab.page.waitForLoadState(loadState, { timeout });
        if (url) await tab.page.waitForURL(url, { timeout });
        if (selector) await tab.page.waitForSelector(selector, { state, timeout });
        if (byText) await tab.page.getByText(byText).first().waitFor({ state, timeout });
        return { ok: true, kind: 'wait', timeout };
      } catch (err) {
        throw asLocatorFailure('wait', err);
      }
    }

    throw new BrowserError('unsupported-input', `Unsupported input kind: ${kind || '(empty)'}`, 400);
  }

  /**
   * Authorizes the file paths of a `browser_input` upload. This reads files off
   * the host, so it fails closed: the workspace root (`scope.cwd`, falling back
   * to the session's recorded cwd) is mandatory and every path must stay inside
   * it after `realpath`, which rejects `..` traversal, absolute paths outside
   * the root and symlinks that escape it.
   * @param {Record<string, any>} event
   * @param {{ workspaceFile?: string, cwd?: string }} scope
   * @param {any} [session]
   * @returns {string[]} resolved absolute paths, ready for `setInputFiles`
   */
  resolveUploadPaths(event, scope = {}, session = null) {
    const forbidden = (detail) => new BrowserError(
      'upload-path-forbidden',
      `Upload path is outside the workspace root: ${detail}`,
      400,
    );
    const maxFiles = Number.isFinite(this.limits.MAX_UPLOAD_FILES) && this.limits.MAX_UPLOAD_FILES > 0
      ? Number(this.limits.MAX_UPLOAD_FILES)
      : BROWSER_LIMITS.MAX_UPLOAD_FILES;
    const raw = Array.isArray(event.files) ? event.files : [event.files];
    const list = raw.map((value) => String(value ?? '').trim()).filter(Boolean);
    if (!list.length) {
      throw new BrowserError(
        'upload-files-required',
        'browser_input upload needs `files`: one server-side path or an array of paths',
        400,
      );
    }
    if (list.length > maxFiles) {
      throw new BrowserError('upload-file-limit', `browser_input upload accepts at most ${maxFiles} files`, 400);
    }
    const root = String(scope?.cwd || session?.cwd || '').trim();
    if (!root) {
      throw new BrowserError(
        'upload-path-forbidden',
        'Upload needs a workspace root: this Browser scope has no cwd',
        400,
      );
    }
    let realRoot = '';
    try {
      realRoot = String(this.realpath(root));
    } catch {
      throw new BrowserError('upload-path-forbidden', 'Upload workspace root cannot be resolved', 400);
    }
    const lexicalRoot = path.resolve(root);
    return list.map((item) => {
      if (item.includes('\0')) throw forbidden(item);
      const candidate = path.isAbsolute(item) ? path.resolve(item) : path.resolve(lexicalRoot, item);
      const lexical = path.relative(lexicalRoot, candidate);
      if (!lexical || lexical.startsWith('..') || path.isAbsolute(lexical)) throw forbidden(item);
      let resolved = '';
      try {
        resolved = String(this.realpath(candidate));
      } catch {
        throw new BrowserError('upload-path-not-found', `Upload file not found: ${item}`, 400);
      }
      const inside = path.relative(realRoot, resolved);
      if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw forbidden(item);
      return resolved;
    });
  }

  /**
   * @param {string} sessionId
   * @param {string} tabId
   * @param {string} ownerSessionId
   * @param {{ since?: number, limit?: number }} [options]
   * @param {{ workspaceFile?: string, cwd?: string }} [scope]
   */
  pullConsole(sessionId, tabId, ownerSessionId, options = {}, scope = {}) {
    const { session, tab } = this.requireTab(sessionId, tabId, ownerSessionId, scope);
    this.touch(session);
    return this.redactPullPayload(tab.console.pull(options));
  }

  /**
   * @param {string} sessionId
   * @param {string} tabId
   * @param {string} ownerSessionId
   * @param {{ since?: number, limit?: number }} [options]
   * @param {{ workspaceFile?: string, cwd?: string }} [scope]
   */
  pullNetwork(sessionId, tabId, ownerSessionId, options = {}, scope = {}) {
    const { session, tab } = this.requireTab(sessionId, tabId, ownerSessionId, scope);
    this.touch(session);
    return this.redactPullPayload(tab.network.pull(options));
  }

  /**
   * Second, defensive redaction pass on the way out to a chat/agent. The
   * buffers already redact at ingest; routing every pull through the one shared
   * helper guarantees a secret cannot leave even if a future entry is added
   * without the buffer constructors.
   * @param {{ entries?: Array<Record<string, unknown>> } & Record<string, unknown>} payload
   * @returns {Record<string, unknown>}
   */
  redactPullPayload(payload) {
    if (!payload || !Array.isArray(payload.entries) || payload.entries.length === 0) return payload;
    // Redact each row on its own: `maxItems` is a per-object breadth cap, so
    // applying it to the outer array would silently truncate a full pull.
    const entries = payload.entries.map((entry) => redactValue(entry, { maxDepth: 8, maxItems: 100 }));
    return { ...payload, entries };
  }

  /**
   * Pulls the bounded dialog log for a tab (pending rows carry `handled: false`
   * plus the `dialogId` `browser_input` kind `dialog` answers with).
   * @param {string} sessionId
   * @param {string} tabId
   * @param {string} ownerSessionId
   * @param {{ since?: number, limit?: number }} [options]
   * @param {{ workspaceFile?: string, cwd?: string }} [scope]
   */
  pullDialogs(sessionId, tabId, ownerSessionId, options = {}, scope = {}) {
    const { session, tab } = this.requireTab(sessionId, tabId, ownerSessionId, scope);
    this.touch(session);
    if (!tab.dialogs) return { entries: [], nextSince: 0, dropped: 0, total: 0 };
    return tab.dialogs.pull(options);
  }

  /**
   * Lists sessions visible to one owner inside one explicit workspace. An empty
   * workspace scope returns nothing: it is never treated as "all workspaces".
   * @param {string} ownerSessionId
   * @param {{ workspaceFile?: string, cwd?: string }} [scope]
   */
  listSessions(ownerSessionId, scope = {}) {
    const reqKey = this.resolveWorkspaceKey(scope);
    if (!reqKey) return [];
    return [...this.sessions.values()]
      .filter((session) => session.ownerSessionId === ownerSessionId
        && String(session.workspaceKey || '').trim() === reqKey)
      .map((session) => this.summarizeSession(session));
  }

  /**
   * @param {string} sessionId
   * @param {string} ownerSessionId
   * @param {{ workspaceFile?: string, cwd?: string }} [scope]
   */
  getSessionSummary(sessionId, ownerSessionId, scope = {}) {
    const session = this.requireSession(sessionId, ownerSessionId, scope);
    return this.summarizeSession(session);
  }

  /**
   * @param {string} sessionId
   * @param {string} ownerSessionId
   * @param {{ chatId?: string }} [input]
   * @param {{ workspaceFile?: string, cwd?: string }} [scope]
   */
  bindChat(sessionId, ownerSessionId, input = {}, scope = {}) {
    const session = this.requireSession(sessionId, ownerSessionId, scope);
    const chatId = String(input.chatId || '').trim();
    if (!chatId) throw new BrowserError('invalid-chat', 'Missing chatId', 400);
    if (session.chatId && session.chatId !== chatId) {
      throw new BrowserError('chat-bind-conflict', 'Browser session is bound to another chat', 409);
    }
    const bound = this.chatBindings.get(chatId);
    if (bound && bound !== session.id) {
      throw new BrowserError('chat-bind-conflict', 'Chat is already bound to another Browser session', 409);
    }
    session.chatId = chatId;
    this.chatBindings.set(chatId, session.id);
    return this.summarizeSession(session);
  }

  /**
   * @param {string} chatId
   * @returns {{ browserSessionId: string, chatId: string } | null}
   */
  resolveChatBinding(chatId) {
    const id = String(chatId || '').trim();
    if (!id) return null;
    const sessionId = this.chatBindings.get(id);
    if (!sessionId) return null;
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.chatBindings.delete(id);
      return null;
    }
    return { browserSessionId: session.id, chatId: id };
  }

  /**
   * Drops a chat -> session pointer that no longer names something this chat can
   * use (the session was closed, swept as idle, lost in a restart, or belongs to
   * another workspace). Only the pointer is removed, never the session, so no
   * owner/workspace/chat scope is widened by this call.
   * @param {string} chatId
   * @param {string} [sessionId] - When given, the pointer is dropped only if it
   *   still names this session, so a newer binding is never erased.
   * @returns {boolean} true when a pointer was removed
   */
  clearChatBinding(chatId, sessionId = '') {
    const id = String(chatId || '').trim();
    if (!id) return false;
    const pointer = this.chatBindings.get(id);
    if (!pointer) return false;
    if (sessionId && pointer !== String(sessionId)) return false;
    this.chatBindings.delete(id);
    const session = this.sessions.get(pointer);
    // Keep both sides of the pair consistent: a session that still claims this
    // chat would otherwise stay un-adoptable while nothing points at it, and its
    // own later close would delete a newer binding for the same chat.
    if (session && session.chatId === id) session.chatId = '';
    return true;
  }

  /**
   * Registers a live `/ws-browser` subscriber for a session and returns its
   * release function. The count lives on the manager so `sweepIdle()` can see it
   * without `ws-handler.js` being imported back here.
   * @param {string} sessionId
   * @param {string} subscriberId
   * @returns {() => void}
   */
  addWsSubscriber(sessionId, subscriberId) {
    const id = String(sessionId || '');
    const socketId = String(subscriberId || '');
    if (!id || !socketId) return () => {};
    if (!this.wsSubscribers.has(id)) this.wsSubscribers.set(id, new Set());
    this.wsSubscribers.get(id).add(socketId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.removeWsSubscriber(id, socketId);
    };
  }

  /**
   * @param {string} sessionId
   * @param {string} subscriberId
   */
  removeWsSubscriber(sessionId, subscriberId) {
    const id = String(sessionId || '');
    const sockets = this.wsSubscribers.get(id);
    if (!sockets) return;
    sockets.delete(String(subscriberId || ''));
    if (sockets.size === 0) this.wsSubscribers.delete(id);
  }

  /**
   * @param {string} sessionId
   * @returns {boolean}
   */
  hasLiveWsSubscriber(sessionId) {
    const sockets = this.wsSubscribers.get(String(sessionId || ''));
    return Boolean(sockets && sockets.size > 0);
  }

  /**
   * Keepalive touch for a caller that holds only the session id (the `/ws-browser`
   * `ping`). An unknown session is ignored instead of throwing: a keepalive must
   * never turn into an error frame.
   * @param {string} sessionId
   * @returns {boolean}
   */
  touchSessionById(sessionId) {
    const session = this.sessions.get(String(sessionId || ''));
    if (!session || session.closing) return false;
    this.touch(session);
    return true;
  }

  /**
   * @param {any} session
   * @param {string} [reason]
   */
  async closeSession(sessionId, ownerSessionId, options = {}) {
    const session = this.sessions.get(String(sessionId || ''));
    if (!session) return { closed: false };
    if (ownerSessionId && session.ownerSessionId !== ownerSessionId) {
      throw new BrowserError('forbidden-owner', 'Browser session belongs to another Cretli session', 403);
    }
    // When the caller knows the workspace (REST/DELETE), a session may only be
    // closed from inside its own workspace. Internal lifecycle calls omit scope.
    const reqKey = this.resolveWorkspaceKey(options.scope || {});
    if (reqKey) {
      const sessionKey = String(session.workspaceKey || '').trim();
      if (sessionKey && sessionKey !== reqKey) {
        throw new BrowserError('forbidden-workspace', 'Browser session belongs to another workspace', 403);
      }
    }
    if (session.closing) return { closed: true };
    session.closing = true;
    this.sessions.delete(session.id);
    this.wsSubscribers.delete(session.id);
    if (session.chatId) this.chatBindings.delete(session.chatId);
    if (session.idleTimer) this.clearTimeoutFn(session.idleTimer);
    this.tabChains.delete(session.id);
    try {
      this.metrics?.recordSessionClose(session.workspaceKey, {
        lifetimeMs: this.now() - session.createdAt,
        at: this.now(),
      });
    } catch {
      // metrics must never break teardown
    }
    this._removePid(session);

    for (const tab of session.tabs.values()) {
      tab.console.clear();
      tab.network.clear();
      this.clearPendingDialogs(tab, 'session-closed');
      tab.dialogs?.clear?.();
      await this.detachCdpSession(tab);
    }
    const tabCount = session.tabs.size;
    session.tabs.clear();

    // Capture the live cookies/localStorage before the context closes. This is
    // best-effort and bounded; a failure only means the session stays ephemeral.
    await this.persistSessionStorageState(session);
    // Opt-in HAR: flush the redacted archive before the buffers are gone.
    this.persistSessionHar(session);
    await this.gracefulClose(session, options.reason || 'closed');
    // Screenshots for this chat may contain sensitive page content; drop them
    // once the session is gone. No-op when the session was never chat-bound.
    if (session.chatId) removeBrowserScreenshots(session.chatId);
    return { closed: true, tabs: tabCount, reason: options.reason || 'closed' };
  }

  /**
   * Graceful close bounded by a hard timeout, then a best-effort process-tree
   * kill when Chromium is still connected. Never hangs, never rejects.
   * @param {any} session
   * @param {string} reason
   */
  async gracefulClose(session, reason) {
    const hard = Number(this.limits.CLOSE_HARD_TIMEOUT_MS) > 0
      ? Number(this.limits.CLOSE_HARD_TIMEOUT_MS)
      : 3000;
    const grace = Number(this.limits.GRACE_CLOSE_MS) > 0 ? Number(this.limits.GRACE_CLOSE_MS) : 2000;
    const closeContext = () => Promise.resolve()
      .then(() => session.context?.close?.())
      .catch(() => {});
    const closeBrowser = () => Promise.resolve()
      .then(() => session.browser?.close?.())
      .catch(() => {});

    // First attempt may race the grace period; the hard timeout bounds it.
    await this.withHardTimeout(
      Promise.all([closeContext(), closeBrowser()]),
      Math.min(grace, hard),
    );
    // Second, always-bounded attempt for anything left behind.
    await this.withHardTimeout(closeContext(), hard);
    await this.withHardTimeout(closeBrowser(), hard);
    // Last resort: kill the Chromium tree if it is still alive.
    this.killBrowserTree(session);
    void reason;
  }

  /** Closes every session (server restart/shutdown). */
  async closeAll(reason = 'shutdown') {
    const ids = [...this.sessions.keys()];
    const hard = Number(this.limits.CLOSE_HARD_TIMEOUT_MS) > 0
      ? Number(this.limits.CLOSE_HARD_TIMEOUT_MS)
      : 3000;
    const results = await Promise.allSettled(ids.map((id) => {
      const session = this.sessions.get(id);
      // closeAll is a hard shutdown path: bound every session separately so one
      // wedged Chromium cannot delay the whole server exit.
      return this.withHardTimeout(
        this.closeSession(id, session?.ownerSessionId, { reason }),
        hard * 4,
      );
    }));
    this.chatBindings.clear();
    return results.length;
  }

  /**
   * Kills Chromium processes left behind by a previous Cretli process. Reads the
   * persisted PID list, keeps only entries that are both alive and identifiable
   * as Chromium, kills their trees, then clears the store. Idempotent and never
   * throws: a corrupt store must not stop the server from booting.
   * @returns {Promise<{ checked: number, killed: number }>}
   */
  async startupSweep() {
    let checked = 0;
    let killed = 0;
    try {
      let entries = [];
      try {
        entries = this.pidStore?.read?.() || [];
      } catch {
        entries = [];
      }
      if (!Array.isArray(entries)) entries = [];
      for (const entry of entries) {
        const pid = Number(entry?.pid);
        if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
        checked += 1;
        let alive = false;
        try {
          alive = this.isProcessAlive(pid) === true;
        } catch {
          alive = false;
        }
        if (!alive) continue;
        let chromium = true;
        try {
          chromium = this.looksLikeChromium(pid) === true;
        } catch {
          chromium = false;
        }
        if (!chromium) continue;
        try {
          if (this.killTree(pid) !== false) killed += 1;
        } catch {
          // already gone / not permitted; do not fail the whole sweep
        }
      }
      try {
        this.pidStore?.clear?.();
      } catch {
        // best-effort
      }
    } catch {
      // The sweep is advisory; boot must continue regardless.
    }
    try {
      this.metrics?.recordOrphanSweep({ checked, killed });
    } catch {
      // metrics must never break boot
    }
    return { checked, killed };
  }

  /** Closes sessions idle for longer than the configured timeout. */
  sweepIdle() {
    const now = this.now();
    const closed = [];
    for (const session of [...this.sessions.values()]) {
      if (now - session.lastActivityAt < this.limits.IDLE_TIMEOUT_MS) continue;
      // Someone is still watching this session over `/ws-browser`. A panel or an
      // agent that only reads state was otherwise torn down after one idle
      // timeout, which blanked a live preview that was never really abandoned.
      if (this.hasLiveWsSubscriber(session.id)) continue;
      closed.push(session.id);
      void this.closeSession(session.id, session.ownerSessionId, { reason: 'idle-timeout' });
    }
    return closed;
  }

  /**
   * @param {any} session
   */
  touch(session) {
    session.lastActivityAt = this.now();
  }

  /**
   * @param {any} session
   */
  summarizeSession(session) {
    return {
      browserSessionId: session.id,
      workspaceFile: session.workspaceFile,
      workspaceFolder: session.workspaceFolder,
      cwd: session.cwd,
      chatId: session.chatId || null,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
      activeTabId: session.activeTabId,
      tabs: [...session.tabs.values()].map((tab) => this.summarizeTab(session, tab)),
      // HAR is opt-in per session/workspace; the summary exposes only the flag
      // and metadata, never entries, headers or cookies.
      recordHar: Boolean(session.har?.enabled),
      har: session.har ? session.har.status() : { enabled: false },
      active: true,
    };
  }

  /**
   * @param {any} session
   * @param {any} tab
   */
  summarizeTab(session, tab) {
    let url = tab.url;
    if (!url && typeof tab.page.url === 'function') {
      try {
        url = tab.page.url();
      } catch {
        url = '';
      }
    }
    return {
      browserSessionId: session.id,
      browserTabId: tab.id,
      url: redactUrl(url),
      title: redactText(tab.title || ''),
      active: session.activeTabId === tab.id,
      createdAt: tab.createdAt,
      isPopup: tab.isPopup === true,
      consoleCount: tab.console.entries.length,
      networkCount: tab.network.entries.length,
      // A pending dialog blocks the page's own script, so the tab strip has to
      // show that one is open even when the caller only listed tabs.
      pendingDialogCount: tab.pendingDialogs instanceof Map ? tab.pendingDialogs.size : 0,
    };
  }

  /**
   * @param {any} browser
   */
  async safeCloseBrowser(browser) {
    try {
      await browser?.close?.();
    } catch {
      // ignore
    }
  }
}
