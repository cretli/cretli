import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Files kept per chat; shared by every media kind so one chat cannot grow unbounded. */
export const MAX_CHAT_MEDIA_FILES = 50;

/** Chat ids that are not real chats (MCP operator sessions) never get durable media. */
const OPERATOR_CHAT_ID_RE = /^cretli-operator/i;
export const CHAT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const CHAT_MEDIA_FILE_RE = /^[0-9]{10,16}-[a-f0-9-]{36}\.(?:jpg|png|webp)$/;

let mediaRoot = '';
let mediaEnabled = false;

/**
 * Configures the durable chat-media store. Called once from server.js.
 * @param {{ dataDir?: string, enabled?: boolean }} [options]
 * @returns {void}
 */
export function configureChatMedia({ dataDir, enabled = true } = {}) {
  mediaRoot = dataDir ? path.join(String(dataDir), 'chat-media') : '';
  mediaEnabled = Boolean(enabled && mediaRoot);
}

/** @returns {string} root directory ('' when disabled). */
export function getChatMediaRoot() {
  return mediaEnabled ? mediaRoot : '';
}

/**
 * @param {unknown} chatId
 * @returns {string} directory for one chat ('' when disabled or the id is not eligible).
 */
export function chatMediaDir(chatId) {
  const id = String(chatId || '').trim();
  if (!mediaEnabled || !CHAT_ID_RE.test(id) || OPERATOR_CHAT_ID_RE.test(id)) return '';
  return path.join(mediaRoot, id);
}

/**
 * Stores one image for a chat. Returns null when the store is off or the chat
 * is not eligible, so the caller can fall back to a temp file.
 * @param {string} chatId
 * @param {Buffer} buffer
 * @param {{ ext?: string }} [options]
 * @returns {{ file: string, path: string, url: string } | null}
 */
export function saveChatMediaSync(chatId, buffer, { ext = 'jpg' } = {}) {
  const dir = chatMediaDir(chatId);
  if (!dir) return null;
  const safeExt = ['jpg', 'png', 'webp'].includes(ext) ? ext : 'jpg';
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = `${String(Date.now()).padStart(13, '0')}-${randomUUID()}.${safeExt}`;
  const full = path.join(dir, file);
  fs.writeFileSync(full, buffer, { mode: 0o600 });
  const stale = fs.readdirSync(dir)
    .filter((name) => CHAT_MEDIA_FILE_RE.test(name))
    .sort()
    .slice(0, -MAX_CHAT_MEDIA_FILES);
  for (const name of stale) {
    try { fs.unlinkSync(path.join(dir, name)); } catch { /* best effort retention */ }
  }
  return { file, path: full, url: chatMediaUrl(chatId, file) };
}

/**
 * @param {string} chatId
 * @param {string} file
 * @returns {string}
 */
export function chatMediaUrl(chatId, file) {
  return `/api/chats/${encodeURIComponent(chatId)}/media/${encodeURIComponent(file)}`;
}

/**
 * Deletes all media of a chat. Best effort; never throws.
 * @param {unknown} chatId
 * @returns {void}
 */
export function removeChatMedia(chatId) {
  const dir = chatMediaDir(chatId);
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}
