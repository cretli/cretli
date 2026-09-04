/**
 * Sticky-session cookie for multi-instance load balancers.
 * Sets cretli-instance on first HTTP response when absent.
 */

export const STICKY_INSTANCE_COOKIE_NAME = 'cretli-instance';
export const LEGACY_STICKY_INSTANCE_COOKIE_NAME = 'cursor-remote-instance';

/**
 * @param {string | undefined} cookieHeader
 * @param {string} name
 * @returns {string}
 */
export function readCookieValue(cookieHeader, name) {
  if (!cookieHeader || typeof cookieHeader !== 'string' || !name) return '';
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${name}=`)) continue;
    return decodeURIComponent(trimmed.slice(name.length + 1)).trim();
  }
  return '';
}

/**
 * @param {string | undefined} cookieHeader
 * @returns {string}
 */
export function readStickyInstanceCookie(cookieHeader) {
  return (
    readCookieValue(cookieHeader, STICKY_INSTANCE_COOKIE_NAME) ||
    readCookieValue(cookieHeader, LEGACY_STICKY_INSTANCE_COOKIE_NAME)
  );
}

/**
 * Ensures the sticky instance cookie is present on the response.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string} instanceId
 * @param {{ secure?: boolean }} [options]
 * @returns {string}
 */
export function ensureStickyInstanceCookie(req, res, instanceId, options = {}) {
  const normalizedId = typeof instanceId === 'string' ? instanceId.trim() : '';
  if (!normalizedId) return '';
  const existing = readStickyInstanceCookie(req.headers.cookie);
  if (existing) return existing;
  const secure = options.secure === true;
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Lax', secure ? 'Secure' : ''].filter(Boolean);
  res.append(
    'Set-Cookie',
    `${STICKY_INSTANCE_COOKIE_NAME}=${encodeURIComponent(normalizedId)}; ${flags.join('; ')}`
  );
  return normalizedId;
}
