/**
 * Dedicated Browser WebSocket channel (`/ws-browser`).
 *
 * This is deliberately separate from the widget `/ws-page-bridge`: it is
 * authenticated by the normal Cretli session cookie (handled in ws-router
 * before this module), it never accepts the widget access token, and it uses
 * the `browser_*` namespace only.
 *
 * Protocol (JSON):
 *   client -> server: subscribe | input | screenshot | frame-ack | pull | state | ping
 *   server -> client: ready | ack | frame | frame-skipped | console | network | state | error | pong
 *
 * Backpressure / fairness:
 * - at most one unacknowledged screenshot frame per tab;
 * - messages are processed through one FIFO queue per socket so a slow
 *   screenshot cannot interleave with input;
 * - input events are rate limited per socket and the queue is bounded.
 */

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
    let lastInputAt = -Infinity;
    let queueDepth = 0;
    /** @type {Promise<void>} */
    let chain = Promise.resolve();

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
    });

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
          }
          sendJson(ws, { type: 'ack', op: 'subscribe', browserTabId: socketState.browserTabId || null });
          return;
        }
        if (type === 'state') {
          const tabId = String(message?.browserTabId || socketState.browserTabId || '').trim();
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
        if (type === 'pull') {
          const tabId = String(message?.browserTabId || socketState.browserTabId || '').trim();
          const channel = String(message?.channel || '').trim();
          const options = { since: message?.since, limit: message?.limit };
          const payload = channel === 'network'
            ? manager.pullNetwork(query.browserSessionId, tabId, ownerSessionId, options, scope)
            : manager.pullConsole(query.browserSessionId, tabId, ownerSessionId, options, scope);
          sendJson(ws, { type: 'console', channel: channel === 'network' ? 'network' : 'console', requestId: message?.requestId || null, payload });
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
      pendingFrames.clear();
    });
  };
}
