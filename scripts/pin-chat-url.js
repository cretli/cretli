#!/usr/bin/env node
/**
 * Pin a chat to a host-page URL (widgetPinnedUrl).
 * Optionally ask the running server to navigate via the page bridge.
 *
 * Usage:
 *   node scripts/pin-chat-url.js --url http://host/page --chat-id <uuid>
 *   node scripts/pin-chat-url.js --url http://host/page --cursor-session-id <uuid>
 *   node scripts/pin-chat-url.js --url http://host/page --chat-id <uuid> --no-navigate
 */

import { getChatByCursorSessionId, loadChats, updateChat } from '../lib/persist/chats-persist.js';

function parseArgs(argv) {
  const out = {
    url: '',
    chatId: '',
    cursorSessionId: '',
    navigate: true,
    baseUrl: process.env.CURSOR_REMOTE_BASE_URL || 'https://127.0.0.1:3011',
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--url') {
      out.url = String(argv[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (arg === '--chat-id') {
      out.chatId = String(argv[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (arg === '--cursor-session-id') {
      out.cursorSessionId = String(argv[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (arg === '--base-url') {
      out.baseUrl = String(argv[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (arg === '--no-navigate') {
      out.navigate = false;
    }
  }
  return out;
}

function resolveChat({ chatId, cursorSessionId }) {
  if (chatId) {
    return loadChats().find((item) => item.id === chatId) || null;
  }
  if (cursorSessionId) {
    return getChatByCursorSessionId(cursorSessionId);
  }
  return null;
}

async function requestNavigateViaServer({ baseUrl, chatId, cursorSessionId, url, navigate }) {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/set-chat-pinned-url-from-agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId, cursorSessionId, url, navigate }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) {
    throw new Error(data?.error || `HTTP ${response.status}`);
  }
  return data;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.url) {
    console.error('Usage: node scripts/pin-chat-url.js --url <url> (--chat-id <uuid> | --cursor-session-id <uuid>)');
    process.exit(1);
  }
  const chat = resolveChat(args);
  if (!chat?.id) {
    console.error('Chat not found — pass --chat-id or --cursor-session-id');
    process.exit(1);
  }
  const updated = updateChat(chat.id, { widgetPinnedUrl: args.url });
  console.log(JSON.stringify({
    ok: true,
    chatId: chat.id,
    widgetPinnedUrl: updated?.widgetPinnedUrl || args.url,
    source: 'chats-persist',
  }, null, 2));
  if (!args.navigate) {
    return;
  }
  try {
    const serverResult = await requestNavigateViaServer({
      baseUrl: args.baseUrl,
      chatId: chat.id,
      cursorSessionId: chat.cursorSessionId || args.cursorSessionId,
      url: args.url,
      navigate: true,
    });
    console.log(JSON.stringify({
      ok: true,
      pageBound: serverResult.pageBound,
      navigated: serverResult.navigated,
      navigateError: serverResult.navigateError,
      source: 'server-api',
    }, null, 2));
  } catch (error) {
    console.warn(JSON.stringify({
      ok: false,
      warning: 'Pinned locally; server navigate skipped or failed',
      error: error instanceof Error ? error.message : String(error),
    }, null, 2));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
