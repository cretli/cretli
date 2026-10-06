#!/usr/bin/env node
/**
 * Isolated fixture for Playwright chat metadata IDB tests.
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import webpack from 'webpack';
import config from './webpack.config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '../..');
const bundleDir = path.join(projectRoot, '.tmp/chat-metadata-idb-e2e');
const port = Number.parseInt(process.env.CHAT_METADATA_IDB_E2E_PORT || '3399', 10);

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
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (url.pathname === '/harness.js') {
    try {
      const body = await fs.readFile(path.join(bundleDir, 'harness.js'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(body);
      return;
    } catch (_) {
      res.writeHead(500);
      res.end('missing bundle');
      return;
    }
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
});

server.listen(port, '127.0.0.1');
