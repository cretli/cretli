#!/usr/bin/env node
/**
 * Isolated fixture for Playwright delegation-card tests.
 * Serves a webpack bundle of the real sdk-rich-view card plus mock APIs.
 * Does not start the Cretli app or touch its data directory.
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import webpack from 'webpack';
import config from './webpack.config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '../..');
const bundleDir = path.join(projectRoot, '.tmp/delegation-card-e2e');
const port = Number.parseInt(process.env.DELEGATION_CARD_E2E_PORT || '3397', 10);

const mock = {
  cancelOk: true,
  retryOk: true,
  retryError: 'Could not retry this job.',
  ackOk: true,
  mailboxRetryOk: true,
  calls: [],
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function match(url, method, expectedMethod, pattern) {
  if (method !== expectedMethod) return null;
  return url.pathname.match(pattern);
}

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
  const method = String(req.method || 'GET').toUpperCase();
  if (url.pathname === '/health') {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (url.pathname === '/api/auth-status') {
    sendJson(res, 200, { csrfToken: 'delegation-card-e2e', authenticated: true });
    return;
  }
  if (url.pathname === '/mock/config' && method === 'POST') {
    Object.assign(mock, await readBody(req));
    sendJson(res, 200, { ok: true, mock });
    return;
  }
  if (url.pathname === '/mock/calls') {
    sendJson(res, 200, { calls: mock.calls });
    return;
  }
  const cancel = match(url, method, 'POST', /^\/api\/delegations\/([^/]+)\/cancel$/);
  if (cancel) {
    mock.calls.push({ type: 'cancel', id: cancel[1] });
    sendJson(res, 200, mock.cancelOk ? { ok: true } : { ok: false, error: 'Could not stop this job.' });
    return;
  }
  const retry = match(url, method, 'POST', /^\/api\/delegations\/([^/]+)\/retry$/);
  if (retry) {
    mock.calls.push({ type: 'retry', id: retry[1] });
    sendJson(res, 200, mock.retryOk ? { ok: true } : { ok: false, error: mock.retryError });
    return;
  }
  const ack = match(url, method, 'POST', /^\/api\/delegations\/([^/]+)\/ack$/);
  if (ack) {
    mock.calls.push({ type: 'ack', id: ack[1] });
    sendJson(res, 200, mock.ackOk ? { ok: true } : { ok: false, error: 'Could not acknowledge.' });
    return;
  }
  const mailbox = match(url, method, 'POST', /^\/api\/chats\/[^/]+\/mailbox\/([^/]+)\/retry$/);
  if (mailbox) {
    mock.calls.push({ type: 'mailbox-retry', id: mailbox[1] });
    sendJson(res, 200, mock.mailboxRetryOk ? { ok: true } : { ok: false, error: 'Could not retry mailbox.' });
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
  process.stdout.write(`delegation-card fixture http://127.0.0.1:${port}\n`);
});
