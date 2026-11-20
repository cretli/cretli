#!/usr/bin/env node
/**
 * Backend test: POST /api/generate-chat-title.
 * Avoids fetch so it also runs on Node builds without a global fetch.
 *
 * Env: CURSOR_REMOTE_URL, WORKSPACE_FILE, WORKSPACE_FOLDER
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';

const BASE_URL = process.env.CURSOR_REMOTE_URL || 'https://localhost:3011';
const WORKSPACE_FILE = process.env.WORKSPACE_FILE || '';
const WORKSPACE_FOLDER = process.env.WORKSPACE_FOLDER || '';
const CHAT_ID = process.env.CHAT_ID || '';

const TEST_TEXT =
  'User: Please refactor the export module. Agent: I will propose splitting it into smaller functions plus tests.';

function postJson(urlStr, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const payload = JSON.stringify(body);
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload, 'utf8'),
      },
      rejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0',
    };
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') opts.rejectUnauthorized = false;
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(opts, (res) => {
      let chunks = '';
      res.on('data', (c) => (chunks += c));
      res.on('end', () =>
        resolve({ status: res.statusCode || 0, body: chunks })
      );
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function run() {
  const url = BASE_URL.replace(/\/$/, '') + '/api/generate-chat-title';
  const body = { text: TEST_TEXT, model: 'auto' };
  if (WORKSPACE_FILE) body.workspaceFile = WORKSPACE_FILE;
  if (WORKSPACE_FOLDER) body.workspaceFolder = WORKSPACE_FOLDER;
  if (CHAT_ID) body.chatId = CHAT_ID;

  console.log('POST', url);
  if (CHAT_ID) console.log('chatId (callback):', CHAT_ID);
  console.log('Body: text (', TEST_TEXT.length, 'characters), model:', body.model);
  const t0 = Date.now();

  let res;
  try {
    res = await postJson(url, body);
  } catch (err) {
    console.error('Connection error:', err.message);
    process.exit(1);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  let data;
  try {
    data = res.body ? JSON.parse(res.body) : {};
  } catch (_) {
    if (res.status === 404) {
      console.error('404 — restart the server (npm start).');
    } else {
      console.error('Non-JSON response, status:', res.status);
    }
    process.exit(1);
  }

  console.log('Status:', res.status, '| Time:', elapsed, 's');
  console.log('Response:', JSON.stringify(data, null, 2));

  if (data.ok && data.title) {
    console.log('\n[OK] Title:', data.title);
    process.exit(0);
  }
  if (data.ok && data.mode === 'callback') {
    console.log('\n[OK] Callback mode — the agent calls the API, the UI polls for the result.');
    process.exit(0);
  }
  if (data.ok && data.mode === 'print' && data.title) {
    console.log('\n[OK] Print mode, title:', data.title);
    process.exit(0);
  }
  console.log('\n[FAIL] Missing the expected response (ok + title, or callback).');
  process.exit(1);
}

run();
