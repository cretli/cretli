#!/usr/bin/env node
/**
 * Title fork test: connects to the agent over WebSocket, sends a short prompt
 * asking for JSON with "title", reads the reply and parses the title out of it.
 * Requires a running server: node scripts/test-fork-title.js
 *
 * Env: CURSOR_REMOTE_WS_URL (e.g. ws://localhost:3011/ws-agent, or wss://... for an HTTPS server), WORKSPACE_FILE (optional).
 * Start the server (npm start), then run: npm run test:fork-title
 */

import WebSocket from 'ws';

const BASE_URL = process.env.CURSOR_REMOTE_WS_URL || 'ws://localhost:3011/ws-agent';
const WORKSPACE_FILE = process.env.WORKSPACE_FILE || '';
const TIMEOUT_MS = 30000;

function stripAnsi(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/\x1b\[[0-9;]*[a-zA-Z@]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[PX^_][^\x1b]*(\x1b\\)?/g, '');
}

const EXAMPLE_TITLE = 'Title test';

/** Looks for JSON with "title" in the buffer after the prompt, rejecting the prompt's own example value. */
function tryExtractTitle(buffer) {
  const raw = stripAnsi(buffer);
  const exampleMarker = `Example: {"title": "${EXAMPLE_TITLE}"}`;
  const afterPrompt = raw.includes(exampleMarker)
    ? raw.slice(raw.indexOf(exampleMarker) + exampleMarker.length)
    : raw;
  const match = afterPrompt.match(/\{\s*"title"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/);
  if (!match) return null;
  const title = match[1].replace(/\\(.)/g, '$1');
  return title === EXAMPLE_TITLE ? null : title;
}

function buildUrl() {
  if (!WORKSPACE_FILE) return BASE_URL;
  const u = new URL(BASE_URL);
  u.searchParams.set('workspace', WORKSPACE_FILE);
  u.searchParams.set('model', 'auto');
  return u.toString();
}

const PROMPT =
  'Reply with a single line of JSON containing the key "title" (a short name, max 50 characters). Example: {"title": "Title test"}. Nothing else.\n';

function run() {
  const url = buildUrl();
  console.log('Connecting to', url.replace(/\?.*/, '?…'));
  const ws = new WebSocket(url);

  let accumulated = '';
  let done = false;

  const timeoutId = setTimeout(() => {
    if (done) return;
    done = true;
    const rawTail = accumulated.slice(-500);
    console.log('\n[timeout] Collected', accumulated.length, 'characters. Tail (ANSI stripped):');
    console.log(stripAnsi(rawTail));
    const title = tryExtractTitle(accumulated);
    if (title) {
      console.log('\n[OK] Title from buffer:', title);
      process.exit(0);
    } else {
      console.log('\n[FAIL] No {"title": "..."} found in the reply.');
      process.exit(1);
    }
  }, TIMEOUT_MS);

  ws.on('open', () => {
    console.log('Connected. Sending the prompt (single block,', PROMPT.length, 'characters)...');
    ws.send(JSON.stringify({ type: 'input', data: PROMPT }));
    setTimeout(() => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data: '\r' }));
    }, 100);
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'output' && msg.data) accumulated += msg.data;
    } catch (_) {}
  });

  ws.on('close', (code, reason) => {
    if (done) return;
    done = true;
    clearTimeout(timeoutId);
    const title = tryExtractTitle(accumulated);
    console.log('\n[close] code=', code, 'reason=', reason || '(none)', 'accumulated=', accumulated.length);
    if (title) {
      console.log('[OK] Title:', title);
      process.exit(0);
    }
    console.log('Tail (ANSI stripped):', stripAnsi(accumulated.slice(-400)));
    console.log('[FAIL] No JSON with a title in the reply.');
    process.exit(1);
  });

  ws.on('error', (err) => {
    if (done) return;
    done = true;
    clearTimeout(timeoutId);
    console.error('WebSocket error:', err.message);
    process.exit(1);
  });
}

run();
