/**
 * Dedicated Browser WebSocket channel (`/ws-browser`).
 *
 * This is deliberately separate from the widget `/ws-page-bridge`: it is
 * authenticated by the normal Cretli session cookie (handled in ws-router
 * before this module), it never accepts the widget access token, and it uses
 * the `browser_*` namespace only.
 *
 * Protocol (JSON, plus binary frames while screencasting):
 *   client -> server: subscribe | input | screenshot | frame-ack | pull | state | ping
 *                     | screencast-start | screencast-ack | screencast-stop
 *   server -> client: ready | ack | frame | frame-skipped | console | network | state | error | pong
 *                     | screencast-frame | screencast-mode | screencast-target
 *                     | screencast-dropped
 *
 * Backpressure / fairness:
 * - at most one unacknowledged screenshot frame per tab;
 * - messages are processed through one FIFO queue per socket so a slow
 *   screenshot cannot interleave with input;
 * - input events are rate limited per socket and the queue is bounded.
 *
 * Screencast (experimental, flag-gated): a `screencast-frame` JSON control
 * message is immediately followed by the raw JPEG as a binary WS frame, and the
 * client answers with `screencast-ack` once it has consumed the pair. Inbound
 * stays JSON-only either way.
 */

import { randomUUID } from 'crypto';
import { evaluateBrowserActionGuard } from './guards.js';
import { BROWSER_LIMITS } from './constants.js';
import { redactText } from './redaction.js';

/** Maximum inbound WS message size (input events are tiny). */
export const BROWSER_WS_MAX_MESSAGE_BYTES = 256 * 1024;

/**
 * @param {import('http').IncomingMessage} req
 * @returns {{ browserSessionId: string, browserTabId: string }}
 */
export function parseBrowserWsQuery(req) {
  const raw = String(req?.url || '');
  const queryIndex = raw.indexOf('?');
  if (queryIndex === -1) return { browserSessionId: '', browserTabId: '' };
  const params = new URLSearchParams(raw.slice(queryIndex + 1));
  return {
    browserSessionId: String(params.get('session') || '').trim(),
    browserTabId: String(params.get('tab') || '').trim(),
  };
}

/**
 * @param {import('ws').WebSocket} ws
 * @param {object} payload
 * @returns {boolean}
 */
function sendJson(ws, payload) {
  if (ws.readyState !== 1 && ws.readyState !== undefined) return false;
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

/**
 * Sends one binary WS frame (a screencast JPEG). Kept separate from `sendJson`
 * because the pairing rule lives in the protocol: a binary frame is only ever
 * emitted right after the control message that announced it, and a failed
 * control send must suppress the blob so the client never sees an orphan.
 * @param {import('ws').WebSocket} ws
 * @param {Uint8Array} payload
 * @returns {boolean}
 */
function sendBinary(ws, payload) {
  if (ws.readyState !== 1 && ws.readyState !== undefined) return false;
  try {
    ws.send(payload, { binary: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {{
 *   browserManager: import('./session-manager.js').BrowserSessionManager,
 *   ownerSessionId: string,
 *   getScope?: () => { workspaceFile?: string, cwd?: string },
 *   now?: () => number,
 *   inputMinIntervalMs?: number,
 *   maxQueue?: number,
 * }} ctx
 * @returns {(ws: import('ws').WebSocket, req: import('http').IncomingMessage) => void}
 */
export function createBrowserWsHandler(ctx) {
  return (ws, req) => {
    const manager = ctx.browserManager;
    const ownerSessionId = String(ctx.ownerSessionId || '');
    const query = parseBrowserWsQuery(req);
    const scope = typeof ctx.getScope === 'function' ? ctx.getScope() : {};
    const now = typeof ctx.now === 'function' ? ctx.now : () => Date.now();
    const inputMinIntervalMs = Number.isFinite(ctx.inputMinIntervalMs)
      ? Math.max(0, Number(ctx.inputMinIntervalMs))
      : BROWSER_LIMITS.INPUT_MIN_INTERVAL_MS;
    const maxQueue = Number.isFinite(ctx.maxQueue)
      ? Math.max(1, Math.floor(Number(ctx.maxQueue)))
      : BROWSER_LIMITS.INPUT_QUEUE_MAX;

    if (!manager || !ownerSessionId) {
      sendJson(ws, { type: 'error', code: 'unauthorized', error: 'Login required' });
      ws.close(4401, 'login required');
      return;
    }
    if (!query.browserSessionId) {
      sendJson(ws, { type: 'error', code: 'missing-session', error: 'Missing browserSessionId' });
      ws.close(4400, 'missing session');
      return;
    }

    /** @type {{ browserTabId: string }} */
    const socketState = { browserTabId: query.browserTabId || '' };
    /** @type {Map<string, boolean>} tabId -> frame pending */
    const pendingFrames = new Map();
    /**
     * tabId -> this socket's screencast sink. The manager owns the CDP producer
     * and the frame window; this map is only what lets the socket hand its frames
     * to the right WS and release them on close, so an abandoned panel can never
     * leave Chromium producing for a tab nobody watches.
     * @type {Map<string, (control: any, binary: Uint8Array|null) => void>}
     */
    const screencastSinks = new Map();
    let lastInputAt = -Infinity;
    let queueDepth = 0;
    /** @type {Promise<void>} */
    let chain = Promise.resolve();

    /**
     * @param {string} tabId
     * @returns {(control: any, binary: Uint8Array|null) => void}
     */
    function attachScreencastSink(tabId) {
      const existing = screencastSinks.get(tabId);
      if (existing) return existing;
      const sink = (control, binary) => {
        if (!control) return;
        // A `screencast-frame` control message is only half a frame: without the
        // blob the client would hold a stale header, so the pair is all-or-nothing.
        if (String(control.type || '') === 'screencast-frame' && binary) {
          if (!sendJson(ws, control)) return;
          sendBinary(ws, binary);
          return;
        }
        sendJson(ws, control);
      };
      screencastSinks.set(tabId, sink);
      return sink;
    }

    /**
     * Stops caring about one tab's stream: the manager drops the producer when
     * this socket was the last viewer.
     * @param {string} tabId
     */
    function releaseScreencastSink(tabId) {
      const sink = screencastSinks.get(tabId);
      if (!sink) return Promise.resolve(false);
      screencastSinks.delete(tabId);
      try {
        return Promise.resolve(manager.releaseScreencastSink(tabId, sink)).catch(() => false);
      } catch {
        // A socket that is already tearing down has no manager to talk to.
        return Promise.resolve(false);
      }
    }

    try {
      manager.requireSession(query.browserSessionId, ownerSessionId, scope);
    } catch (err) {
      sendJson(ws, { type: 'error', code: err?.code || 'forbidden', error: redactText(err?.message || 'forbidden') });
      ws.close(err?.status === 404 ? 4404 : 4403, err?.code || 'forbidden');
      return;
    }

    sendJson(ws, {
      type: 'ready',
      browserSessionId: query.browserSessionId,
      browserTabId: socketState.browserTabId || null,
      limits: { ...manager.limits },
      // R1: the client has to learn whether pushed frames are even possible
      // before it decides between the screencast and the pull cycle.
      screencast: typeof manager.screencastStatus === 'function'
        ? manager.screencastStatus()
        : { mode: 'off', available: false },
    });

    // Hold one live subscriber for the lifetime of this socket so `sweepIdle()`
    // spares a session the panel or an agent is still watching. The returned
    // release is idempotent and is the only teardown path — call it on close
    // instead of removing the subscriber by hand.
    const releaseWsSubscriber = manager.addWsSubscriber(query.browserSessionId, randomUUID());

    /**
     * @param {any} message
     */
    async function handleMessage(message) {
      const type = String(message?.type || '').trim();
      const actionByType = {
        input: 'input',
        screenshot: 'screenshot',
        'close-tab': 'close-tab',
        navigate: 'navigate',
        // A pushed frame is the same read-only preview capability as a pulled
        // one, so it inherits the guard decision instead of a new bypass.
        'screencast-start': 'screenshot',
      };
      const action = actionByType[type];
      if (action) {
        const decision = evaluateBrowserActionGuard({
          action,
          mode: message?.mode,
          chatId: message?.chatId,
        });
        if (!decision.allowed) {
          sendJson(ws, { type: 'error', code: decision.code, error: decision.reason, requestId: message?.requestId || null });
          return;
        }
      }

      try {
        if (type === 'ping') {
          manager.touchSessionById(query.browserSessionId);
          sendJson(ws, { type: 'pong', at: now() });
          return;
        }
        if (type === 'subscribe') {
          const tabId = String(message?.browserTabId || message?.tabId || '').trim();
          if (tabId) {
            const tabs = manager.listTabs(query.browserSessionId, ownerSessionId, scope);
            if (!tabs.some((tab) => tab.browserTabId === tabId)) {
              sendJson(ws, { type: 'error', code: 'tab-not-found', error: 'Browser tab not found' });
              return;
            }
            socketState.browserTabId = tabId;
            // A viewer that moved away must not keep the previous tab producing.
            for (const watched of [...screencastSinks.keys()]) {
              if (watched !== tabId) releaseScreencastSink(watched);
            }
          }
          sendJson(ws, { type: 'ack', op: 'subscribe', browserTabId: socketState.browserTabId || null });
          return;
        }
        if (type === 'state') {
          const tabId = String(message?.browserTabId || socketState.browserTabId || '').trim();
          // The status poll doubles as the deterministic stall check: a stream
          // that stopped producing is ended here, so the panel sees `mode: 'pull'`
          // even on a host where the per-stream timer never fired.
          if (typeof manager.expireScreencasts === 'function'
            && (manager.screencastMode === 'experimental' || screencastSinks.size > 0)) {
            await manager.expireScreencasts();
          }
          const state = await manager.getState(query.browserSessionId, tabId, ownerSessionId, scope);
          sendJson(ws, { type: 'state', state });
          return;
        }
        if (type === 'input') {
          const at = now();
          if (at - lastInputAt < inputMinIntervalMs) {
            sendJson(ws, {
              type: 'error',
              code: 'input-rate-limited',
              error: `Input events are capped at ${Math.max(1, Math.round(1000 / Math.max(1, inputMinIntervalMs)))}/s`,
              requestId: message?.requestId || null,
            });
            return;
          }
          lastInputAt = at;
          const tabId = String(message?.browserTabId || socketState.browserTabId || '').trim();
          const result = await manager.dispatchInput(
            query.browserSessionId,
            tabId,
            ownerSessionId,
            message?.event || {},
            scope,
          );
          sendJson(ws, { type: 'ack', op: 'input', requestId: message?.requestId || null, result });
          return;
        }
        if (type === 'screenshot') {
          const tabId = String(message?.browserTabId || socketState.browserTabId || '').trim();
          if (pendingFrames.get(tabId)) {
            sendJson(ws, { type: 'frame-skipped', requestId: message?.requestId || null, reason: 'backpressure' });
            return;
          }
          pendingFrames.set(tabId, true);
          try {
            const frame = await manager.screenshot(query.browserSessionId, tabId, ownerSessionId, {
              quality: message?.quality,
              force: message?.force === true,
              workspaceFile: scope.workspaceFile,
              cwd: scope.cwd,
            });
            sendJson(ws, { type: 'frame', requestId: message?.requestId || null, frame });
          } catch (err) {
            pendingFrames.delete(tabId);
            sendJson(ws, {
              type: 'error',
              code: err?.code || 'screenshot-failed',
              error: redactText(err?.message || 'screenshot failed'),
              requestId: message?.requestId || null,
            });
          }
          return;
        }
        if (type === 'frame-ack') {
          const tabId = String(message?.browserTabId || socketState.browserTabId || '').trim();
          pendingFrames.delete(tabId);
          return;
        }
        if (type === 'screencast-start') {
          const tabId = String(message?.browserTabId || socketState.browserTabId || '').trim();
          if (!tabId) {
            sendJson(ws, { type: 'error', code: 'missing-tab', error: 'Browser tab required', requestId: message?.requestId || null });
            return;
          }
          // The client declares that it can read binary WS frames. It can never
          // turn streaming on: the deployment flag is checked inside the manager.
          const allowBinary = message?.caps?.binary === true || message?.allowBinary === true;
          const sink = attachScreencastSink(tabId);
          const result = await manager.startScreencast(
            query.browserSessionId,
            tabId,
            ownerSessionId,
            { allowBinary, fps: message?.fps, quality: message?.quality, sink },
            scope,
          );
          if (!result?.ok) releaseScreencastSink(tabId);
          sendJson(ws, {
            type: 'screencast-mode',
            mode: result?.ok ? 'screencast' : 'pull',
            reason: result?.ok ? (result.resumed ? 'resumed' : 'started') : (result?.reason || 'unavailable'),
            browserTabId: tabId,
            requestId: message?.requestId || null,
            status: result?.status || (typeof manager.screencastStatus === 'function'
              ? manager.screencastStatus()
              : null),
          });
          return;
        }
        if (type === 'screencast-stop') {
          const tabId = String(message?.browserTabId || socketState.browserTabId || '').trim();
          await releaseScreencastSink(tabId);
          try {
            await manager.stopScreencast(query.browserSessionId, tabId, ownerSessionId, {
              reason: 'client-stop',
            }, scope);
          } catch {
            // An unknown tab has no stream left to stop either way.
          }
          sendJson(ws, { type: 'screencast-mode', mode: 'pull', reason: 'stopped', browserTabId: tabId });
          return;
        }
        if (type === 'screencast-ack') {
          const tabId = String(message?.browserTabId || socketState.browserTabId || '').trim();
          const seq = Number(message?.seq);
          if (!Number.isInteger(seq) || seq < 0) {
            sendJson(ws, { type: 'error', code: 'invalid-seq', error: 'Screencast ack needs a numeric seq' });
            return;
          }
          // Acks are flow control, so (like `frame-ack`) they are never answered;
          // the manager uses the round trip for the per-frame latency metric.
          await manager.ackScreencastFrame(query.browserSessionId, tabId, ownerSessionId, seq, scope);
          return;
        }
        if (type === 'pull') {
          const tabId = String(message?.browserTabId || socketState.browserTabId || '').trim();
          const channel = String(message?.channel || '').trim();
          const options = { since: message?.since, limit: message?.limit };
          const target = channel === 'network' ? 'network' : (channel === 'dialogs' ? 'dialogs' : 'console');
          const payload = target === 'network'
            ? manager.pullNetwork(query.browserSessionId, tabId, ownerSessionId, options, scope)
            : (target === 'dialogs'
              ? pullDialogs(query.browserSessionId, tabId, options, scope)
              : manager.pullConsole(query.browserSessionId, tabId, ownerSessionId, options, scope));
          sendJson(ws, { type: 'console', channel: target, requestId: message?.requestId || null, payload });
          return;
        }
        sendJson(ws, { type: 'error', code: 'unknown-message', error: `Unknown message type: ${type || '(empty)'}` });
      } catch (err) {
        sendJson(ws, { type: 'error', code: err?.code || 'browser-error', error: redactText(err?.message || 'Browser error') });
      }
    }

    /**
     * Serializes message handling: one operation at a time per socket. This is
     * the per-tab/session queue the plan requires, and it also bounds how much
     * work a client can pile up.
     * @param {any} message
     */
    function enqueue(message) {
      if (queueDepth >= maxQueue) {
        sendJson(ws, { type: 'error', code: 'queue-full', error: 'Too many pending Browser operations' });
        return;
      }
      queueDepth += 1;
      chain = chain
        .then(() => handleMessage(message))
        .catch(() => {})
        .finally(() => { queueDepth -= 1; });
    }

    ws.on('message', (raw) => {
      const size = Buffer.isBuffer(raw) ? raw.length : Buffer.byteLength(String(raw || ''), 'utf8');
      if (size > BROWSER_WS_MAX_MESSAGE_BYTES) {
        sendJson(ws, { type: 'error', code: 'message-too-large', error: 'Message too large' });
        return;
      }
      let message;
      try {
        message = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
      } catch {
        sendJson(ws, { type: 'error', code: 'invalid-json', error: 'Invalid JSON' });
        return;
      }
      enqueue(message);
    });

    ws.on('close', () => {
      // Release the live subscriber first so an abandoned tab becomes sweepable,
      // then drop the per-tab backpressure bookkeeping.
      releaseWsSubscriber();
      pendingFrames.clear();
      // A dropped socket is a documented fallback trigger: the viewer is gone, so
      // nothing may keep Chromium producing frames for it.
      for (const watched of [...screencastSinks.keys()]) releaseScreencastSink(watched);
    });
  };
}
