#!/usr/bin/env node
/**
 * Field and size profile of a logical chat export, used to freeze the SQLite chats schema
 * (docs/storage-chats-metadata-decision.md section 12, docs/storage-chats-field-profile.md).
 *
 * Usage: node scripts/profile-chat-fields.mjs --input <copy-of-chat-export.json> [--out <report.json>]
 *
 * The report holds numbers and field NAMES only: never chat contents, titles, paths or ids. The script reads
 * the copy, never writes next to it, and refuses to run on the active runtime data directory (pass an
 * explicit copy). Counter parity is checked in an isolated temporary database that is deleted afterwards.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from '../lib/storage/migrations.js';
import { offlineHandlers as h, splitChat, CHATS_BATCH_MAX_ITEMS } from '../lib/storage/chats-store.js';
import { resolveDataPath } from '../lib/runtime-paths.js';

/** Field names are schema vocabulary; anything else is counted but never printed. */
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function parseArgs(argv) {
  const args = { input: '', out: '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--input') args.input = argv[++i] ?? '';
    else if (argv[i] === '--out') args.out = argv[++i] ?? '';
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.input) throw new Error('--input <copy-of-chat-export.json> is required (the script never defaults to the active data directory)');
  return args;
}

/** @param {string} file */
function assertNotActiveRuntime(file) {
  const real = fs.realpathSync(file);
  const dataDir = path.resolve(resolveDataPath());
  const realData = fs.existsSync(dataDir) ? fs.realpathSync(dataDir) : dataDir;
  for (const candidate of [path.resolve(file), real]) {
    for (const root of [dataDir, realData]) {
      if (candidate === root || candidate.startsWith(root + path.sep)) {
        throw new Error('Refusing to profile a file inside the active runtime data directory; pass a copy outside it');
      }
    }
  }
}

/** @param {number[]} values @param {number} q */
function quantile(values, q) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))];
}

const stats = (values) => ({ p50: quantile(values, 0.5), p95: quantile(values, 0.95), max: quantile(values, 1) });
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

function profile(chats, fileBytes) {
  const fields = new Map();
  const placement = new Map();
  const recordBytes = [];
  const lightBytes = [];
  const detailsBytes = [];
  let nonconformingNames = 0;
  for (const chat of chats) {
    recordBytes.push(bytes(chat));
    const part = splitChat(chat);
    lightBytes.push(Buffer.byteLength(part.cols.light_json, 'utf8'));
    detailsBytes.push(bytes(part.extra) + bytes(part.order));
    for (const [key, value] of Object.entries(chat)) {
      if (!SAFE_NAME.test(key)) { nonconformingNames += 1; continue; }
      const entry = fields.get(key) ?? { present: 0, types: {}, sizes: [] };
      entry.present += 1;
      const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
      entry.types[type] = (entry.types[type] ?? 0) + 1;
      entry.sizes.push(bytes(value));
      fields.set(key, entry);
      const where = key === 'id' ? 'key'
        : key in part.light ? 'light_json'
          : key in part.extra ? 'chat_details'
            : 'column';
      const slot = placement.get(key) ?? { column: 0, light_json: 0, chat_details: 0, key: 0 };
      slot[where] += 1;
      placement.set(key, slot);
    }
  }
  const report = {};
  for (const [key, entry] of [...fields.entries()].sort((a, b) => b[1].present - a[1].present)) {
    report[key] = { present: entry.present, types: entry.types, bytes: stats(entry.sizes), placement: placement.get(key) };
  }
  const overKiB = Object.entries(report).filter(([, v]) => v.bytes.p95 > 1024).map(([k]) => k);
  return {
    chats: chats.length, fileBytes, nonconformingFieldNames: nonconformingNames,
    recordBytes: stats(recordBytes), lightJsonBytes: stats(lightBytes), detailsBytes: stats(detailsBytes),
    fieldsOverOneKiBAtP95: overKiB, fields: report,
  };
}

function topology(chats) {
  const byId = new Map(chats.map((c) => [c.id, c]));
  const parentOf = (c) => (typeof c.forkParentChatId === 'string' ? c.forkParentChatId.trim() : '');
  const children = new Map();
  for (const c of chats) {
    const p = parentOf(c);
    if (p) children.set(p, [...(children.get(p) ?? []), c.id]);
  }
  let maxDepth = 0;
  for (const c of chats) {
    let depth = 0;
    const seen = new Set();
    for (let p = parentOf(c); p && byId.has(p) && !seen.has(p); p = parentOf(byId.get(p))) { seen.add(p); depth += 1; }
    maxDepth = Math.max(maxDepth, depth);
  }
  const subtreeSize = (id, seen = new Set()) => {
    if (seen.has(id)) return 0;
    seen.add(id);
    return 1 + (children.get(id) ?? []).reduce((sum, k) => sum + subtreeSize(k, seen), 0);
  };
  const roots = chats.filter((c) => !parentOf(c) || !byId.has(parentOf(c)));
  const sizes = roots.map((c) => subtreeSize(c.id));
  const partitions = new Map();
  for (const c of chats) {
    if (typeof c.widgetInstallationId !== 'string' || c.widgetInstallationId === '') continue;
    const key = `${c.widgetInstallationId}\u0000${c.widgetPageSessionId ?? ''}`;
    partitions.set(key, (partitions.get(key) ?? 0) + 1);
  }
  const buckets = new Set(chats.map((c) => `${String(c.workspaceFile || '')}\u0000${String(c.workspaceFolder || '')}\u0000${String(c.archivedAt || '').trim() ? 1 : 0}`));
  const legacyKeys = new Map();
  for (const c of chats) {
    if (!String(c.archivedAt || '').trim()) continue;
    const legacy = `${String(c.workspaceFile || '')}\n${String(c.workspaceFolder || '')}`;
    const raw = `${String(c.workspaceFile || '')}\u0000${String(c.workspaceFolder || '')}`;
    legacyKeys.set(legacy, new Set([...(legacyKeys.get(legacy) ?? []), raw]));
  }
  return {
    maxForkDepth: maxDepth, maxParentChain: maxDepth, forkRoots: roots.length,
    subtreeRows: stats(sizes), widgetPartitions: partitions.size, widgetPartitionRows: stats([...partitions.values()]),
    distinctCounterBuckets: buckets.size,
    legacyKeyCollisions: [...legacyKeys.values()].filter((set) => set.size > 1).length,
  };
}

/** Import into an isolated temporary database and compare the counters with reference COUNTs. */
function counterParity(chats) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-chat-profile-'));
  const db = new DatabaseSync(path.join(dir, 'profile.sqlite'));
  try {
    applyMigrations(db);
    const ctx = { prepare: (sql) => db.prepare(sql) };
    db.exec('BEGIN IMMEDIATE');
    const seen = new Set();
    let imported = 0;
    for (let i = 0; i < chats.length; i += CHATS_BATCH_MAX_ITEMS) {
      const batch = chats.slice(i, i + CHATS_BATCH_MAX_ITEMS).filter((c) => typeof c.id === 'string' && c.id.trim() && !seen.has(c.id) && seen.add(c.id));
      if (batch.length > 0) { h.importBatch(ctx, { chats: batch }); imported += batch.length; }
    }
    db.exec('COMMIT');
    const verdict = h.verifyCounts(ctx);
    const counts = h.counts(ctx, {});
    const ref = db.prepare("SELECT count(*) AS total, sum(archived_at <> '') AS archived, sum(parent_id = '') AS roots FROM chats").get();
    const archivedMap = h.archivedCountsByWorkspace(ctx, {}).counts;
    const archivedSum = Object.values(archivedMap).reduce((a, b) => a + b, 0);
    return {
      imported, countersMatchGroupBy: verdict.ok, counterMismatches: verdict.mismatches, buckets: verdict.buckets,
      totalMatches: counts.total === Number(ref.total), archivedMatches: counts.archived === Number(ref.archived),
      rootsMatch: counts.roots === Number(ref.roots), archivedMapSumMatches: archivedSum === Number(ref.archived),
    };
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = path.resolve(args.input);
  assertNotActiveRuntime(file);
  const text = fs.readFileSync(file, 'utf8');
  const doc = JSON.parse(text);
  const chats = Array.isArray(doc?.chats) ? doc.chats.filter((c) => c && typeof c === 'object') : [];
  const report = { generatedFor: 'chats-sqlite-schema-freeze', ...profile(chats, Buffer.byteLength(text)), topology: topology(chats), counterParity: counterParity(chats) };
  const json = JSON.stringify(report, null, 2);
  if (args.out) fs.writeFileSync(path.resolve(args.out), `${json}\n`, { mode: 0o600 });
  process.stdout.write(`${json}\n`);
}

try {
  main();
} catch (err) {
  process.stderr.write(`profile-chat-fields: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
