/**
 * Fake Cretli Chrome extension over a real `ws` server wired through the real
 * router. Everything lives in temp dirs; the repository data/ is never touched.
 */
import './isolated-data-dir.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { attachWebSocketHandlers } from '../../lib/ws/ws-router.ts';
import { createChromeExtStore, INSTANCE_OWNER_ID } from '../../lib/browser/chrome-ext-store.js';
import { createCretliExtensionBridge } from '../../lib/browser/cretli-extension-bridge.js';

export const EXT_ID = 'a'.repeat(32);
export const OWNER = INSTANCE_OWNER_ID;

export async function createFixture({ authTimeoutMs = 5000, now } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-chrome-ext-'));
  const store = createChromeExtStore({ dir: path.join(root, 'chrome-ext'), now });
  const downloadsDir = path.join(root, 'downloads');
  const bridge = createCretliExtensionBridge({ store, downloadsDir, authTimeoutMs });
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  attachWebSocketHandlers(wss, { chromeExtBridge: bridge, getCurrentCwd: () => root });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${server.address().port}/ws-chrome-ext`;
  return {
    root, store, bridge, downloadsDir, url, serverSockets: () => [...wss.clients],
    client: (options) => new FakeExtension(url, options),
    /** Pairs a fake extension for OWNER and returns it connected. */
    async pairedClient(options = {}) {
      const client = new FakeExtension(url, options);
      await client.open();
      client.json({ type: 'pair', code: store.createPairingCode(OWNER).code, extensionId: options.extensionId || EXT_ID, label: 'Test' });
      client.paired = await client.next('paired');
      await client.next('authed');
      return client;
    },
    async close() {
      for (const ws of wss.clients) ws.terminate();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export class FakeExtension {
  constructor(url, { extensionId = EXT_ID, origin } = {}) {
    this.url = url;
    this.origin = origin === undefined ? `chrome-extension://${extensionId}` : origin;
    this.messages = [];
    this.waiters = [];
    this.closeInfo = null;
    this.onCommand = null;
    this.closed = new Promise((resolve) => { this.resolveClosed = resolve; });
  }

  open() {
    const headers = this.origin ? { Origin: this.origin } : {};
    this.ws = new WebSocket(this.url, { headers });
    this.ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(raw.toString('utf8'));
      if (msg.type === 'cmd' && this.onCommand) { this.onCommand(msg); return; }
      const waiter = this.waiters.findIndex((w) => w.type === msg.type);
      if (waiter >= 0) this.waiters.splice(waiter, 1)[0].resolve(msg);
      else this.messages.push(msg);
    });
    this.ws.on('close', (code, reason) => {
      this.closeInfo = { code, reason: reason.toString() };
      this.resolveClosed(this.closeInfo);
    });
    return new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
      this.ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
  }

  json(message) { this.ws.send(JSON.stringify(message)); }

  /** Binary frame: 16-byte command id followed by the payload. */
  frame(id, payload) {
    this.ws.send(Buffer.concat([Buffer.from(id.replace(/-/g, ''), 'hex'), Buffer.from(payload)]), { binary: true });
  }

  next(type, timeoutMs = 2000) {
    const index = this.messages.findIndex((m) => m.type === type);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
      this.waiters.push({ type, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    });
  }

  /** Sends one complete file for command `id` in 256 KiB frames. */
  sendFile(id, { name, mime, bytes, sha256, declare = true, sourceHost = 'shop.example.com' }) {
    const data = Buffer.from(bytes);
    this.json({ type: 'download.begin', requestId: id, mime, name, sourceHost, ...(declare ? { size: data.length } : {}) });
    for (let at = 0; at < data.length; at += 256 * 1024) this.frame(id, data.subarray(at, at + 256 * 1024));
    this.json({ type: 'download.end', requestId: id, sha256: sha256 || crypto.createHash('sha256').update(data).digest('hex') });
  }

  /** Answers every command by the handler's return value `{ ok, data|error }`. */
  respondWith(handler) {
    this.onCommand = async (cmd) => {
      this.seen = [...(this.seen || []), cmd];
      const outcome = await handler(cmd, this);
      if (outcome) this.json({ type: 'result', id: cmd.id, ...outcome });
    };
  }

  close() { this.ws.close(); return this.closed; }
}

export const ctxFor = (extra = {}) => ({ chatId: 'chat-1', ownerSessionId: OWNER, authorize: async () => {}, ...extra });

/** Opens https://shop.example.com in the fake browser (domain approved) and returns the tab id. */
export async function openShopTab(fx, client, tabId = 7) {
  fx.store.approveDomain(OWNER, 'shop.example.com');
  client.respondWith((cmd) => (cmd.name === 'open_url'
    ? { ok: true, data: { tabId, url: 'https://shop.example.com/invoices', title: 'Invoices' } }
    : null));
  const opened = await fx.bridge.execute(ctxFor(), 'open_url', { url: 'https://shop.example.com/invoices' });
  if (!opened.ok) throw new Error(JSON.stringify(opened));
  return tabId;
}
