import '../tests/helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BUILTIN_TOOLS, createCretliMcpToolHandlers, listCretliMcpToolDefs } from '../lib/mcp/builtin/catalog.js';
import { createOperatorClientMethods } from '../lib/operator/operator-client-methods.js';
import { openOperatorStore } from '../lib/operator/operator-internal-store.js';
import { OPERATOR_BUILTIN_ALLOWLIST, redactOperatorAuditArgs, resolveOperatorBuiltinToolDecision } from '../lib/operator/operator-tool-policy.js';
import { listOperatorNotes } from '../lib/persist/operator-journal-persist.js';
import { operatorRunChatRow } from './helpers/operator-run-chat-fixture.js';

const WS = path.resolve('/tmp/operator-gate-ws');

function fixture(row = operatorRunChatRow({ workspaceFolder: WS })) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-operator-gate-'));
  const client = createOperatorClientMethods({ chatId: row?.id || 'none' }, { findChatById: async () => row, dataDir: () => dataDir });
  const auditRows = () => {
    const db = openOperatorStore({ dataDir });
    try { return db.prepare('SELECT * FROM operator_audit ORDER BY id').all(); } finally { db.close(); }
  };
  const runId = row?.operatorRunId;
  const startRun = () => {
    const db = openOperatorStore({ dataDir });
    try {
      const now = new Date().toISOString();
      db.prepare("INSERT INTO operator_runs(id, state, workspace, owner_instance_id, heartbeat_at, lease_expires_at, started_at) VALUES (?, 'running', ?, 'i1', ?, ?, ?)")
        .run(runId, WS, now, new Date(Date.now() + 60_000).toISOString(), now);
    } finally { db.close(); }
  };
  return { dataDir, client, auditRows, startRun, cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }) };
}

const toolAllowed = (name) => OPERATOR_BUILTIN_ALLOWLIST.has(name);
const isDenied = (result) => result.isError === true && /PLAN_MODE_DENIED|operator/i.test(JSON.stringify(result));

test('every BUILTIN_TOOLS entry is decided: off the allowlist is denied with one audit row, a new tool stays denied', async () => {
  const f = fixture();
  try {
    const handlers = createCretliMcpToolHandlers(f.client, { mode: 'agent' });
    const names = BUILTIN_TOOLS.map((tool) => tool.name).filter((name) => handlers[name]);
    assert.ok(names.length > 100, 'catalog is enumerated, not sampled');
    for (const name of names) {
      const before = f.auditRows().length;
      const result = await handlers[name]({});
      const rows = f.auditRows();
      assert.equal(rows.length, before + 1, `${name}: exactly one audit row per call`);
      const row = rows.at(-1);
      assert.equal(row.tool, name);
      if (toolAllowed(name)) {
        assert.equal(row.outcome, 'allowed', name);
      } else {
        assert.equal(row.outcome, 'denied', name);
        assert.ok(isDenied(result), `${name} must be denied for an operator run`);
      }
    }
    // The allowlist only names tools that exist (a typo would silently allow nothing).
    for (const name of OPERATOR_BUILTIN_ALLOWLIST.keys()) assert.ok(names.includes(name), `${name} is in the catalog`);
  } finally { f.cleanup(); }
});

test('explicitly excluded tools are denied even though Plan mode opens them by name', async () => {
  const f = fixture();
  try {
    const handlers = createCretliMcpToolHandlers(f.client, { mode: 'plan' });
    for (const name of ['cretli_feedback', 'voice_reply', 'decision_request', 'chat_archive', 'chat_delete', 'chat_rename', 'todo_update', 'delegation_start', 'watcher_set']) {
      assert.ok(isDenied(await handlers[name]({ kind: 'bug', summary: 's', text: 't' })), name);
    }
  } finally { f.cleanup(); }
});

test('scout_findings: list is allowed, submit/accept/anything else is denied (name AND action)', async () => {
  const f = fixture();
  try {
    const handlers = createCretliMcpToolHandlers(f.client, { mode: 'agent' });
    assert.equal(resolveOperatorBuiltinToolDecision('scout_findings', { action: 'list' }).allow, true);
    assert.equal(resolveOperatorBuiltinToolDecision('scout_findings', {}).allow, true, 'missing action means list');
    for (const action of ['submit', 'accept', 'reject', 'LIST ', 'x']) {
      const allowed = resolveOperatorBuiltinToolDecision('scout_findings', { action }).allow;
      assert.equal(allowed, action === 'LIST ', action);
    }
    assert.ok(isDenied(await handlers.scout_findings({ action: 'submit', scan_id: 's', submit_token: 't', findings: [] })));
    assert.equal(f.auditRows().at(-1).outcome, 'denied');
    assert.equal(f.auditRows().at(-1).action, 'submit');
  } finally { f.cleanup(); }
});

test('one allowed call and one denied call leave exactly one audit row each, args redacted and capped', async () => {
  const f = fixture();
  try {
    const handlers = createCretliMcpToolHandlers(f.client, { mode: 'agent' });
    await handlers.todo_list({ api_key: 'sk-secret-value', filter: 'x'.repeat(10_000) });
    await handlers.todo_update({ todo_id: 'a', token: 'tok-secret' });
    const rows = f.auditRows();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => [row.tool, row.outcome]), [['todo_list', 'allowed'], ['todo_update', 'denied']]);
    assert.equal(rows[0].run_id, 'operator-run-1');
    for (const row of rows) {
      assert.doesNotMatch(row.detail, /sk-secret-value|tok-secret/);
      assert.ok(Buffer.byteLength(row.detail) < 2400, 'detail stays small');
    }
    assert.match(rows[0].detail, /\[redacted\]/);
    assert.ok(Buffer.byteLength(redactOperatorAuditArgs({ a: 'y'.repeat(50_000), b: Array(500).fill('z'.repeat(100)) })) <= 2048);
  } finally { f.cleanup(); }
});

test('a failing audit write denies the call, even an otherwise allowed one (fail-closed)', async () => {
  const f = fixture();
  try {
    // Any property other than the operator methods that a tool handler touches means the handler ran.
    const operatorMethods = new Set(Object.keys(f.client));
    let handlerRan = false;
    const spy = new Proxy({ ...f.client, recordOperatorAudit: async () => { throw new Error('disk full'); } }, {
      get(target, prop) {
        if (typeof prop === 'string' && !operatorMethods.has(prop) && !(prop in target)) handlerRan = true;
        return Reflect.get(target, prop);
      },
    });
    const handlers = createCretliMcpToolHandlers(spy, { mode: 'agent' });
    const result = await handlers.todo_list({});
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /audit/i);
    assert.equal(handlerRan, false, 'the tool handler never ran');
    // Sanity check of the spy: with a working audit the same call does reach the handler.
    handlerRan = false;
    const working = new Proxy({ ...f.client }, {
      get(target, prop) {
        if (typeof prop === 'string' && !operatorMethods.has(prop) && !(prop in target)) handlerRan = true;
        return Reflect.get(target, prop);
      },
    });
    await createCretliMcpToolHandlers(working, { mode: 'agent' }).todo_list({});
    assert.equal(handlerRan, true, 'the spy detects handler execution');
    // Real failure path: the journal location is a file, so the insert throws.
    const blocked = path.join(f.dataDir, 'blocked');
    fs.writeFileSync(blocked, 'x');
    const realFailure = createOperatorClientMethods({ chatId: 'operator-run-chat-1' }, {
      findChatById: async () => operatorRunChatRow({ workspaceFolder: WS }),
      dataDir: () => path.join(blocked, 'nested'),
    });
    const denied = await createCretliMcpToolHandlers(realFailure, { mode: 'agent' }).todo_list({});
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied), /audit/i);
    // A client that cannot identify itself fails closed instead of using a wider policy.
    const unknown = { isOperatorRunChat: async () => { throw new Error('store down'); } };
    assert.equal((await createCretliMcpToolHandlers(unknown, { mode: 'agent' }).todo_list({})).isError, true);
  } finally { f.cleanup(); }
});

test('a normal chat keeps the regular gate and writes no operator audit', async () => {
  const f = fixture({ id: 'normal-1', pickPurpose: '', workspaceFolder: WS });
  try {
    const handlers = createCretliMcpToolHandlers(f.client, { mode: 'plan' });
    const result = await handlers.todo_update({ todo_id: 'x', patch: {} });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /Plan mode/);
    assert.equal(f.auditRows().length, 0);
  } finally { f.cleanup(); }
});

test('operator_note / operator_report: hidden from every listing except the operator run, refused to other callers', async () => {
  const names = (defs) => defs.map((tool) => tool.name);
  assert.ok(!names(listCretliMcpToolDefs()).includes('operator_note'));
  assert.ok(!names(listCretliMcpToolDefs()).includes('operator_report'));
  assert.ok(!names(listCretliMcpToolDefs({ operatorRun: false })).includes('operator_note'));
  const operatorNames = names(listCretliMcpToolDefs({ operatorRun: true }));
  assert.deepEqual([...operatorNames].sort(), [...OPERATOR_BUILTIN_ALLOWLIST.keys()].sort());
  assert.ok(operatorNames.includes('operator_note') && operatorNames.includes('operator_report'));
  assert.ok(!operatorNames.includes('cretli_feedback') && !operatorNames.includes('todo_update'));

  const f = fixture({ id: 'normal-2', pickPurpose: '', workspaceFolder: WS });
  try {
    const handlers = createCretliMcpToolHandlers(f.client, { mode: 'agent' });
    for (const [name, args] of [['operator_note', { text: 'hello' }], ['operator_report', { summary: 'done' }]]) {
      const result = await handlers[name](args);
      assert.equal(result.isError, true, name);
      assert.match(JSON.stringify(result), /operator run chat/);
    }
    // The external /mcp has no chat at all.
    const external = createCretliMcpToolHandlers({}, { mode: 'agent' });
    assert.equal((await external.operator_note({ text: 'x' })).isError, true);
  } finally { f.cleanup(); }
});

test('operator_note writes a journal note tagged with the run id; operator_report records once and does not end the run', async () => {
  const f = fixture();
  try {
    f.startRun();
    const handlers = createCretliMcpToolHandlers(f.client, { mode: 'plan' });
    const note = await handlers.operator_note({ text: 'checked the review failure', kind: 'decision', todo_id: 't1' });
    assert.equal(note.isError, false);
    const notes = listOperatorNotes(WS, { dataDir: f.dataDir });
    assert.equal(notes.length, 1);
    assert.equal(notes[0].author.sessionId, 'operator-run-1');
    assert.equal(notes[0].author.clientId, 'operator_run');
    for (const bad of [{ text: '' }, { text: 'x'.repeat(2001) }, { text: 'ok', kind: 'temporary_setting' }, { text: 'ok', kind: 'nope' }]) {
      assert.equal((await handlers.operator_note(bad)).isError, true, JSON.stringify(bad).slice(0, 40));
    }

    assert.equal((await handlers.operator_report({ summary: '' })).isError, true);
    assert.equal((await handlers.operator_report({ summary: 'ok', proposals: Array(6).fill({ title: 't', rationale: 'r' }) })).isError, true);
    assert.equal((await handlers.operator_report({ summary: 'ok', proposals: [{ title: 'x'.repeat(121), rationale: 'r' }] })).isError, true);
    const ok = await handlers.operator_report({ summary: 'All good', proposals: [{ kind: 'defer', title: 'Defer leaf', rationale: 'blocked on review' }] });
    assert.equal(ok.isError, false);
    const db = openOperatorStore({ dataDir: f.dataDir });
    try {
      const run = db.prepare('SELECT * FROM operator_runs WHERE id = ?').get('operator-run-1');
      assert.equal(run.state, 'running', 'reporting does not end the run');
      assert.ok(run.reported_at);
      assert.equal(run.report_summary, 'All good');
      assert.deepEqual(JSON.parse(run.report_proposals), [{ kind: 'defer', todo_id: '', title: 'Defer leaf', rationale: 'blocked on review' }]);
    } finally { db.close(); }
    assert.equal((await handlers.operator_report({ summary: 'again' })).isError, true, 'second report rejected');
  } finally { f.cleanup(); }
});
