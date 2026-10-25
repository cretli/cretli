/**
 * Create-only MCP feedback store: root, dedup, closed-duplicate link, caps.
 */
import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import path from 'node:path';

const { loadTodosData, updateTodo } = await import('../lib/persist/todos-persist.js');
const { submitFeedback, parseFeedbackInput, parseFeedbackMeta, FEEDBACK_ROOT_TITLE } = await import('../lib/persist/feedback-store.js');
const { resolveProjectPath } = await import('../lib/runtime-paths.js');

const dataDir = ISOLATED_DATA_DIR;
const cretliCwd = resolveProjectPath();
let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log('OK:', name);
  } catch (err) {
    failed += 1;
    console.error('FAIL:', name);
    console.error(err && err.stack ? err.stack : String(err));
  }
}

const report = { kind: 'bug', tool: 'todo_show', summary: 'Returns stale data', details: 'details', severity: 'low' };
const src = { harness: 'claude', mode: 'agent', workspace: '/work/my-app', chatId: 'chat-1' };
const items = () => loadTodosData(dataDir, cretliCwd).items;
const root = () => items().find((row) => row.title === FEEDBACK_ROOT_TITLE);

let first;
check('first report creates root and an idea under it', () => {
  first = submitFeedback(dataDir, report, src);
  assert.equal(first.action, 'created');
  assert.ok(root());
  const row = items().find((it) => it.id === first.id);
  assert.equal(row.parentId, root().id);
  assert.equal(row.status, 'idea');
  assert.equal(row.assignee, undefined);
  assert.equal(items().filter((it) => it.title === FEEDBACK_ROOT_TITLE).length, 1);
});

check('client workspace goes to metadata; root stays in the Cretli workspace', () => {
  const row = items().find((it) => it.id === first.id);
  const meta = parseFeedbackMeta(row.body);
  assert.equal(meta.sources[0].workspace, '/work/my-app');
  assert.equal(meta.sources[0].harness, 'claude');
  assert.equal(path.resolve(cretliCwd), path.resolve(resolveProjectPath()));
});

check('identical report bumps the counter instead of creating a new todo', () => {
  const before = items().length;
  const dup = submitFeedback(dataDir, { ...report, summary: '  returns STALE data. ' }, { ...src, chatId: 'chat-2' });
  assert.equal(dup.action, 'duplicate');
  assert.equal(dup.id, first.id);
  assert.equal(dup.count, 2);
  assert.equal(items().length, before);
  const meta = parseFeedbackMeta(items().find((it) => it.id === first.id).body);
  assert.equal(meta.count, 2);
  assert.equal(meta.sources.length, 2);
});

check('sources list is capped', () => {
  for (let i = 0; i < 20; i += 1) submitFeedback(dataDir, report, { ...src, chatId: `c${i}` });
  const meta = parseFeedbackMeta(items().find((it) => it.id === first.id).body);
  assert.equal(meta.sources.length, 8);
  assert.ok(meta.count >= 22);
});

check('report after the previous was closed creates a new one with a link', () => {
  updateTodo(dataDir, cretliCwd, first.id, { status: 'done' });
  const next = submitFeedback(dataDir, report, src);
  assert.equal(next.action, 'created');
  assert.notEqual(next.id, first.id);
  assert.equal(next.previousId, first.id);
  const row = items().find((it) => it.id === next.id);
  assert.equal(row.status, 'idea');
  assert.equal(parseFeedbackMeta(row.body).previousId, first.id);
});

check('unknown fields, bad enums and over-limit values are rejected', () => {
  const bad = [
    { ...report, extra: 1 },
    { ...report, kind: 'nope' },
    { ...report, severity: 'critical' },
    { ...report, summary: 'x'.repeat(201) },
    { ...report, tool: 'x'.repeat(101) },
    { ...report, details: 'x'.repeat(4001) },
    { ...report, repro: 'x'.repeat(2001) },
    { kind: 'bug' },
    null,
  ];
  for (const input of bad) {
    assert.throws(() => parseFeedbackInput(input), (err) => err.code === 'VALIDATION');
  }
  const before = items().length;
  assert.throws(() => submitFeedback(dataDir, { ...report, status: 'ready' }, src), (err) => err.code === 'VALIDATION');
  assert.equal(items().length, before);
});

check('the open-report cap errors without writing', () => {
  const before = items().length;
  assert.throws(
    () => submitFeedback(dataDir, { kind: 'idea', summary: 'brand new' }, src, { maxOpen: 1 }),
    (err) => err.code === 'LIMIT',
  );
  assert.equal(items().length, before);
});

check('every report is an idea without an assignee', () => {
  const children = items().filter((it) => it.parentId === root().id);
  assert.ok(children.length >= 2);
  for (const row of children) {
    assert.equal(row.assignee, undefined);
    assert.ok(['idea', 'done'].includes(row.status));
  }
  assert.equal(children.filter((row) => row.status !== 'idea' && row.id !== first.id).length, 0);
});

removeIsolatedDataDir();
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('feedback-store: all checks passed');
