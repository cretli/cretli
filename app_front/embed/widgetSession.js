const PAGE_SESSION_PREFIX = 'cr-widget-page-session:v1:';
const AUTH_PREFIX = 'cr-widget-auth:v1:';
const OPEN_ON_LOAD_PREFIX = 'cr-widget-open-on-load:v1:';

function storageKey(prefix, installationId, origin) {
  return `${prefix}${installationId}:${origin}`;
}

function decodeBase64Url(value) {
  const base64 = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  return atob(padded);
}

function buildStablePageSessionId(installationId, origin) {
  const stable = `page-${installationId}-${origin}`;
  return stable.length <= 128 ? stable : stable.slice(0, 128);
}

export function parseWidgetTokenExpiry(accessToken) {
  if (typeof accessToken !== 'string') return 0;
  const payloadPart = accessToken.split('.')[0];
  if (!payloadPart) return 0;
  try {
    const payload = JSON.parse(decodeBase64Url(payloadPart));
    return typeof payload.exp === 'number' ? payload.exp : 0;
  } catch {
    return 0;
  }
}

export function getOrCreatePageSessionId(installationId, origin) {
  if (!installationId || !origin) {
    return globalThis.crypto?.randomUUID?.()
      || `page-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  const stable = buildStablePageSessionId(installationId, origin);
  const key = storageKey(PAGE_SESSION_PREFIX, installationId, origin);
  try {
    const stored = localStorage.getItem(key)?.trim() || '';
    if (stored && stored.length <= 128) return stored;
    localStorage.setItem(key, stable);
  } catch {
    // localStorage may be unavailable in private mode.
  }
  return stable;
}

export function loadStoredWidgetAuth(installationId, origin, pageSessionId) {
  if (!installationId || !origin || !pageSessionId) return null;
  const key = storageKey(AUTH_PREFIX, installationId, origin);
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || data.pageSessionId !== pageSessionId) return null;
    if (!data.accessToken || data.installation?.id !== installationId) return null;
    const exp = Number(data.expiresAt) || parseWidgetTokenExpiry(data.accessToken);
    if (!exp || exp <= Date.now()) {
      localStorage.removeItem(key);
      return null;
    }
    return {
      type: 'cretli-widget-authorized',
      installation: data.installation,
      accessToken: data.accessToken,
      pageSessionId: data.pageSessionId,
    };
  } catch {
    return null;
  }
}

export function saveWidgetAuth(installationId, origin, auth) {
  if (!installationId || !origin || !auth?.accessToken || !auth?.installation) return;
  const key = storageKey(AUTH_PREFIX, installationId, origin);
  try {
    localStorage.setItem(key, JSON.stringify({
      pageSessionId: auth.pageSessionId,
      accessToken: auth.accessToken,
      installation: auth.installation,
      expiresAt: parseWidgetTokenExpiry(auth.accessToken),
    }));
  } catch {
    // Ignore storage errors.
  }
}

export function clearWidgetAuth(installationId, origin) {
  if (!installationId || !origin) return;
  try {
    localStorage.removeItem(storageKey(AUTH_PREFIX, installationId, origin));
  } catch {
    // Ignore storage errors.
  }
}

export function markWidgetOpenOnLoad(installationId, origin) {
  if (!installationId || !origin) return;
  const key = storageKey(OPEN_ON_LOAD_PREFIX, installationId, origin);
  try {
    sessionStorage.setItem(key, '1');
  } catch {
    // sessionStorage may be unavailable.
  }
}

export function consumeWidgetOpenOnLoad(installationId, origin) {
  if (!installationId || !origin) return false;
  const key = storageKey(OPEN_ON_LOAD_PREFIX, installationId, origin);
  try {
    const value = sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
    return value === '1';
  } catch {
    return false;
  }
}
