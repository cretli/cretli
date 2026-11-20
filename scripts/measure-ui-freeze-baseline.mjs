#!/usr/bin/env node
/**
 * Task 0.1 baseline helper — synthetic measurement of the synchronous paths that
 * the 2026-10-05 trace blamed for the UI freeze, using the real instrumentation.
 *
 * What it measures (no browser, no server, no real data):
 * - `buildChatLocalBootCache` cost and storage reads per build for a small
 *   bootstrap (40 rows) and the 300/301/1000/1500 thresholds.
 * - `readChatLocalBootCache` (cold-start parse) for the small bootstrap.
 *
 * The activity maps are seeded into a fake localStorage so the module's own
 * counters (`storage.reads`, `boot-cache.build` span) are exercised. Raw
 * `getItem` calls are counted separately to match the "storage reads" table in
 * docs/ui-freeze-trace-2026-10-05.md.
 *
 * Usage: node scripts/measure-ui-freeze-baseline.mjs [N ...]
 */

import { performance } from 'node:perf_hooks';

import {
  CHAT_LOCAL_BOOT_CACHE_KEY,
  buildChatLocalBootCache,
  readChatLocalBootCache,
} from '../app_front/features/chat/chatLocalBootCache.js';
import {
  getUiFreezeCounters,
  snapshotUiFreezeCounters,
  __resetUiFreezeCountersForTest,
} from '../app_front/lib/uiFreezeCounters.js';
import { __resetUiFreezeTraceActiveCacheForTest } from '../app_front/lib/uiFreezeTrace.js';

const DEFAULT_SIZES = [40, 300, 301, 1000, 1500];
const MAP_ENTRIES = 1500;
const REPEATS = 5;

/** @param {string[]} argv */
function parseSizes(argv) {
  const sizes = argv
    .map((value) => Number(value))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  return sizes.length > 0 ? sizes : DEFAULT_SIZES;
}

/** @param {number} count */
function createFakeStorage(count) {
  /** @type {Map<string, string>} */
  const map = new Map();
  const activity = {};
  const lastUsed = {};
  for (let index = 0; index < MAP_ENTRIES; index += 1) {
    activity[`chat-${index}`] = 1_700_000_000_000 + index;
    lastUsed[`chat-${index}`] = 1_700_000_000_000 + index;
  }
  map.set('cretli-chat-activity', JSON.stringify(activity));
  map.set('cretli-chat-last-used', JSON.stringify(lastUsed));
  map.set('cretli-ui-freeze-diag', '1');
  void count;
  let rawReads = 0;
  return {
    get length() {
      return map.size;
    },
    key(index) {
      return [...map.keys()][index] ?? null;
    },
    getItem(key) {
      rawReads += 1;
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(String(key), String(value));
    },
    removeItem(key) {
      map.delete(String(key));
    },
    get rawReads() {
      return rawReads;
    },
    resetRawReads() {
      rawReads = 0;
    },
    get(key) {
      return map.get(key);
    },
  };
}

/** @param {number} count */
function createChats(count) {
  const chats = [];
  for (let index = 0; index < count; index += 1) {
    chats.push({
      id: `chat-${index}`,
      title: `Chat ${index}`,
      cursorSessionId: `session-${index}`,
      workspaceFile: '/ws/baseline.code-workspace',
      updatedAt: new Date(1_700_000_000_000 + index * 1000).toISOString(),
      createdAt: new Date(1_600_000_000_000 + index * 1000).toISOString(),
    });
  }
  return chats;
}

/** @param {() => void} fn @param {number} repeats */
function measure(fn, repeats = REPEATS) {
  /** @type {number[]} */
  const samples = [];
  for (let index = 0; index < repeats; index += 1) {
    const startedAt = performance.now();
    fn();
    samples.push(performance.now() - startedAt);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    max: sorted[sorted.length - 1],
  };
}

/**
 * @param {object} row
 * @returns {string}
 */
function ms(value) {
  return `${Math.round(value * 100) / 100}`;
}

async function main() {
  const sizes = parseSizes(process.argv.slice(2));
  const previousLocalStorage = globalThis.localStorage;
  const storage = createFakeStorage(MAP_ENTRIES);
  globalThis.localStorage = storage;
  __resetUiFreezeTraceActiveCacheForTest();
  __resetUiFreezeCountersForTest();

  const lines = [];
  lines.push('# UI freeze baseline — synthetic synchronous paths');
  lines.push('');
  lines.push(`Date: ${new Date().toISOString()}`);
  lines.push(`Node: ${process.version}; machine: ${process.arch}/${process.platform}`);
  lines.push(`Repeats per row: ${REPEATS}; activity/last-used maps: ${MAP_ENTRIES} entries each.`);
  lines.push('');
  lines.push('## boot-cache.build per chat count');
  lines.push('');
  lines.push('| chats | median build ms | max build ms | raw getItem/build | counter storage.reads/build | built rows |');
  lines.push('| ---: | ---: | ---: | ---: | ---: | ---: |');

  for (const size of sizes) {
    const chats = createChats(size);
    const timing = measure(() => {
      buildChatLocalBootCache({
        chats,
        activeChatId: 'chat-0',
        workspaceContext: { workspaceFile: '/ws/baseline.code-workspace', workspaceFolder: '/ws' },
      });
    });
    // One isolated build for the read counters so a 1s window roll cannot clip them.
    storage.resetRawReads();
    __resetUiFreezeCountersForTest();
    getUiFreezeCounters();
    const doc = buildChatLocalBootCache({
      chats,
      activeChatId: 'chat-0',
      workspaceContext: { workspaceFile: '/ws/baseline.code-workspace', workspaceFolder: '/ws' },
    });
    const snap = snapshotUiFreezeCounters();
    lines.push(
      `| ${size} | ${ms(timing.median)} | ${ms(timing.max)} | ${storage.rawReads} | ${snap.counters['storage.reads'] || 0} | ${doc.chats.length} |`
    );
  }

  lines.push('');
  lines.push('## cold-start parse (small bootstrap)');
  lines.push('');
  lines.push('| chats | median parse ms | max parse ms | JSON bytes |');
  lines.push('| ---: | ---: | ---: | ---: |');
  for (const size of sizes.filter((value) => value <= 300)) {
    const chats = createChats(size);
    const doc = buildChatLocalBootCache({ chats, activeChatId: 'chat-0' });
    const json = JSON.stringify(doc);
    storage.setItem(CHAT_LOCAL_BOOT_CACHE_KEY, json);
    const timing = measure(() => {
      readChatLocalBootCache(storage);
    });
    lines.push(`| ${size} | ${ms(timing.median)} | ${ms(timing.max)} | ${json.length} |`);
  }

  lines.push('');
  lines.push('Captured with `cretli-ui-freeze-diag=1`; the same counters are what a real');
  lines.push('browser run reports through the Logs panel freeze filter (');
  lines.push('`freeze-counters:snapshot` lines) and `window.__crUiFreeze.format()`.');

  globalThis.localStorage = previousLocalStorage;
  __resetUiFreezeCountersForTest();
  __resetUiFreezeTraceActiveCacheForTest();

  process.stdout.write(`${lines.join('\n')}\n`);
}

await main();
