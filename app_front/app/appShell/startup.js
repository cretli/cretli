import { appLogger } from '../../core/logging/logger.js';
import { readStorageValueWithAlias } from '../../lib/storageKeyAlias.js';
import { EMBED_ALLOWED_PANELS, EMBED_DEFAULT_PANEL } from './embedMode.js';
import { RESTORABLE_PANELS } from './panelRegistry.js';

const STARTUP_DEBUG_FLAG_LS_KEY = 'cretli-debug-startup';
const APP_BOOT_STARTED_AT_MS = typeof performance !== 'undefined' ? performance.now() : Date.now();
export const APP_MODES = {
  main: {
    id: 'main',
    allowedPanels: RESTORABLE_PANELS,
    defaultPanel: 'chat',
  },
  embed: {
    id: 'embed',
    allowedPanels: EMBED_ALLOWED_PANELS,
    defaultPanel: EMBED_DEFAULT_PANEL,
  },
};

if (typeof window !== 'undefined') {
  window.__crAppBootStartedAtMs = APP_BOOT_STARTED_AT_MS;
}

function isStartupDebugEnabled() {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search || '');
  const query = (params.get('debugStartup') || '').trim().toLowerCase();
  if (query === '1' || query === 'true' || query === 'yes') return true;
  try {
    const stored = readStorageValueWithAlias(localStorage, STARTUP_DEBUG_FLAG_LS_KEY, '');
    if (!stored) return false;
    const normalized = String(stored).trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
  } catch (_) {
    return false;
  }
}

export function startupLog(step) {
  if (!isStartupDebugEnabled()) return;
  const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const sinceBootMs = (nowMs - APP_BOOT_STARTED_AT_MS).toFixed(1);
  const message = `[startup +${sinceBootMs}ms] ${step}`;
  console.log(message);
  appLogger.log('startup-debug', message);
}

export function measureStartupStep(stepName, fn) {
  const startedAtMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const result = fn();
  const endedAtMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
  startupLog(`${stepName} (${(endedAtMs - startedAtMs).toFixed(1)}ms)`);
  return result;
}
