/**
 * Bridge to Cretli's own Chrome extension (`/ws-chrome-ext`).
 *
 * Separate from `chrome-extension-bridge.js`, which drives Anthropic's Claude
 * in Chrome. Contract: docs/chrome-extension-bridge.md sections 2-5.
 *
 * - first message authenticates (pair / auth, 5 s timeout), one live socket per owner;
 * - one command per owner at a time, server-enforced timeouts, MCP abort -> cancel;
 * - PDF/CSV bytes arrive as binary frames and are written under the chat's
 *   download directory; the server recomputes size and sha256;
 * - results are whitelisted field by field, so cookies, headers and credentials
 *   cannot reach the agent even if the extension sent them.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { chromeExtensionIdFromOrigin } from '../ws/ws-origin.ts';
import { consentHost, domainOfUrl, getChromeExtStore } from './chrome-ext-store.js';
import { resolveDataPath } from '../runtime-paths.js';

export const AUTH_TIMEOUT_MS = 5000;
export const FRAME_MAX_BYTES = 256 * 1024;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_COMMAND_BYTES = 50 * 1024 * 1024;
export const MAX_FILES_PER_COMMAND = 10;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DOWNLOAD_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 300_000;
const MAX_TEXT_FRAME_BYTES = 1024 * 1024;

export const ERROR_CODES = Object.freeze([
  'E_NOT_PAIRED', 'E_DISCONNECTED', 'E_KILLED', 'E_DOMAIN_NOT_ALLOWED', 'E_PERMISSION_DENIED',
  'E_NO_TAB', 'E_SELECTOR', 'E_TYPE', 'E_LIMIT', 'E_HTTP', 'E_TIMEOUT', 'E_CANCELLED', 'E_BUSY', 'E_INTERNAL',
]);
const CODE_SET = new Set(ERROR_CODES);
const ALLOWED_MIME = new Map([['application/pdf', '.pdf'], ['text/csv', '.csv']]);

const fail = (code, message) => ({ ok: false, error: { code, message } });

const clip = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

/** https URL without userinfo, or '' for anything else (including unparsable values). */
function safeUrl(value) {
  try {
    const parsed = new URL(String(value ?? '').trim());
    if (parsed.protocol !== 'https:') return '';
    parsed.username = '';
    parsed.password = '';
    return clip(parsed.href, 2000);
  } catch {
    return '';
  }
}

/**
 * Whitelists a command result. Unknown fields are dropped, so credentials or
 * headers an extension might add never survive.
 * @returns {Record<string, any>}
 */
export function sanitizeResult(name, data) {
  const raw = data && typeof data === 'object' ? data : {};
  if (name === 'open_url') {
    return {
      tabId: Number.isInteger(raw.tabId) ? raw.tabId : -1,
      url: safeUrl(raw.url),
      title: clip(raw.title, 200),
    };
  }
  if (name === 'list_documents') {
    const items = Array.isArray(raw.items) ? raw.items.slice(0, 200) : [];
    return {
      items: items.filter((item) => item && typeof item === 'object').map((item) => ({
        selector: clip(item.selector, 500),
        href: safeUrl(item.href),
        text: clip(item.text, 200),
        mimeHint: clip(item.mimeHint, 100),
      })),
    };
  }
  return {};
}

/** @returns {{ code: string, message: string }} */
const SAFE_MESSAGES = Object.freeze({
  E_NOT_PAIRED: 'No Chrome extension is paired.',
  E_DISCONNECTED: 'The Chrome extension disconnected.',
  E_KILLED: 'The Chrome extension was switched off.',
  E_DOMAIN_NOT_ALLOWED: 'The host is not on the allowed list.',
  E_PERMISSION_DENIED: 'Chrome host permission is not granted.',
  E_NO_TAB: 'The tab was not found.',
  E_SELECTOR: 'The selector did not match exactly one link.',
  E_TYPE: 'Only PDF and CSV documents are supported.',
  E_LIMIT: 'A size or count limit was exceeded.',
  E_HTTP: 'HTTP error',
  E_TIMEOUT: 'The command timed out.',
  E_CANCELLED: 'The command was cancelled.',
  E_BUSY: 'Another command is running.',
  E_INTERNAL: 'The Chrome extension reported an internal error.',
});

export function sanitizeError(error) {
  const raw = error && typeof error === 'object' ? error : {};
  const code = CODE_SET.has(raw.code) ? raw.code : 'E_INTERNAL';
  if (code === 'E_HTTP') {
    const status = Number.isInteger(raw.status) && raw.status >= 100 && raw.status <= 599 ? raw.status : 0;
    return { code, message: status ? `HTTP ${status}` : 'HTTP error' };
  }
  // The extension's own message is never forwarded: it could carry header or cookie values.
  return { code, message: SAFE_MESSAGES[code] };
}

/** Safe file name: `[A-Za-z0-9._-]`, max 120 chars, extension forced to match the MIME type. */
export function sanitizeFileName(name, mime) {
  const ext = ALLOWED_MIME.get(mime) || '';
  let base = String(name || 'document').split(/[\\/]/).pop().replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  if (base.toLowerCase().endsWith(ext)) base = base.slice(0, -ext.length);
  base = base.slice(0, 120 - ext.length) || 'document';
  return `${base}${ext}`;
}

function safeSegment(value) {
  return String(value || 'chat').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 120) || 'chat';
}

function uuidBytes(id) {
  return Buffer.from(String(id).replace(/-/g, ''), 'hex');
}

/**
 * @param {{
 *   store?: ReturnType<typeof import('./chrome-ext-store.js').createChromeExtStore>,
 *   downloadsDir?: string,
 *   authTimeoutMs?: number,
 * }} [options]
 */
export function createCretliExtensionBridge(options = {}) {
  const getStore = () => options.store || getChromeExtStore();
  const getDownloadsDir = () => options.downloadsDir || resolveDataPath('chrome-ext-downloads');
  const authTimeoutMs = options.authTimeoutMs ?? AUTH_TIMEOUT_MS;
  /** @type {Map<string, any>} owner -> live connection */
  const conns = new Map();

  const send = (ws, message) => {
    try { ws.send(JSON.stringify(message)); } catch { /* socket already closing */ }
  };

  function pushDomains(ownerId) {
    const conn = conns.get(ownerId);
    if (conn) send(conn.ws, { type: 'domains', ...getStore().listDomains(ownerId) });
  }

  function dropPartial(cmd) {
    const current = cmd.current;
    if (!current) return;
    cmd.current = null;
    try { fs.closeSync(current.fd); } catch { /* already closed */ }
    try { fs.rmSync(current.partPath, { force: true }); } catch { /* best effort */ }
  }

  /** Ends a command exactly once; removes partial and (on error) completed files. */
  function finish(conn, cmd, outcome) {
    if (cmd.done) return;
    cmd.done = true;
    clearTimeout(cmd.timer);
    cmd.signal?.removeEventListener?.('abort', cmd.onAbort);
    dropPartial(cmd);
    if (conn.active === cmd) conn.active = null;
    const store = getStore();
    if (cmd.name === 'download') {
      if (outcome.ok) {
        for (const file of cmd.files) {
          store.appendAudit({ owner: conn.ownerId, chatId: cmd.chatId, domain: file.sourceHost, file: file.name, size: file.size, sha256: file.sha256, result: 'ok' });
        }
      } else {
        for (const file of cmd.files) fs.rmSync(file.path, { force: true });
        store.appendAudit({
          owner: conn.ownerId, chatId: cmd.chatId, domain: cmd.currentHost || cmd.domain || '',
          file: cmd.currentName || '', size: cmd.totalBytes, sha256: '', result: outcome.error.code,
        });
      }
    }
    cmd.resolve(outcome);
  }

  function abortCommand(conn, cmd, code, message, { notify = true } = {}) {
    if (cmd.done) return;
    if (notify && conn.ws.readyState === 1) {
      send(conn.ws, { type: 'cmd', id: crypto.randomUUID(), name: 'cancel', timeoutMs: 5000, args: { targetId: cmd.id } });
    }
    finish(conn, cmd, fail(code, message));
  }

  function onDownloadBegin(conn, cmd, msg) {
    if (cmd.current) return abortCommand(conn, cmd, 'E_INTERNAL', 'Overlapping download transfers.');
    const mime = String(msg.mime || '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_MIME.has(mime)) return abortCommand(conn, cmd, 'E_TYPE', 'Only PDF and CSV files can be downloaded.');
    if (cmd.files.length >= MAX_FILES_PER_COMMAND) return abortCommand(conn, cmd, 'E_LIMIT', `At most ${MAX_FILES_PER_COMMAND} files per command.`);
    // The extension reports the final host of the fetch; it must be currently approved.
    cmd.currentHost = String(msg.sourceHost || '').toLowerCase().slice(0, 253);
    const sourceHost = consentHost(msg.sourceHost);
    if (!sourceHost || !getStore().isDomainAllowed(conn.ownerId, sourceHost)) {
      return abortCommand(conn, cmd, 'E_DOMAIN_NOT_ALLOWED', 'The download host is not on the allowed list.');
    }
    const declared = Number.isFinite(msg.size) ? msg.size : 0;
    if (declared > MAX_FILE_BYTES || cmd.totalBytes + declared > MAX_COMMAND_BYTES) {
      return abortCommand(conn, cmd, 'E_LIMIT', 'File or command size limit exceeded.');
    }
    const dir = path.join(getDownloadsDir(), safeSegment(cmd.chatId));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const name = sanitizeFileName(msg.name, mime);
    const partPath = path.join(dir, `.${crypto.randomUUID()}.part`);
    cmd.currentName = name;
    cmd.currentHost = sourceHost;
    cmd.current = {
      fd: fs.openSync(partPath, 'wx', 0o600), partPath, dir, name, mime, bytes: 0,
      declared, hash: crypto.createHash('sha256'), head: Buffer.alloc(0),
      decoder: mime === 'text/csv' ? new TextDecoder('utf-8', { fatal: true }) : null,
      sourceHost: cmd.currentHost, badContent: false,
    };
  }

  function onDownloadFrame(conn, cmd, payload) {
    const current = cmd.current;
    if (!current) return;
    if (payload.length > FRAME_MAX_BYTES) return abortCommand(conn, cmd, 'E_LIMIT', 'Binary frame too large.');
    if (current.bytes + payload.length > MAX_FILE_BYTES || cmd.totalBytes + current.bytes + payload.length > MAX_COMMAND_BYTES) {
      return abortCommand(conn, cmd, 'E_LIMIT', 'File or command size limit exceeded.');
    }
    if (current.mime === 'application/pdf' && current.head.length < 5) {
      current.head = Buffer.concat([current.head, payload.subarray(0, 5 - current.head.length)]);
    }
    if (current.decoder) {
      if (payload.includes(0)) current.badContent = true;
      else {
        try { current.decoder.decode(payload, { stream: true }); } catch { current.badContent = true; }
      }
    }
    fs.writeSync(current.fd, payload);
    current.hash.update(payload);
    current.bytes += payload.length;
  }

  function onDownloadEnd(conn, cmd, msg) {
    const current = cmd.current;
    if (!current) return;
    const sha256 = current.hash.digest('hex');
    if (current.decoder && !current.badContent) {
      try { current.decoder.decode(new Uint8Array(0)); } catch { current.badContent = true; }
    }
    const sniffOk = current.mime === 'application/pdf'
      ? current.head.toString('latin1') === '%PDF-'
      : !current.badContent;
    if (!current.bytes || !sniffOk) return abortCommand(conn, cmd, 'E_TYPE', 'File content does not match its declared type.');
    if (String(msg.sha256 || '').toLowerCase() !== sha256) return abortCommand(conn, cmd, 'E_INTERNAL', 'sha256 mismatch.');
    if (current.declared && current.declared !== current.bytes) return abortCommand(conn, cmd, 'E_INTERNAL', 'Size mismatch.');
    fs.closeSync(current.fd);
    let finalPath = path.join(current.dir, current.name);
    const ext = path.extname(current.name);
    for (let n = 1; fs.existsSync(finalPath); n += 1) {
      // Reserve room for "-N" so the final name still fits the 120-character cap.
      const suffix = `-${n}`;
      const stem = current.name.slice(0, current.name.length - ext.length).slice(0, 120 - ext.length - suffix.length);
      finalPath = path.join(current.dir, `${stem}${suffix}${ext}`);
    }
    fs.renameSync(current.partPath, finalPath);
    cmd.current = null;
    cmd.totalBytes += current.bytes;
    cmd.files.push({
      path: finalPath, name: path.basename(finalPath), size: current.bytes, sha256, mime: current.mime, sourceHost: current.sourceHost,
    });
  }

  function onResult(conn, msg) {
    const cmd = conn.active;
    if (!cmd || msg.id !== cmd.id) return;
    if (msg.ok !== true) return finish(conn, cmd, { ok: false, error: sanitizeError(msg.error) });
    if (cmd.name === 'download') {
      if (cmd.current) return abortCommand(conn, cmd, 'E_INTERNAL', 'Download ended with an unfinished file.', { notify: false });
      return finish(conn, cmd, { ok: true, data: { files: cmd.files.map((file) => ({ ...file })) } });
    }
    const data = sanitizeResult(cmd.name, msg.data);
    if (cmd.name === 'open_url' && data.tabId >= 0) conn.tabs.set(data.tabId, data.url);
    return finish(conn, cmd, { ok: true, data });
  }

  function onMessage(conn, raw, isBinary) {
    const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    const cmd = conn.active;
    if (isBinary) {
      if (cmd && buffer.length > 16 && buffer.subarray(0, 16).equals(uuidBytes(cmd.id))) {
        try { onDownloadFrame(conn, cmd, buffer.subarray(16)); } catch (err) { abortCommand(conn, cmd, 'E_INTERNAL', clip(err.message, 120)); }
      }
      return;
    }
    if (buffer.length > MAX_TEXT_FRAME_BYTES) return;
    let msg;
    try { msg = JSON.parse(buffer.toString('utf8')); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ping') return send(conn.ws, { type: 'pong' });
    if (msg.type === 'result') return onResult(conn, msg);
    if (!cmd || cmd.name !== 'download' || msg.requestId !== cmd.id) return;
    try {
      if (msg.type === 'download.begin') onDownloadBegin(conn, cmd, msg);
      else if (msg.type === 'download.end') onDownloadEnd(conn, cmd, msg);
    } catch (err) {
      abortCommand(conn, cmd, 'E_INTERNAL', clip(err.message, 120));
    }
  }

  function register(ws, install) {
    const store = getStore();
    const ownerId = install.ownerId;
    const previous = conns.get(ownerId);
    if (previous) {
      conns.delete(ownerId);
      previous.ws.close(4409, 'replaced');
    }
    if (store.isKilled(ownerId)) {
      ws.close(4403, 'killed');
      return null;
    }
    const conn = { ws, ownerId, installId: install.installId, active: null, tabs: new Map() };
    conns.set(ownerId, conn);
    ws.on('message', (raw, isBinary) => onMessage(conn, raw, isBinary));
    ws.once('close', () => {
      if (conns.get(ownerId) === conn) conns.delete(ownerId);
      if (conn.active) finish(conn, conn.active, fail('E_DISCONNECTED', 'The Chrome extension disconnected.'));
    });
    send(ws, { type: 'authed', installId: install.installId, ...store.listDomains(ownerId) });
    return conn;
  }

  /** Handles one new `/ws-chrome-ext` socket whose Origin already passed the gate. */
  function handleConnection(ws, req) {
    const originId = chromeExtensionIdFromOrigin(String(req?.headers?.origin || ''));
    if (!originId) {
      ws.close(4403, 'origin not allowed');
      return;
    }
    const timer = setTimeout(() => ws.close(4401, 'auth timeout'), authTimeoutMs);
    ws.once('close', () => clearTimeout(timer));
    const onFirst = (raw, isBinary) => {
      ws.off('message', onFirst);
      clearTimeout(timer);
      let msg;
      try {
        if (isBinary) throw new Error('binary');
        msg = JSON.parse(Buffer.from(raw).toString('utf8'));
      } catch {
        ws.close(4403, 'invalid auth message');
        return;
      }
      const store = getStore();
      if (msg?.type === 'pair') {
        if (msg.extensionId !== originId) return ws.close(4403, 'extension id mismatch');
        const redeemed = store.redeemPairingCode(msg.code, { extensionId: originId, label: msg.label });
        if (!redeemed.ok) return ws.close(4403, 'pairing failed');
        send(ws, { type: 'paired', installId: redeemed.install.installId, token: redeemed.token });
        register(ws, redeemed.install);
        return;
      }
      if (msg?.type === 'auth') {
        const install = store.authenticate(msg.installId, msg.token, originId);
        if (!install) return ws.close(4403, 'invalid credentials');
        register(ws, install);
        return;
      }
      ws.close(4403, 'invalid auth message');
    };
    // A WebSocket must always observe transport errors, including before pairing.
    const onError = () => {
      clearTimeout(timer);
      ws.off('message', onFirst);
      try { ws.close(1011, 'socket error'); } catch { /* the transport may already be closed */ }
    };
    ws.on('error', onError);
    ws.once('close', () => ws.off('error', onError));
    ws.on('message', onFirst);
  }

  function validateArgs(conn, name, args, ownerId, chatId) {
    const store = getStore();
    const input = args && typeof args === 'object' ? args : {};
    const needDomain = (domain) => {
      if (!domain) return fail('E_DOMAIN_NOT_ALLOWED', 'Only https URLs on a registrable domain can be used.');
      if (store.isDomainAllowed(ownerId, domain)) return null;
      store.requestDomain(ownerId, domain, chatId);
      pushDomains(ownerId);
      return fail('E_DOMAIN_NOT_ALLOWED', `The domain ${domain} is not on your allowed list. Approve it in Settings, then retry.`);
    };
    if (name === 'open_url') {
      const denied = needDomain(domainOfUrl(input.url));
      if (denied) return { error: denied };
      return { args: { url: String(input.url).slice(0, 2000), reuseTab: input.reuseTab === true } };
    }
    if (!Number.isInteger(input.tabId)) return { error: fail('E_NO_TAB', 'tabId is required.') };
    const tabUrl = conn.tabs.get(input.tabId);
    if (!tabUrl) return { error: fail('E_NO_TAB', 'Unknown tab. Open the page with chrome_ext_open first.') };
    const tabDomain = domainOfUrl(tabUrl);
    const tabDenied = needDomain(tabDomain);
    if (tabDenied) return { error: tabDenied };
    if (name === 'list_documents') {
      const match = input.match && typeof input.match === 'object' ? input.match : {};
      const limit = Number.isInteger(input.limit) ? Math.min(200, Math.max(1, input.limit)) : 50;
      return {
        args: {
          tabId: input.tabId, limit,
          ...(typeof input.selector === 'string' && input.selector ? { selector: input.selector.slice(0, 500) } : {}),
          match: {
            ...(typeof match.hrefPattern === 'string' ? { hrefPattern: match.hrefPattern.slice(0, 200) } : {}),
            ...(typeof match.textPattern === 'string' ? { textPattern: match.textPattern.slice(0, 200) } : {}),
          },
        },
      };
    }
    const items = Array.isArray(input.items) ? input.items : [];
    if (!items.length) return { error: fail('E_SELECTOR', 'download needs at least one item.') };
    if (items.length > MAX_FILES_PER_COMMAND) return { error: fail('E_LIMIT', `At most ${MAX_FILES_PER_COMMAND} files per command.`) };
    const clean = [];
    for (const item of items) {
      const selector = typeof item?.selector === 'string' ? item.selector.slice(0, 500) : '';
      const href = typeof item?.href === 'string' ? item.href.slice(0, 2000) : '';
      if (!selector && !href) return { error: fail('E_SELECTOR', 'Each item needs a selector or href.') };
      if (href) {
        const hrefDomain = domainOfUrl(href);
        if (!hrefDomain) return { error: fail('E_DOMAIN_NOT_ALLOWED', 'Document links must be https URLs.') };
        if (hrefDomain !== tabDomain) {
          const denied = needDomain(hrefDomain);
          if (denied) return { error: denied };
        }
      }
      clean.push({ ...(selector ? { selector } : {}), ...(href ? { href } : {}) });
    }
    return { args: { tabId: input.tabId, items: clean } };
  }

  /**
   * Runs one command for the owner. Never throws for protocol failures: those
   * come back as `{ ok: false, error }`. `ctx.authorize` may throw (tool gates).
   * @returns {Promise<any>} `{ ok: true, data }` or `{ ok: false, error: { code, message } }`
   */
  async function execute(ctx, name, args, signal) {
    const ownerId = String(ctx.ownerSessionId || '');
    const store = getStore();
    await ctx.authorize?.();
    if (store.isKilled(ownerId)) return fail('E_KILLED', 'The Chrome extension was switched off with the kill switch.');
    if (!store.getInstallForOwner(ownerId)) return fail('E_NOT_PAIRED', 'No Chrome extension is paired for this user.');
    const conn = conns.get(ownerId);
    if (!conn || conn.ws.readyState !== 1) return fail('E_DISCONNECTED', 'The Chrome extension is not connected.');
    if (conn.active) return fail('E_BUSY', 'Another Chrome extension command is running.');
    const checked = validateArgs(conn, name, args, ownerId, ctx.chatId);
    if (checked.error) return checked.error;
    const requested = Number.isFinite(args?.timeoutMs) ? args.timeoutMs : 0;
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, requested > 0 ? requested : (name === 'download' ? DOWNLOAD_TIMEOUT_MS : DEFAULT_TIMEOUT_MS));
    await ctx.authorize?.();
    if (conn.active) return fail('E_BUSY', 'Another Chrome extension command is running.');
    return new Promise((resolve) => {
      const cmd = {
        id: crypto.randomUUID(), name, chatId: String(ctx.chatId || ''), resolve, done: false,
        files: [], totalBytes: 0, current: null, currentName: '', currentHost: '',
        domain: domainOfUrl(conn.tabs.get(checked.args.tabId) || checked.args.url),
        signal, timer: null, onAbort: null,
      };
      cmd.timer = setTimeout(() => abortCommand(conn, cmd, 'E_TIMEOUT', 'The Chrome extension command timed out.'), timeoutMs);
      cmd.onAbort = () => abortCommand(conn, cmd, 'E_CANCELLED', 'The command was cancelled.');
      conn.active = cmd;
      if (signal?.aborted) return cmd.onAbort();
      signal?.addEventListener?.('abort', cmd.onAbort, { once: true });
      send(conn.ws, { type: 'cmd', id: cmd.id, name, timeoutMs, args: checked.args });
    });
  }

  return {
    handleConnection,
    execute,
    pushDomains,

    /** Read-only snapshot for chrome_ext_status and the REST status route. No secrets. */
    status(ownerId) {
      const store = getStore();
      const install = store.getInstallForOwner(ownerId);
      const conn = conns.get(String(ownerId || ''));
      const domains = store.listDomains(ownerId);
      return {
        paired: !!install,
        connected: !!conn && conn.ws.readyState === 1,
        killed: store.isKilled(ownerId),
        label: install?.label || '',
        lastSeenAt: install?.lastSeenAt || null,
        allowedDomains: domains.allowed,
        pendingDomains: domains.pending.map((item) => item.domain),
      };
    },

    /** Unpair: delete the token hash and close the socket with 4403 revoked. */
    revoke(ownerId) {
      const removed = getStore().revokeOwner(ownerId);
      const conn = conns.get(String(ownerId || ''));
      if (conn) {
        conns.delete(conn.ownerId);
        conn.ws.close(4403, 'revoked');
      }
      return !!removed;
    },

    /** Server-side kill switch: refuses commands with E_KILLED and drops the socket. */
    setKilled(ownerId, killed) {
      getStore().setKilled(ownerId, killed === true);
      // Design section 2 point 6: the kill switch also deletes the token hash, so a re-pair is needed.
      if (killed === true) getStore().revokeOwner(ownerId);
      const conn = conns.get(String(ownerId || ''));
      if (killed === true && conn) {
        conns.delete(conn.ownerId);
        conn.ws.close(4403, 'killed');
      }
    },
  };
}

export const cretliExtensionBridge = createCretliExtensionBridge();
