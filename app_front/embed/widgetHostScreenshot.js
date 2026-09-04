/** @typedef {{ dataUrl: string, mimeType?: string, width?: number, height?: number }} HostScreenshotResult */

import {
  cancelWidgetHostClipboardPending,
  handleWidgetHostClipboardMessage,
} from './widgetHostClipboard.js';
import {
  cancelWidgetHostNavigationPending,
  handleWidgetHostNavigationMessage,
} from './widgetHostNavigation.js';
import {
  cancelWidgetHostPagePickPending,
  handleWidgetHostPagePickMessage,
  setWidgetHostPortForPagePick,
} from './widgetHostPagePick.js';

const pending = new Map();
let hostPort = null;

export function getWidgetHostPort() {
  return hostPort;
}

/**
 * @param {MessageEvent} event
 * @returns {boolean}
 */
export function handleWidgetHostScreenshotMessage(event) {
  const data = event?.data;
  if (!data || typeof data !== 'object') return false;
  if (data.type !== 'cretli-widget-screenshot-result') return false;
  const id = typeof data.id === 'string' ? data.id : '';
  if (!id || !pending.has(id)) return false;
  const entry = pending.get(id);
  pending.delete(id);
  clearTimeout(entry.timeoutId);
  if (data.ok && typeof data.dataUrl === 'string') {
    entry.resolve({
      dataUrl: data.dataUrl,
      mimeType: typeof data.mimeType === 'string' ? data.mimeType : 'image/jpeg',
      width: Number(data.width) || undefined,
      height: Number(data.height) || undefined,
    });
    return true;
  }
  entry.reject(new Error(String(data.error || 'Failed to capture a screenshot of the host page')));
  return true;
}

/**
 * @param {MessagePort | null | undefined} port
 */
export function setWidgetHostPort(port) {
  hostPort = port || null;
  if (!hostPort) {
    cancelWidgetHostClipboardPending();
    cancelWidgetHostNavigationPending();
    cancelWidgetHostPagePickPending();
    for (const [id, entry] of pending.entries()) {
      clearTimeout(entry.timeoutId);
      entry.reject(new Error('Connection to the host page was closed'));
      pending.delete(id);
    }
    return;
  }
  hostPort.onmessage = (event) => {
    if (handleWidgetHostClipboardMessage(event)) return;
    if (handleWidgetHostNavigationMessage(event)) return;
    if (handleWidgetHostScreenshotMessage(event)) return;
    if (handleWidgetHostPagePickMessage(event)) return;
  };
  setWidgetHostPortForPagePick(hostPort);
}

export function isWidgetHostScreenshotAvailable() {
  return !!hostPort;
}

/**
 * @param {'dom' | 'display'} [mode]
 * @returns {Promise<HostScreenshotResult>}
 */
export function requestWidgetHostScreenshot(mode = 'display') {
  if (!hostPort) {
    return Promise.reject(new Error('Host page screenshots require an embedded widget'));
  }
  const id = `shot-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const captureMode = mode === 'dom' ? 'dom' : 'display';
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Timed out waiting for the host page screenshot'));
    }, 120_000);
    pending.set(id, { resolve, reject, timeoutId });
    try {
      hostPort.postMessage({
        type: 'cretli-widget-screenshot',
        id,
        mode: captureMode,
      });
    } catch (error) {
      clearTimeout(timeoutId);
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * @param {HostScreenshotResult} result
 * @returns {Promise<File>}
 */
export async function hostScreenshotResultToFile(result) {
  const dataUrl = String(result?.dataUrl || '');
  if (!dataUrl.startsWith('data:')) {
    throw new Error('Invalid host page screenshot format');
  }
  const mimeType = result?.mimeType || 'image/jpeg';
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const ext = mimeType.includes('png') ? 'png' : 'jpg';
  return new File([blob], `host-screen-${Date.now()}.${ext}`, { type: mimeType });
}
