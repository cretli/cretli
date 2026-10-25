/**
 * Stage 4.2 — mounted history window eviction planning and record registry.
 *
 * DOM eviction must not break dedupe: applied record identities stay in the
 * registry even when the card is parked off-screen (older/newer local caches).
 */

import {
  hasViewOrderKey,
  isSameViewOrderKey,
  resolveViewOrderKey,
  viewOrderIdentity,
} from '../features/chat/chatHistoryViewOrder.js';
import { UI_FREEZE_CHAT_MOUNTED_RECORD_CAP } from './uiFreezeRenderBudgets.js';

export { UI_FREEZE_CHAT_MOUNTED_RECORD_CAP };

/** @typedef {'head' | 'tail'} MountedEvictionEdge */

/**
 * @param {unknown} value
 * @returns {value is Element}
 */
function isTrackableElement(value) {
  if (typeof Element !== 'undefined' && value instanceof Element) return true;
  return !!(
    value
    && typeof value === 'object'
    && typeof /** @type {{ remove?: unknown }} */ (value).remove === 'function'
  );
}

/**
 * @param {unknown} value
 * @returns {value is HTMLElement}
 */
function isTrackableHtmlElement(value) {
  if (typeof HTMLElement !== 'undefined' && value instanceof HTMLElement) return true;
  return isTrackableElement(value);
}

/**
 * @param {number} mountedCount
 * @param {number} [cap]
 * @returns {number}
 */
export function countMountedWindowExcess(mountedCount, cap = UI_FREEZE_CHAT_MOUNTED_RECORD_CAP) {
  const limit = Math.max(0, Math.floor(Number(cap) || 0));
  const count = Math.max(0, Math.floor(Number(mountedCount) || 0));
  if (limit <= 0) return 0;
  return Math.max(0, count - limit);
}

/**
 * @param {{ mountedCount: number, cap?: number, evictFrom: MountedEvictionEdge }} input
 * @returns {{ evictCount: number, evictFrom: MountedEvictionEdge }}
 */
export function planMountedWindowEviction(input) {
  const evictFrom = input?.evictFrom === 'head' ? 'head' : 'tail';
  const evictCount = countMountedWindowExcess(input?.mountedCount, input?.cap);
  return { evictCount, evictFrom };
}

/**
 * Chooses which edge to trim when the stream exceeds the mounted cap.
 *
 * @param {{ stickToBottom: boolean, isLoadingOlderHistory?: boolean }} input
 * @returns {MountedEvictionEdge}
 */
export function resolveMountedEvictionEdge(input) {
  if (input?.isLoadingOlderHistory === true) return 'tail';
  if (input?.stickToBottom === true) return 'head';
  return 'tail';
}

/**
 * @param {unknown} record
 * @returns {string}
 */
export function resolveMountedRecordIdentity(record) {
  return viewOrderIdentity(resolveViewOrderKey(record));
}

/** @typedef {'mounted' | 'parked'} MountedHistoryRecordMountState */

/**
 * @returns {{
 *   size: () => number,
 *   has: (identity: string) => boolean,
 *   isMounted: (identity: string) => boolean,
 *   note: (record: unknown) => void,
 *   markParked: (identity: string) => void,
 *   markParkedRecord: (record: unknown) => void,
 *   forget: (identity: string) => void,
 *   get: (identity: string) => unknown | undefined,
 *   clear: () => void,
 *   identities: () => string[],
 * }}
 */
export function createMountedHistoryRecordRegistry() {
  /** @type {Map<string, { record: unknown, mountState: MountedHistoryRecordMountState }>} */
  const byIdentity = new Map();

  /**
   * @param {string} id
   * @returns {{ record: unknown, mountState: MountedHistoryRecordMountState } | undefined}
   */
  function entryFor(id) {
    const key = String(id || '').trim();
    if (key === '') return undefined;
    return byIdentity.get(key);
  }

  return {
    size() {
      return byIdentity.size;
    },
    has(identity) {
      return entryFor(identity) !== undefined;
    },
    isMounted(identity) {
      const entry = entryFor(identity);
      return entry?.mountState === 'mounted';
    },
    note(record) {
      const id = resolveMountedRecordIdentity(record);
      if (!id) return;
      byIdentity.set(id, { record, mountState: 'mounted' });
    },
    markParked(identity) {
      const id = String(identity || '').trim();
      if (id === '') return;
      const entry = byIdentity.get(id);
      if (!entry) return;
      byIdentity.set(id, { ...entry, mountState: 'parked' });
    },
    markParkedRecord(record) {
      const id = resolveMountedRecordIdentity(record);
      if (id) this.markParked(id);
    },
    forget(identity) {
      const id = String(identity || '').trim();
      if (id === '') return;
      byIdentity.delete(id);
    },
    get(identity) {
      return entryFor(identity)?.record;
    },
    clear() {
      byIdentity.clear();
    },
    identities() {
      return [...byIdentity.keys()];
    },
  };
}

/**
 * @param {unknown} record
 * @param {ReturnType<typeof createMountedHistoryRecordRegistry>} registry
 * @returns {boolean}
 */
export function isMountedHistoryRecordApplied(record, registry) {
  const key = resolveViewOrderKey(record);
  if (!hasViewOrderKey(key)) return false;
  const id = viewOrderIdentity(key);
  return id !== '' && registry.has(id);
}

/**
 * @param {{ historySeq?: number, roomEventSeq?: number, eventStreamId?: string }} incomingKey
 * @param {ReturnType<typeof createMountedHistoryRecordRegistry>} registry
 * @returns {boolean}
 */
export function isMountedViewOrderKeyApplied(incomingKey, registry) {
  if (!hasViewOrderKey(incomingKey)) return false;
  const id = viewOrderIdentity(incomingKey);
  if (id === '') return false;
  if (registry && typeof registry.isMounted === 'function') {
    return registry.isMounted(id);
  }
  return registry.has(id);
}

/**
 * @param {unknown[]} records chronological
 * @param {unknown[]} parked chronological
 * @returns {unknown[]}
 */
export function mergeParkedHistoryRecords(records, parked) {
  const left = Array.isArray(records) ? records : [];
  const right = Array.isArray(parked) ? parked : [];
  if (left.length === 0) return right.slice();
  if (right.length === 0) return left.slice();
  /** @type {unknown[]} */
  const merged = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length || rightIndex < right.length) {
    const leftKey = resolveViewOrderKey(left[leftIndex]);
    const rightKey = resolveViewOrderKey(right[rightIndex]);
    if (leftIndex >= left.length) {
      merged.push(right[rightIndex]);
      rightIndex += 1;
      continue;
    }
    if (rightIndex >= right.length) {
      merged.push(left[leftIndex]);
      leftIndex += 1;
      continue;
    }
    if (isSameViewOrderKey(leftKey, rightKey)) {
      merged.push(left[leftIndex]);
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    const leftHistory = Number(leftKey.historySeq) || 0;
    const rightHistory = Number(rightKey.historySeq) || 0;
    if (leftHistory > 0 && rightHistory > 0) {
      if (leftHistory <= rightHistory) {
        merged.push(left[leftIndex]);
        leftIndex += 1;
      } else {
        merged.push(right[rightIndex]);
        rightIndex += 1;
      }
      continue;
    }
    merged.push(left[leftIndex]);
    leftIndex += 1;
  }
  return merged;
}

/**
 * @param {ParentNode | null | undefined} stream
 * @returns {number}
 */
export function countMountedStreamCards(stream) {
  if (!stream || typeof stream.children === 'undefined') return 0;
  let count = 0;
  for (const child of stream.children) {
    if (!child || typeof child !== 'object') continue;
    count += 1;
  }
  return count;
}

/** @typedef {{ connected: number, detached: number, total: number }} MountedDomNodeCounts */

/**
 * WeakRef-backed registry of mounted history DOM nodes (connected and detached until GC).
 *
 * @returns {{
 *   track: (el: Element) => void,
 *   trackSubtree: (root: Element) => void,
 *   pruneDead: () => void,
 *   count: () => MountedDomNodeCounts,
 *   clear: () => void,
 * }}
 */
export function createMountedDomNodeRegistry() {
  /** @type {Set<WeakRef<Element>>} */
  const refs = new Set();

  /**
   * @param {Element} el
   */
  function track(el) {
    if (!isTrackableElement(el)) return;
    refs.add(new WeakRef(/** @type {Element} */ (el)));
  }

  /**
   * @param {Element} root
   */
  function trackSubtree(root) {
    if (!isTrackableElement(root)) return;
    track(root);
    if (typeof root.querySelectorAll === 'function') {
      for (const node of root.querySelectorAll('*')) {
        if (isTrackableElement(node)) track(node);
      }
    }
  }

  function pruneDead() {
    for (const ref of refs) {
      if (!ref.deref()) refs.delete(ref);
    }
  }

  /**
   * @returns {MountedDomNodeCounts}
   */
  function count() {
    pruneDead();
    let connected = 0;
    let detached = 0;
    for (const ref of refs) {
      const el = ref.deref();
      if (!el) {
        refs.delete(ref);
        continue;
      }
      if (el.isConnected) connected += 1;
      else detached += 1;
    }
    return { connected, detached, total: connected + detached };
  }

  function clear() {
    refs.clear();
  }

  return { track, trackSubtree, pruneDead, count, clear };
}

/**
 * @param {ReturnType<typeof createMountedDomNodeRegistry>} registry
 * @returns {number}
 */
export function countConnectedAndDetachedNodes(registry) {
  if (!registry || typeof registry.count !== 'function') return 0;
  const stats = registry.count();
  return stats.total;
}

/**
 * Tracks listeners and animation/timer loops tied to mounted stream cards; released on eviction.
 *
 * @returns {{
 *   getActiveListenerCount: () => number,
 *   getActiveLoopCount: () => number,
 *   bindCardListener: (cardRoot: HTMLElement, target: EventTarget, type: string, listener: EventListener, options?: boolean | AddEventListenerOptions) => void,
 *   registerLoop: (cardRoot: HTMLElement, dispose: () => void) => void,
 *   releaseCard: (cardRoot: HTMLElement) => void,
 *   resetAll: () => void,
 * }}
 */
export function createMountedViewResourceLedger() {
  let activeListeners = 0;
  let activeLoops = 0;
  /** @type {WeakMap<HTMLElement, { listeners: Array<() => void>, loops: Array<() => void> }>} */
  const byCard = new WeakMap();
  /** @type {Set<HTMLElement>} */
  const trackedRoots = new Set();

  /**
   * @param {HTMLElement} cardRoot
   */
  function ensureCard(cardRoot) {
    let entry = byCard.get(cardRoot);
    if (!entry) {
      entry = { listeners: [], loops: [] };
      byCard.set(cardRoot, entry);
    }
    return entry;
  }

  /**
   * @param {HTMLElement} cardRoot
   * @param {EventTarget} target
   * @param {string} type
   * @param {EventListener} listener
   * @param {boolean | AddEventListenerOptions} [options]
   */
  function bindCardListener(cardRoot, target, type, listener, options) {
    if (!isTrackableHtmlElement(cardRoot) || !target || typeof listener !== 'function') return;
    trackedRoots.add(cardRoot);
    target.addEventListener(type, listener, options);
    activeListeners += 1;
    const dispose = () => {
      target.removeEventListener(type, listener, options);
      activeListeners = Math.max(0, activeListeners - 1);
    };
    ensureCard(cardRoot).listeners.push(dispose);
  }

  /**
   * @param {HTMLElement} cardRoot
   * @param {() => void} dispose
   */
  function registerLoop(cardRoot, dispose) {
    if (!isTrackableHtmlElement(cardRoot) || typeof dispose !== 'function') return;
    trackedRoots.add(cardRoot);
    activeLoops += 1;
    const wrapped = () => {
      dispose();
      activeLoops = Math.max(0, activeLoops - 1);
    };
    ensureCard(cardRoot).loops.push(wrapped);
  }

  /**
   * @param {HTMLElement} cardRoot
   */
  function releaseCard(cardRoot) {
    if (!isTrackableHtmlElement(cardRoot)) return;
    const entry = byCard.get(cardRoot);
    if (!entry) return;
    for (const dispose of entry.listeners) dispose();
    for (const dispose of entry.loops) dispose();
    byCard.delete(cardRoot);
    trackedRoots.delete(cardRoot);
  }

  function resetAll() {
    for (const root of [...trackedRoots]) {
      releaseCard(root);
    }
    trackedRoots.clear();
    activeListeners = 0;
    activeLoops = 0;
  }

  return {
    getActiveListenerCount: () => activeListeners,
    getActiveLoopCount: () => activeLoops,
    bindCardListener,
    registerLoop,
    releaseCard,
    resetAll,
  };
}

/**
 * @param {HTMLElement} cardRoot
 * @param {ReturnType<typeof createMountedViewResourceLedger>} ledger
 * @param {ReturnType<typeof createMountedDomNodeRegistry>} nodeRegistry
 */
export function releaseEvictedMountedCard(cardRoot, ledger, nodeRegistry) {
  if (!isTrackableHtmlElement(cardRoot)) return;
  if (ledger) ledger.releaseCard(cardRoot);
  if (nodeRegistry) nodeRegistry.trackSubtree(cardRoot);
  cardRoot.remove();
}
