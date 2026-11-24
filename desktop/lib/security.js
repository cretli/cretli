// Cretli's default port; the server binds 127.0.0.1 (plain HTTP with USE_HTTPS=0).
export const DEFAULT_SERVER_URL = 'http://127.0.0.1:3011';

export function parseServerUrl(value = DEFAULT_SERVER_URL) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new TypeError('CRETLI_URL must be an http or https URL without credentials');
  }
  return url;
}

export function isAllowedNavigation(target, configuredOrigin) {
  try {
    return new URL(target).origin === configuredOrigin;
  } catch {
    return false;
  }
}

/**
 * Resolve the target URL of a navigation event. Modern Electron passes a single
 * details/event object carrying `url` (will-navigate, will-redirect,
 * will-frame-navigate); older signatures pass the URL as a second argument.
 */
export function resolveNavigationUrl(event, legacyUrl) {
  if (typeof event?.url === 'string') return event.url;
  if (typeof event?.details?.url === 'string') return event.details.url;
  return typeof legacyUrl === 'string' ? legacyUrl : undefined;
}

/**
 * Build a navigation listener that cancels any navigation (including a missing
 * or unparsable URL) that does not stay on the configured origin.
 */
export function createNavigationGuard(configuredOrigin) {
  return (event, legacyUrl) => {
    const target = resolveNavigationUrl(event, legacyUrl);
    if (!isAllowedNavigation(target, configuredOrigin)) event.preventDefault();
  };
}

export function isTrustedSender(senderFrame, configuredOrigin) {
  return Boolean(senderFrame?.url && isAllowedNavigation(senderFrame.url, configuredOrigin));
}

/**
 * Wrap an ipcMain.handle-style handler so it only runs for frames at the
 * configured origin. `event.senderFrame` is supplied by Electron.
 */
export function guardIpcHandler(handler, configuredOrigin) {
  return (event, ...args) => {
    if (!isTrustedSender(event?.senderFrame, configuredOrigin)) {
      throw new Error('IPC sender is not trusted');
    }
    return handler(event, ...args);
  };
}

export function buildWindowOptions(preload) {
  return {
    width: 1280,
    height: 800,
    webPreferences: {
      preload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  };
}
