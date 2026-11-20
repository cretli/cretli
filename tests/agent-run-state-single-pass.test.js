/**
 * `summarizeChatRunStates` single pass: best-ranked delegation per chat, controller child counts, and
 * a bounded cost for thousands of chats and delegations (isolated data dir, JSON store fixture).
 */
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { summarizeChatRunStates } from '../lib/agent-run-state.js';

const at = (s) => `2026-11-04T18:00:${String(s).padStart(2, '0')}.000Z`;

test('picks the best-ranked row and counts only controlled active children', () => {
  const items = [
    { id: 'old-done', parentChatId: 'p', childChatId: 'c1', status: 'completed', createdAt: at(1) },
    { id: 'run-a', parentChatId: 'p', childChatId: 'c2', status: 'running', createdAt: at(2) },
    { id: 'run-b', parentChatId: 'p', childChatId: 'c3', status: 'running', createdAt: at(3) },
    { id: 'wait', parentChatId: 'q', childChatId: 'c4', status: 'waiting_for_input', createdAt: at(4) },
    // Moved controller: `p` stays the parent but no longer counts this child.
    { id: 'moved', parentChatId: 'p', controllerChatId: 'ctl', childChatId: 'c5', status: 'running', createdAt: at(5) },
  ].map((row) => ({ revision: 1, ...row }));
  fs.writeFileSync(path.join(ISOLATED_DATA_DIR, 'delegations.json'), JSON.stringify({ v: 2, items }));
  const chats = ['p', 'q', 'ctl', 'c1', 'c2', 'c4', 'idle'].map((id) => ({ id }));
  const out = summarizeChatRunStates(chats.map((c) => c.id), { chats });
  assert.equal(out.p.state, 'waiting');
  assert.equal(out.p.waitingAgentCount, 2);
  // Equal rank: the newer of the two running rows wins, like the former sort.
  assert.equal(out.p.delegationId, 'moved');
  assert.equal(out.ctl.waitingAgentCount, 1);
  assert.equal(out.q.waitingAgentCount, 1);
  assert.equal(out.c4.state, 'waiting');
  assert.equal(out.c2.state, 'busy');
  assert.equal(out.c1.state, 'attention');
  assert.equal(out.idle, undefined);
});

test('scales linearly over many chats and delegations', () => {
  const N = 20_000;
  const items = Array.from({ length: N }, (_, i) => ({
    id: `d-${i}`,
    revision: 1,
    parentChatId: `p-${i % 500}`,
    childChatId: `c-${i}`,
    status: i % 10 === 0 ? 'running' : 'cancelled',
    createdAt: at(i % 60),
  }));
  fs.writeFileSync(path.join(ISOLATED_DATA_DIR, 'delegations.json'), JSON.stringify({ v: 2, items }));
  const chats = [...Array.from({ length: 500 }, (_, i) => ({ id: `p-${i}` })), ...items.map((r) => ({ id: r.childChatId }))];
  const ids = chats.map((c) => c.id);
  summarizeChatRunStates(ids, { chats }); // warm the store index
  const started = performance.now();
  const out = summarizeChatRunStates(ids, { chats });
  const ms = performance.now() - started;
  console.log(`[agent-run-state] ${chats.length} chats, ${N} delegations: ${ms.toFixed(1)} ms`);
  assert.equal(out['p-0'].waitingAgentCount, N / 500);
  assert.equal(out['c-10'].state, 'busy');
  assert.equal(out['c-11'], undefined);
  assert.ok(ms < 1500, `summarize took ${ms.toFixed(0)} ms`);
});
