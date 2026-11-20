/**
 * needs_rescope scope proposals: the proposal is stored on the todo, a close
 * with an open proposal holds the leaf (no Watcher retry), and acceptance
 * widens `## Leaf scope`, clears the leaf's backoff and re-opens it.
 */
import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addTodo, getTodoById } from '../lib/persist/todos-legacy-adapter.js';
import { getWorkspaceWatcher, upsertWorkspaceWatcher } from '../lib/persist/workspace-watchers-persist.js';
import {
  WORKSPACE_WATCHER_SCOPE_REQUEST_HOLD_MS,
  acceptWorkspaceWatcherScopeRequest,
  buildWorkspaceWatcherCycleClosePatch,
  isScopeRequestAutoAcceptable,
  storeWorkspaceWatcherScopeRequest,
} from '../lib/workspace-watcher-cycle-close.js';
import { isWorkspaceWatcherTodoInBlockedBackoff } from '../lib/workspace-watcher-guardrails.js';
import {
  appendLeafScopePathsToBody,
  collectTodoLeafScopePaths,
  normalizeScopeRequestFiles,
  parseScopeRequest,
  removeScopeRequestFromBody,
  setScopeRequestInBody,
} from '../lib/todo-parallel-scope.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-scope-request-'));
const BODY = 'Do the thing.\n\n## Leaf scope\n- `lib/a.js`\n- `tests/a.test.js`\n\n## Notes\nkeep me\n';

function setup(body = BODY, status = 'doing') {
  const dataDir = path.join(tmpRoot, `data-${Math.random().toString(36).slice(2)}`);
  const cwd = path.join(tmpRoot, `ws-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const todo = addTodo(dataDir, cwd, { title: 'leaf', status, body }).item;
  return { dataDir, cwd, todo };
}

test('files are validated: no traversal, absolute paths or duplicates; capped', () => {
  assert.deepEqual(
    normalizeScopeRequestFiles(['lib/x.js', '../etc/passwd', '/abs.js', 'LIB/X.js', './y.js', 'a b.js', '']),
    ['lib/x.js', 'y.js'],
  );
  assert.deepEqual(normalizeScopeRequestFiles('lib/x.js'), []);
  assert.equal(normalizeScopeRequestFiles(Array.from({ length: 80 }, (_, i) => `f${i}.js`)).length, 50);
});

test('body helpers: proposal round-trips and never leaks into Leaf scope', () => {
  const body = setScopeRequestInBody(BODY, { files: ['lib/b.js', 'config/x-allowlist.json'], reason: 'needs b', at: '2026-11-05T10:00:00.000Z' });
  assert.deepEqual(parseScopeRequest(body), {
    files: ['lib/b.js', 'config/x-allowlist.json'], reason: 'needs b', at: '2026-11-05T10:00:00.000Z',
  });
  assert.deepEqual(collectTodoLeafScopePaths({ body }), ['lib/a.js', 'tests/a.test.js']);
  // Replacing keeps one section; removing restores the original body.
  const replaced = setScopeRequestInBody(body, { files: ['lib/c.js'], reason: 'r', at: 't' });
  assert.equal(replaced.match(/## Scope request/g).length, 1);
  assert.equal(removeScopeRequestFromBody(replaced).trim(), BODY.trim());
  assert.equal(parseScopeRequest(BODY), null);
});

test('appendLeafScopePathsToBody extends the section, skips known paths, creates a missing one', () => {
  const next = appendLeafScopePathsToBody(BODY, ['lib/b.js', 'LIB/A.js']);
  assert.deepEqual(collectTodoLeafScopePaths({ body: next }), ['lib/a.js', 'tests/a.test.js', 'lib/b.js']);
  assert.match(next, /## Notes\nkeep me/);
  assert.deepEqual(collectTodoLeafScopePaths({ body: appendLeafScopePathsToBody('plain', ['lib/b.js']) }), ['lib/b.js']);
});

test('store: the proposal is written to the todo body; files already in scope are dropped', async () => {
  const { dataDir, cwd, todo } = setup();
  const stored = await storeWorkspaceWatcherScopeRequest({
    dataDir, workspaceFolder: cwd, todoId: todo.id, files: ['lib/a.js', 'lib/b.js', '../bad'], reason: 'needs b', now: Date.parse('2026-11-05T10:00:00.000Z'),
  });
  assert.deepEqual(stored, { stored: true, files: ['lib/b.js'] });
  const saved = getTodoById(dataDir, cwd, todo.id);
  assert.deepEqual(parseScopeRequest(saved.body)?.files, ['lib/b.js']);
  assert.match(saved.body, /Reason: needs b/);

  const none = await storeWorkspaceWatcherScopeRequest({ dataDir, workspaceFolder: cwd, todoId: todo.id, files: ['lib/a.js'] });
  assert.equal(none.stored, false);
  assert.equal(none.reason, 'no_new_files');
});

function closePatch({ todo, reasonCode, reports, row = {}, onBlockedEscalation }) {
  const cycle = { cycleId: 'c1', chatId: 'chat-1', todoIds: [todo.id], reportId: 'r1' };
  const now = Date.parse('2026-11-05T10:00:00.000Z');
  return buildWorkspaceWatcherCycleClosePatch({
    row: { failures: {}, decisions: [], activeCycles: [cycle], ...row },
    cycle,
    outcome: 'blocked',
    decisionReason: 'reported_blocked',
    reports: reports || [{ reportId: 'r1', cycleId: 'c1', chatId: 'chat-1', outcome: 'blocked', reasonCode }],
    todoIds: [todo.id],
    now,
    at: new Date(now).toISOString(),
    closeSource: 'report',
    todo,
    onBlockedEscalation,
  });
}

test('close: an open proposal holds the leaf and never escalates to idea', () => {
  const body = setScopeRequestInBody(BODY, { files: ['lib/b.js'], reason: 'r', at: 't' });
  const todo = { id: 'leaf-1', status: 'doing', body };
  const now = Date.parse('2026-11-05T10:00:00.000Z');
  /** @type {Record<string, any>[]} */
  const escalations = [];
  const patch = closePatch({ todo, reasonCode: 'needs_rescope', onBlockedEscalation: (e) => escalations.push(e), row: { blockedReasonStreak: { 'leaf-1': { code: 'needs_rescope', count: 1 } } } });
  const hold = patch.blockedBackoff['leaf-1'];
  assert.equal(Date.parse(hold.until) - now, WORKSPACE_WATCHER_SCOPE_REQUEST_HOLD_MS);
  // The Watcher's eligibility filter keeps the leaf out well past any normal backoff.
  assert.equal(isWorkspaceWatcherTodoInBlockedBackoff(patch.blockedBackoff, 'leaf-1', now + 7 * 24 * 60 * 60_000), true);
  assert.equal(patch.blockedReasonStreak['leaf-1'], undefined);
  assert.equal(escalations.length, 0);
});

test('close: needs_rescope without a proposal, or another code, keeps the normal backoff', () => {
  const plain = { id: 'leaf-1', status: 'doing', body: BODY };
  const withProposal = { ...plain, body: setScopeRequestInBody(BODY, { files: ['lib/b.js'], reason: 'r', at: 't' }) };
  const now = Date.parse('2026-11-05T10:00:00.000Z');
  const noProposal = closePatch({ todo: plain, reasonCode: 'needs_rescope' });
  assert.ok(Date.parse(noProposal.blockedBackoff['leaf-1'].until) - now < WORKSPACE_WATCHER_SCOPE_REQUEST_HOLD_MS);
  assert.equal(noProposal.blockedReasonStreak['leaf-1'].code, 'needs_rescope');
  const otherCode = closePatch({ todo: withProposal, reasonCode: 'needs_human' });
  assert.ok(Date.parse(otherCode.blockedBackoff['leaf-1'].until) - now < WORKSPACE_WATCHER_SCOPE_REQUEST_HOLD_MS);
});

test('accept: files join Leaf scope, backoff and counters clear, a parked leaf becomes ready', async () => {
  const { dataDir, cwd, todo } = setup(BODY, 'idea');
  await storeWorkspaceWatcherScopeRequest({ dataDir, workspaceFolder: cwd, todoId: todo.id, files: ['lib/b.js', 'lib/c.js'], reason: 'r' });
  upsertWorkspaceWatcher(cwd, {
    mode: 'observe',
    blockedBackoff: { [todo.id]: { count: 2, until: '2099-01-01T00:00:00.000Z' }, other: { count: 1, until: '2099-01-01T00:00:00.000Z' } },
    failures: { [todo.id]: 3 },
    blockedReasonStreak: { [todo.id]: { code: 'needs_rescope', count: 2 } },
  }, { dataDir });

  const partial = await acceptWorkspaceWatcherScopeRequest({ dataDir, workspaceFolder: cwd, todoId: todo.id, files: ['lib/b.js'], actor: 'tester' });
  assert.equal(partial.ok, true);
  assert.deepEqual(partial.accepted, ['lib/b.js']);
  assert.deepEqual(partial.remaining, ['lib/c.js']);
  let saved = getTodoById(dataDir, cwd, todo.id);
  assert.deepEqual(collectTodoLeafScopePaths(saved), ['lib/a.js', 'tests/a.test.js', 'lib/b.js']);
  assert.deepEqual(parseScopeRequest(saved.body)?.files, ['lib/c.js']);
  assert.equal(saved.status, 'ready');

  const rest = await acceptWorkspaceWatcherScopeRequest({ dataDir, workspaceFolder: cwd, todoId: todo.id });
  assert.equal(rest.ok, true);
  saved = getTodoById(dataDir, cwd, todo.id);
  assert.equal(parseScopeRequest(saved.body), null);
  assert.deepEqual(collectTodoLeafScopePaths(saved), ['lib/a.js', 'tests/a.test.js', 'lib/b.js', 'lib/c.js']);
  assert.match(saved.body, /## Notes\nkeep me/);

  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.blockedBackoff[todo.id], undefined);
  assert.ok(row.blockedBackoff.other, 'other leaves keep their backoff');
  assert.equal(row.failures[todo.id], undefined);
  assert.equal(row.blockedReasonStreak?.[todo.id], undefined);
});

test('accept: refusals leave the todo untouched', async () => {
  const { dataDir, cwd, todo } = setup();
  const none = await acceptWorkspaceWatcherScopeRequest({ dataDir, workspaceFolder: cwd, todoId: todo.id });
  assert.equal(none.ok === false && none.code, 'NOT_FOUND');
  await storeWorkspaceWatcherScopeRequest({ dataDir, workspaceFolder: cwd, todoId: todo.id, files: ['lib/b.js'], reason: 'r' });
  const before = getTodoById(dataDir, cwd, todo.id);
  const foreign = await acceptWorkspaceWatcherScopeRequest({ dataDir, workspaceFolder: cwd, todoId: todo.id, files: ['lib/zzz.js'] });
  assert.equal(foreign.ok === false && foreign.code, 'VALIDATION_ERROR');
  const stale = await acceptWorkspaceWatcherScopeRequest({ dataDir, workspaceFolder: cwd, todoId: todo.id, expectedUpdatedAt: 'stale' });
  assert.equal(stale.ok === false && stale.code, 'CONFLICT');
  assert.equal(getTodoById(dataDir, cwd, todo.id).body, before.body);
});

test('auto-accept is opt-in and limited to allowlist config files', () => {
  const on = { CRETLI_WATCHER_SCOPE_AUTO_ACCEPT: '1' };
  assert.equal(isScopeRequestAutoAcceptable(['config/delegation-controller-allowlist.json'], {}), false);
  assert.equal(isScopeRequestAutoAcceptable(['config/delegation-controller-allowlist.json'], on), true);
  assert.equal(isScopeRequestAutoAcceptable(['config/delegation-controller-allowlist.json', 'lib/chat-tree.js'], on), false);
  assert.equal(isScopeRequestAutoAcceptable([], on), false);
});

test('watcher_report stores the proposal for the cycle orchestrator only, and only for needs_rescope', async () => {
  const { WATCHER_MCP_TOOLS } = await import('../lib/mcp/builtin/watcher-tools.js');
  const { setBuiltinMcpRuntimeDeps } = await import('../lib/mcp/builtin/runtime-deps.js');
  const { dataDir, cwd, todo } = setup();
  setBuiltinMcpRuntimeDeps({ dataDir });
  const report = WATCHER_MCP_TOOLS.find((tool) => tool.name === 'watcher_report');
  assert.ok(report.inputSchema.properties.scope_request);
  const calls = [];
  const client = {
    workspaceWatcherShow: async () => ({ watcher: { activeCycles: [{ cycleId: 'c1', chatId: 'orch-1', todoIds: [todo.id] }] } }),
    workspaceWatcherUpdate: async (input) => { calls.push(input); return { ok: true, closed: true, message: 'closed' }; },
  };
  const run = (chatId, args) => report.handler(
    { outcome: 'blocked', reason_code: 'needs_rescope', scope_request: { files: ['lib/b.js'], reason: 'needs b' }, ...args },
    { client, session: { chatId, workspaceFolder: cwd } },
  );

  await run('foreign-chat', {});
  assert.equal(parseScopeRequest(getTodoById(dataDir, cwd, todo.id).body), null, 'a foreign chat stores nothing');
  await run('orch-1', { reason_code: 'needs_human' });
  assert.equal(parseScopeRequest(getTodoById(dataDir, cwd, todo.id).body), null, 'only needs_rescope carries a proposal');
  const out = await run('orch-1', {});
  assert.deepEqual(parseScopeRequest(getTodoById(dataDir, cwd, todo.id).body)?.files, ['lib/b.js']);
  assert.equal(calls.length, 3, 'the report itself is always forwarded');
  assert.equal(out.structuredContent?.scopeRequest?.autoAccepted ?? false, false);
});
