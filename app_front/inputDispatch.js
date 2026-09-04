/**
 * Shared layer for sending input to the PTY (xterm + WebSocket).
 */

import { usesHarnessWebSocket } from '../lib/agent-transport.js';

export function focusTerminal(term) {
  if (!term || typeof term.focus !== 'function') return;
  try {
    term.focus();
  } catch (_) {}
}

function getOpenWs(state) {
  const ws = state?.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return null;
  return ws;
}

/**
 * Sends a single sequence to the PTY.
 * @param {{ term?: import('@xterm/xterm').Terminal | null, ws?: WebSocket | null }} state
 * @param {string} sequence
 * @param {{ focus?: boolean, focusDelayMs?: number, onBeforeSend?: () => void }} [options]
 * @returns {boolean}
 */
export function sendSequenceToTerminalState(state, sequence, options = {}) {
  if (!sequence) return false;
  const ws = getOpenWs(state);
  if (!ws) return false;
  if (usesHarnessWebSocket(state)) {
    if (sequence !== '\x03') {
      return false;
    }
    if (options.focus !== false) focusTerminal(state?.term);
    const delayMs = Number.isFinite(options.focusDelayMs) ? Math.max(0, Number(options.focusDelayMs)) : 0;
    const sendNow = () => {
      const openWs = getOpenWs(state);
      if (!openWs) return;
      if (typeof options.onBeforeSend === 'function') options.onBeforeSend();
      openWs.send(JSON.stringify({ type: 'cancel' }));
    };
    if (delayMs > 0) {
      setTimeout(sendNow, delayMs);
    } else {
      sendNow();
    }
    return true;
  }
  if (options.focus !== false) focusTerminal(state?.term);
  const delayMs = Number.isFinite(options.focusDelayMs) ? Math.max(0, Number(options.focusDelayMs)) : 0;
  const sendNow = () => {
    const openWs = getOpenWs(state);
    if (!openWs) return;
    if (typeof options.onBeforeSend === 'function') options.onBeforeSend();
    openWs.send(JSON.stringify({ type: 'input', data: sequence }));
  };
  if (delayMs > 0) {
    setTimeout(sendNow, delayMs);
  } else {
    sendNow();
  }
  return true;
}

/**
 * Sends text, then Enter after a delay.
 * @param {{ term?: import('@xterm/xterm').Terminal | null, ws?: WebSocket | null }} state
 * @param {string} text
 * @param {{ focus?: boolean, focusDelayMs?: number, enterFocusDelayMs?: number, onBeforeSend?: () => void, sendEnterDelayMs?: number, onAfterSdkSend?: (t: string) => void, sdkMode?: string, displayText?: string }} [options]
 * @returns {boolean}
 */
export function sendTextWithEnterToTerminalState(state, text, options = {}) {
  const ws = getOpenWs(state);
  if (!ws) return false;
  if (usesHarnessWebSocket(state)) {
    if (options.focus !== false) focusTerminal(state?.term);
    const focusDelayMs = Number.isFinite(options.focusDelayMs) ? Math.max(0, Number(options.focusDelayMs)) : 0;
    const payloadText = text ?? '';
    const displayText = typeof options.displayText === 'string' ? options.displayText.trim() : '';
    const sendSdkPrompt = () => {
      const wsNow = getOpenWs(state);
      if (!wsNow) return;
      if (typeof options.onBeforeSend === 'function') options.onBeforeSend();
      wsNow.send(
        JSON.stringify({
          type: 'send',
          text: payloadText,
          clientSentAt: Date.now(),
          ...(options.sdkMode ? { mode: options.sdkMode } : {}),
          ...(displayText ? { displayText } : {}),
        })
      );
      if (typeof options.onAfterSdkSend === 'function') options.onAfterSdkSend(payloadText);
    };
    if (focusDelayMs > 0) {
      setTimeout(sendSdkPrompt, focusDelayMs);
    } else {
      sendSdkPrompt();
    }
    return true;
  }
  if (options.focus !== false) focusTerminal(state?.term);
  const focusDelayMs = Number.isFinite(options.focusDelayMs) ? Math.max(0, Number(options.focusDelayMs)) : 0;
  const enterFocusDelayMs = Number.isFinite(options.enterFocusDelayMs)
    ? Math.max(0, Number(options.enterFocusDelayMs))
    : 0;
  const sendTextNow = () => {
    const wsNow = getOpenWs(state);
    if (!wsNow) return;
    if (typeof options.onBeforeSend === 'function') options.onBeforeSend();
    wsNow.send(JSON.stringify({ type: 'input', data: text ?? '' }));
  };
  if (focusDelayMs > 0) {
    setTimeout(sendTextNow, focusDelayMs);
  } else {
    sendTextNow();
  }
  const delayMs = Number.isFinite(options.sendEnterDelayMs) ? options.sendEnterDelayMs : 80;
  setTimeout(() => {
    if (options.focus !== false) focusTerminal(state?.term);
    const sendEnterNow = () => {
      const ws2 = getOpenWs(state);
      if (!ws2) return;
      ws2.send(JSON.stringify({ type: 'input', data: '\r' }));
    };
    if (enterFocusDelayMs > 0) {
      setTimeout(sendEnterNow, enterFocusDelayMs);
    } else {
      sendEnterNow();
    }
  }, delayMs);
  return true;
}
