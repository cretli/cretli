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
  WORKSPACE_MEMORY_PROMPT_CHAR_BUDGET,
} from '../lib/workspace-watcher-prompt.js';
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
  assert.match(prompt, /workspace_memory_add/);
  assert.match(prompt, /ttl_ms/);
});

test('MCP tools add/list/delete and honor plan-mode gating', async () => {
  const dataDir = freshDataDir('mcp');
  const ws = freshWorkspace('mcp');
  setBuiltinMcpRuntimeDeps({ dataDir });
  const handlers = createCretliMcpToolHandlers({}, { chatId: 'chat-memory', mode: 'agent' });

  const addResult = await handlers.workspace_memory_add({
    type: 'blocker',
    key: 'b1',
    value: 'waiting on the external API',
    workspace_folder: ws,
  });
  assert.notEqual(addResult.isError, true);
  const id = addResult.structuredContent.entry.id;
  assert.ok(id);

  const listResult = await handlers.workspace_memory_list({
    workspace_folder: ws,
    types: ['blocker'],
    limit: 1,
  });
  assert.equal(listResult.structuredContent.items.length, 1);
  assert.equal(listResult.structuredContent.items[0].key, 'b1');
  assert.equal(listResult.structuredContent.total, 1);

  const badTypes = await handlers.workspace_memory_list({ workspace_folder: ws, types: ['nope'] });
  assert.equal(badTypes.isError, true);

  const deleteResult = await handlers.workspace_memory_delete({ id, workspace_folder: ws });
  assert.equal(deleteResult.structuredContent.deleted, true);
  const missingResult = await handlers.workspace_memory_delete({ id, workspace_folder: ws });
  assert.equal(missingResult.isError, true);
  assert.equal(missingResult.structuredContent.code, 'NOT_FOUND');

  const planHandlers = createCretliMcpToolHandlers({}, { chatId: 'chat-memory', mode: 'plan' });
  const denied = await planHandlers.workspace_memory_add({
    type: 'context',
    key: 'x',
    value: 'y',
    workspace_folder: ws,
  });
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.code, 'PLAN_MODE_DENIED');
  // The read tool stays available in Plan mode (Scout-safe).
  const planList = await planHandlers.workspace_memory_list({ workspace_folder: ws });
  assert.notEqual(planList.isError, true);
});

test('MCP list paginates with a cursor', async () => {
  const dataDir = freshDataDir('page');
  const ws = freshWorkspace('page');
  setBuiltinMcpRuntimeDeps({ dataDir });
  const handlers = createCretliMcpToolHandlers({}, { chatId: 'chat-memory', mode: 'agent' });
  for (let i = 0; i < 5; i += 1) {
    await handlers.workspace_memory_add({ type: 'context', key: `k${i}`, value: 'v', workspace_folder: ws });
  }
  const page1 = await handlers.workspace_memory_list({ workspace_folder: ws, limit: 2 });
  assert.equal(page1.structuredContent.items.length, 2);
  assert.ok(page1.structuredContent.next_cursor);
  const page2 = await handlers.workspace_memory_list({
    workspace_folder: ws,
    limit: 2,
    cursor: page1.structuredContent.next_cursor,
  });
  assert.equal(page2.structuredContent.items.length, 2);
  const ids = new Set([...page1.structuredContent.items, ...page2.structuredContent.items].map((item) => item.id));
  assert.equal(ids.size, 4);
  assert.equal(page1.structuredContent.total, 5);
});
