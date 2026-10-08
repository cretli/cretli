import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** How many screenshots are kept per chat before the oldest are dropped. */
export const MAX_SCREENSHOT_FILES = 12;

/** Private temp directory for one chat's screenshots. */
export function browserScreenshotDir(chatId) {
  const safeChat = String(chatId || '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
  return path.join(os.tmpdir(), 'cretli-browser', safeChat);
}

/**
 * Writes a screenshot frame to a private temp file and returns its metadata
 * with a `path` instead of inline base64. Shared by the SDK and MCP harnesses so
 * an image never enters the model's text/context budget.
 *
 * @param {string} chatId
 * @param {{ data?: string }} frame
 * @returns {Record<string, any>}
 */
export function saveBrowserScreenshot(chatId, frame) {
  const dir = browserScreenshotDir(chatId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${Date.now()}-${randomUUID()}.jpg`);
  fs.writeFileSync(file, Buffer.from(String(frame?.data || ''), 'base64'), { mode: 0o600 });
  const stale = fs.readdirSync(dir)
    .filter((name) => name.endsWith('.jpg'))
    .sort()
    .slice(0, -MAX_SCREENSHOT_FILES);
  for (const name of stale) {
    try { fs.unlinkSync(path.join(dir, name)); } catch { /* best effort retention */ }
  }
  const { data, ...metadata } = frame || {};
  return { ...metadata, path: file };
}

/**
 * Removes one chat's screenshot directory. Screenshots may contain sensitive
 * page content, so they must not outlive the chat/session that produced them.
 * Best effort: missing paths and permission errors are ignored, and an empty
 * chatId is a no-op so the shared `cretli-browser` root is never removed.
 *
 * @param {unknown} chatId
 * @returns {void}
 */
export function removeBrowserScreenshots(chatId) {
  const safeChat = String(chatId || '').trim();
  if (!safeChat) return;
  try {
    fs.rmSync(browserScreenshotDir(safeChat), { recursive: true, force: true });
  } catch {
    // best effort cleanup
  }
}

/**
 * Removes the whole `cretli-browser` temp root. Used at server start to clear
 * screenshots left behind by a previous process. Best effort, never throws.
 *
 * @returns {void}
 */
export function purgeBrowserScreenshotRoot() {
  try {
    fs.rmSync(path.join(os.tmpdir(), 'cretli-browser'), { recursive: true, force: true });
  } catch {
    // best effort cleanup
  }
}
