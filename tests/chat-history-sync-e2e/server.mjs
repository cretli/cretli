#!/usr/bin/env node
/**
 * Isolated fixture for Playwright chat-history sync tests.
 * Builds the harness into .tmp and does not touch public/dist or the app server.
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import webpack from 'webpack';
import config from './webpack.config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '../..');
const bundleDir = path.join(projectRoot, '.tmp/chat-history-sync-e2e');
const port = Number.parseInt(process.env.CHAT_HISTORY_SYNC_E2E_PORT || '3398', 10);

await new Promise((resolve, reject) => {
  webpack(config, (err, stats) => {
    if (err) {
      reject(err);
      return;
    }
    if (stats?.hasErrors()) {
      reject(new Error(stats.toString({ colors: false, errors: true })));
      return;
    }
    resolve();
  });
});

const html = await fs.readFile(path.join(here, 'index.html'), 'utf8');

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<unknown>}
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/** @type {Map<string, { cursorSessionId: string, headSeq: number, events: Array<{ seq: number, rec: unknown }> }>} */
const historyByChatId = new Map();
let failNextHistory = false;
let partialNextHistory = false;

function getHistoryDoc(chatId) {
  const existing = historyByChatId.get(chatId);
  if (existing) return existing;
  const created = { cursorSessionId: '', headSeq: 0, events: [] };
  historyByChatId.set(chatId, created);
  return created;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
  if (url.pathname === '/health') {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (url.pathname === '/api/auth-status') {
    sendJson(res, 200, { csrfToken: 'chat-history-sync-e2e', authenticated: true });
    return;
  }
  if (url.pathname === '/__test__/history' && req.method === 'POST') {
    const body = /** @type {Record<string, unknown>} */ (await readJsonBody(req));
    const chatId = String(body.chatId || '').trim();
    if (!chatId) {
      sendJson(res, 400, { ok: false, error: 'chatId required' });
      return;
    }
    const events = Array.isArray(body.events) ? body.events : [];
    const cleaned = events
      .filter((row) => row && typeof row === 'object' && Number(row.seq) > 0)
      .map((row) => ({ seq: Number(row.seq), rec: row.rec }));
    const headSeq = Number(body.headSeq) || cleaned.reduce((max, row) => Math.max(max, row.seq), 0);
    historyByChatId.set(chatId, {
      cursorSessionId: typeof body.cursorSessionId === 'string' ? body.cursorSessionId : '',
      headSeq,
      events: cleaned,
    });
    sendJson(res, 200, { ok: true, headSeq, stored: cleaned.length });
    return;
  }
  if (url.pathname === '/__test__/fail-next-history' && req.method === 'POST') {
    failNextHistory = true;
    sendJson(res, 200, { ok: true });
    return;
  }
  if (url.pathname === '/__test__/partial-next-history' && req.method === 'POST') {
    partialNextHistory = true;
    sendJson(res, 200, { ok: true });
    return;
  }
  const historyMatch = url.pathname.match(/^\/api\/chats\/([^/]+)\/history$/);
  if (historyMatch && (!req.method || req.method === 'GET')) {
    if (failNextHistory) {
      failNextHistory = false;
      sendJson(res, 500, { ok: false, error: 'history unavailable' });
      return;
    }
    const chatId = decodeURIComponent(historyMatch[1]);
    const doc = getHistoryDoc(chatId);
    const sinceRaw = Number.parseInt(String(url.searchParams.get('since') || '0'), 10);
    const since = Number.isFinite(sinceRaw) ? Math.max(0, sinceRaw) : 0;
    let events = doc.events.filter((row) => row.seq > since);
    let hasMore = false;
    let headSeq = doc.headSeq;
    if (partialNextHistory) {
      partialNextHistory = false;
      events = [];
      hasMore = true;
      headSeq = Math.max(headSeq, since + 1);
    }
    sendJson(res, 200, {
      ok: true,
      chatId,
      cursorSessionId: doc.cursorSessionId,
      headSeq,
      events,
      hasMore,
    });
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  if (url.pathname === '/harness.js') {
    const js = await fs.readFile(path.join(bundleDir, 'harness.js'));
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
    res.end(js);
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`chat-history-sync fixture http://127.0.0.1:${port}\n`);
});
