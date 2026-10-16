#!/usr/bin/env node
/**
 * Server cost of the sidebar presence summarize path.
 *
 * 1. REAL (when `data/chats.json` exists): ms/call of the exact
 *    `summarizeChatRunStates()` the presence bus runs on every flush.
 * 2. SYNTHETIC (always): the per-chat resolve work over a generated chat +
 *    delegation set, so the script runs without `data/`.
 * 3. FLUSH PATH: summarize calls per flush with S owed scopes. "before" ran one
 *    summarize per distinct scope plus one for the delta (S + 1); "after"
 *    reuses a single map per flush (1). The bus is driven for real with a
 *    summarize override that burns the measured per-call cost.
 *
 *   node scripts/measure-presence-summarize-cost.mjs
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { resolveChatAgentPresence, summarizeChatRunStates } from '../lib/agent-run-state.js';
import {
  subscribeChatListUpdates,
  __clearChatListUpdateClientsForTest,
} from '../lib/chat-list-updates.js';
import {
  initAgentPresenceBus,
  scheduleAgentPresenceRefresh,
  flushAgentPresenceNow,
  __setPresenceSummarizeForTest,
  __setWatcherPresenceForTest,
  __resetAgentPresenceBusForTest,
} from '../lib/agent-presence-bus.js';

const ROOT = process.cwd();
const REAL_CHATS = path.join(ROOT, 'data', 'chats.json');
const CHAT_COUNT = 1500;
const ITERATIONS = 30;
const SCOPE_COUNTS = [1, 3, 5, 10];

/** @param {() => void} fn @param {number} n @returns {number} ms per call */
function timeCall(fn, n) {
  fn();
  const start = process.hrtime.bigint();
  for (let i = 0; i < n; i += 1) fn();
  return Number(process.hrtime.bigint() - start) / 1e6 / n;
}

function syntheticSummarize() {
  const out = {};
  for (let i = 0; i < CHAT_COUNT; i += 1) {
    const run = { busy: i % 7 === 0, runId: `r${i}`, waitingForInput: i % 31 === 0 };
    const delegation = i % 3 === 0 ? { id: `d${i}`, status: i % 5 === 0 ? 'running' : 'completed' } : null;
    const row = resolveChatAgentPresence(run, delegation);
    if (row.state !== 'idle') out[`c${i}`] = row;
  }
  return out;
}

function socket() {
  return Object.assign(new EventEmitter(), {
    readyState: 1,
    bufferedAmount: 0,
    send() {},
  });
}

/** Returns summarize calls observed for one flush with `scopes` owed scopes. */
function callsPerFlush(scopes, perCall) {
  __resetAgentPresenceBusForTest();
  __clearChatListUpdateClientsForTest();
  __setWatcherPresenceForTest(() => []);
  let calls = 0;
  __setPresenceSummarizeForTest(() => { calls += 1; perCall(); return {}; });
  initAgentPresenceBus();
  const sockets = [];
  for (let i = 0; i < scopes; i += 1) {
    const ws = socket();
    subscribeChatListUpdates(ws, { kind: 'widget', chatIds: [`w${i}`] });
    sockets.push(ws);
  }
  for (const ws of sockets) ws.bufferedAmount = 1e9;
  scheduleAgentPresenceRefresh();
  flushAgentPresenceNow();
  for (const ws of sockets) ws.bufferedAmount = 0;
  calls = 0;
  scheduleAgentPresenceRefresh();
  flushAgentPresenceNow();
  return calls;
}

const rows = [];
const syntheticMs = timeCall(syntheticSummarize, ITERATIONS);
rows.push([`synthetic resolve (${CHAT_COUNT} chats)`, syntheticMs]);
let realMs = null;
if (existsSync(REAL_CHATS)) {
  try {
    realMs = timeCall(() => summarizeChatRunStates(), ITERATIONS);
    rows.push(['real summarizeChatRunStates', realMs]);
  } catch (err) {
    console.log(`real dataset skipped: ${err.message}`);
  }
} else {
  console.log('data/chats.json not found - real dataset skipped');
}

console.log('\nsummarize cost');
console.log('dataset'.padEnd(40), 'ms/call');
for (const [name, ms] of rows) console.log(name.padEnd(40), ms.toFixed(3));

const unit = realMs ?? syntheticMs;
console.log(`\nflush path (owed scopes, unit cost ${unit.toFixed(3)} ms/summarize)`);
console.log('scopes'.padEnd(8), 'before calls'.padEnd(14), 'after calls'.padEnd(13), 'before ms'.padEnd(11), 'after ms');
for (const scopes of SCOPE_COUNTS) {
  const after = callsPerFlush(scopes, () => {});
  const before = scopes + 1;
  console.log(
    String(scopes).padEnd(8),
    String(before).padEnd(14),
    String(after).padEnd(13),
    (before * unit).toFixed(3).padEnd(11),
    (after * unit).toFixed(3),
  );
}
__resetAgentPresenceBusForTest();
__clearChatListUpdateClientsForTest();
process.exit(0);
