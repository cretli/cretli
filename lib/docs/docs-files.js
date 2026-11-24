import fs from 'node:fs';
import { isDocPath } from './doc-ref.js';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { writeTextAtomic } from '../persist/atomic-write.js';
import { DocsError } from './docs-state-store.js';

export const MAX_NOTE_BYTES = 128 * 1024;
export const MAX_FILES = 2000;
export const MAX_ENTRIES = 10000;
export const sha256 = (text) => createHash('sha256').update(text).digest('hex');
export const inside = (root, candidate) => candidate === root || (!path.relative(root, candidate).startsWith(`..${path.sep}`)
  && path.relative(root, candidate) !== '..' && !path.isAbsolute(path.relative(root, candidate)));

export function notePath(input) {
  if (!isDocPath(input)) throw new DocsError('docs-invalid-path', 'A root-relative NFC Markdown path is required');
  return input;
}

// Check every component, including intermediate symlinks, before accessing its target.
export function resolveNote(root, input, { missing = false } = {}) {
  const relative = notePath(input);
  let current = root;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    try {
      const real = fs.realpathSync(current);
      if (!inside(root, real)) throw new DocsError('docs-path-escape', 'Symlink leaves the Docs root', 403);
      current = real;
      const stat = fs.statSync(current);
      if (i < parts.length - 1 && !stat.isDirectory()) throw new DocsError('docs-invalid-path', 'Parent must be a directory');
      if (i === parts.length - 1 && (!stat.isFile() || !current.endsWith('.md'))) throw new DocsError('docs-invalid-path', 'Note must be a regular file');
    } catch (error) {
      if (error.code === 'ENOENT' && missing && i === parts.length - 1) return current;
      throw error;
    }
  }
  return current;
}

export function readNote(root, input) {
  const target = resolveNote(root, input);
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new DocsError('docs-invalid-path', 'Note must be a regular file');
    if (stat.size > MAX_NOTE_BYTES) throw new DocsError('docs-too-large', 'Note exceeds 128 KiB', 413);
    const buffer = Buffer.alloc(MAX_NOTE_BYTES + 1);
    let count = 0;
    while (count < buffer.length) {
      const bytes = fs.readSync(fd, buffer, count, buffer.length - count, count);
      if (!bytes) break;
      count += bytes;
    }
    if (count > MAX_NOTE_BYTES) throw new DocsError('docs-too-large', 'Note exceeds 128 KiB', 413);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count)); }
    catch { throw new DocsError('docs-invalid-encoding', 'Notes must contain valid UTF-8'); }
    return { path: input, text, sha256: sha256(text), size: count, mtimeMs: stat.mtimeMs };
  } finally { fs.closeSync(fd); }
}

export function checkText(text) {
  if (typeof text !== 'string') throw new DocsError('docs-invalid-text', 'Note text must be a string');
  if (Buffer.byteLength(text) > MAX_NOTE_BYTES) throw new DocsError('docs-too-large', 'Note exceeds 128 KiB', 413);
}

export function checkExpected(note, expectedSha256) {
  if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new DocsError('docs-precondition-required', 'expectedSha256 is required', 428);
  }
  if (note.sha256 !== expectedSha256) throw new DocsError('docs-conflict', 'Note changed since it was read', 409);
}

/**
 * @param {any} root
 * @param {any} input
 * @param {string} text
 * @param {{ create?: boolean, expectedSha256?: string }} [opts]
 */
export function writeNote(root, input, text, { create = false, expectedSha256 } = {}) {
  checkText(text);
  const target = resolveNote(root, input, { missing: create });
  if (create) {
    if (fs.existsSync(target)) throw new DocsError('docs-exists', 'Note already exists', 409);
  } else checkExpected(readNote(root, input), expectedSha256);
  // The shared writer's timestamp temp name is isolated in a private directory.
  // The final rename still publishes a complete file on the same filesystem.
  const staging = fs.mkdtempSync(path.join(path.dirname(target), '.cretli-write-'));
  fs.chmodSync(staging, 0o700);
  const staged = path.join(staging, 'note.md');
  const publish = path.join(path.dirname(target), `.cretli-publish-${randomUUID()}`);
  try {
    writeTextAtomic(staged, text);
    fs.renameSync(staged, publish);
    if (create) {
      // A hard link atomically enforces create-only semantics without overwriting a new file.
      fs.linkSync(publish, target);
    } else {
      checkExpected(readNote(root, input), expectedSha256);
      resolveNote(root, input);
      fs.renameSync(publish, target);
    }
  } finally {
    fs.rmSync(publish, { force: true });
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return readNote(root, input);
}

export const MAX_SKIPPED = 100;

export function recordSkipped(skipped, relative, error) {
  if (error.code === 'docs-index-limit') throw error;
  const reason = error instanceof DocsError ? error.code : ({
    ENOENT: 'docs-not-found', EACCES: 'docs-unreadable', EPERM: 'docs-unreadable', ELOOP: 'docs-symlink-cycle',
  }[error.code] || 'docs-entry-unavailable');
  if (skipped.length < MAX_SKIPPED) skipped.push({ path: relative, reason });
}

export function listNotes(root) {
  const files = [];
  const skipped = [];
  let entries = 0;
  const visit = (folder, relative, ancestors) => {
    const real = fs.realpathSync(folder);
    if (!inside(root, real)) throw new DocsError('docs-path-escape', 'Symlink leaves the Docs root', 403);
    if (ancestors.has(real)) throw new DocsError('docs-symlink-cycle', 'Directory symlink cycle');
    const next = new Set([...ancestors, real]);
    const dir = fs.opendirSync(real);
    try {
      let entry;
      while ((entry = dir.readSync())) {
        if (++entries > MAX_ENTRIES) throw new DocsError('docs-index-limit', 'Docs tree exceeds the entry limit', 413);
        if (entry.name.startsWith('.')) continue;
        const rel = relative ? `${relative}/${entry.name}` : entry.name;
        try {
          // Validate directory names too, before following any symlink beneath them.
          notePath(entry.name.endsWith('.md') ? rel : `${rel}/_.md`);
          const absolute = path.join(real, entry.name);
          const resolved = fs.realpathSync(absolute);
          if (!inside(root, resolved)) throw new DocsError('docs-path-escape', 'Symlink leaves the Docs root', 403);
          const stat = fs.statSync(resolved);
          if (stat.isDirectory()) {
            if (rel.split('/').length > 32) throw new DocsError('docs-index-limit', 'Docs tree exceeds the depth limit', 413);
            visit(absolute, rel, next);
          } else if (stat.isFile() && entry.name.endsWith('.md')) {
            if (!resolved.endsWith('.md')) throw new DocsError('docs-invalid-path', 'Note must target a Markdown file');
            if (files.length >= MAX_FILES) throw new DocsError('docs-index-limit', 'Docs tree exceeds 2000 notes', 413);
            files.push({ path: rel, size: stat.size, mtimeMs: stat.mtimeMs });
          }
        } catch (error) { recordSkipped(skipped, rel, error); }
      }
    } finally { dir.closeSync(); }
  };
  visit(root, '', new Set());
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), skipped };
}

export function trashNote(root, input, expectedSha256) {
  checkExpected(readNote(root, input), expectedSha256);
  const target = resolveNote(root, input);
  const trash = path.join(root, '.cretli-trash');
  if (!fs.existsSync(trash)) fs.mkdirSync(trash, { mode: 0o700 });
  const real = fs.realpathSync(trash);
  if (!inside(root, real) || fs.lstatSync(trash).isSymbolicLink()) throw new DocsError('docs-path-escape', 'Invalid trash directory', 403);
  const destination = path.join(real, `${randomUUID()}.md`);
  fs.renameSync(target, destination);
  return { path: input, trashed: true, trashPath: `.cretli-trash/${path.basename(destination)}` };
}
