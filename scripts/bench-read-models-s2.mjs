#!/usr/bin/env node
/**
 * S2 read-model bench (docs/event-bus-s2.md). Builds an isolated synthetic data dir
 * (never the repository data/) with N chats via scripts/architecture-http-fixture.mjs, then
 * times the functions behind the polled chat routes while a simulated "Watcher cycle"
 * writes (history revision bumps / delegation-free presence changes) between samples.
 * Reports p50/p95/max per call and event-loop delay (perf_hooks.monitorEventLoopDelay).
 *
 * Usage: node scripts/bench-read-models-s2.mjs [--size 2000] [--samples 100] [--json]
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const size = Number(opt('--size', 2000));
const samples = Number(opt('--samples', 100));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-s2-bench-'));

const { populateFixture } = await import('./architecture-http-fixture.mjs');
await populateFixture({ dir, size, profile: opt('--profile', 'full'), seed: 20261122 });
const { peekChatsAsync } = await import('../lib/persist/chats-persist.js');
const { summarizeChatRunStatesAsync } = await import('../lib/agent-run-state.js');
const { bumpChatHistoryRevision, getChatHistoryRevisions } = await import('../lib/persist/chat-history-revisions.js');

const rows = await peekChatsAsync();
const ids = rows.map((r) => r.id);
ids.forEach((id, i) => bumpChatHistoryRevision(id, i));

const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)]; };
const r3 = (v) => Math.round(v * 1000) / 1000;
async function time(name, fn) {
  const h = monitorEventLoopDelay({ resolution: 1 });
  h.enable();
  const t = [];
  for (let i = 0; i < samples; i += 1) {
    // Simulated background write: one chat's history advances.
    bumpChatHistoryRevision(ids[i % ids.length], 1000 + i);
    const s = performance.now();
    await fn();
    t.push(performance.now() - s);
    await new Promise((r) => setImmediate(r));
  }
  h.disable();
  return { name, p50: r3(pct(t, 50)), p95: r3(pct(t, 95)), max: r3(Math.max(...t)), eventLoopP99Ms: r3(h.percentile(99) / 1e6) };
}
const { getWorkspaceWatcherView } = await import('../lib/workspace-watcher-control.js');
const { listNotifications } = await import('../lib/notifications/notification-store.ts');
const hotWs = rows[0]?.workspaceFile || rows[0]?.workspaceFolder || dir;
const out = [];
out.push(await time('watcher view (uncached compute)', () => getWorkspaceWatcherView({ dataDir: dir, workspaceFolder: hotWs, now: Date.now() })));
out.push(await time('listNotifications', () => listNotifications({})));
out.push(await time('peekChatsAsync (all)', () => peekChatsAsync()));
out.push(await time('getChatHistoryRevisions(all ids)', () => getChatHistoryRevisions(ids)));
out.push(await time('agent-states (no ids = all chats)', () => summarizeChatRunStatesAsync([])));
out.push(await time('agent-states (all ids listed)', () => summarizeChatRunStatesAsync(ids)));
const result = { size: ids.length, samples, results: out };
if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
else { console.log(`chats=${ids.length} samples=${samples}`); console.table(out); }
fs.rmSync(dir, { recursive: true, force: true });
