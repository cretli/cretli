// Benchmark: presence attach / owed-snapshot flush cost, full recompute (old path) vs presence index.
// Usage: node scripts/bench-presence-flush.mjs [chats=50000]
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { subscribeChatListUpdates } from '../lib/chat-list-updates.js';
import {
  initAgentPresenceBus, scheduleAgentPresenceRefresh, flushAgentPresenceNow,
  __setPresenceSummarizeForTest, __setWatcherPresenceForTest,
} from '../lib/agent-presence-bus.js';

const CHATS = Number(process.argv[2]) || 50_000;
const chatIds = Array.from({ length: CHATS }, (_, i) => `chat-${i}`);
const busy = { state: 'busy', runId: '', delegationId: 'd', delegationStatus: '', attention: false, waitingAgentCount: 0 };
/** Stand-in for summarizeChatRunStates: cost is linear in the ids it is asked about. */
const summarize = (ids) => {
  const out = {};
  for (const id of ids || chatIds) {
    const n = Number(id.slice(5));
    if (n % 10 === 0) out[id] = { ...busy };
  }
  return out;
};
const median = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const time = (fn, runs = 15) => { const xs = []; for (let i = 0; i < runs; i += 1) { const t = performance.now(); fn(); xs.push(performance.now() - t); } return median(xs); };

initAgentPresenceBus();
__setWatcherPresenceForTest(() => []);
__setPresenceSummarizeForTest(summarize);
const ws = /** @type {any} */ (Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, _presenceProtocol: 2, send() {} }));
subscribeChatListUpdates(ws, { kind: 'session' });

// Before: every attach / owed-snapshot flush recomputed the whole map (one full summarize).
const before = time(() => summarize());
// After: unscoped refresh still rebuilds (rare), a scoped flush touches the dirty ids only.
const afterScoped = time(() => { scheduleAgentPresenceRefresh(['chat-10', 'chat-11']); flushAgentPresenceNow(); });
let n = 0;
const afterAttach = time(() => subscribeChatListUpdates(/** @type {any} */ (Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, _presenceProtocol: 2, send() {}, n: n++ })), { kind: 'session' }), 50);
console.log(JSON.stringify({ chats: CHATS, beforeFullRecomputeMs: +before.toFixed(2), afterScopedFlushMs: +afterScoped.toFixed(3), afterWarmAttachMs: +afterAttach.toFixed(3) }));
process.exit(0);
