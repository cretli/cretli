import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { parseTodoRef } from '../todo-ref.js';
import { listNotes, readNote, recordSkipped } from './docs-files.js';
import { DocsError } from './docs-state-store.js';

function safeMetadata(value, seen = new Set(), budget = { left: 4096 }, depth = 0) {
  if (--budget.left < 0 || depth > 20) throw new Error('Frontmatter is too complex');
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) throw new Error('Frontmatter aliases are not supported');
  seen.add(value);
  return Array.isArray(value) ? value.map((item) => safeMetadata(item, seen, budget, depth + 1))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safeMetadata(item, seen, budget, depth + 1)]));
}

// Keep source offsets intact so parsing and rename use exactly the same code exclusions.
function visibleMarkdown(text) {
  const chars = text.split('');
  const hide = (start, end) => {
    for (let i = start; i < end; i++) if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
  };
  let fence = null;
  let offset = 0;
  for (const line of text.split(/(?<=\n)/)) {
    if (fence) {
      hide(offset, offset + line.length);
      const close = /^ {0,3}(`+|~+)[ \t]*\r?\n?$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
    } else {
      const open = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/.exec(line);
      if (open && (open[1][0] !== '`' || !open[2].includes('`'))) {
        fence = { char: open[1][0], length: open[1].length };
        hide(offset, offset + line.length);
      }
    }
    offset += line.length;
  }
  const visible = chars.join('');
  const runs = [...visible.matchAll(/`+|\r?\n[ \t]*\r?\n/g)];
  const nextByLength = new Map();
  const closing = new Map();
  for (let i = runs.length - 1; i >= 0; i--) {
    if (runs[i][0][0] !== '`') { nextByLength.clear(); continue; }
    closing.set(i, nextByLength.get(runs[i][0].length));
    nextByLength.set(runs[i][0].length, i);
  }
  for (let i = 0; i < runs.length; i++) {
    if (runs[i][0][0] !== '`') continue;
    let slashes = 0;
    for (let at = runs[i].index - 1; at >= 0 && chars[at] === '\\'; at--) slashes++;
    const end = closing.get(i);
    if (slashes % 2 || end === undefined) continue;
    hide(runs[i].index, runs[end].index + runs[end][0].length);
    i = end;
  }
  return chars.join('');
}

function wikiMatches(body) {
  return [...visibleMarkdown(body).matchAll(/\[\[([^\]\n]+)\]\]/g)]
    .filter((match) => body.slice(match.index, match.index + match[0].length) === match[0]);
}

export function parseNote(note) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(note.text);
  let frontmatter = {};
  let frontmatterError = null;
  if (match) {
    try {
      const value = yaml.load(match[1], { schema: yaml.JSON_SCHEMA, json: true });
      if (value && typeof value === 'object' && !Array.isArray(value)) frontmatter = safeMetadata(value);
    } catch { frontmatterError = 'Invalid YAML frontmatter'; }
  }
  const body = match ? note.text.slice(match[0].length) : note.text;
  const title = typeof frontmatter.title === 'string' ? frontmatter.title
    : /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || path.posix.basename(note.path, '.md');
  const wikilinks = wikiMatches(body).map((m) => {
    const [targetHeading, ...aliases] = m[1].split('|');
    const [target, ...heading] = targetHeading.split('#');
    return { raw: m[1], target: target.trim(), heading: heading.join('#'), alias: aliases.join('|') };
  });
  const rawTags = frontmatter.tags;
  const tags = new Set((Array.isArray(rawTags) ? rawTags : typeof rawTags === 'string' ? rawTags.split(/[ ,]+/) : [])
    .filter((tag) => typeof tag === 'string').map((tag) => tag.replace(/^#/, '')));
  for (const m of body.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)) tags.add(m[1]);
  const mentions = [...new Set(visibleMarkdown(body).split(/\r?\n/).map((line) => parseTodoRef(line)?.todoId).filter(Boolean))];
  return { ...note, title, frontmatter, frontmatterError, wikilinks, tags: [...tags], mentions };
}

export function resolveWikiTarget(source, target, notes) {
  if (!target) return source;
  const withExt = target.endsWith('.md') ? target : `${target}.md`;
  const local = path.posix.normalize(path.posix.join(path.posix.dirname(source), withExt));
  if (notes.has(local)) return local;
  if (notes.has(withExt)) return withExt;
  if (!target.includes('/')) {
    const matches = [...notes.keys()].filter((name) => path.posix.basename(name) === withExt);
    if (matches.length === 1) return matches[0];
  }
  return null;
}

export function createDocsIndex(root) {
  let notes = new Map();
  let dirty = true;
  let timer;
  let watcher;
  try {
    watcher = fs.watch(root, () => {
      clearTimeout(timer);
      timer = setTimeout(() => { dirty = true; }, 50);
      timer.unref();
    });
    watcher.on('error', () => { dirty = true; });
    watcher.unref();
  } catch { /* Request-time stat checks remain authoritative without a watcher. */ }
  return {
    refresh() {
      const { files, skipped } = listNotes(root);
      const next = new Map();
      let bytes = 0;
      for (const file of files) {
        bytes += file.size;
        if (bytes > 16 * 1024 * 1024) throw new DocsError('docs-index-limit', 'Docs index exceeds 16 MiB', 413);
        try {
          const old = notes.get(file.path);
          const note = !dirty && old?.mtimeMs === file.mtimeMs && old?.size === file.size
            ? old : parseNote(readNote(root, file.path));
          next.set(file.path, note);
        } catch (error) { recordSkipped(skipped, file.path, error); }
      }
      const previous = notes;
      notes = next;
      dirty = false;
      return { notes, previous, skipped };
    },
    invalidate() { dirty = true; },
    close() { clearTimeout(timer); watcher?.close(); },
  };
}

export function backlinksFor(target, notes) {
  return [...notes.values()].filter((note) => note.wikilinks.some((link) => resolveWikiTarget(note.path, link.target, notes) === target))
    .map((note) => ({ path: note.path, title: note.title }));
}

export function rewriteWikilinks(note, oldPath, newPath, notes) {
  const header = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(note.text)?.[0] || '';
  const body = note.text.slice(header.length);
  let result = '';
  let offset = 0;
  for (const match of wikiMatches(body)) {
    const [whole, raw] = match;
    const suffixAt = raw.search(/[#|]/);
    const target = (suffixAt < 0 ? raw : raw.slice(0, suffixAt)).trim();
    let replacement = whole;
    if (resolveWikiTarget(note.path, target, notes) === oldPath) {
      const suffix = suffixAt < 0 ? '' : raw.slice(suffixAt);
      const relative = path.posix.relative(path.posix.dirname(note.path === oldPath ? newPath : note.path), newPath);
      replacement = `[[${target.endsWith('.md') ? relative : relative.slice(0, -3)}${suffix}]]`;
    }
    result += body.slice(offset, match.index) + replacement;
    offset = match.index + whole.length;
  }
  return header + result + body.slice(offset);
}
