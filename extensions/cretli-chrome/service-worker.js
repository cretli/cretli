// Cretli extension service worker: keeps the WebSocket to the Cretli server,
// executes the fixed command set (open_url, list_documents, download, cancel)
// and streams document bytes back as binary frames. No code or command derived
// from page content is ever executed.
import { domainOfUrl, originsFor } from './domains.js';
import { fetchDocument } from './fetch-document.js';
import { abortAll, awaitAbortable, bindSocketLifecycle } from './lifecycle.js';

const DEFAULT_URL = 'wss://127.0.0.1:3011/ws-chrome-ext';
const FRAME = 256 * 1024;
const BACKOFF = [1000, 2000, 5000, 15000, 30000, 60000];

let ws = null;
let attempt = 0;
let reconnectTimer = null;
let authed = false;
let allowed = [];
let pending = [];
const running = new Map(); // command id -> AbortController

const store = {
  get: (keys) => chrome.storage.local.get(keys),
  set: (values) => chrome.storage.local.set(values),
};

function sendJson(message) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function fail(code, message, extra = {}) {
  return { ok: false, error: { code, message, ...extra } };
}

async function hasHostAccess(domain) {
  return chrome.permissions.contains({ origins: originsFor(domain) });
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw new DOMException('Cancelled.', 'AbortError');
  if (!ws || ws.readyState !== WebSocket.OPEN) throw new DOMException('Disconnected.', 'AbortError');
}

async function checkDomain(domain, signal) {
  throwIfCancelled(signal);
  if (!domain || !allowed.includes(domain)) return fail('E_DOMAIN_NOT_ALLOWED', 'Domain is not on the allowed list.');
  const hasAccess = await awaitAbortable(hasHostAccess(domain), signal, () => !!ws && ws.readyState === WebSocket.OPEN);
  throwIfCancelled(signal);
  if (!hasAccess) return fail('E_PERMISSION_DENIED', 'Chrome host permission not granted. Open the Cretli popup and grant access.');
  return null;
}

async function ensureContentScript(tabId, signal) {
  throwIfCancelled(signal);
  await awaitAbortable(chrome.scripting.executeScript({ target: { tabId }, files: ['content-script.js'] }), signal, () => !!ws && ws.readyState === WebSocket.OPEN);
  throwIfCancelled(signal);
}

function waitForLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function done() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }
    function onUpdated(id, info) { if (id === tabId && info.status === 'complete') done(); }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((tab) => { if (tab.status === 'complete') done(); }).catch(done);
  });
}

async function openUrl({ url, reuseTab }, signal) {
  throwIfCancelled(signal);
  const denied = await checkDomain(domainOfUrl(url), signal);
  if (denied) return denied;
  const { cretliTabId } = await awaitAbortable(store.get('cretliTabId'), signal, () => !!ws && ws.readyState === WebSocket.OPEN);
  throwIfCancelled(signal);
  let tab = null;
  if (reuseTab && Number.isInteger(cretliTabId)) {
    tab = await awaitAbortable(chrome.tabs.update(cretliTabId, { url }).catch(() => null), signal, () => !!ws && ws.readyState === WebSocket.OPEN);
    throwIfCancelled(signal);
  }
  if (!tab) {
    throwIfCancelled(signal);
    tab = await awaitAbortable(chrome.tabs.create({ url, active: false }), signal, () => !!ws && ws.readyState === WebSocket.OPEN);
  }
  throwIfCancelled(signal);
  await awaitAbortable(store.set({ cretliTabId: tab.id }), signal, () => !!ws && ws.readyState === WebSocket.OPEN);
  throwIfCancelled(signal);
  await awaitAbortable(waitForLoad(tab.id, 20000), signal, () => !!ws && ws.readyState === WebSocket.OPEN);
  throwIfCancelled(signal);
  const done = await awaitAbortable(chrome.tabs.get(tab.id), signal, () => !!ws && ws.readyState === WebSocket.OPEN);
  throwIfCancelled(signal);
  return { ok: true, data: { tabId: done.id, url: done.url || url, title: (done.title || '').slice(0, 200) } };
}

async function tabAccess(tabId, signal) {
  throwIfCancelled(signal);
  const tab = await awaitAbortable(chrome.tabs.get(tabId).catch(() => null), signal, () => !!ws && ws.readyState === WebSocket.OPEN);
  throwIfCancelled(signal);
  if (!tab) return { error: fail('E_NO_TAB', 'Tab not found.') };
  const domain = domainOfUrl(tab.url || '');
  const denied = await checkDomain(domain, signal);
  return denied ? { error: denied } : { tab, domain };
}

async function listDocuments({ tabId, selector, match, limit }, signal) {
  const access = await tabAccess(tabId, signal);
  if (access.error) return access.error;
  await ensureContentScript(tabId, signal);
  throwIfCancelled(signal);
  const [{ result }] = await awaitAbortable(chrome.scripting.executeScript({
    target: { tabId }, func: (opts) => globalThis.__cretliExt.list(opts), args: [{ selector, match, limit }],
  }), signal, () => !!ws && ws.readyState === WebSocket.OPEN);
  throwIfCancelled(signal);
  return { ok: true, data: result };
}

async function sha256Hex(buffer) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function idBytes(id) {
  const hex = id.replace(/-/g, '');
  return Uint8Array.from(hex.match(/../g).map((h) => parseInt(h, 16)));
}

async function downloadOne(id, item, tab, domain, signal) {
  let href = item.href;
  if (!href && item.selector) {
    const [{ result }] = await awaitAbortable(chrome.scripting.executeScript({
      target: { tabId: tab.id }, func: (sel) => globalThis.__cretliExt.resolve(sel), args: [item.selector],
    }), signal, () => !!ws && ws.readyState === WebSocket.OPEN);
    if (result?.error) return fail(result.error, 'Selector did not match exactly one link.');
    href = result.href;
  }
  // Every host is checked against the current server-approved list and Chrome grant.
  const fetched = await fetchDocument(href || '', {
    signal,
    isHostAllowed: async (host) => !(await checkDomain(host, signal)),
  });
  if (!fetched.ok) return fetched;
  const { bytes, mime, finalHost, name } = fetched;
  if (signal.aborted || !ws || ws.readyState !== WebSocket.OPEN) return fail('E_CANCELLED', 'Cancelled.');
  sendJson({ type: 'download.begin', requestId: id, mime, size: bytes.length, name, sourceHost: finalHost });
  const prefix = idBytes(id);
  for (let at = 0; at < bytes.length; at += FRAME) {
    if (signal.aborted || !ws || ws.readyState !== WebSocket.OPEN) return fail('E_CANCELLED', 'Cancelled.');
    const part = bytes.subarray(at, at + FRAME);
    const frame = new Uint8Array(16 + part.length);
    frame.set(prefix, 0);
    frame.set(part, 16);
    ws.send(frame);
  }
  sendJson({ type: 'download.end', requestId: id, sha256: await sha256Hex(bytes) });
  return null;
}

async function download(id, { tabId, items }, signal) {
  const access = await tabAccess(tabId, signal);
  if (access.error) return access.error;
  await ensureContentScript(tabId, signal);
  for (const item of items) {
    throwIfCancelled(signal);
    const problem = await downloadOne(id, item, access.tab, access.domain, signal);
    if (problem) return problem;
  }
  return { ok: true, data: {} };
}

async function runCommand(message) {
  const controller = new AbortController();
  running.set(message.id, controller);
  let outcome;
  try {
    if (message.name === 'open_url') outcome = await openUrl(message.args || {}, controller.signal);
    else if (message.name === 'list_documents') outcome = await listDocuments(message.args || {}, controller.signal);
    else if (message.name === 'download') outcome = await download(message.id, message.args || {}, controller.signal);
    else if (message.name === 'cancel') {
      running.get(message.args?.targetId)?.abort();
      outcome = { ok: true, data: {} };
    } else outcome = fail('E_INTERNAL', 'Unknown command.');
  } catch (err) {
    outcome = controller.signal.aborted ? fail('E_CANCELLED', 'Cancelled.') : fail('E_INTERNAL', String(err?.message || err).slice(0, 200));
  } finally {
    // Whatever the outcome, end the request before the controller leaves `running`.
    controller.abort();
    running.delete(message.id);
  }
  sendJson({ type: 'result', id: message.id, ...outcome });
}

async function onMessage(event) {
  if (typeof event.data !== 'string') return;
  let message;
  try { message = JSON.parse(event.data); } catch { return; }
  if (message.type === 'paired') {
    await store.set({ installId: message.installId, token: message.token });
  } else if (message.type === 'authed' || message.type === 'domains') {
    authed = true;
    attempt = 0;
    allowed = message.allowed || [];
    pending = (message.pending || []).map((item) => item.domain);
    await store.set({ allowed, pending });
  } else if (message.type === 'cmd') {
    runCommand(message);
  }
  broadcastStatus();
}

async function connect(firstMessage) {
  clearTimeout(reconnectTimer);
  if (ws && ws.readyState <= WebSocket.OPEN) return;
  const { serverUrl, installId, token, killed } = await store.get(['serverUrl', 'installId', 'token', 'killed']);
  if (killed) return;
  const hello = firstMessage || (installId && token ? { type: 'auth', installId, token } : null);
  if (!hello) return;
  const url = serverUrl || DEFAULT_URL;
  ws = new WebSocket(url);
  authed = false;
  ws.onopen = () => sendJson(hello);
  ws.onmessage = onMessage;
  bindSocketLifecycle(ws, { running, onClosed: (event) => {
    ws = null;
    authed = false;
    broadcastStatus();
    // 4403: revoked, killed or bad credentials; retry only slowly.
    const delay = event.code === 4403 ? 60000 : BACKOFF[Math.min(attempt, BACKOFF.length - 1)];
    attempt += 1;
    reconnectTimer = setTimeout(() => connect(), delay);
  } });
}

function disconnect() {
  clearTimeout(reconnectTimer);
  abortAll(running);
  if (ws) { ws.onclose = null; ws.close(1000); ws = null; }
  authed = false;
}

async function status() {
  const { installId, killed, serverUrl } = await store.get(['installId', 'killed', 'serverUrl']);
  return { paired: !!installId, connected: authed, killed: !!killed, serverUrl: serverUrl || DEFAULT_URL, allowed, pending };
}

async function broadcastStatus() {
  chrome.runtime.sendMessage({ type: 'status', status: await status() }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  (async () => {
    if (message.type === 'status') return status();
    if (message.type === 'pair') {
      disconnect();
      await store.set({ serverUrl: message.serverUrl || DEFAULT_URL, killed: false });
      await connect({ type: 'pair', code: String(message.code || '').trim(), extensionId: chrome.runtime.id, label: 'Chrome' });
      return status();
    }
    if (message.type === 'kill') {
      // Local kill switch: disconnect and forget the token. Pair again to resume.
      disconnect();
      await chrome.storage.local.remove(['installId', 'token']);
      await store.set({ killed: true });
      return status();
    }
    if (message.type === 'resume') { await store.set({ killed: false }); return status(); }
    if (message.type === 'grant') {
      // Runs from a popup click, which Chrome accepts as the required user gesture.
      const granted = await chrome.permissions.request({ origins: originsFor(String(message.domain)) });
      return { granted };
    }
    if (message.type === 'save-url') { await store.set({ serverUrl: message.serverUrl }); return status(); }
    return null;
  })().then(reply);
  return true;
});

chrome.alarms.create('cretli-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {
  if (ws && ws.readyState === WebSocket.OPEN) sendJson({ type: 'ping' });
  else connect();
});
chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(() => connect());
connect();
