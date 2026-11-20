#!/usr/bin/env node
/**
 * Read-only static inventory of blocking primitives on the server (stage 1 of the
 * architecture program, docs/architecture-baseline.md). It never runs application
 * code and never touches `data/`.
 *
 * Counted per file under lib/ and server.js:
 * - synchronous fs calls (readFileSync, writeFileSync, ...),
 * - synchronous child processes (execSync, spawnSync, execFileSync),
 * - Atomics.wait (blocks the event loop thread for the given timeout),
 * - node:sqlite DatabaseSync users (synchronous by construction),
 * - loadChats() textual occurrences (reported under the key loadChatsCalls, kept for
 *   JSON compatibility; matches include definitions, imports and comments, not only
 *   call sites; each real call returns a full copy of the chat list).
 *
 * Usage: node scripts/architecture-sync-io-inventory.mjs [--out docs/architecture-sync-io-inventory.json]
 * Output is deterministic (sorted keys, no timestamps) so it can be hashed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SYNC_FS = /\b(readFileSync|writeFileSync|appendFileSync|readdirSync|statSync|existsSync|mkdirSync|renameSync|unlinkSync|rmSync|copyFileSync|openSync|fsyncSync|lstatSync|realpathSync|accessSync)\(/g;
const SYNC_CHILD = /\b(execSync|spawnSync|execFileSync)\(/g;
const ATOMICS_WAIT = /Atomics\.wait\(/g;
const DATABASE_SYNC = /\bDatabaseSync\b/g;
const LOAD_CHATS = /\bloadChats\(/g;

/** @param {string} dir @returns {string[]} */
function listJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...listJsFiles(full));
    } else if (/\.(?:js|mjs|ts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** @param {string} text @param {RegExp} re */
function count(text, re) {
  return (text.match(re) || []).length;
}

const files = [...listJsFiles(path.join(ROOT, 'lib')), path.join(ROOT, 'server.js')].sort();
const rows = {};
const totals = { syncFs: 0, syncChild: 0, atomicsWait: 0, databaseSync: 0, loadChatsCalls: 0 };
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const row = {
    syncFs: count(text, SYNC_FS),
    syncChild: count(text, SYNC_CHILD),
    atomicsWait: count(text, ATOMICS_WAIT),
    databaseSync: count(text, DATABASE_SYNC),
    loadChatsCalls: count(text, LOAD_CHATS),
  };
  if (!Object.values(row).some(Boolean)) continue;
  rows[path.relative(ROOT, file)] = row;
  for (const key of Object.keys(totals)) totals[key] += row[key];
}

const result = { schema: 1, fileCount: files.length, totals, files: rows };
const outIndex = process.argv.indexOf('--out');
const json = `${JSON.stringify(result, null, 2)}\n`;
if (outIndex > 0) fs.writeFileSync(path.resolve(ROOT, process.argv[outIndex + 1]), json);
else process.stdout.write(json);
