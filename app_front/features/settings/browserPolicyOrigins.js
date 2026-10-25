/** Parsing of the Settings Browser policy origins field (no DOM, unit-tested). */

/**
 * Splits the origins textarea into normalized origins. A line without a scheme
 * gets `http://` (the usual local dev server); a path or query is dropped.
 * Lines that are not an http(s) origin are returned in `invalid` instead of
 * being dropped silently by the server.
 *
 * @param {string} text
 * @returns {{ origins: string[], invalid: string[] }}
 */
export function parseBrowserPolicyOrigins(text) {
  const origins = [];
  const invalid = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw) continue;
    let parsed = null;
    try {
      parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    } catch {
      parsed = null;
    }
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname
      || parsed.username || parsed.password) {
      invalid.push(raw);
      continue;
    }
    if (!origins.includes(parsed.origin)) origins.push(parsed.origin);
  }
  return { origins, invalid };
}
