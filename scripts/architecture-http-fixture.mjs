#!/usr/bin/env node
/**
 * V9 fixture generator (docs/architecture-http-baseline.md). Deterministic for a
 * given seed; writes ONLY into the data directory it is given and refuses to touch
 * the repository `data/` directory. All names are fictional.
 *
 * Shape per size N (profile `full`):
 * - N chats over WORKSPACES (>= 20) workspaces, ~35% forks, with chains up to
 *   DEEP_CHAIN levels deep (deep subtrees)
 * - one "hot" workspace holds HOT_LIVE_ROWS live rows in a single group
 * - ~40% of the remaining chats are archived (large archive)
 * - HISTORY_CHATS chats get HISTORY_EVENTS history events each (long histories)
 * - TODOS todos in the hot workspace and DELEGATIONS delegation records (growth)
 * Usage state is not generated: there is no stable public writer for it in this
 * stage; the baseline reports it as not covered.
 *
 * CLI: node scripts/architecture-http-fixture.mjs --dir <empty dir> --size 5000 [--profile full|smoke] [--seed N]
 * Library: `await populateFixture({ dir, size, profile, seed })` (call at most once
 * per process: persistence paths bind to the env at first import).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROFILES = Object.freeze({
  full: { workspaces: 24, deepChain: 40, hotLiveRows: 3000, historyChats: 20, historyEvents: 1500, todos: 400, delegations: 600 },
  smoke: { workspaces: 20, deepChain: 12, hotLiveRows: 60, historyChats: 2, historyEvents: 50, todos: 15, delegations: 15 },
});

/** @param {number} seed */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Pure: the chat rows of a fixture. Exported so tests can reason about the shape.
 *
 * @param {{ size: number, seed: number, profile: keyof typeof PROFILES, root: string }} options
 */
export function buildChats({ size, seed, profile, root }) {
  const p = PROFILES[profile];
  const rand = mulberry32(seed + size);
  const transports = ['sdk', 'opencode', 'claude', 'codex', 'qwen', 'deepseek'];
  const folder = (w) => path.join(root, 'workspaces', `ws-${String(w).padStart(2, '0')}`);
  const hot = Math.min(p.hotLiveRows, Math.floor(size / 2));
  const chats = [];
  for (let i = 0; i < size; i += 1) {
    const isHot = i < hot;
    const ws = isHot ? 0 : 1 + (i % (p.workspaces - 1));
    const chain = !isHot && i < hot + p.deepChain;
    const hasFork = i > hot + 10 && rand() < 0.35;
    chats.push({
      id: `chat-${String(i).padStart(6, '0')}`,
      title: `Fixture chat ${i}`,
      cursorSessionId: `session-${i}`,
      workspaceFolder: folder(ws),
      workspaceFile: `${folder(ws)}.code-workspace`,
      model: 'fixture/model',
      agentTransport: transports[Math.floor(rand() * transports.length)],
      createdAt: new Date(1.7e12 + i * 60000).toISOString(),
      widgetInstallationId: i % 9 === 0 ? `widget-${i % 3}` : undefined,
      forkParentChatId: chain && i > hot
        ? `chat-${String(i - 1).padStart(6, '0')}`
        : hasFork ? `chat-${String(hot + Math.floor(rand() * (i - hot))).padStart(6, '0')}` : undefined,
      archivedAt: !isHot && rand() < 0.4 ? new Date(1.7e12 + i * 61000).toISOString() : undefined,
    });
  }
  return chats;
}

/**
 * Bind persistence to `dir` and write the whole fixture.
 *
 * @param {{ dir: string, size: number, profile?: keyof typeof PROFILES, seed?: number }} options
 */
export async function populateFixture({ dir, size, profile = 'full', seed = 20261017 }) {
  const resolved = path.resolve(dir);
  const repoData = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
  if (resolved === repoData || resolved.startsWith(`${repoData}${path.sep}`)) {
    throw new Error('Refusing to write a fixture into the repository data/ directory');
  }
  fs.mkdirSync(resolved, { recursive: true });
  if (fs.readdirSync(resolved).length > 0) throw new Error(`Fixture directory must be empty: ${resolved}`);
  for (const key of ['CRETLI_DATA_DIR', 'CURSOR_REMOTE_DATA_DIR']) process.env[key] = resolved;
  const p = PROFILES[profile];
  if (!p) throw new Error(`Unknown profile: ${profile}`);
  const chats = buildChats({ size, seed, profile, root: resolved });
  fs.writeFileSync(path.join(resolved, 'chats.json'), JSON.stringify({ chats }));
  const stats = { size, profile, seed, chats: chats.length, workspaces: p.workspaces };

  const { appendChatHistoryEvents } = await import('../lib/persist/chat-history-persist.js');
  stats.historyEvents = 0;
  for (let c = 0; c < Math.min(p.historyChats, chats.length); c += 1) {
    const chat = chats[c];
    const items = Array.from({ length: p.historyEvents }, (_, e) => ({
      rec: { kind: e % 2 ? 'assistant' : 'user', text: `Fixture message ${e} of ${chat.id}. ${'lorem ipsum '.repeat(8)}` },
    }));
    appendChatHistoryEvents(chat.id, chat.cursorSessionId, items);
    stats.historyEvents += items.length;
  }

  const { addTodo } = await import('../lib/persist/todos-persist.js');
  const hotFolder = chats[0].workspaceFolder;
  stats.todos = 0;
  for (let t = 0; t < p.todos; t += 1) {
    try {
      addTodo(resolved, hotFolder, { title: `Fixture todo ${t}`, body: 'Synthetic body. '.repeat(20), status: 'ready' });
      stats.todos += 1;
    } catch { break; }
  }

  const { createDelegationRecord } = await import('../lib/persist/delegations-persist.js');
  stats.delegations = 0;
  for (let d = 0; d < p.delegations; d += 1) {
    createDelegationRecord({
      parentChatId: chats[d % Math.min(chats.length, 200)].id,
      workspaceFolder: hotFolder,
      assignment: 'implement',
      status: 'completed',
      executor: { transport: 'opencode', model: 'opencode/test' },
    });
    stats.delegations += 1;
  }
  const { closeDelegationSqlite } = await import('../lib/persist/delegation-sqlite.js');
  closeDelegationSqlite();
  stats.usage = 'not generated (no stable writer in this stage)';
  return stats;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const dir = opt('--dir', '');
  if (!dir) {
    process.stderr.write(`Usage: node scripts/architecture-http-fixture.mjs --dir <empty dir under ${os.tmpdir()}> --size 5000 [--profile full|smoke] [--seed N]\n`);
    process.exit(2);
  }
  const stats = await populateFixture({
    dir, size: Number(opt('--size', '500')), profile: opt('--profile', 'full'), seed: Number(opt('--seed', '20261017')),
  });
  process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
}
