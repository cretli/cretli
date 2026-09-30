/**
 * Daily JSONL usage files under data/usage/.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { resolveDataPath } from '../runtime-paths.js';

/**
 * Parsed day files keyed by absolute path. Entries are dropped when the file's
 * mtime/size changes or when an append happens through this module.
 *
 * @type {Map<string, { mtimeMs: number, size: number, events: object[] }>}
 */
const dayFileCache = new Map();
const MAX_CACHED_DAY_FILES = 400;

/**
 * @param {string} dataDir
 * @returns {string}
 */
export function resolveUsageDataDir(dataDir) {
  const root = String(dataDir || '').trim() || resolveDataPath();
  return path.join(root, 'usage');
}

/**
 * @param {string} [dataDir]
 * @param {string} isoDate
 * @returns {string}
 */
export function usageDayPath(dataDir, isoDate) {
  const day = String(isoDate || '').slice(0, 10);
  return path.join(resolveUsageDataDir(dataDir), `${day}.jsonl`);
}

/**
 * @param {object} event
 * @param {{ dataDir?: string }} [ctx]
 * @returns {void}
 */
export function appendUsageEvent(event, ctx = {}) {
  if (!event || typeof event !== 'object') return;
  const file = usageDayPath(ctx.dataDir, event.at);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8');
  dayFileCache.delete(file);
}

/**
 * @param {string} from
 * @param {string} to
 * @returns {string[]}
 */
function daysInRange(from, to) {
  const start = String(from || '').slice(0, 10);
  const end = String(to || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return [];
  if (start > end) return [];
  const days = [];
  const cursor = new Date(`${start}T00:00:00.000Z`);
  const last = new Date(`${end}T00:00:00.000Z`);
  while (cursor <= last) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/**
 * Reads and caches one day file, keyed by mtime + size.
 *
 * @param {string} file
 * @returns {object[]}
 */
function readDayFile(file) {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    dayFileCache.delete(file);
    return [];
  }
  const cached = dayFileCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.events;
  }
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const events = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') events.push(parsed);
    } catch {
      // Skip a corrupt line rather than failing the whole day.
    }
  }
  if (dayFileCache.size >= MAX_CACHED_DAY_FILES) {
    const oldest = dayFileCache.keys().next().value;
    if (oldest) dayFileCache.delete(oldest);
  }
  dayFileCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, events });
  return events;
}

/**
 * @param {{ from?: string, to?: string, dataDir?: string }} [query]
 * @returns {object[]}
 */
export function readUsageEvents(query = {}) {
  const to = String(query.to || new Date().toISOString());
  const from = String(query.from || to);
  const dir = resolveUsageDataDir(query.dataDir);
  if (!existsSync(dir)) return [];
  const wanted = new Set(daysInRange(from, to));
  if (wanted.size === 0) return [];
  const files = readdirSync(dir).filter((name) => {
    const day = name.replace(/\.jsonl$/, '');
    return name.endsWith('.jsonl') && wanted.has(day);
  });
  files.sort();
  const events = [];
  for (const name of files) {
    // A loop keeps large day files from blowing the spread-argument limit.
    for (const event of readDayFile(path.join(dir, name))) events.push(event);
  }
  return events;
}
