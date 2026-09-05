/**
 * Push notifications subscription (Web Push + VAPID).
 * Fetches the public VAPID key from /api/push/vapid-public, subscribes the SW
 * and posts the subscription to /api/push/subscribe.
 *
 * Toggle state is persisted in localStorage under 'cretli-push-enabled'.
 */
import { t } from '../../i18n/index.js';
import { cretliApiFetch } from '../../lib/cretliApiRequest.js';
import {
  readStorageValueWithAlias,
  removeStorageValueWithAlias,
  writeStorageValueWithAlias,
} from '../../lib/storageKeyAlias.js';

const LS_KEY = 'cretli-push-enabled';

function base64UrlToUint8Array(base64Url) {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function getVapidPublicKey() {
  const res = await cretliApiFetch('/api/push/vapid-public');
  if (!res.ok) throw new Error(`vapid-public HTTP ${res.status}`);
  const data = await res.json();
  if (!data?.publicKey) throw new Error('vapid-public: missing publicKey');
  return String(data.publicKey);
}

async function getSwRegistration() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  return await navigator.serviceWorker.ready;
}

async function subscribe() {
  const reg = await getSwRegistration();
  if (!reg) throw new Error('service worker not ready');
  const publicKey = await getVapidPublicKey();
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToUint8Array(publicKey),
  });
  const res = await cretliApiFetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription: sub, endpoint: sub.endpoint }),
  });
  if (!res.ok) throw new Error(`subscribe HTTP ${res.status}`);
  return sub;
}

async function unsubscribe() {
  const reg = await getSwRegistration();
  if (!reg) return;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  try {
    await sub.unsubscribe();
  } catch (_) {}
  try {
    await cretliApiFetch('/api/push/subscribe', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
  } catch (_) {}
}

export function isPushEnabled() {
  try {
    return readStorageValueWithAlias(localStorage, LS_KEY, '') === '1';
  } catch (_) {
    return false;
  }
}

function setStored(flag) {
  try {
    if (flag) writeStorageValueWithAlias(localStorage, LS_KEY, '1');
    else removeStorageValueWithAlias(localStorage, LS_KEY);
  } catch (_) {}
}

/**
 * Enables/disables notifications. Returns { ok, message }.
 */
export async function setPushEnabled(enabled) {
  if (!('Notification' in window)) {
    return { ok: false, message: t('pwa.pushUnsupported') };
  }
  if (enabled) {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      return { ok: false, message: t('pwa.pushPermissionDenied') };
    }
    try {
      await subscribe();
      setStored(true);
      return { ok: true, message: t('pwa.pushOn') };
    } catch (err) {
      return { ok: false, message: t('pwa.pushError', { detail: err?.message || String(err) }) };
    }
  }
  try {
    await unsubscribe();
    setStored(false);
    return { ok: true, message: t('pwa.pushOff') };
  } catch (err) {
    setStored(false);
    return { ok: false, message: t('pwa.pushError', { detail: err?.message || String(err) }) };
  }
}

/**
 * Initializes the #pwa-push-checkbox toggle in settings.
 */
export function initPushSettingsToggle() {
  if (typeof document === 'undefined') return;
  const checkbox = document.getElementById('pwa-push-checkbox');
  const status = document.getElementById('pwa-push-status');
  if (!checkbox || !status) return;

  const supported =
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window;
  if (!supported) {
    checkbox.disabled = true;
    checkbox.checked = false;
    status.textContent = t('pwa.pushUnsupported');
    return;
  }

  checkbox.checked = isPushEnabled();
  status.textContent = '';

  checkbox.addEventListener('change', async () => {
    checkbox.disabled = true;
    const result = await setPushEnabled(checkbox.checked);
    checkbox.checked = result.ok ? checkbox.checked : isPushEnabled();
    status.textContent = result.message;
    checkbox.disabled = false;
  });
}
