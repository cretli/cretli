/**
 * Live view client for the dedicated `/ws-browser` channel.
 *
 * Two frame sources are negotiated on one socket: the default pull cycle
 * (`screenshot` -> `frame` -> `frame-ack`, JSON only) and the experimental
 * screencast, where the server announces a frame in JSON and sends the JPEG as
 * the following binary WS frame. The pull cycle is always the fallback, so
 * losing streaming never means losing the picture.
 *
 * The protocol decisions (URL shape, backoff schedule, message routing,
 * frame-ack handling) are exported as pure helpers and the socket lifecycle is
 * a factory with an injected socket and timers, so both are testable without a
 * DOM. The panel owns rendering; this module owns the connection.
 */

import { BROWSER_WS_PATH } from '../../../lib/browser/constants.js';
import { pairScreencastFrame } from '../../../lib/browser/screencast.js';

/** Server close codes that end a Browser socket. */
export const BROWSER_WS_CLOSE = Object.freeze({
  MISSING_SESSION: 4400,
  LOGIN_REQUIRED: 4401,
  FORBIDDEN: 4403,
  SESSION_GONE: 4404,
});

const STOP_CLOSE_CODES = new Set([BROWSER_WS_CLOSE.MISSING_SESSION, BROWSER_WS_CLOSE.FORBIDDEN]);
const RESYNC_CLOSE_CODES = new Set([BROWSER_WS_CLOSE.LOGIN_REQUIRED, BROWSER_WS_CLOSE.SESSION_GONE]);

/**
 * A policy reject (`stop`) cannot be fixed by dialling again, so reconnecting
 * would spin forever; a lost login or session (`resync`) means the in-memory
 * session list moved on and the panel must reload it before reconnecting.
 * Anything else — including a bare socket drop after a server restart — is
 * retried with backoff.
 * @param {number} code
 * @returns {'stop' | 'resync' | 'retry'}
 */
export function classifyBrowserWsClose(code) {
  const value = Number(code);
  if (STOP_CLOSE_CODES.has(value)) return 'stop';
  if (RESYNC_CLOSE_CODES.has(value)) return 'resync';
  return 'retry';
}

/**
 * Builds the channel URL the way the other Cretli sockets do (`ws:`/`wss:` from
 * `location.protocol` + `location.host`). Auth rides on the ordinary session
 * cookie, so no subprotocol and no widget token are ever used here.
 * @param {{ sessionId?: string, tabId?: string, protocol?: string, host?: string }} [options]
 * @returns {string}
 */
export function buildBrowserWsUrl(options = {}) {
  const pageProtocol = options.protocol
    || (typeof location !== 'undefined' ? location.protocol : 'http:');
  const pageHost = options.host !== undefined
    ? options.host
    : (typeof location !== 'undefined' ? location.host : '');
  const query = new URLSearchParams();
  if (options.sessionId) query.set('session', String(options.sessionId));
  if (options.tabId) query.set('tab', String(options.tabId));
  const suffix = query.toString();
  return `${pageProtocol === 'https:' ? 'wss:' : 'ws:'}//${pageHost}${BROWSER_WS_PATH}${suffix ? `?${suffix}` : ''}`;
}

/**
 * Growing reconnect delay, capped so a long outage settles at `maxMs` instead of
 * doubling forever.
 * @param {number} attempt Zero-based consecutive failure count.
 * @param {{ baseMs?: number, maxMs?: number }} [options]
 * @returns {number}
 */
export function browserWsReconnectDelayMs(attempt, options = {}) {
  const baseMs = Number(options.baseMs) > 0 ? Number(options.baseMs) : 600;
  const maxMs = Number(options.maxMs) > 0 ? Number(options.maxMs) : 15000;
  const index = Math.max(0, Math.floor(Number(attempt) || 0));
  // Clamped exponent: 2 ** index runs into Infinity long before the cap does.
  return Math.min(maxMs, Math.round(baseMs * (2 ** Math.min(index, 16))));
}

/**
 * Normalizes one inbound message into a routing decision.
 *
 * The server answers a `pull` with `type: 'console'` for both channels, so a
 * `network` message type never exists: the channel field is the only
 * discriminator and the entries ride nested under `payload`.
 * @param {unknown} message
 * @returns {{ kind: string, [key: string]: any }}
 */
export function resolveBrowserWsRoute(message) {
  const type = String(message?.type || '');
  if (type === 'frame') {
    return { kind: 'frame', frame: message?.frame ?? null, requestId: message?.requestId ?? null };
  }
  if (type === 'frame-skipped') {
    return {
      kind: 'frame-skipped',
      reason: String(message?.reason || ''),
      requestId: message?.requestId ?? null,
    };
  }
  if (type === 'state') return { kind: 'state', state: message?.state ?? null };
  if (type === 'console') {
    const channel = String(message?.channel || '') === 'network' ? 'network' : 'console';
    return { kind: 'pull', channel, payload: message?.payload ?? {}, requestId: message?.requestId ?? null };
  }
  if (type === 'error') {
    return {
      kind: 'error',
      code: String(message?.code || ''),
      error: String(message?.error || ''),
      requestId: message?.requestId ?? null,
    };
  }
  if (type === 'ready') {
    return {
      kind: 'ready',
      limits: message?.limits ?? null,
      tabId: String(message?.browserTabId || ''),
      screencast: message?.screencast ?? null,
    };
  }
  // The streaming path announces a frame in JSON and sends the JPEG as the next
  // binary frame, so this route only carries the header.
  if (type === 'screencast-frame') {
    return { kind: 'screencast-frame', header: message ?? null, seq: Number(message?.seq) };
  }
  if (type === 'screencast-mode') {
    return {
      kind: 'screencast-mode',
      mode: String(message?.mode || ''),
      reason: String(message?.reason || ''),
      status: message?.status ?? null,
    };
  }
  if (type === 'screencast-target') {
    return { kind: 'screencast-target', target: message?.target ?? null, applied: message?.applied ?? null };
  }
  if (type === 'screencast-dropped') {
    return { kind: 'screencast-dropped', seq: Number(message?.seq) };
  }
  if (type === 'ack') return { kind: 'ack', op: String(message?.op || ''), requestId: message?.requestId ?? null };
  if (type === 'pong') return { kind: 'pong', at: message?.at ?? null };
  if (type === 'ping') return { kind: 'ping' };
  return { kind: 'ignore', type };
}

/** Message types the server runs through the fail-closed Browser action guard. */
export const BROWSER_WS_MUTATION_TYPES = Object.freeze(new Set(['input', 'navigate', 'close-tab']));

/**
 * The guard rejects a mutation without an effective mode (`mode-required`), so
 * every mutating message must carry the same `mode` + `chatId` pair the REST
 * layer appends. Read messages (`screenshot`, `state`, `pull`) need neither.
 * @param {Record<string, any>} message
 * @param {{ mode?: string, chatId?: string }} [context]
 * @returns {Record<string, any>}
 */
export function withBrowserWsGuardContext(message, context = {}) {
  if (!BROWSER_WS_MUTATION_TYPES.has(String(message?.type || ''))) return message;
  const next = { ...message };
  const mode = String(context?.mode || '').trim();
  const chatId = String(context?.chatId || '').trim();
  if (mode) next.mode = mode;
  if (chatId) next.chatId = chatId;
  return next;
}

/**
 * Only a delivered frame holds one slot in the server's `pendingFrames` map, so
 * only a frame is acknowledged. A `frame-skipped` answer means nothing is
 * pending, and acking it could free a slot another tab owns.
 * @param {unknown} message
 * @returns {boolean}
 */
export function shouldAckBrowserWsFrame(message) {
  return resolveBrowserWsRoute(message).kind === 'frame';
}

/**
 * @param {string} tabId
 * @returns {{ type: 'frame-ack', browserTabId: string }}
 */
export function buildBrowserWsFrameAck(tabId) {
  return { type: 'frame-ack', browserTabId: String(tabId || '') };
}

/**
 * @param {string} tabId
 * @param {number} seq
 * @returns {{ type: 'screencast-ack', browserTabId: string, seq: number }}
 */
export function buildBrowserScreencastAck(tabId, seq) {
  return { type: 'screencast-ack', browserTabId: String(tabId || ''), seq: Number(seq) || 0 };
}

/**
 * The viewer never asks for a mode the server did not offer: `available` from
 * `ready.screencast` gates this message, and `caps.binary` states what the socket
 * can actually read. The server re-checks its own flag either way.
 * @param {{ tabId?: string, binary?: boolean, fps?: number, quality?: number }} [options]
 * @returns {Record<string, any>}
 */
export function buildBrowserScreencastStart(options = {}) {
  const message = {
    type: 'screencast-start',
    browserTabId: String(options.tabId || ''),
    caps: { binary: options.binary !== false },
  };
  if (Number.isFinite(Number(options.fps))) message.fps = Number(options.fps);
  if (Number.isFinite(Number(options.quality))) message.quality = Number(options.quality);
  return message;
}

/**
 * @param {string} tabId
 * @returns {{ type: 'screencast-stop', browserTabId: string }}
 */
export function buildBrowserScreencastStop(tabId) {
  return { type: 'screencast-stop', browserTabId: String(tabId || '') };
}

/**
 * A WS payload that is not a string is either an `ArrayBuffer` (what a socket with
 * `binaryType = 'arraybuffer'` delivers) or a typed view. Anything else — notably a
 * `Blob`, which is what a socket that cannot be configured delivers — returns null,
 * and the caller treats that as "this client cannot read pushed frames".
 * @param {unknown} payload
 * @returns {Uint8Array|null}
 */
export function browserWsBytesFromPayload(payload) {
  if (typeof ArrayBuffer === 'undefined') return null;
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  if (ArrayBuffer.isView(payload)) {
    return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  return null;
}

/**
 * @param {ArrayBufferView|ArrayBuffer} bytes
 * @returns {string}
 */
export function browserBytesToBase64(bytes) {
  const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  if (typeof btoa !== 'function') return '';
  let binary = '';
  // Chunked so a large frame cannot blow the argument list of a single
  // String.fromCharCode(...view) spread.
  const chunkSize = 8192;
  for (let i = 0; i < view.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, view.subarray(i, i + chunkSize));
  }
  try {
    return btoa(binary);
  } catch {
    return '';
  }
}

/**
 * Turns one screencast pair (JSON header + bytes) into the frame shape the panel
 * already renders for a pulled screenshot, so the streaming mode needs no second
 * render path. Returns null when the pair does not line up, which is a protocol
 * break and a documented trigger for falling back to the pull cycle.
 * @param {Record<string, any>|null} header
 * @param {Uint8Array|null} bytes
 * @returns {Record<string, any>|null}
 */
export function browserScreencastFrame(header, bytes) {
  const paired = pairScreencastFrame(header, bytes?.byteLength ?? 0);
  if (!paired || !bytes) return null;
  const frame = {
    browserTabId: String(header?.browserTabId || ''),
    mimeType: String(header?.mimeType || 'image/jpeg'),
    bytes: paired.byteLength,
    data: browserBytesToBase64(bytes),
    seq: paired.seq,
    stream: 'screencast',
  };
  if (Number.isFinite(Number(header?.width))) frame.width = Number(header.width);
  if (Number.isFinite(Number(header?.height))) frame.height = Number(header.height);
  if (Number.isFinite(Number(header?.capturedAt))) frame.at = Number(header.capturedAt);
  if (Number.isFinite(Number(header?.frameIndex))) frame.frameIndex = Number(header.frameIndex);
  return frame;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Socket lifecycle for the live view: open, poll frames and pulls, keepalive
 * ping, reconnect with backoff, and tear everything down when the panel is not
 * shown. Every timer re-checks `isActive()` before firing, so no loop can
 * survive a panel switch or a close.
 *
 * @param {{
 *   WebSocketImpl?: any,
 *   setTimeoutFn?: (fn: () => void, ms: number) => any,
 *   clearTimeoutFn?: (handle: any) => void,
 *   isActive?: () => boolean,
 *   getGuardContext?: () => { mode?: string, chatId?: string },
 *   getPullCursors?: () => { console?: number, network?: number },
 *   pullLimit?: number,
 *   frameIntervalMs?: number,
 *   pullIntervalMs?: number,
 *   keepaliveIntervalMs?: number,
 *   reconnectBaseMs?: number,
 *   reconnectMaxMs?: number,
 *   binaryFrames?: boolean,
 *   screencastFps?: number,
 *   screencastQuality?: number,
 *   handlers?: {
 *     onOpen?: (reconnect: boolean) => void,
 *     onClose?: () => void,
 *     onReady?: (route: { limits: any, tabId: string, screencast: any }) => void,
 *     onFrame?: (frame: any) => void,
 *     onFrameSkipped?: (route: { reason: string }) => void,
 *     onScreencastMode?: (info: { mode: string, reason: string, status: any }) => void,
 *     onScreencastTarget?: (route: { target: any, applied: any }) => void,
 *     onScreencastDropped?: (route: { seq: number }) => void,
 *     onState?: (state: any) => void,
 *     onPull?: (channel: 'console' | 'network', payload: any) => void,
 *     onError?: (route: { code: string, error: string, requestId: any }) => void,
 *     onAck?: (route: { op: string }) => void,
 *     onReconnecting?: (info: { delayMs: number, attempt: number }) => void,
 *     onResync?: (info: { code: number, reason: string }) => void,
 *     onStop?: (info: { code: number, reason: string }) => void,
 *   },
 * }} [options]
 */
export function createBrowserWsClient(options = {}) {
  const handlers = options.handlers || {};
  const setTimeoutFn = typeof options.setTimeoutFn === 'function' ? options.setTimeoutFn : null;
  const clearTimeoutFn = typeof options.clearTimeoutFn === 'function' ? options.clearTimeoutFn : null;
  const isActive = typeof options.isActive === 'function' ? options.isActive : () => true;
  const frameIntervalMs = positiveNumber(options.frameIntervalMs, 1000);
  const pullIntervalMs = positiveNumber(options.pullIntervalMs, 2000);
  const keepaliveIntervalMs = positiveNumber(options.keepaliveIntervalMs, 20000);
  const reconnectBaseMs = positiveNumber(options.reconnectBaseMs, 600);
  const reconnectMaxMs = positiveNumber(options.reconnectMaxMs, 15000);
  const pullLimit = positiveNumber(options.pullLimit, 100);
  // Streaming is opt-out for the client: a host that cannot read binary WS
  // frames sets this false and the pull cycle stays the only path.
  const binaryFrames = options.binaryFrames !== false;

  /** @type {{ sessionId: string, tabId: string }} */
  let target = { sessionId: '', tabId: '' };
  /** @type {any} */
  let socket = null;
  let connected = false;
  let attempt = 0;
  let framePending = false;
  let requestSeq = 0;
  /** @type {'pull' | 'screencast'} */
  let liveMode = 'pull';
  /** The JSON control message that announced the binary frame expected next. */
  let pendingScreencastHeader = null;
  /** @type {Record<string, any>|null} Last `ready.screencast` / status seen. */
  let screencastInfo = null;
  const screencastCounters = { frames: 0, dropped: 0, breaks: 0 };
  /** @type {Record<string, any>} */
  const timers = { reconnect: null, frame: null, pull: null, keepalive: null };

  /**
   * @param {'reconnect' | 'frame' | 'pull' | 'keepalive'} key
   */
  function clearTimer(key) {
    if (timers[key] == null) return;
    if (clearTimeoutFn) clearTimeoutFn(timers[key]);
    timers[key] = null;
  }

  function clearAllTimers() {
    clearTimer('reconnect');
    clearTimer('frame');
    clearTimer('pull');
    clearTimer('keepalive');
  }

  /**
   * @param {'reconnect' | 'frame' | 'pull' | 'keepalive'} key
   * @param {() => void} fn
   * @param {number} ms
   */
  function schedule(key, fn, ms) {
    clearTimer(key);
    if (!setTimeoutFn) return;
    timers[key] = setTimeoutFn(() => {
      timers[key] = null;
      // A timer must never outlive the panel: the user can switch tabs while it
      // is pending, and a loop running in the background is what this prevents.
      if (!isActive()) {
        close('panel-inactive');
        return;
      }
      fn();
    }, ms);
  }

  /**
   * @param {Record<string, any>} message
   * @returns {boolean}
   */
  function send(message) {
    if (!connected || !socket) return false;
    const context = typeof options.getGuardContext === 'function' ? options.getGuardContext() : {};
    try {
      socket.send(JSON.stringify(withBrowserWsGuardContext(message, context)));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * @param {string} prefix
   * @returns {string}
   */
  function nextRequestId(prefix) {
    requestSeq += 1;
    return `${prefix}-${requestSeq}`;
  }

  function pollFrame() {
    if (!connected) return;
    // While the server pushes frames the poll stays armed but silent: it is the
    // safety net a fallback switches back to without re-scheduling anything.
    if (liveMode === 'screencast') {
      schedule('frame', pollFrame, frameIntervalMs);
      return;
    }
    // The server answers a second request while one frame is still unacknowledged
    // with `frame-skipped`, so a tick is skipped while ours is in flight.
    if (!framePending) {
      framePending = send({
        type: 'screenshot',
        browserTabId: target.tabId,
        requestId: nextRequestId('frame'),
      });
    }
    schedule('frame', pollFrame, frameIntervalMs);
  }

  /**
   * Records the mode the server is actually serving and tells the panel, because
   * an automatic fallback has to be visible (and measurable) to be honest.
   * @param {string} mode
   * @param {string} reason
   * @param {Record<string, any>|null} [status]
   */
  function applyLiveMode(mode, reason, status) {
    const next = mode === 'screencast' ? 'screencast' : 'pull';
    if (status) screencastInfo = status;
    const changed = next !== liveMode;
    liveMode = next;
    if (next === 'screencast') pendingScreencastHeader = null;
    if (!changed && !reason) return;
    if (typeof handlers.onScreencastMode === 'function') {
      handlers.onScreencastMode({ mode: next, reason: reason || '', status: status || null });
    }
  }

  /**
   * Asks for pushed frames. Only ever sent after the server said the mode is
   * available, so a client cannot turn streaming on for itself.
   * @param {Record<string, any>|null} info
   */
  function requestScreencast(info) {
    if (!binaryFrames || !info?.available) return false;
    return send(buildBrowserScreencastStart({
      tabId: target.tabId,
      binary: true,
      fps: options.screencastFps,
      quality: options.screencastQuality,
    }));
  }

  /**
   * Gives up on streaming for this connection: the producer is stopped rather
   * than ignored, so the server is not pushing bytes to a socket that cannot read
   * them, and the pull cycle resumes on the next tick.
   * @param {string} reason
   */
  function breakScreencast(reason) {
    screencastCounters.breaks += 1;
    if (liveMode === 'screencast') send(buildBrowserScreencastStop(target.tabId));
    pendingScreencastHeader = null;
    applyLiveMode('pull', reason, screencastInfo);
  }

  /**
   * Pairs one binary WS frame with the control message that announced it and hands
   * the panel the same frame shape the pull path uses.
   * @param {unknown} payload
   */
  function handleScreencastPayload(payload) {
    const header = pendingScreencastHeader;
    pendingScreencastHeader = null;
    const bytes = browserWsBytesFromPayload(payload);
    const frame = browserScreencastFrame(header, bytes);
    if (!frame) {
      breakScreencast('binary-unreadable');
      return false;
    }
    screencastCounters.frames += 1;
    if (typeof handlers.onFrame === 'function') handlers.onFrame(frame);
    // The ack is what frees the server's window slot, so it goes out after the
    // panel has the frame: a panel that cannot keep up shows up as collapsed
    // frames and a lower rate, not as a growing queue.
    send(buildBrowserScreencastAck(frame.browserTabId || target.tabId, frame.seq));
    return true;
  }

  function pollPull() {
    if (!connected) {
      return;
    }
    const cursors = typeof options.getPullCursors === 'function' ? options.getPullCursors() : {};
    const consoleSince = Number(cursors.console) || 0;
    const networkSince = Number(cursors.network) || 0;
    send({
      type: 'pull',
      channel: 'console',
      browserTabId: target.tabId,
      since: consoleSince,
      limit: pullLimit,
      requestId: nextRequestId('console'),
    });
    send({
      type: 'pull',
      channel: 'network',
      browserTabId: target.tabId,
      since: networkSince,
      limit: pullLimit,
      requestId: nextRequestId('network'),
    });
    send({ type: 'state', browserTabId: target.tabId, requestId: nextRequestId('state') });
    schedule('pull', pollPull, pullIntervalMs);
  }

  function keepalive() {
    if (!connected) return;
    send({ type: 'ping' });
    schedule('keepalive', keepalive, keepaliveIntervalMs);
  }

  function startLoops() {
    schedule('frame', pollFrame, frameIntervalMs);
    schedule('pull', pollPull, pullIntervalMs);
    schedule('keepalive', keepalive, keepaliveIntervalMs);
  }

  function scheduleReconnect() {
    const delayMs = browserWsReconnectDelayMs(attempt, { baseMs: reconnectBaseMs, maxMs: reconnectMaxMs });
    attempt += 1;
    if (typeof handlers.onReconnecting === 'function') handlers.onReconnecting({ delayMs, attempt });
    schedule('reconnect', () => open(), delayMs);
  }

  /**
   * @param {any} message
   */
  function handleMessage(message) {
    const route = resolveBrowserWsRoute(message);
    if (route.kind === 'ignore') return;
    if (route.kind === 'ready') {
      // A confirmed `ready` is the only proof the channel is usable again, so it
      // is also where the backoff is reset.
      attempt = 0;
      if (route.screencast) screencastInfo = route.screencast;
      if (typeof handlers.onReady === 'function') handlers.onReady(route);
      // Streaming is requested only when the server offered it in `ready`.
      requestScreencast(route.screencast || null);
      return;
    }
    if (route.kind === 'screencast-frame') {
      // The bytes of this frame are the next binary message; the header is held
      // only until they arrive (or until a collapse or stop clears it).
      pendingScreencastHeader = route.header;
      return;
    }
    if (route.kind === 'screencast-mode') {
      applyLiveMode(route.mode, route.reason, route.status);
      return;
    }
    if (route.kind === 'screencast-target') {
      screencastInfo = { ...(screencastInfo || {}), target: route.target, applied: route.applied };
      if (typeof handlers.onScreencastTarget === 'function') handlers.onScreencastTarget(route);
      return;
    }
    if (route.kind === 'screencast-dropped') {
      screencastCounters.dropped += 1;
      if (pendingScreencastHeader
        && Number(pendingScreencastHeader.seq) === Number(route.seq)) {
        // Its blob will never arrive, so it must not be paired with a later frame.
        pendingScreencastHeader = null;
      }
      if (typeof handlers.onScreencastDropped === 'function') handlers.onScreencastDropped(route);
      return;
    }
    if (route.kind === 'frame') {
      framePending = false;
      if (typeof handlers.onFrame === 'function') handlers.onFrame(route.frame);
      send(buildBrowserWsFrameAck(route.frame?.browserTabId || target.tabId));
      return;
    }
    if (route.kind === 'frame-skipped') {
      framePending = false;
      if (typeof handlers.onFrameSkipped === 'function') handlers.onFrameSkipped(route);
      return;
    }
    if (route.kind === 'state') {
      if (typeof handlers.onState === 'function') handlers.onState(route.state);
      return;
    }
    if (route.kind === 'pull') {
      if (typeof handlers.onPull === 'function') handlers.onPull(route.channel, route.payload);
      return;
    }
    if (route.kind === 'error') {
      // A failed frame request must not hold the in-flight slot forever.
      if (String(route.requestId || '').startsWith('frame-')) framePending = false;
      if (typeof handlers.onError === 'function') handlers.onError(route);
      return;
    }
    if (route.kind === 'ack') {
      if (typeof handlers.onAck === 'function') handlers.onAck(route);
      return;
    }
    // `ping`/`pong` only prove the socket is alive; the keepalive loop already
    // runs, so there is nothing else to do with them.
  }

  /**
   * Opens the channel, or re-points a live one onto another tab of the same
   * session instead of stacking a second socket onto the same tab.
   * @param {{ sessionId?: string, tabId?: string }} [next]
   */
  function open(next = {}) {
    const nextSession = next.sessionId === undefined ? target.sessionId : String(next.sessionId || '');
    const nextTab = next.tabId === undefined ? target.tabId : String(next.tabId || '');
    if (!nextSession) {
      close('no-session');
      return;
    }
    if (nextSession === target.sessionId && connected) {
      if (nextTab && nextTab !== target.tabId) switchTab(nextTab);
      return;
    }
    if (nextSession !== target.sessionId) close('session-changed');
    target = { sessionId: nextSession, tabId: nextTab || target.tabId };
    if (!isActive()) return;
    if (socket) return;
    const Impl = options.WebSocketImpl
      || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    if (!Impl) return;
    clearTimer('reconnect');
    try {
      socket = new Impl(buildBrowserWsUrl({ sessionId: target.sessionId, tabId: target.tabId }));
    } catch {
      socket = null;
    }
    if (!socket) {
      scheduleReconnect();
      return;
    }
    const current = socket;
    if (binaryFrames) {
      // Pairing a JSON header with a raw frame only works when the payload lands
      // as bytes we can size synchronously; the default `blob` delivery cannot.
      try {
        current.binaryType = 'arraybuffer';
      } catch {
        // A socket that refuses the setting is handled as a non-binary client.
      }
    }

    current.onopen = () => {
      if (socket !== current) return;
      connected = true;
      // Non-zero `attempt` means this open followed a drop, so the panel should
      // re-read the (in-memory) session list instead of trusting its stale ids.
      if (typeof handlers.onOpen === 'function') handlers.onOpen(attempt > 0);
      startLoops();
    };
    current.onmessage = (event) => {
      if (socket !== current) return;
      const data = event?.data;
      if (typeof data !== 'string') {
        // Inbound control traffic stays JSON-only; a non-string payload can only be
        // a screencast blob, so it is paired with the header that announced it.
        handleScreencastPayload(data);
        return;
      }
      let parsed = null;
      try {
        parsed = JSON.parse(String(data || '{}'));
      } catch {
        return;
      }
      handleMessage(parsed);
    };
    current.onerror = () => {
      // `onclose` always follows; the reconnect decision lives there.
    };
    current.onclose = (closeEvent) => {
      if (socket !== current) return;
      const code = Number(closeEvent?.code) || 0;
      const reason = String(closeEvent?.reason || '');
      socket = null;
      connected = false;
      framePending = false;
      // A dropped socket is a fallback: the new connection re-negotiates the mode
      // from `ready`, and until then the pull cycle is the only frame source.
      liveMode = 'pull';
      pendingScreencastHeader = null;
      clearTimer('frame');
      clearTimer('pull');
      clearTimer('keepalive');
      if (typeof handlers.onClose === 'function') handlers.onClose();
      const action = classifyBrowserWsClose(code);
      if (action === 'stop') {
        if (typeof handlers.onStop === 'function') handlers.onStop({ code, reason });
        return;
      }
      if (action === 'resync') {
        // Never redial a session id the server has already forgotten: the panel
        // reloads the session list and opens the new target from there.
        if (typeof handlers.onResync === 'function') handlers.onResync({ code, reason });
        return;
      }
      scheduleReconnect();
    };
  }

  /**
   * @param {string} tabId
   */
  function switchTab(tabId) {
    const next = String(tabId || '');
    if (!next || next === target.tabId) return;
    const wasStreaming = liveMode === 'screencast';
    target = { ...target, tabId: next };
    framePending = false;
    if (!connected) return;
    send({ type: 'subscribe', browserTabId: next });
    if (!wasStreaming) return;
    // The server released the previous tab's producer when this socket subscribed
    // elsewhere, so the new tab has to be asked for one instead of freezing.
    liveMode = 'pull';
    pendingScreencastHeader = null;
    requestScreencast(screencastInfo);
  }

  function close(reason) {
    clearAllTimers();
    attempt = 0;
    framePending = false;
    liveMode = 'pull';
    pendingScreencastHeader = null;
    const current = socket;
    socket = null;
    connected = false;
    if (!current) return;
    current.onopen = null;
    current.onmessage = null;
    current.onerror = null;
    current.onclose = null;
    try {
      current.close(1000, reason || '');
    } catch {
      // Already gone; the timers above were the leak risk.
    }
  }

  return {
    open,
    switchTab,
    send,
    close,
    isLive: () => connected,
    getTarget: () => ({ ...target }),
    getAttempt: () => attempt,
    /** Which frame source is currently authoritative for the panel. */
    getLiveMode: () => liveMode,
    /** Streaming status as the server last reported it, plus what this client saw. */
    getScreencast: () => ({
      mode: liveMode,
      requested: Boolean(screencastInfo?.available),
      info: screencastInfo,
      frames: screencastCounters.frames,
      dropped: screencastCounters.dropped,
      breaks: screencastCounters.breaks,
    }),
  };
}
