const pending = new Map();
let hostPort = null;

/**
 * @param {MessagePort | null | undefined} port
 */
export function setWidgetHostPortForPagePick(port) {
  hostPort = port || null;
}

/**
 * @param {MessageEvent} event
 * @returns {boolean}
 */
export function handleWidgetHostPagePickMessage(event) {
  const data = event?.data;
  if (!data || typeof data !== 'object') return false;
  if (data.type !== 'cretli-widget-pick-element-result') return false;
  const id = typeof data.id === 'string' ? data.id : '';
  if (!id || !pending.has(id)) return false;
  const entry = pending.get(id);
  pending.delete(id);
  clearTimeout(entry.timeoutId);
  if (data.ok && data.context && typeof data.context === 'object') {
    entry.resolve(data.context);
    return true;
  }
  entry.reject(new Error(String(data.error || 'Failed to select an element on the host page')));
  return true;
}

export function cancelWidgetHostPagePickPending() {
  for (const [id, entry] of pending.entries()) {
    clearTimeout(entry.timeoutId);
    entry.reject(new Error('Host page element selection was cancelled'));
    pending.delete(id);
  }
}

export function isWidgetHostPagePickAvailable() {
  return !!hostPort;
}

/**
 * @returns {Promise<object>}
 */
export function requestWidgetHostPagePick() {
  if (!hostPort) {
    return Promise.reject(new Error('Selecting on the host page requires an embedded widget'));
  }
  const id = `pick-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Timed out waiting for the host page element selection'));
    }, 120_000);
    pending.set(id, { resolve, reject, timeoutId });
    try {
      hostPort.postMessage({
        type: 'cretli-widget-pick-element',
        id,
      });
    } catch (error) {
      clearTimeout(timeoutId);
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * @param {object|null|undefined} context
 * @returns {string}
 */
export function formatHostPagePickContextBlock(context) {
  if (!context || typeof context !== 'object') return '';
  const serialized = JSON.stringify(context);
  const limited = serialized.length > 32_000
    ? `${serialized.slice(0, 32_000)}…`
    : serialized;
  return `[PAGE SELECTION CONTEXT]\n${limited}\n[/PAGE SELECTION CONTEXT]`;
}

/**
 * @param {object|null|undefined} context
 * @returns {string}
 */
export function getHostPagePickLabel(context) {
  const element = context?.element;
  if (!element || typeof element !== 'object') return 'Page element';
  const tag = typeof element.tag === 'string' ? element.tag : 'element';
  const text = typeof element.text === 'string' ? element.text.trim().slice(0, 40) : '';
  if (text) return `<${tag}> ${text}`;
  if (typeof element.selector === 'string' && element.selector.trim()) {
    return `<${tag}> ${element.selector.trim().slice(0, 48)}`;
  }
  return `<${tag}>`;
}
