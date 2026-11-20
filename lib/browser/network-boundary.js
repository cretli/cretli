/**
 * Explicit network-boundary contract for the Browser module.
 *
 * The MVP policy is defense in depth, not a complete egress proxy. A proxy
 * boundary is accepted only when an operator supplies a concrete Playwright
 * proxy URL; this prevents a configuration label from overstating isolation.
 */

export const BROWSER_NETWORK_BOUNDARIES = Object.freeze([
  'mvp-defense-in-depth',
  'proxy',
  'required',
]);

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ mode: string, proxyServer: string, configured: boolean, error: string }}
 */
export function resolveBrowserNetworkBoundary(env = process.env) {
  const requested = String(env?.CRETLI_BROWSER_NETWORK_BOUNDARY || 'mvp-defense-in-depth')
    .trim()
    .toLowerCase();
  const mode = BROWSER_NETWORK_BOUNDARIES.includes(requested) ? requested : '';
  const proxyServer = String(env?.CRETLI_BROWSER_PROXY_SERVER || '').trim();
  if (!mode) {
    return { mode: 'mvp-defense-in-depth', proxyServer: '', configured: false, error: `Unsupported network boundary: ${requested}` };
  }
  if ((mode === 'proxy' || mode === 'required') && !proxyServer) {
    return { mode, proxyServer: '', configured: false, error: `${mode} requires CRETLI_BROWSER_PROXY_SERVER` };
  }
  if (proxyServer) {
    try {
      const parsed = new URL(proxyServer);
      if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(parsed.protocol)) throw new Error('unsupported scheme');
    } catch {
      return { mode, proxyServer: '', configured: false, error: 'CRETLI_BROWSER_PROXY_SERVER must be a valid http(s), socks4, or socks5 URL' };
    }
  }
  return { mode, proxyServer, configured: mode === 'mvp-defense-in-depth' || Boolean(proxyServer), error: '' };
}
