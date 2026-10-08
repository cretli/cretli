/**
 * Workspace Memory: workspace-keyed persistence, typed facts, lazy TTL, CAS,
 * the three MCP tools and the watcher-prompt section.
 */

import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  WORKSPACE_MEMORY_DEFAULT_TRANSIENT_BLOCKER_TTL_MS,
  WORKSPACE_MEMORY_MAX_ENTRIES,
  WORKSPACE_MEMORY_MAX_TTL_MS,
  WORKSPACE_MEMORY_TYPES,
  addWorkspaceMemory,
  deleteWorkspaceMemory,
  listWorkspaceMemory,
  loadWorkspaceMemoryDocument,
  pruneWorkspaceMemory,
  workspaceMemoryKey,
} from '../lib/persist/workspace-memory-persist.js';
import { workspaceKeyFromCwd } from '../lib/persist/todos-persist.js';
import {
  buildWorkspaceMemoryPromptBlock,
  buildWorkspaceWatcherCyclePrompt,
  buildWorkspaceWatcherCyclePromptPlan,
  buildWorkspaceWatcherPreviousChatsBlock,
  WORKSPACE_MEMORY_PROMPT_CHAR_BUDGET,
  WORKSPACE_MEMORY_PROMPT_ENTRY_LIMIT,
  WORKSPACE_WATCHER_PROMPT_CHAR_BUDGET,
  WORKSPACE_WATCHER_PROMPT_HISTORY_CHAR_BUDGET,
} from '../lib/workspace-watcher-prompt.js';
import {
  buildHarnessBlockerKey,
  buildTodoBlockerKey,
  isTransientBlockerCause,
  memoryEntryDedupKey,
  normalizeMemoryKey,
  parseBlockerKey,
} from '../lib/workspace-memory-key.js';
import { createCretliMcpToolHandlers } from '../lib/mcp/builtin/catalog.js';
import { setBuiltinMcpRuntimeDeps } from '../lib/mcp/builtin/runtime-deps.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-memory-'));
const T0 = Date.parse('2026-03-01T00:00:00.000Z');

/** @param {string} name */
function freshDataDir(name) {
  const dir = path.join(tmpRoot, `data-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** @param {string} name */
function freshWorkspace(name) {
  const dir = path.join(tmpRoot, `ws-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('memory file is keyed by workspaceKeyFromCwd under data/workspace-memory', () => {
  const dataDir = freshDataDir('key');
  const ws = freshWorkspace('key');
  const entry = addWorkspaceMemory(ws, { type: 'decision', key: 'stack', value: 'ESM only' }, { dataDir, now: T0 });
  const filePath = path.join(dataDir, 'workspace-memory', `${workspaceKeyFromCwd(ws)}.json`);
  assert.equal(workspaceMemoryKey(ws), workspaceKeyFromCwd(ws));
  assert.ok(fs.existsSync(filePath), 'file lives under data/workspace-memory/<hash>.json');
  const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(doc.v, 1);
  assert.equal(doc.revision, 1);
  assert.equal(doc.entries.length, 1);
  assert.equal(doc.entries[0].id, entry.id);
  assert.equal(doc.entries[0].type, 'decision');
  assert.equal(doc.entries[0].expiresAt, '');
});

test('every documented type is accepted and unknown types are rejected', () => {
  const dataDir = freshDataDir('types');
  const ws = freshWorkspace('types');
  for (const type of WORKSPACE_MEMORY_TYPES) {
    addWorkspaceMemory(ws, { type, key: type, value: `value for ${type}` }, { dataDir, now: T0 });
  }
  assert.equal(listWorkspaceMemory(ws, { dataDir, now: T0 }).length, WORKSPACE_MEMORY_TYPES.length);
  assert.throws(
    () => addWorkspaceMemory(ws, { type: 'nope', key: 'k', value: 'v' }, { dataDir, now: T0 }),
    /type must be one of/,
  );
  assert.throws(
    () => addWorkspaceMemory(ws, { type: 'decision', key: '', value: 'v' }, { dataDir, now: T0 }),
    /key is required/,
  );
  assert.throws(
    () => addWorkspaceMemory(ws, { type: 'decision', key: 'k', value: '   ' }, { dataDir, now: T0 }),
    /value is required/,
  );
  assert.throws(
    () => addWorkspaceMemory(ws, { type: 'decision', key: 'k', value: 'v', ttlMs: 0 }, { dataDir, now: T0 }),
    /ttl_ms/,
  );
});

test('list filters by type and returns newest first', () => {
  const dataDir = freshDataDir('filter');
  const ws = freshWorkspace('filter');
  addWorkspaceMemory(ws, { type: 'decision', key: 'd', value: 'v' }, { dataDir, now: T0 });
  addWorkspaceMemory(ws, { type: 'pattern', key: 'p', value: 'v' }, { dataDir, now: T0 + 1_000 });
  addWorkspaceMemory(ws, { type: 'context', key: 'c', value: 'v' }, { dataDir, now: T0 + 2_000 });
  assert.deepEqual(
    listWorkspaceMemory(ws, { dataDir, now: T0 + 3_000 }).map((entry) => entry.type),
    ['context', 'pattern', 'decision'],
  );
  const patterns = listWorkspaceMemory(ws, { dataDir, now: T0 + 3_000, types: ['pattern'] });
  assert.equal(patterns.length, 1);
  assert.equal(patterns[0].key, 'p');
});

test('TTL expires lazily on read and prune removes it from disk', () => {
  const dataDir = freshDataDir('ttl');
  const ws = freshWorkspace('ttl');
  addWorkspaceMemory(ws, { type: 'pattern', key: 'temporary', value: 'v', ttlMs: 1_000 }, { dataDir, now: T0 });
  addWorkspaceMemory(ws, { type: 'decision', key: 'permanent', value: 'v' }, { dataDir, now: T0 });
  assert.equal(listWorkspaceMemory(ws, { dataDir, now: T0 + 500 }).length, 2);
  assert.equal(listWorkspaceMemory(ws, { dataDir, now: T0 + 1_500 }).length, 1);
  // Lazy: the expired row is still on disk until a writer prunes it.
  assert.equal(loadWorkspaceMemoryDocument(ws, { dataDir }).entries.length, 2);
  const pruned = pruneWorkspaceMemory(ws, { dataDir, now: T0 + 1_500 });
  assert.equal(pruned.removed, 1);
  assert.equal(loadWorkspaceMemoryDocument(ws, { dataDir }).entries.length, 1);
});

test('delete removes one entry and is idempotent', () => {
  const dataDir = freshDataDir('delete');
  const ws = freshWorkspace('delete');
  const first = addWorkspaceMemory(ws, { type: 'finding', key: 'f1', value: 'v' }, { dataDir, now: T0 });
  addWorkspaceMemory(ws, { type: 'finding', key: 'f2', value: 'v' }, { dataDir, now: T0 + 1 });
  const removed = deleteWorkspaceMemory(ws, first.id, { dataDir });
  assert.equal(removed.deleted, true);
  assert.equal(removed.entry.id, first.id);
  assert.equal(listWorkspaceMemory(ws, { dataDir, now: T0 }).some((entry) => entry.id === first.id), false);
  assert.equal(deleteWorkspaceMemory(ws, first.id, { dataDir }).deleted, false);
});

test('concurrent writers from several processes never lose an entry', async () => {
  const dataDir = freshDataDir('cas');
  const ws = freshWorkspace('cas');
  const helper = fileURLToPath(new URL('./helpers/workspace-memory-add-child.js', import.meta.url));
  const tags = ['a', 'b', 'c', 'd', 'e', 'f'];
  await Promise.all(tags.map((tag) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper, dataDir, ws, tag, '3'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`child ${tag} exited ${code}: ${stderr}`));
    });
  })));
  const entries = listWorkspaceMemory(ws, { dataDir });
  assert.equal(entries.length, tags.length * 3, 'every concurrent add survived');
  assert.equal(new Set(entries.map((entry) => entry.key)).size, tags.length * 3);
  assert.equal(loadWorkspaceMemoryDocument(ws, { dataDir }).revision, tags.length * 3);
});

test('concurrent writers to one key converge on a single updated entry', async () => {
  const dataDir = freshDataDir('cas-upsert');
  const ws = freshWorkspace('cas-upsert');
  const helper = fileURLToPath(new URL('./helpers/workspace-memory-add-child.js', import.meta.url));
  const sharedKey = buildTodoBlockerKey('t-concurrent', 'quota');
  const tags = ['a', 'b', 'c', 'd'];
  await Promise.all(tags.map((tag) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper, dataDir, ws, tag, '4', sharedKey], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`child ${tag} exited ${code}: ${stderr}`));
    });
  })));
  const entries = listWorkspaceMemory(ws, { dataDir });
  assert.equal(entries.length, 1, 'all concurrent upserts collapse into one row');
  assert.equal(entries[0].key, sharedKey);
  assert.ok(entries[0].expiresAt, 'the recognized transient blocker keeps its default TTL');
});

test('memory prompt block is ordered, capped and empty-safe', () => {
  assert.equal(buildWorkspaceMemoryPromptBlock([]), '');
  assert.equal(buildWorkspaceMemoryPromptBlock([
    { type: 'decision', key: 'expired', value: 'gone', expiresAt: new Date(T0 - 1_000).toISOString() },
  ], { now: T0 }), '');

  const many = [];
  for (let i = 0; i < 200; i += 1) {
    many.push({ type: 'context', key: `k${i}`, value: 'x'.repeat(500), createdAt: new Date(T0 + i).toISOString() });
  }
  many.push({ type: 'blocker', key: 'must-see', value: 'external API down', createdAt: new Date(T0).toISOString() });
  const block = buildWorkspaceMemoryPromptBlock(many, { now: T0 + 1_000_000 });
  assert.match(block, /^WORKSPACE MEMORY/);
  assert.match(block, /\[blocker\] must-see/);
  assert.ok(block.length <= WORKSPACE_MEMORY_PROMPT_CHAR_BUDGET, `block length ${block.length} exceeds the budget`);
});

test('cycle prompt carries the WORKSPACE MEMORY section and the recording instruction', () => {
  const prompt = buildWorkspaceWatcherCyclePrompt({
    workspaceFolder: '/w',
    watcher: { policy: { requirePlanApproval: false } },
    decision: { kind: 'start_cycle' },
    todo: { id: 't1', title: 'Do me' },
    orchestrator: {},
    memory: [{ type: 'decision', key: 'stack', value: 'use ESM, not CJS', createdAt: new Date(T0).toISOString() }],
  });
  assert.match(prompt, /WORKSPACE MEMORY/);
  assert.match(prompt, /\[decision\] stack: use ESM, not CJS/);
  assert.match(prompt, /wmem_add/);
  assert.match(prompt, /ttl_ms/);
});

test('MCP tools add/list/delete and honor plan-mode gating', async () => {
  const dataDir = freshDataDir('mcp');
  const ws = freshWorkspace('mcp');
  setBuiltinMcpRuntimeDeps({ dataDir });
  const handlers = createCretliMcpToolHandlers({}, { chatId: 'chat-memory', mode: 'agent' });

  const addResult = await handlers.wmem_add({
    type: 'blocker',
    key: 'b1',
    value: 'waiting on the external API',
    workspace_folder: ws,
  });
  assert.notEqual(addResult.isError, true);
  const id = addResult.structuredContent.entry.id;
  assert.ok(id);

  const listResult = await handlers.wmem_list({
    workspace_folder: ws,
    types: ['blocker'],
    limit: 1,
  });
  assert.equal(listResult.structuredContent.items.length, 1);
  assert.equal(listResult.structuredContent.items[0].key, 'b1');
  assert.equal(listResult.structuredContent.total, 1);

  const badTypes = await handlers.wmem_list({ workspace_folder: ws, types: ['nope'] });
  assert.equal(badTypes.isError, true);

  const deleteResult = await handlers.wmem_delete({ id, workspace_folder: ws });
  assert.equal(deleteResult.structuredContent.deleted, true);
  const missingResult = await handlers.wmem_delete({ id, workspace_folder: ws });
  assert.equal(missingResult.isError, true);
  assert.equal(missingResult.structuredContent.code, 'NOT_FOUND');

  const planHandlers = createCretliMcpToolHandlers({}, { chatId: 'chat-memory', mode: 'plan' });
  const denied = await planHandlers.wmem_add({
    type: 'context',
    key: 'x',
    value: 'y',
    workspace_folder: ws,
  });
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.code, 'PLAN_MODE_DENIED');
  // The read tool stays available in Plan mode (Scout-safe).
  const planList = await planHandlers.wmem_list({ workspace_folder: ws });
  assert.notEqual(planList.isError, true);
});

test('MCP list paginates with a cursor', async () => {
  const dataDir = freshDataDir('page');
  const ws = freshWorkspace('page');
  setBuiltinMcpRuntimeDeps({ dataDir });
  const handlers = createCretliMcpToolHandlers({}, { chatId: 'chat-memory', mode: 'agent' });
  for (let i = 0; i < 5; i += 1) {
    await handlers.wmem_add({ type: 'context', key: `k${i}`, value: 'v', workspace_folder: ws });
  }
  const page1 = await handlers.wmem_list({ workspace_folder: ws, limit: 2 });
  assert.equal(page1.structuredContent.items.length, 2);
  assert.ok(page1.structuredContent.next_cursor);
  const page2 = await handlers.wmem_list({
    workspace_folder: ws,
    limit: 2,
    cursor: page1.structuredContent.next_cursor,
  });
  assert.equal(page2.structuredContent.items.length, 2);
  const ids = new Set([...page1.structuredContent.items, ...page2.structuredContent.items].map((item) => item.id));
  assert.equal(ids.size, 4);
  assert.equal(page1.structuredContent.total, 5);
});

/** @param {number} ms */
function iso(ms) {
  return new Date(ms).toISOString();
}

test('blocker key convention round-trips todo/harness scope, models and causes', () => {
  const todoKey = buildTodoBlockerKey('a461fced-61f0-4a75-9c28-9573974b7669', 'quota');
  assert.equal(todoKey, 'blocker:todo:a461fced-61f0-4a75-9c28-9573974b7669:quota');
  assert.deepEqual(parseBlockerKey(todoKey), {
    scope: 'todo',
    todoId: 'a461fced-61f0-4a75-9c28-9573974b7669',
    cause: 'quota',
    identity: todoKey,
  });
  assert.equal(buildTodoBlockerKey('', 'quota'), '');
  assert.equal(buildTodoBlockerKey('t', ''), '');

  const harnessKey = buildHarnessBlockerKey('deepseek', 'model:x/y', 'model_unavailable');
  assert.equal(harnessKey, 'blocker:harness:deepseek:model%3Ax%2Fy:model_unavailable');
  const parsedHarness = parseBlockerKey(harnessKey);
  assert.equal(parsedHarness.scope, 'harness');
  assert.equal(parsedHarness.harness, 'deepseek');
  assert.equal(parsedHarness.model, 'model:x/y');
  assert.equal(parsedHarness.cause, 'model_unavailable');
  assert.equal(buildHarnessBlockerKey('deepseek', null, 'quota'), 'blocker:harness:deepseek:*:quota');
  assert.equal(parseBlockerKey('blocker:harness:deepseek:*:quota').model, '');

  assert.equal(parseBlockerKey('some free-form key'), null);
  assert.equal(parseBlockerKey('blocker:todo:only-two'), null);
  assert.equal(parseBlockerKey('blocker:unknown:x:y'), null);
  assert.equal(normalizeMemoryKey('  blocker:todo:t:quota  '), 'blocker:todo:t:quota');

  assert.equal(isTransientBlockerCause('quota'), true);
  assert.equal(isTransientBlockerCause('rate_limit'), true);
  assert.equal(isTransientBlockerCause('slot_busy'), true);
  assert.equal(isTransientBlockerCause('model_unavailable'), true);
  assert.equal(isTransientBlockerCause('bad_code'), false);

  // Dedup identity separates causes of one todo and models of one harness, while
  // a legacy key falls back to type + exact key.
  assert.notEqual(
    memoryEntryDedupKey({ type: 'blocker', key: buildTodoBlockerKey('t', 'quota') }),
    memoryEntryDedupKey({ type: 'blocker', key: buildTodoBlockerKey('t', 'rate_limit') }),
  );
  assert.notEqual(
    memoryEntryDedupKey({ type: 'blocker', key: buildHarnessBlockerKey('h', 'm1', 'quota') }),
    memoryEntryDedupKey({ type: 'blocker', key: buildHarnessBlockerKey('h', 'm2', 'quota') }),
  );
  assert.equal(memoryEntryDedupKey({ type: 'blocker', key: 'legacy thing' }), 'blocker:legacy thing');
});

test('memory block prioritizes the current todo, then ancestors, then plan target', () => {
  const entries = [
    { id: 'ctx', type: 'context', key: 'general', value: 'nothing relevant here', createdAt: iso(T0 + 10) },
    { id: 'sibling', type: 'decision', key: 'other todo', value: 'mentions deadbeef01 somewhere', createdAt: iso(T0 + 9) },
    { id: 'target', type: 'finding', key: 'plan target note', value: 'plan target aaaaaaaa1111 context', createdAt: iso(T0 + 8) },
    { id: 'anc', type: 'decision', key: 'ancestor note', value: 'ancestor bbbbbbbb2222 decision', createdAt: iso(T0 + 7) },
    { id: 'cur', type: 'blocker', key: 'current note', value: 'current cccccccc3333 blocker', createdAt: iso(T0 + 6) },
  ];
  const block = buildWorkspaceMemoryPromptBlock(entries, {
    now: T0 + 1_000,
    todoIds: ['cccccccc3333', 'bbbbbbbb2222', 'aaaaaaaa1111'],
  });
  const lines = block.split('\n');
  assert.match(lines[1], /current cccccccc3333/, 'current todo fact comes first');
  assert.match(lines[2], /ancestor bbbbbbbb2222/, 'ancestor fact comes next');
  assert.match(lines[3], /plan target aaaaaaaa1111/, 'plan target fact comes before unrelated facts');
});

test('memory identifier matching honors word boundaries and the 8-char prefix', () => {
  const full = 'a461fced-61f0-4a75-9c28-9573974b7669';
  const entries = [
    { id: 'a', type: 'context', key: 'k-a', value: 'ref deadbeef here', createdAt: iso(T0) },
    { id: 'b', type: 'context', key: 'k-b', value: 'inside deadbeef01cafe no match', createdAt: iso(T0) },
    { id: 'c', type: 'context', key: 'k-c', value: `full ${full} here`, createdAt: iso(T0) },
    { id: 'd', type: 'context', key: 'k-d', value: 'short a461fced ref', createdAt: iso(T0) },
  ];
  const prefixBlock = buildWorkspaceMemoryPromptBlock(entries, { now: T0 + 10, todoIds: ['deadbeef'] });
  const prefixLines = prefixBlock.split('\n').filter((line) => line.startsWith('- ['));
  assert.match(prefixLines[0], /ref deadbeef here/, 'only the boundary match is promoted');
  assert.equal(prefixLines.length, 4, 'non-matching facts stay as lower-priority context');

  const insideBlock = buildWorkspaceMemoryPromptBlock(entries, { now: T0 + 10, todoIds: ['deadbeef01cafe'] });
  const insideLines = insideBlock.split('\n').filter((line) => line.startsWith('- ['));
  assert.match(insideLines[0], /inside deadbeef01cafe no match/, 'a longer identifier matches as a whole');

  const fullBlock = buildWorkspaceMemoryPromptBlock(entries, { now: T0 + 10, todoIds: [full] });
  const fullLines = fullBlock.split('\n').filter((line) => line.startsWith('- ['));
  assert.match(fullLines[0], /full a461fced/, 'the full uuid matches');
  assert.match(fullLines[1], /short a461fced ref/, 'the 8-char prefix of the full id matches too');
});

test('memory block dedups topics, keeps distinct causes and uses updatedAt with fallback', () => {
  const entries = [
    { id: 'q1', type: 'blocker', key: buildTodoBlockerKey('t', 'quota'), value: 'quota old', createdAt: iso(T0), updatedAt: iso(T0) },
    { id: 'q2', type: 'blocker', key: buildTodoBlockerKey('t', 'quota'), value: 'quota new', createdAt: iso(T0 + 5), updatedAt: iso(T0 + 5) },
    { id: 'r1', type: 'blocker', key: buildTodoBlockerKey('t', 'rate_limit'), value: 'rate limited', createdAt: iso(T0 + 6) },
    { id: 'd1', type: 'decision', key: 'stack', value: 'old decision', createdAt: iso(T0 + 1) },
    // updatedAt is newer than createdAt and must win.
    { id: 'd2', type: 'decision', key: 'stack', value: 'new decision', createdAt: iso(T0 + 2), updatedAt: iso(T0 + 9) },
  ];
  const block = buildWorkspaceMemoryPromptBlock(entries, { now: T0 + 1_000, todoIds: ['t'] });
  assert.match(block, /quota new/);
  assert.doesNotMatch(block, /quota old/);
  assert.match(block, /rate limited/, 'a different cause of the same todo stays');
  assert.match(block, /new decision/);
  assert.doesNotMatch(block, /old decision/);
});

test('memory block tie-breaks equal timestamps deterministically', () => {
  const entries = [
    { id: 'aa', type: 'decision', key: 'same', value: 'from aa', createdAt: iso(T0), updatedAt: iso(T0) },
    { id: 'bb', type: 'decision', key: 'same', value: 'from bb', createdAt: iso(T0), updatedAt: iso(T0) },
  ];
  const first = buildWorkspaceMemoryPromptBlock(entries, { now: T0 + 10 });
  const second = buildWorkspaceMemoryPromptBlock([...entries].reverse(), { now: T0 + 10 });
  assert.equal(first, second, 'input order does not change the tie-break');
  assert.match(first, /from bb/, 'higher id wins the stable tie-break');
  assert.doesNotMatch(first, /from aa/);
});

test('memory block caps entries, whole section size and truncates at a boundary', () => {
  const entries = [];
  for (let i = 0; i < 20; i += 1) {
    entries.push({ id: `e${i}`, type: 'context', key: `k${i}`, value: 'x'.repeat(500), createdAt: iso(T0 + i) });
  }
  const block = buildWorkspaceMemoryPromptBlock(entries, { now: T0 + 10_000 });
  assert.ok(block.length <= WORKSPACE_MEMORY_PROMPT_CHAR_BUDGET, `section length ${block.length}`);
  assert.equal(block.split('\n').filter((line) => line.startsWith('- [')).length, WORKSPACE_MEMORY_PROMPT_ENTRY_LIMIT);
  assert.match(block, /fact\(s\) omitted/);
  assert.match(block, /wmem_list/);
  assert.match(block, /…$|…\s|…\n/im, 'a truncated value is marked with an ellipsis');
});

test('memory block truncates at a sentence end when one fits', () => {
  const longSentence = 'First sentence explains the cause. Second sentence carries the recommendation that must survive when possible.';
  const block = buildWorkspaceMemoryPromptBlock([
    { id: 's', type: 'decision', key: 'sentence', value: longSentence, createdAt: iso(T0) },
  ], { now: T0 + 10, maxChars: 220 });
  assert.match(block, /First sentence explains the cause\.…/);
});

test('memory block drops expired entries and skips a too-small section', () => {
  const expired = [{ id: 'e', type: 'decision', key: 'k', value: 'v', createdAt: iso(T0), expiresAt: iso(T0 - 1) }];
  assert.equal(buildWorkspaceMemoryPromptBlock(expired, { now: T0 }), '');

  const live = [{ id: 'l', type: 'decision', key: 'k', value: 'v'.repeat(500), createdAt: iso(T0) }];
  const header = 'WORKSPACE MEMORY (durable facts from earlier cycles — treat as prior decisions; do not redo them):';
  assert.equal(buildWorkspaceMemoryPromptBlock(live, { now: T0, maxChars: header.length }), '');
  assert.equal(buildWorkspaceMemoryPromptBlock(live, { now: T0, maxChars: header.length + 5 }), '');
  const tiny = buildWorkspaceMemoryPromptBlock(live, { now: T0, maxChars: header.length + 60 });
  assert.ok(tiny.length <= header.length + 60, `tiny section ${tiny.length}`);
  assert.match(tiny, /…/, 'a tiny budget still marks the cut');
});

test('historical cycle fixture: memory section stays under 3000 chars and keeps the todo blocker', () => {
  const fixturePath = fileURLToPath(new URL('./fixtures/workspace-memory-cycle-fixture.json', import.meta.url));
  const entries = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const todoId = 'a461fced-61f0-4a75-9c28-9573974b7669';
  const ancestorId = 'bbbbbbbb-2222-4333-8444-555555555555';
  const block = buildWorkspaceMemoryPromptBlock(entries, {
    now: Date.parse('2026-02-03T00:00:00.000Z'),
    todoIds: [todoId, ancestorId],
  });
  assert.ok(block.length < 3000, `historical memory section was ${block.length}`);
  assert.ok(block.length <= WORKSPACE_MEMORY_PROMPT_CHAR_BUDGET);
  assert.match(block, new RegExp(todoId), 'the todo blocker is present');
  assert.match(block, /newest observation/, 'only the newest duplicate blocker is rendered');
  assert.doesNotMatch(block, /Cycle 20 blocked/);
  assert.doesNotMatch(block, /Cycle 21 blocked/);
  assert.match(block, /rate_limit/, 'a different cause of the same todo stays');
  assert.ok(
    block.split('\n').filter((line) => line.startsWith('- [')).length <= WORKSPACE_MEMORY_PROMPT_ENTRY_LIMIT,
  );
});

test('cycle prompt plan respects the whole-prompt budget and section allocation', () => {
  const many = [];
  for (let i = 0; i < 40; i += 1) {
    many.push({ id: `m${i}`, type: 'context', key: `k${i}`, value: 'y'.repeat(400), createdAt: iso(T0 + i) });
  }
  const chats = [];
  for (let i = 0; i < 40; i += 1) {
    chats.push({ id: `chat-${i}`, todoIds: ['t1'], at: iso(T0), outcome: 'success' });
  }
  const plan = buildWorkspaceWatcherCyclePromptPlan({
    workspaceFolder: '/w',
    watcher: { policy: { requirePlanApproval: true }, cycleChats: chats },
    decision: { kind: 'start_cycle' },
    todo: { id: 't1', title: 'Do me' },
    orchestrator: {},
    previousChats: chats,
    memory: many,
    todoIds: ['t1'],
    cycleId: 'cycle-budget',
  });
  assert.equal(plan.tooLong, false);
  assert.ok(plan.contractChars <= WORKSPACE_WATCHER_PROMPT_CHAR_BUDGET);
  assert.ok(plan.promptLength <= WORKSPACE_WATCHER_PROMPT_CHAR_BUDGET, `prompt ${plan.promptLength}`);
  assert.ok(plan.historyChars <= WORKSPACE_WATCHER_PROMPT_HISTORY_CHAR_BUDGET, `history ${plan.historyChars}`);
  assert.ok(plan.memoryChars <= WORKSPACE_MEMORY_PROMPT_CHAR_BUDGET, `memory ${plan.memoryChars}`);
  // Older sessions are summarized, not silently dropped.
  assert.match(plan.prompt, /omitted/);
});

test('cycle prompt plan reports tooLong without honoring an impossible budget', () => {
  const plan = buildWorkspaceWatcherCyclePromptPlan({
    workspaceFolder: '/w',
    watcher: { policy: { requirePlanApproval: true } },
    decision: { kind: 'start_cycle' },
    todo: { id: 't1', title: 'Do me' },
    orchestrator: {},
    maxChars: 50,
  });
  assert.equal(plan.tooLong, true);
  assert.match(plan.prompt, /MCP contract \(blocking precondition\)/, 'the full contract is returned, not a shortened one');
  assert.ok(plan.prompt.length > 50);
});

test('cycle prompt budget holds for plan-only and both implement variants with saturated sections', () => {
  const many = [];
  for (let i = 0; i < 60; i += 1) {
    many.push({
      id: `m${i}`,
      type: i % 3 === 0 ? 'blocker' : 'context',
      key: `k${i}`,
      value: `${'z'.repeat(500)} recommendation sentence ${i}.`,
      createdAt: iso(T0 + i),
      updatedAt: iso(T0 + i),
    });
  }
  const chats = [];
  for (let i = 0; i < 60; i += 1) chats.push({ id: `chat-${i}`, todoIds: ['t1'], at: iso(T0), outcome: 'success' });
  const variants = [
    { name: 'plan-only', policy: { requirePlanApproval: true }, decision: { kind: 'plan_gate', planOnly: true } },
    { name: 'implement-gated', policy: { requirePlanApproval: true }, decision: { kind: 'start_cycle' } },
    { name: 'implement-ungated', policy: { requirePlanApproval: false }, decision: { kind: 'start_cycle' } },
  ];
  for (const variant of variants) {
    const input = {
      workspaceFolder: '/w',
      watcher: { policy: variant.policy, cycleChats: chats },
      decision: variant.decision,
      todo: { id: 't1', title: 'Do me' },
      orchestrator: {},
      previousChats: chats,
      memory: many,
      todoIds: ['t1'],
      cycleId: `cycle-${variant.name}`,
    };
    const plan = buildWorkspaceWatcherCyclePromptPlan(input);
    assert.equal(plan.tooLong, false, `${variant.name} contract fits`);
    assert.ok(plan.promptLength <= WORKSPACE_WATCHER_PROMPT_CHAR_BUDGET, `${variant.name} prompt ${plan.promptLength}`);
    assert.ok(plan.historyChars <= WORKSPACE_WATCHER_PROMPT_HISTORY_CHAR_BUDGET, `${variant.name} history ${plan.historyChars}`);
    assert.ok(plan.memoryChars <= WORKSPACE_MEMORY_PROMPT_CHAR_BUDGET, `${variant.name} memory ${plan.memoryChars}`);
    // Sections plus the two blank-line separators can never exceed the cap.
    assert.ok(plan.contractChars + plan.historyChars + plan.memoryChars + 4 <= WORKSPACE_WATCHER_PROMPT_CHAR_BUDGET);
    assert.match(plan.prompt, /WORKSPACE MEMORY/, `${variant.name} keeps the memory section`);
    assert.match(plan.prompt, /PREVIOUS CYCLES/, `${variant.name} keeps the history section`);
    // Deterministic allocation: the same input yields the same prompt.
    const again = buildWorkspaceWatcherCyclePromptPlan({ ...input });
    assert.equal(again.prompt, plan.prompt, `${variant.name} allocation is deterministic`);
    assert.equal(again.promptLength, plan.promptLength);
  }
});

/**
 * Extract rendered previous-cycle ids in display order, so ordering assertions
 * do not depend on the surrounding prose.
 *
 * @param {string} block
 * @returns {string[]}
 */
function previousCycleRowIds(block) {
  return [...block.matchAll(/^- (?:\[relevance\] )?([^\s]+) · todo=/gm)].map((match) => match[1]);
}

test('previous cycles block sorts unsorted input by close time with invalid dates last', () => {
  const rows = [
    { id: 'mid', todoIds: ['x'], at: iso(T0 + 2_000) },
    { id: 'no-date', todoIds: ['x'] },
    { id: 'newest', todoIds: ['x'], at: iso(T0 + 5_000) },
    { id: 'bad-date', todoIds: ['x'], at: 'not-a-date' },
    { id: 'oldest', todoIds: ['x'], at: iso(T0) },
  ];
  const block = buildWorkspaceWatcherPreviousChatsBlock(rows, { todoIds: ['x'] });
  assert.deepEqual(
    previousCycleRowIds(block),
    ['newest', 'mid', 'oldest', 'no-date', 'bad-date'],
    'valid close times descend; missing/invalid dates go last',
  );
  // Reversing the input must not change the rendered order (deterministic ties).
  const reversed = buildWorkspaceWatcherPreviousChatsBlock([...rows].reverse(), { todoIds: ['x'] });
  assert.deepEqual(previousCycleRowIds(reversed), previousCycleRowIds(block));
});

test('previous cycles block keeps every relevant cycle, caps the rest and dedupes chats', () => {
  const current = 'aaaaaaaa-1111-4111-8111-111111111111';
  const ancestor = 'bbbbbbbb-2222-4222-8222-222222222222';
  const chats = [
    { id: 'dup', todoIds: [current], at: iso(T0 + 1) },
    { id: 'dup', todoIds: [current], at: iso(T0 + 90_000) },
    { id: 'rel-current', todoIds: [current], at: iso(T0 + 10) },
    { id: 'rel-ancestor', todoIds: [ancestor], at: iso(T0 + 9) },
    { id: 'rest-1', todoIds: ['other-1'], at: iso(T0 + 100) },
    { id: 'rest-2', todoIds: ['other-2'], at: iso(T0 + 99) },
    { id: 'rest-3', todoIds: ['other-3'], at: iso(T0 + 98) },
    { id: 'rest-4', todoIds: ['other-4'], at: iso(T0 + 97) },
  ];
  const block = buildWorkspaceWatcherPreviousChatsBlock(chats, { todoIds: [current, ancestor] });
  const ids = previousCycleRowIds(block);
  assert.equal(new Set(ids).size, ids.length, 'a repeated chat id renders once');
  assert.equal(ids.filter((id) => id === 'dup').length, 1);
  assert.ok(ids.includes('rel-current') && ids.includes('rel-ancestor'));
  assert.ok(ids.includes('rest-1') && ids.includes('rest-2') && ids.includes('rest-3'));
  assert.ok(!ids.includes('rest-4'), 'only the three newest unrelated cycles are kept');
  assert.equal(ids.length, 6);
  assert.match(block, /- \[relevance\] rel-current/);
  assert.match(block, /- \[relevance\] rel-ancestor/);
  assert.doesNotMatch(block, /- \[relevance\] rest-1/);
  assert.match(block, /\(1 older\/lower-priority previous cycle\(s\) omitted/, 'the dropped rest row is reported');
});

test('previous cycles section keeps the omission footer inside its budget', () => {
  const chats = [];
  for (let i = 0; i < 20; i += 1) {
    chats.push({ id: `chat-${String(i).padStart(2, '0')}`, todoIds: ['t1'], at: iso(T0 + i * 1_000), outcome: 'success' });
  }
  const block = buildWorkspaceWatcherPreviousChatsBlock(chats, { maxChars: 520, todoIds: ['t1'] });
  assert.ok(block.length <= 520, `history block ${block.length} exceeds its budget`);
  assert.match(block, /omitted/, 'the mandatory footer survives the trim');
  assert.match(block, /chat_show/);
  // A budget that cannot hold the header plus one row drops the section
  // instead of overflowing or emitting a footer-only stub.
  assert.equal(buildWorkspaceWatcherPreviousChatsBlock(chats, { maxChars: 40, todoIds: ['t1'] }), '');
});

test('cycle prompt renders usage limits with their harness/model scope and a separate allow-list', () => {
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const past = new Date(Date.now() - 3_600_000).toISOString();
  const prompt = buildWorkspaceWatcherCyclePrompt({
    workspaceFolder: '/w',
    watcher: { policy: { requirePlanApproval: false, allowedHarnesses: ['mock'] }, cycleChats: [] },
    decision: { kind: 'start_cycle' },
    todo: { id: 't1', title: 'Do me' },
    orchestrator: { harness: 'mock', model: 'cheap', source: 'policy' },
    activeUsageLimits: [
      { harness: 'mock', model: 'cheap', resetAt: future },
      { harness: 'opencode', resetAt: future },
      { harness: 'expired', resetAt: past },
    ],
  });
  const limitLine = prompt.split('\n').find((line) => line.includes('usage limits'));
  assert.ok(limitLine, 'the prompt carries a usage-limit line');
  assert.match(limitLine, /mock:cheap/, 'a model-scoped limit keeps its harness:model scope');
  assert.doesNotMatch(limitLine, /mock(?!:)/, 'a model-scoped limit is never shown as a whole-harness ban');
  assert.match(limitLine, /(^|[^:a-z])opencode($|[^:a-z])/, 'a whole-harness limit stays bare');
  assert.doesNotMatch(limitLine, /expired/, 'an expired limit is not presented as active');
  assert.match(prompt, /Allowed harnesses: mock/, 'the allow-list stays a separate constraint');
});

test('cycle prompt integration: relevance, omissions, deterministic allocation and intact contract', () => {
  const current = 'aaaaaaaa-1111-4111-8111-111111111111';
  const ancestor = 'bbbbbbbb-2222-4222-8222-222222222222';
  const chats = [];
  for (let i = 0; i < 30; i += 1) {
    chats.push({
      id: `old-${String(i).padStart(2, '0')}`,
      todoIds: [`dddddddd-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`],
      at: iso(T0 + i),
      outcome: 'success',
    });
  }
  // Relevant cycles are the newest, so the oldest irrelevant ones are what the
  // budget drops first.
  chats.push({ id: 'rel-current', todoIds: [current], at: iso(T0 + 1_000_000), outcome: 'failure' });
  chats.push({ id: 'rel-ancestor', todoIds: [ancestor], at: iso(T0 + 999_999), outcome: 'success' });
  const memory = [];
  for (let i = 0; i < 60; i += 1) {
    memory.push({
      id: `m${i}`,
      type: 'context',
      key: `k${i}`,
      value: `${'z'.repeat(400)} recommendation sentence ${i}.`,
      createdAt: iso(T0 + i),
      updatedAt: iso(T0 + i),
    });
  }
  const variants = [
    { name: 'plan-only', policy: { requirePlanApproval: true, allowedHarnesses: ['mock'] }, decision: { kind: 'plan_gate', planOnly: true } },
    { name: 'implement-gated', policy: { requirePlanApproval: true, allowedHarnesses: ['mock'] }, decision: { kind: 'start_cycle' } },
    { name: 'implement-ungated', policy: { requirePlanApproval: false, allowedHarnesses: ['mock'] }, decision: { kind: 'start_cycle' } },
  ];
  for (const variant of variants) {
    const input = {
      workspaceFolder: `/w/${'x'.repeat(80)}`,
      watcher: { policy: variant.policy, cycleChats: chats },
      decision: variant.decision,
      todo: { id: current, title: `Do me ${'t'.repeat(120)}` },
      orchestrator: { harness: 'mock', model: 'cheap', source: 'policy' },
      activeUsageLimits: [{ harness: 'opencode', resetAt: new Date(Date.now() + 3_600_000).toISOString() }],
      previousChats: chats,
      memory,
      todoIds: [current, ancestor],
      cycleId: `cycle-${variant.name}`,
    };
    const plan = buildWorkspaceWatcherCyclePromptPlan(input);
    assert.equal(plan.tooLong, false, `${variant.name} contract fits`);
    assert.ok(plan.promptLength <= WORKSPACE_WATCHER_PROMPT_CHAR_BUDGET, `${variant.name} prompt ${plan.promptLength}`);
    assert.ok(plan.historyChars <= WORKSPACE_WATCHER_PROMPT_HISTORY_CHAR_BUDGET, `${variant.name} history ${plan.historyChars}`);
    assert.ok(plan.memoryChars <= WORKSPACE_MEMORY_PROMPT_CHAR_BUDGET, `${variant.name} memory ${plan.memoryChars}`);
    // The fixed contract survives untouched.
    assert.match(plan.prompt, /MCP contract \(blocking precondition\)/, `${variant.name} contract intact`);
    assert.match(plan.prompt, /action "report"/, `${variant.name} report contract intact`);
    assert.match(plan.prompt, /cretli-ref todo=/);
    // Relevance and omissions are visible in the full prompt.
    assert.match(plan.prompt, /PREVIOUS CYCLES/);
    assert.match(plan.prompt, /\[relevance\] rel-current/);
    assert.match(plan.prompt, /\[relevance\] rel-ancestor/);
    assert.match(plan.prompt, /omitted/, `${variant.name} reports omitted history`);
    assert.match(plan.prompt, /WORKSPACE MEMORY/, `${variant.name} keeps the memory section`);
    assert.match(plan.prompt, /opencode/, `${variant.name} keeps the scoped usage limit`);
    // Deterministic allocation: the same input yields the same prompt.
    const again = buildWorkspaceWatcherCyclePromptPlan({ ...input });
    assert.equal(again.prompt, plan.prompt, `${variant.name} allocation is deterministic`);
  }
});

test('transient blocker keys default to a 24 h TTL, explicit TTL/permanent win, unknown keys stay permanent', () => {
  const dataDir = freshDataDir('ttl-rules');
  const ws = freshWorkspace('ttl-rules');
  const expected = new Date(T0 + WORKSPACE_MEMORY_DEFAULT_TRANSIENT_BLOCKER_TTL_MS).toISOString();
  for (const cause of ['quota', 'rate_limit', 'slot_busy', 'model_unavailable']) {
    const entry = addWorkspaceMemory(ws, {
      type: 'blocker',
      key: buildTodoBlockerKey(`todo-${cause}`, cause),
      value: `blocked by ${cause}`,
    }, { dataDir, now: T0 });
    assert.equal(entry.expiresAt, expected, `${cause} gets the default TTL`);
  }
  const harness = addWorkspaceMemory(ws, {
    type: 'blocker',
    key: buildHarnessBlockerKey('deepseek', 'model-x', 'quota'),
    value: 'harness quota',
  }, { dataDir, now: T0 });
  assert.equal(harness.expiresAt, expected);

  const explicit = addWorkspaceMemory(ws, {
    type: 'blocker',
    key: buildTodoBlockerKey('t-explicit', 'quota'),
    value: 'explicit',
    ttlMs: 60_000,
  }, { dataDir, now: T0 });
  assert.equal(explicit.expiresAt, new Date(T0 + 60_000).toISOString(), 'explicit TTL wins over the default');

  const permanent = addWorkspaceMemory(ws, {
    type: 'blocker',
    key: buildTodoBlockerKey('t-permanent', 'quota'),
    value: 'permanent quota',
    permanent: true,
  }, { dataDir, now: T0 });
  assert.equal(permanent.expiresAt, '', 'permanent:true overrides the transient default');

  const unknownCause = addWorkspaceMemory(ws, {
    type: 'blocker',
    key: buildTodoBlockerKey('t-unknown', 'bad_code'),
    value: 'broken code',
  }, { dataDir, now: T0 });
  assert.equal(unknownCause.expiresAt, '', 'an unknown cause stays permanent');
  const legacy = addWorkspaceMemory(ws, { type: 'blocker', key: 'waiting on the vendor', value: 'legacy' }, { dataDir, now: T0 });
  assert.equal(legacy.expiresAt, '', 'a legacy free-form key stays permanent');
  const note = addWorkspaceMemory(ws, { type: 'context', key: 'note', value: 'note' }, { dataDir, now: T0 });
  assert.equal(note.expiresAt, '', 'a non-blocker fact stays permanent');

  assert.throws(
    () => addWorkspaceMemory(ws, {
      type: 'blocker', key: buildTodoBlockerKey('t', 'quota'), value: 'x', permanent: true, ttlMs: 1,
    }, { dataDir, now: T0 }),
    /permanent and ttl_ms/,
  );
  assert.throws(
    () => addWorkspaceMemory(ws, { type: 'context', key: 'k', value: 'v', ttlMs: 0 }, { dataDir, now: T0 }),
    /ttl_ms/,
  );
  assert.throws(
    () => addWorkspaceMemory(ws, { type: 'context', key: 'k', value: 'v', ttlMs: WORKSPACE_MEMORY_MAX_TTL_MS + 1 }, { dataDir, now: T0 }),
    /ttl_ms/,
  );
});

test('re-writing the same type+key updates in place and collapses historical duplicates', () => {
  const dataDir = freshDataDir('upsert');
  const ws = freshWorkspace('upsert');
  const key = buildTodoBlockerKey('t-upsert', 'quota');
  const first = addWorkspaceMemory(ws, { type: 'blocker', key, value: 'first' }, { dataDir, now: T0 });
  const second = addWorkspaceMemory(ws, { type: 'blocker', key, value: 'second' }, { dataDir, now: T0 + 5_000 });
  assert.equal(second.id, first.id, 'the id is stable across an update');
  assert.equal(second.createdAt, first.createdAt, 'createdAt is preserved');
  assert.equal(second.updatedAt, new Date(T0 + 5_000).toISOString(), 'updatedAt advances');
  assert.equal(second.value, 'second');
  assert.equal(listWorkspaceMemory(ws, { dataDir, now: T0 + 6_000 }).length, 1, 'no duplicate row is appended');

  // Historical rows with the same identity: keep the newest, drop the others.
  const ws2 = freshWorkspace('upsert-history');
  const filePath = path.join(dataDir, 'workspace-memory', `${workspaceKeyFromCwd(ws2)}.json`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({
    v: 1,
    workspaceFolder: ws2,
    updatedAt: iso(T0),
    revision: 1,
    entries: [
      { id: 'oldest', type: 'blocker', key, value: 'oldest', createdAt: iso(T0), updatedAt: iso(T0), expiresAt: '' },
      { id: 'newest', type: 'blocker', key, value: 'newest', createdAt: iso(T0 + 10), updatedAt: iso(T0 + 20), expiresAt: '' },
      { id: 'middle', type: 'blocker', key, value: 'middle', createdAt: iso(T0 + 15), updatedAt: iso(T0 + 15), expiresAt: '' },
      { id: 'other', type: 'decision', key: 'untouched', value: 'keep', createdAt: iso(T0), updatedAt: iso(T0), expiresAt: '' },
    ],
  }));
  const stored = addWorkspaceMemory(ws2, { type: 'blocker', key, value: 'fresh' }, { dataDir, now: T0 + 30_000 });
  assert.equal(stored.id, 'newest', 'the newest historical duplicate is updated');
  assert.equal(stored.createdAt, iso(T0 + 10));
  assert.deepEqual(
    listWorkspaceMemory(ws2, { dataDir, now: T0 + 31_000 }).map((row) => row.id).sort(),
    ['newest', 'other'],
    'only the newest duplicate of the updated identity survives',
  );
});

test('the same key under different types stays two entries and the listing follows updatedAt', () => {
  const dataDir = freshDataDir('identity');
  const ws = freshWorkspace('identity');
  const decision = addWorkspaceMemory(ws, { type: 'decision', key: 'shared', value: 'decision' }, { dataDir, now: T0 });
  const context = addWorkspaceMemory(ws, { type: 'context', key: 'shared', value: 'context' }, { dataDir, now: T0 + 1_000 });
  assert.notEqual(decision.id, context.id);
  addWorkspaceMemory(ws, { type: 'decision', key: 'shared', value: 'decision refreshed' }, { dataDir, now: T0 + 5_000 });
  assert.deepEqual(
    listWorkspaceMemory(ws, { dataDir, now: T0 + 6_000 }).map((row) => `${row.type}:${row.value}`),
    ['decision:decision refreshed', 'context:context'],
    'the refreshed older entry moves to the front',
  );
});

test('the 500-entry cap evicts the least recently updated record, with createdAt fallback and id tie-break', () => {
  const dataDir = freshDataDir('cap');
  /** @param {string} name @param {object[]} entries */
  const seedCap = (name, entries) => {
    const ws = freshWorkspace(name);
    const filePath = path.join(dataDir, 'workspace-memory', `${workspaceKeyFromCwd(ws)}.json`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ v: 1, workspaceFolder: ws, updatedAt: iso(T0), revision: 1, entries }));
    return ws;
  };
  /** @param {(i: number) => string} idOf */
  const capRows = (idOf) => {
    const rows = [];
    for (let i = 0; i < WORKSPACE_MEMORY_MAX_ENTRIES; i += 1) {
      rows.push({
        id: idOf(i),
        type: 'context',
        key: `k-${String(i).padStart(3, '0')}`,
        value: `v${i}`,
        createdAt: iso(T0 + i),
        updatedAt: iso(T0 + i),
        expiresAt: '',
      });
    }
    return rows;
  };
  const paddedId = (i) => `id-${String(i).padStart(3, '0')}`;

  const fallbackWs = seedCap('cap-fallback', capRows(paddedId).map((row) => ({ ...row, updatedAt: '' })));
  addWorkspaceMemory(fallbackWs, { type: 'context', key: 'new', value: 'new' }, { dataDir, now: T0 + 100_000 });
  const fallbackDoc = loadWorkspaceMemoryDocument(fallbackWs, { dataDir });
  assert.equal(fallbackDoc.entries.length, WORKSPACE_MEMORY_MAX_ENTRIES);
  assert.equal(fallbackDoc.entries.some((row) => row.id === 'id-000'), false, 'createdAt fallback picks the oldest');

  const tieWs = seedCap('cap-tie', capRows(paddedId).map((row) => ({ ...row, updatedAt: iso(T0) })));
  addWorkspaceMemory(tieWs, { type: 'context', key: 'new', value: 'new' }, { dataDir, now: T0 + 100_000 });
  const tieDoc = loadWorkspaceMemoryDocument(tieWs, { dataDir });
  assert.equal(tieDoc.entries.some((row) => row.id === 'id-000'), false, 'the lower id loses an exact tie');
  assert.equal(tieDoc.entries.some((row) => row.id === 'id-001'), true);

  const refreshWs = seedCap('cap-refresh', capRows(paddedId));
  addWorkspaceMemory(refreshWs, { type: 'context', key: 'k-000', value: 'refreshed' }, { dataDir, now: T0 + 500_000 });
  addWorkspaceMemory(refreshWs, { type: 'context', key: 'new', value: 'new' }, { dataDir, now: T0 + 500_001 });
  const refreshDoc = loadWorkspaceMemoryDocument(refreshWs, { dataDir });
  assert.equal(refreshDoc.entries.some((row) => row.id === 'id-000'), true, 'a refreshed entry is protected');
  assert.equal(refreshDoc.entries.some((row) => row.id === 'id-001'), false, 'the next oldest leaves instead');
});

test('the scout signal preview sees the 100 most recently updated facts', async () => {
  const { buildScoutSignalsBlock } = await import('../lib/workspace-watcher-scout.js');
  const dataDir = freshDataDir('scout-order');
  const ws = freshWorkspace('scout-order');
  for (let i = 0; i < 100; i += 1) {
    addWorkspaceMemory(ws, {
      type: 'context',
      key: `area-${String(i).padStart(3, '0')}`,
      value: `stale-${String(i).padStart(3, '0')}`,
    }, { dataDir, now: T0 + i });
  }
  // An old entry refreshed late and a genuinely new one must both own the first
  // 100 preview slots; the first stale entry falls out of the window.
  addWorkspaceMemory(ws, { type: 'finding', key: 'fresh-area', value: 'already explored' }, { dataDir, now: T0 + 100_000 });
  addWorkspaceMemory(ws, { type: 'context', key: 'area-000', value: 'refreshed-000' }, { dataDir, now: T0 + 100_001 });
  const block = buildScoutSignalsBlock({ memory: listWorkspaceMemory(ws, { dataDir, now: T0 + 200_000 }) }).join('\n');
  assert.match(block, /refreshed-000/, 'the refreshed old fact is present');
  assert.match(block, /already explored/, 'the new fact is present');
  assert.doesNotMatch(block, /stale-001\b/, 'a stale fact without a refresh falls outside the preview window');
});

test('wmem_add upserts by key and supports permanent transient blockers', async () => {
  const dataDir = freshDataDir('mcp-upsert');
  const ws = freshWorkspace('mcp-upsert');
  setBuiltinMcpRuntimeDeps({ dataDir });
  const handlers = createCretliMcpToolHandlers({}, { chatId: 'chat-memory', mode: 'agent' });
  const key = buildTodoBlockerKey('t1', 'quota');
  const first = await handlers.wmem_add({ type: 'blocker', key, value: 'quota', workspace_folder: ws });
  assert.notEqual(first.isError, true);
  assert.ok(first.structuredContent.entry.expires_at, 'a recognized transient blocker gets the default TTL');
  const second = await handlers.wmem_add({ type: 'blocker', key, value: 'quota again', workspace_folder: ws });
  assert.equal(second.structuredContent.entry.id, first.structuredContent.entry.id, 'the same key updates in place');
  const listed = await handlers.wmem_list({ workspace_folder: ws, types: ['blocker'] });
  assert.equal(listed.structuredContent.total, 1);

  const permanent = await handlers.wmem_add({
    type: 'blocker', key, value: 'permanent quota', permanent: true, workspace_folder: ws,
  });
  assert.equal(permanent.structuredContent.entry.expires_at, '', 'permanent:true clears the default TTL');
  assert.equal(permanent.structuredContent.entry.id, first.structuredContent.entry.id);

  const conflict = await handlers.wmem_add({
    type: 'blocker', key, value: 'x', permanent: true, ttl_ms: 10, workspace_folder: ws,
  });
  assert.equal(conflict.isError, true, 'permanent + ttl_ms is a loud validation error');
});
