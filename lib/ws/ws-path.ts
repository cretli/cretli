/** Normalizes a WebSocket URL pathname for routing and security checks. */
export function normalizeWsPath(urlPath: string): string {
  const path = String(urlPath || '/').trim();
  if (!path.startsWith('/')) return `/${path}`;
  return path;
}

export function isWidgetChatPath(urlPath: string): boolean {
  const path = normalizeWsPath(urlPath);
  return path === '/ws-agent-sdk' || path.endsWith('/ws-agent-sdk');
}

export function isPageBridgePath(urlPath: string): boolean {
  const path = normalizeWsPath(urlPath);
  return path === '/ws-page-bridge' || path.endsWith('/ws-page-bridge');
}

/** Dedicated Browser channel, separate from the widget page bridge. */
export function isBrowserPath(urlPath: string): boolean {
  const path = normalizeWsPath(urlPath);
  return path === '/ws-browser' || path.endsWith('/ws-browser');
}

export function isTerminalPath(urlPath: string): boolean {
  const path = normalizeWsPath(urlPath);
  return path === '/ws' || path.endsWith('/ws')
    || path === '/ws-agent' || path.endsWith('/ws-agent');
}
