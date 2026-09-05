/**
 * Periodic client instance heartbeat to server registry.
 */

import {
  getClientInstanceId,
  getClientInstanceKind,
  getClientInstanceLabel,
  getClientUserAgentShort,
} from './clientInstance.js';
import { readStorageValueWithAlias } from './storageKeyAlias.js';
import { UI_FREEZE_DIAG_LS_KEY } from './uiFreezeTrace.js';
import { consumeClientInstanceCommandResults, pullAndExecuteClientInstanceCommands } from './clientInstanceCommands.js';
import { cretliApiFetch } from './cretliApiRequest.js';

const REMOTE_DEBUG_FLAG_LS_KEY = 'cretli-debug-remote';
const HEARTBEAT_INTERVAL_MS = 8000;

/** @type {ReturnType<typeof setInterval> | null} */
let heartbeatTimerId = null;

/** @type {() => string | null} */
let getActiveChatIdFn = () => null;

/** @type {() => number} */
let countOpenWsFn = () => 0;

/**
 * @param {string} lsKey
 * @returns {boolean}
 */
function isLocalStorageFlagEnabled(lsKey) {
  if (typeof localStorage === 'undefined') return false;
  try {
    const stored = readStorageValueWithAlias(localStorage, lsKey, '');
    if (!stored) return false;
    const normalized = String(stored).trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
  } catch {
    return false;
  }
}

/**
 * @returns {string|null}
 */
function readActivePanelFromDom() {
  if (typeof document === 'undefined') return null;
  const activeTab = document.querySelector('.tab.active');
  const panel = activeTab?.dataset?.panel;
  return typeof panel === 'string' && panel ? panel : null;
}

/**
 * @returns {object}
 */
function buildHeartbeatPayload() {
  let heapMiB = null;
  if (typeof performance !== 'undefined' && performance.memory?.usedJSHeapSize) {
    heapMiB = Math.round(performance.memory.usedJSHeapSize / 1048576);
  }
  return {
    clientInstanceId: getClientInstanceId(),
    label: getClientInstanceLabel(),
    kind: getClientInstanceKind(),
    ua: getClientUserAgentShort(),
    visibility: typeof document !== 'undefined' ? document.visibilityState || 'unknown' : 'unknown',
    activePanel: readActivePanelFromDom(),
    activeChatId: getActiveChatIdFn(),
    wsCount: countOpenWsFn(),
    debugRemote: isLocalStorageFlagEnabled(REMOTE_DEBUG_FLAG_LS_KEY),
    debugUiFreeze: isLocalStorageFlagEnabled(UI_FREEZE_DIAG_LS_KEY),
    heapMiB,
  };
}

/**
 * Sends one heartbeat to the server.
 * @returns {Promise<boolean>}
 */
export async function sendClientInstanceHeartbeat() {
  if (typeof fetch === 'undefined') return false;
  try {
    await pullAndExecuteClientInstanceCommands();
    const res = await cretliApiFetch(`${window.location.origin || ''}/api/client-instances/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...buildHeartbeatPayload(),
        commandResults: consumeClientInstanceCommandResults(),
      }),
      keepalive: true,
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data?.ok === true;
  } catch {
    return false;
  }
}

/**
 * @param {{ getActiveChatId?: () => string | null, countOpenChatWs?: () => number }} [options]
 */
export function initClientInstanceHeartbeat(options = {}) {
  if (heartbeatTimerId != null || typeof window === 'undefined') return;
  if (typeof options.getActiveChatId === 'function') getActiveChatIdFn = options.getActiveChatId;
  if (typeof options.countOpenChatWs === 'function') countOpenWsFn = options.countOpenChatWs;
  void sendClientInstanceHeartbeat();
  heartbeatTimerId = window.setInterval(() => {
    void sendClientInstanceHeartbeat();
  }, HEARTBEAT_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    void sendClientInstanceHeartbeat();
  });
}

/**
 * Stops heartbeat (tests).
 */
export function stopClientInstanceHeartbeatForTests() {
  if (heartbeatTimerId == null || typeof window === 'undefined') return;
  window.clearInterval(heartbeatTimerId);
  heartbeatTimerId = null;
}
