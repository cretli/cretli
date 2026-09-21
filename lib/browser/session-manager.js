/**
 * BrowserSessionManager — server-side Chromium sessions for the Browser module.
 *
 * Responsibilities (P0 plan):
 * - one BrowserContext per session, one Page per tab, isolated per owner;
 * - auth/workspace scoping contract (foreign session/workspace => 403);
 * - per-session and per-tab limits;
 * - URL/SSRF policy applied to every request/redirect/subresource;
 * - redacted bounded Console/Network buffers;
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
import { BROWSER_LIMITS, BROWSER_SCREENSHOT_QUALITY, DEFAULT_BLOCKED_PORTS } from './constants.js';
import { ConsoleBuffer, NetworkBuffer } from './buffers.js';
import {
  evaluateUrlPolicy,
  buildHostResolverRules,
  parseHttpUrl,
  normalizeHostname,
  normalizeOrigin,
} from './url-policy.js';
import { redactText, redactUrl, isSensitiveHeaderName } from './redaction.js';
import { killProcessTree } from './process-tree.js';

export class BrowserError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} [status]
   */
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'BrowserError';
    this.code = code;
    this.status = status;
  }
}

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
   *   now?: () => number,
   *   setIntervalFn?: Function,
   *   clearIntervalFn?: Function,
   *   setTimeoutFn?: Function,
   *   clearTimeoutFn?: Function,
   * }} [options]
   */
  constructor(options = {}) {
    this.driver = options.driver || null;
    this.driverStatus = options.driverStatus || {};
    this.instanceId = options.instanceId || randomUUID();
    this.limits = options.limits || BROWSER_LIMITS;
    this.dataDir = options.dataDir || '';
    this.resolvePolicy = typeof options.resolvePolicy === 'function'
      ? options.resolvePolicy
      : () => ({ allowedOrigins: [], blockedPorts: [], unblockedPorts: [] });
    this.blockedPorts = Array.isArray(options.blockedPorts) ? options.blockedPorts : [];
    // Cretli's own origin(s) (direct loopback URL and configured public origin)
    // are always denied, even when a workspace allowlists them.
    this.selfOrigins = Array.isArray(options.selfOrigins)
      ? options.selfOrigins.map((origin) => normalizeOrigin(origin)).filter(Boolean)
      : [];
    this.lookup = typeof options.lookup === 'function' ? options.lookup : undefined;
    this.killTree = typeof options.killTree === 'function' ? options.killTree : killProcessTree;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.setIntervalFn = options.setIntervalFn || setInterval;
    this.clearIntervalFn = options.clearIntervalFn || clearInterval;
    this.setTimeoutFn = options.setTimeoutFn || setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
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
    this.sweepTimer = null;
  }

  /** @returns {boolean} */
  isAvailable() {
    return Boolean(this.driver);
  }

  /** @returns {object} */
  getRuntimeStatus() {
    return {
      available: Boolean(this.driver),
      status: this.driver ? 'available' : (this.driverStatus.status || 'browser-unavailable'),
      reason: this.driver ? 'ok' : (this.driverStatus.reason || 'Browser runtime unavailable'),
      version: this.driverStatus.version || null,
      executablePath: this.driverStatus.executablePath || null,
      sandboxWarning: this.driverStatus.sandboxWarning || null,
      networkBoundary: this.driverStatus.networkBoundary || { mode: 'mvp-defense-in-depth', configured: true },
      limits: { ...this.limits },
    };
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
   * Detaches a tab's CDP session without ever hanging teardown: a wedged CDP
   * connection must not block close, so the detach is bounded by the same hard
   * cleanup timeout used for context/browser close. The reference is cleared
   * first so a retry sees no live session.
   * @param {any} tab
   */
  async detachCdpSession(tab) {
    const cdp = tab?.cdpSession;
    if (tab) tab.cdpSession = null;
    if (!cdp || typeof cdp.detach !== 'function') return;
    const timeout = Number(this.limits.CLOSE_HARD_TIMEOUT_MS) > 0
      ? Number(this.limits.CLOSE_HARD_TIMEOUT_MS)
      : 3000;
    await this.withHardTimeout(Promise.resolve().then(() => cdp.detach()), timeout);
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

    const owned = [...this.sessions.values()].filter((session) => session.ownerSessionId === ownerSessionId);
    if (owned.length >= this.limits.MAX_SESSIONS_PER_OWNER) {
      throw new BrowserError(
        'session-limit',
        `Maximum ${this.limits.MAX_SESSIONS_PER_OWNER} active Browser session per user/instance`,
        409,
      );
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
    try {
      const { rules, pins } = await buildHostResolverRules({
        policy: this.policyFor(workspaceKey),
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
      const sandbox = this.driverStatus.sandboxWarning ? ` ${this.driverStatus.sandboxWarning}` : '';
      throw new BrowserError(
        'browser-unavailable',
        `Could not launch Chromium: ${err?.message || String(err)}.${sandbox}`,
        503,
      );
    }

    const viewport = this.normalizeViewport(input?.viewport);
    let context;
    try {
      context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: viewport.dpr,
        hasTouch: viewport.hasTouch,
        isMobile: viewport.hasTouch,
        acceptDownloads: false,
        ignoreHTTPSErrors: false,
        // A Service Worker would bypass context.route(), so the SSRF policy
        // could not see its requests. Block them for the whole MVP.
        serviceWorkers: 'block',
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
      // The first hop reuses the original request (method/body/headers); later
      // hops are issued explicitly so each redirect target is policy-checked.
      let response = await route.fetch({ maxRedirects: 0 });
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
    const { requestId } = tab.network.recordRequest({
      method: request.method?.() || 'GET',
      url: blockedUrl || request.url?.() || '',
      resourceType: request.resourceType?.() || 'other',
      at: this.now(),
    });
    tab.network.update(requestId, {
      blocked: true,
      blockedReason: String(decision?.code || 'blocked'),
    });
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
   * @param {any} session
   * @param {any} page
   * @param {{ isPopup?: boolean }} [options]
   */
  attachPage(session, page, options = {}) {
    const existing = session.pageTabs?.get(page);
    if (existing) return existing;
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
      isPopup: options.isPopup === true,
      console: new ConsoleBuffer(),
      network: new NetworkBuffer(),
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
      tab.network.recordRequest({
        requestId,
        method: request.method?.() || 'GET',
        url: request.url?.() || '',
        resourceType: request.resourceType?.() || 'other',
        at: this.now(),
      });
    });
    page.on?.('response', (response) => {
      const request = response.request?.();
      const requestId = request ? tab.requestIds.get(request) : null;
      if (!requestId) return;
      tab.network.recordResponse(requestId, {
        status: response.status?.(),
        ok: response.ok?.(),
        at: this.now(),
      });
    });
    page.on?.('requestfailed', (request) => {
      const requestId = tab.requestIds.get(request);
      if (!requestId) return;
      tab.network.recordFailure(requestId, {
        errorText: request.failure?.()?.errorText || 'request failed',
        at: this.now(),
      });
    });
    page.on?.('dialog', (dialog) => {
      Promise.resolve(dialog.dismiss?.()).catch(() => {});
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
        }
      } catch {
        // ignore
      }
    });
    page.on?.('close', () => {
      if (session.closing) return;
      session.tabs.delete(tabId);
      if (session.activeTabId === tabId) {
        session.activeTabId = session.tabs.size > 0 ? [...session.tabs.keys()][0] : null;
      }
    });

    return tab;
  }

  /**
   * @param {string} sessionId
   * @param {string} ownerSessionId
   * @param {{ url?: string, activate?: boolean }} [input]
   * @param {{ internal?: boolean }} [options]
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
    const page = await session.context.newPage();
    const tab = this.attachPage(session, page);
    if (input.activate !== false) session.activeTabId = tab.id;
    if (input.url) {
      await this.navigate(sessionId, tab.id, input.url, ownerSessionId, options.scope || {});
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
   */
  async navigate(sessionId, tabId, rawUrl, ownerSessionId, scope = {}) {
    const { session, tab } = this.requireTab(sessionId, tabId, ownerSessionId, scope);
    const url = String(rawUrl || '').trim();
    if (!url) throw new BrowserError('invalid-url', 'Missing URL', 400);

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
        tab.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }),
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
      html = typeof tab.page.content === 'function' ? await tab.page.content() : '';
    } catch (err) {
      throw new BrowserError('dom-failed', `DOM read failed: ${err?.message || String(err)}`, 502);
    }
    const withoutExecutableContent = String(html)
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/\s(?:on[a-z]+|srcdoc)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    const maxBytes = Math.min(256 * 1024, Math.max(1024, Number(scope.maxBytes) || 128 * 1024));
    const redacted = redactText(withoutExecutableContent);
    const data = Buffer.byteLength(redacted) > maxBytes
      ? `${redacted.slice(0, maxBytes)}…`
      : redacted;
    this.touch(session);
    return { browserSessionId: session.id, browserTabId: tab.id, html: data, truncated: data.endsWith('…'), bytes: Buffer.byteLength(data) };
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
        buffer = await tab.page.screenshot({ type: 'jpeg', quality, fullPage: false });
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

  /**
   * @param {string} sessionId
   * @param {string} tabId
   * @param {string} ownerSessionId
   * @param {Record<string, any>} event
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
    const run = () => this.performInput(session, tab, event);
    const previous = tab.inputChain instanceof Promise ? tab.inputChain : Promise.resolve();
    const next = previous.then(run, run);
    tab.inputChain = next.then(() => undefined, () => undefined);
    return next;
  }

  /**
   * @param {any} session
   * @param {any} tab
   * @param {Record<string, any>} event
   */
  async performInput(session, tab, event) {
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
      if (action === 'type') await tab.page.keyboard.type(String(event.text || ''), { delay: 0 });
      else if (action === 'down') await tab.page.keyboard.down(String(event.key || ''));
      else if (action === 'up') await tab.page.keyboard.up(String(event.key || ''));
      else await tab.page.keyboard.press(String(event.key || 'Enter'));
      return { ok: true };
    }

    if (kind === 'resize') {
      const viewport = this.normalizeViewport(event.viewport || {});
      session.viewport = viewport;
      await tab.page.setViewportSize({ width: viewport.width, height: viewport.height });
      return { ok: true, viewport };
    }

    throw new BrowserError('unsupported-input', `Unsupported input kind: ${kind || '(empty)'}`, 400);
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
    return tab.console.pull(options);
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
    return tab.network.pull(options);
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
    if (session.chatId) this.chatBindings.delete(session.chatId);
    if (session.idleTimer) this.clearTimeoutFn(session.idleTimer);

    for (const tab of session.tabs.values()) {
      tab.console.clear();
      tab.network.clear();
      await this.detachCdpSession(tab);
    }
    const tabCount = session.tabs.size;
    session.tabs.clear();

    await this.gracefulClose(session, options.reason || 'closed');
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

  /** Closes sessions idle for longer than the configured timeout. */
  sweepIdle() {
    const now = this.now();
    const closed = [];
    for (const session of [...this.sessions.values()]) {
      if (now - session.lastActivityAt >= this.limits.IDLE_TIMEOUT_MS) {
        closed.push(session.id);
        void this.closeSession(session.id, session.ownerSessionId, { reason: 'idle-timeout' });
      }
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
