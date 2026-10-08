/**
 * Screenshot temp-file lifecycle: per-chat retention, per-chat removal and the
 * server-start purge of the shared `cretli-browser` temp root, plus the
 * chatId sanitization that keeps a hostile id inside that root, the private
 * file/dir modes and the inline-base64 stripping of the returned metadata.
 */

import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_SCREENSHOT_FILES,
  browserScreenshotDir,
  purgeBrowserScreenshotRoot,
  removeBrowserScreenshots,
  saveBrowserScreenshot,
} from '../lib/browser/screenshot-file.js';

const ROOT = path.join(os.tmpdir(), 'cretli-browser');
const CHAT_ID = `screenshot-test-${process.pid}-${Date.now()}`;
const OTHER_CHAT_ID = `${CHAT_ID}-other`;

/**
 * @param {string} value
 * @returns {{ data: string, width: number, height: number }}
 */
function frame(value) {
  return { data: Buffer.from(value).toString('base64'), width: 4, height: 3 };
}

test('saveBrowserScreenshot keeps at most MAX_SCREENSHOT_FILES per chat', () => {
  try {
    const dir = browserScreenshotDir(CHAT_ID);
    for (let i = 0; i < MAX_SCREENSHOT_FILES + 3; i += 1) {
      const saved = saveBrowserScreenshot(CHAT_ID, frame(`frame-${i}`));
      assert.equal(saved.path.startsWith(`${dir}${path.sep}`), true, 'file lives in the chat dir');
    }
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('.jpg'));
    assert.equal(files.length, MAX_SCREENSHOT_FILES);
  } finally {
    removeBrowserScreenshots(CHAT_ID);
  }
});

test('removeBrowserScreenshots removes only the target chat dir', () => {
  try {
    saveBrowserScreenshot(CHAT_ID, frame('a'));
    saveBrowserScreenshot(OTHER_CHAT_ID, frame('b'));

    removeBrowserScreenshots(CHAT_ID);

    assert.equal(fs.existsSync(browserScreenshotDir(CHAT_ID)), false);
    assert.equal(fs.existsSync(browserScreenshotDir(OTHER_CHAT_ID)), true, 'other chats are untouched');

    // Empty/missing chat id must never touch the shared root.
    removeBrowserScreenshots('');
    removeBrowserScreenshots(null);
    removeBrowserScreenshots(undefined);
    assert.equal(fs.existsSync(browserScreenshotDir(OTHER_CHAT_ID)), true);
  } finally {
    removeBrowserScreenshots(CHAT_ID);
    removeBrowserScreenshots(OTHER_CHAT_ID);
  }
});

test('purgeBrowserScreenshotRoot removes the shared temp root', () => {
  const ourDir = path.basename(browserScreenshotDir(CHAT_ID));
  // A live server could own other chats' screenshots in the same root. Only
  // exercise the destructive purge when the root holds no unrelated chat dir.
  const unrelated = fs.existsSync(ROOT)
    ? fs.readdirSync(ROOT).filter((name) => name !== ourDir)
    : [];
  if (unrelated.length > 0) {
    // Never delete unrelated chat dirs owned by a live server; skip the
    // destructive purge assertion in that case.
    assert.equal(fs.existsSync(ROOT), true);
    return;
  }

  try {
    saveBrowserScreenshot(CHAT_ID, frame('a'));
    assert.equal(fs.existsSync(ROOT), true);
    purgeBrowserScreenshotRoot();
    assert.equal(fs.existsSync(ROOT), false);
  } finally {
    removeBrowserScreenshots(CHAT_ID);
  }
});

test('browserScreenshotDir sanitizes a hostile chatId into the shared temp root', () => {
  const hostile = ['../../etc/passwd', 'a b/c', '..//..//secret', '../../../../tmp/escaped', '../..', ''];
  for (const chatId of hostile) {
    const dir = browserScreenshotDir(chatId);
    const segment = path.basename(dir);
    assert.ok(dir.startsWith(`${ROOT}${path.sep}`), `${chatId || '<empty>'} stays under the temp root`);
    assert.equal(path.dirname(dir), ROOT, `${chatId || '<empty>'} is a direct child of the root`);
    assert.equal(segment.includes('..'), false, 'no parent traversal in the dir name');
    assert.equal(segment.includes('/') || segment.includes('\\'), false, 'no path separator survives');
    assert.equal(dir, path.resolve(dir), 'the resolved path is the returned path');
    assert.equal(path.relative(ROOT, path.resolve(dir)).startsWith('..'), false, 'never escapes the root');
  }

  // An empty or missing id falls back to the literal `unknown` bucket.
  assert.equal(path.basename(browserScreenshotDir('')), 'unknown');
  assert.equal(path.basename(browserScreenshotDir(null)), 'unknown');
  assert.equal(path.basename(browserScreenshotDir(undefined)), 'unknown');
  // Safe characters are preserved verbatim, everything else becomes `_`.
  assert.equal(path.basename(browserScreenshotDir('a-b_C9')), 'a-b_C9');
  assert.equal(path.basename(browserScreenshotDir('a b/c')), 'a_b_c');

  // A hostile id must not be able to write outside the root either.
  const probe = '../../../../tmp/cretli-escape-probe';
  try {
    const saved = saveBrowserScreenshot(probe, frame('x'));
    assert.equal(path.dirname(saved.path).startsWith(`${ROOT}${path.sep}`), true);
    assert.equal(fs.existsSync(path.join(os.tmpdir(), 'cretli-escape-probe')), false, 'no traversal target');
  } finally {
    removeBrowserScreenshots(probe);
  }
});

test('saveBrowserScreenshot writes a private dir (0700) and file (0600)', () => {
  // `mode` is filtered by the process umask, so assert the exact value the
  // implementation yields instead of the requested one.
  const requestedMask = 0o777 ^ (process.umask() & 0o777);
  const dir = browserScreenshotDir(`${CHAT_ID}-modes`);
  try {
    const saved = saveBrowserScreenshot(`${CHAT_ID}-modes`, frame('m'));
    const dirMode = fs.statSync(dir).mode & 0o777;
    const fileMode = fs.statSync(saved.path).mode & 0o777;
    assert.equal(dirMode, 0o700 & requestedMask, 'directory keeps the private 0700 request');
    assert.equal(fileMode, 0o600 & requestedMask, 'file keeps the private 0600 request');
    // The security property that must never regress: no group/other access.
    assert.equal(dirMode & 0o077, 0, 'screenshots are not readable by group or other');
    assert.equal(fileMode & 0o077, 0, 'screenshots are not readable by group or other');
  } finally {
    removeBrowserScreenshots(`${CHAT_ID}-modes`);
  }
});

test('saveBrowserScreenshot returns metadata with path and without inline data', () => {
  const chatId = `${CHAT_ID}-metadata`;
  const source = {
    data: Buffer.from('pixels').toString('base64'),
    width: 800,
    height: 600,
    mimeType: 'image/jpeg',
    bytes: 6,
  };
  try {
    const saved = saveBrowserScreenshot(chatId, source);
    assert.equal(saved.data, undefined, 'base64 never survives into the returned metadata');
    assert.equal('data' in saved, false);
    assert.equal(typeof saved.path, 'string');
    assert.ok(saved.path.endsWith('.jpg'));
    assert.equal(saved.width, 800);
    assert.equal(saved.height, 600);
    assert.equal(saved.mimeType, 'image/jpeg');
    assert.equal(saved.bytes, 6);
    // The caller's object is not mutated, so a retry still has its frame.
    assert.equal(typeof source.data, 'string');
    assert.equal(fs.readFileSync(saved.path, 'utf8'), 'pixels');
  } finally {
    removeBrowserScreenshots(chatId);
  }
});
