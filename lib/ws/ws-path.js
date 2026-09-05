/**
 * Normalizes a WebSocket URL pathname for routing and security checks.
 * @param {string} urlPath
 * @returns {string}
 */
export function normalizeWsPath(urlPath) {
  const path = String(urlPath || '/').trim();
  if (!path.startsWith('/')) return `/${path}`;
  return path;
}

/**
 * @param {string} urlPath
 * @returns {boolean}
 */
export function isWidgetChatPath(urlPath) {
  const path = normalizeWsPath(urlPath);
  return path === '/ws-agent-sdk' || path.endsWith('/ws-agent-sdk');
}

/**
 * @param {string} urlPath
 * @returns {boolean}
 */
export function isPageBridgePath(urlPath) {
  const path = normalizeWsPath(urlPath);
  return path === '/ws-page-bridge' || path.endsWith('/ws-page-bridge');
}

/**
 * @param {string} urlPath
 * @returns {boolean}
 */
export function isTerminalPath(urlPath) {
  const path = normalizeWsPath(urlPath);
  return path === '/ws' || path.endsWith('/ws')
    || path === '/ws-agent' || path.endsWith('/ws-agent');
}
