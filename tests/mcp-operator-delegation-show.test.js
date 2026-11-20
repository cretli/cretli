import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test, after } from 'node:test';
import { tempDir } from './helpers/temp-git-repo.js';

const dataDir = tempDir('cretli-operator-delegation-show-');
process.env.CRETLI_DATA_DIR = dataDir;
const { addTodo, writeTodoReview } = await import('../lib/persist/todos-store.js');
const { createDelegationRecord, updateDelegationRecord } = await import('../lib/persist/delegations-persist.js');
const { callExternalOperatorTool, EXTERNAL_OPERATOR_TOOLS } = await import('../lib/mcp/mcp-external-operator-tools.js');
const { setBuiltinMcpRuntimeDeps } = await import('../lib/mcp/builtin/runtime-deps.js');
setBuiltinMcpRuntimeDeps({ dataDir });
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const wsA = tempDir('cretli-ods-ws-a-');
const wsB = tempDir('cretli-ods-ws-b-');
const clientA = { id: 'op-a', name: 'A', mode: 'operator', workspaceFolder: wsA };

async function call(name, args, client = clientA) {
  const response = await callExternalOperatorTool(client, name, args);
  const raw = response.content[0].text;
  return { isError: response.isError, body: response.isError ? raw : JSON.parse(raw) };
}
function review(workspaceFolder, leafId, report, extra = {}) {
  const created = createDelegationRecord({
    parentChatId: 'parent', childChatId: 'child', workspaceFolder, leafId,
    executor: { transport: 'codex', model: 'gpt-x' }, status: 'completed',
    assignment: 'review', reviewSubject: 'code', ...extra,
  });
  // The report body is not accepted at creation; it is written on completion.
  return updateDelegationRecord(created.id, { report }) || created;
}

test('tool is listed and described', () => {
  assert.ok(EXTERNAL_OPERATOR_TOOLS.some((tool) => tool.name === 'operator_delegation_show'));
});

test('show by delegation_id (full and prefix) returns verdicts, executor and findings', async () => {
  const row = review(wsA, 'leaf-x', 'All good.\nTASK: review\nVERDICT: PASS');
  const full = await call('operator_delegation_show', { delegation_id: row.id });
  assert.equal(full.isError, false);
  assert.equal(full.body.delegation_id, row.id);
  assert.equal(full.body.raw_verdict, 'PASS');
  assert.equal(full.body.harness, 'codex');
  assert.equal(full.body.model, 'gpt-x');
  assert.equal(full.body.server_verdict, null);
  assert.match(full.body.report, /VERDICT: PASS/);
  assert.ok(Array.isArray(full.body.findings.items));
  const prefix = await call('operator_delegation_show', { delegation_id: row.id.slice(0, 8) });
  assert.equal(prefix.body.delegation_id, row.id);
});

test('show by todo_id picks the newest review and reports the server verdict', async () => {
  const todo = (await addTodo(dataDir, wsA, { title: 'Reviewed task', status: 'doing' })).item;
  const row = review(wsA, todo.id, 'Looks fine.\nVERDICT: PASS');
  review(wsA, todo.id, 'older', { assignment: 'implement', reviewSubject: 'other' });
  await writeTodoReview(dataDir, wsA, todo.id, {
    code: { state: 'failed', reviewers: [{ delegationId: row.id, attemptId: 'a1', verdict: 'FAIL', usable: true, status: 'completed' }] },
  });
  const out = await call('operator_delegation_show', { todo_id: todo.id });
  assert.equal(out.isError, false, JSON.stringify(out.body));
  assert.equal(out.body.delegation_id, row.id);
  assert.equal(out.body.todo_id, todo.id);
  assert.equal(out.body.raw_verdict, 'PASS');
  // Server verdict is recorded separately from what the reviewer wrote.
  const server = out.body.server_verdict;
  assert.ok(server, JSON.stringify(out.body));
  {
    assert.equal(server.verdict, 'FAIL');
    assert.equal(server.subject, 'code');
  }
  assert.equal(out.body.other_delegations.length, 1);
});

test('report is paged by cursor and a stale cursor is refused', async () => {
  const report = `${'x'.repeat(9000)}\nVERDICT: PASS`;
  const row = review(wsA, 'leaf-long', report);
  const first = await call('operator_delegation_show', { delegation_id: row.id });
  assert.equal(first.body.truncated, true);
  assert.ok(first.body.next_cursor);
  let text = first.body.report;
  let cursor = first.body.next_cursor;
  while (cursor) {
    const page = await call('operator_delegation_show', { delegation_id: row.id, cursor });
    assert.equal(page.isError, false);
    text += page.body.report;
    cursor = page.body.next_cursor;
  }
  assert.equal(text, report);
  const bad = await call('operator_delegation_show', { delegation_id: row.id, cursor: 'other:report:0' });
  assert.equal(bad.isError, true);
});

test('a delegation of another workspace is refused', async () => {
  const foreign = review(wsB, 'leaf-b', 'VERDICT: PASS');
  const byId = await call('operator_delegation_show', { delegation_id: foreign.id });
  assert.equal(byId.isError, true);
  const byPrefix = await call('operator_delegation_show', { delegation_id: foreign.id.slice(0, 8) });
  assert.equal(byPrefix.isError, true);
  const none = await call('operator_delegation_show', {});
  assert.equal(none.isError, true);
});
