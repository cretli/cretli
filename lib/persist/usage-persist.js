/**
 * Daily JSONL usage files under data/usage/.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'fs';
import path from 'path';
import { resolveDataPath } from '../runtime-paths.js';

/**
 * @param {string} [dataDir]
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
    const raw = readFileSync(path.join(dir, name), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object') events.push(parsed);
      } catch {
        // Skip a corrupt line rather than failing the whole day.
      }
    }
  }
  return events;
}
