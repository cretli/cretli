// Shared by the service worker, popup, options page and tests.
// Consent is scoped to the exact host: without the public suffix list a
// "registrable domain" guess would let one tenant of a shared suffix
// (e.g. alice.github.io) approve another (bob.github.io).

/** Lower-case host, or '' for IP literals, single labels and malformed names. */
export function consentHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
  if (!host || host.length > 253 || !/^[a-z0-9.-]+$/.test(host)) return '';
  const labels = host.split('.');
  if (labels.length < 2 || labels.some((label) => !label || label.length > 63)) return '';
  if (labels.every((label) => /^\d+$/.test(label))) return '';
  return host;
}

/** Consent host of an https URL on the default port without userinfo, or ''. */
export function domainOfUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return '';
    return consentHost(parsed.hostname);
  } catch {
    return '';
  }
}

/** Chrome match pattern for exactly this host (no subdomains, no shared suffix). */
export function originsFor(host) {
  return [`https://${host}/*`];
}
