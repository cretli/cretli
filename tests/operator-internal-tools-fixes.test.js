import { ISOLATED_DATA_DIR } from '../tests/helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { executeTool } from '../lib/agent-harness/tool-executor.ts';
import { buildMcpRuntimeContext } from '../lib/mcp/mcp-session.js';
import { resolveMcpServersForContext, BUILTIN_CRETILI_SERVER_ID } from '../lib/mcp/mcp-config.js';
import { MCP_BUILTIN_TOOL_NAME_LIMIT, mcpBuiltinToolBridgeEncodedName } from '../lib/mcp/mcp-tool-names.js';
import { callContextTool } from '../lib/mcp/mcp-service.js';
import { createCretliMcpToolHandlers } from '../lib/mcp/builtin/catalog.js';
import { createOperatorClientMethods } from '../lib/operator/operator-client-methods.js';
import { gateOperatorNativeToolCall } from '../lib/operator/operator-native-gate.js';
import { openOperatorStore } from '../lib/operator/operator-internal-store.js';
import { noteChatRowsForOperatorIndex, resetOperatorRunChatRegistry, getOperatorRunIdentity } from '../lib/operator/operator-run-chat-registry.js';
import { resolveOperatorRunIdentity, resolveOperatorRunIdentityAsync } from '../lib/operator/operator-run-chat.js';
import { buildClaudeQueryOptions, createRoomClaudeCanUseTool, createRoomClaudePreToolUseHook } from '../lib/claude/claude-agent-ws.ts';
import { resolvePlanModeSdkEventDecision } from '../lib/sdk/sdk-plan-guard.ts';
import { buildSdkCustomTools, denyCustomToolsForOperatorRuns, sdkRoomsForTests } from '../lib/sdk/cursor-agent-sdk-ws.ts';
import { operatorRunChatRow } from './helpers/operator-run-chat-fixture.js';

const execFileAsync = promisify(execFile);
const BRIDGE = 'mcp__cretli_bridge__mcp__cretli_builtincretl__';

function workspace() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-operator-fixes-')));
  const root = path.join(base, 'ws');
  for (const dir of ['src/nested', 'data']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/app.js'), 'APP');
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(root, 'src/nested/server.key'), 'KEY');
  return { root, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

const auditRows = () => {
  const db = openOperatorStore({ dataDir: ISOLATED_DATA_DIR });
  try { return db.prepare('SELECT * FROM operator_audit ORDER BY id').all(); } finally { db.close(); }
};
const auditCount = () => auditRows().length;

/** Makes every audit write fail by replacing the journal file with a directory; returns the restore function. */
function breakAudit() {
  const file = path.join(ISOLATED_DATA_DIR, 'operator-journal.sqlite');
  const moved = `${file}.moved`;
  const wasThere = fs.existsSync(file);
  if (wasThere) fs.renameSync(file, moved);
  fs.mkdirSync(file);
  return () => {
    fs.rmSync(file, { recursive: true, force: true });
    if (wasThere) fs.renameSync(moved, file);
  };
}

function operatorChat(id, root) {
  noteChatRowsForOperatorIndex(operatorRunChatRow({ id, operatorRunId: `run-${id}`, workspaceFolder: root }));
  return id;
}

test.beforeEach(() => resetOperatorRunChatRegistry());

test('F6: executor read_file with disagreeing path aliases is denied; matching aliases read', async () => {
  const w = workspace();
  try {
    const chatId = operatorChat('f6', w.root);
    const ctx = { cwd: w.root, mode: 'agent', operatorRun: true, chatId };
    const attack = await executeTool('read_file', { file_path: 'src/app.js', path: '.env' }, ctx);
    assert.equal(attack.ok, false);
    assert.doesNotMatch(attack.output, /SECRET/);
    assert.equal((await executeTool('read_file', { file_path: '.env', path: 'src/app.js' }, ctx)).ok, false);
    assert.equal((await executeTool('read_file', { path: '.env' }, ctx)).ok, false);
    const same = await executeTool('read_file', { file_path: 'src/app.js', path: './src/app.js' }, ctx);
    assert.equal(same.ok, true, same.error);
    assert.equal(same.output, 'APP');
  } finally { w.cleanup(); }
});

test('F7: no Grep can reach a nested secret (claude Grep and sdk grep)', async () => {
  const w = workspace();
  try {
    const chatId = operatorChat('f7', w.root);
    const ctx = { cwd: w.root, mode: 'agent', operatorRun: true, chatId };
    for (const args of [{ pattern: 'KEY', path: 'src' }, { pattern: 'KEY', path: 'src/nested' }, { pattern: 'KEY' }, { pattern: 'KEY', path: '.' },
      { pattern: 'KEY', path: 'src/nested/server.key' }, { pattern: 'KEY', path: 'src', glob: '**/*.key' },
      { pattern: 'KEY', file_path: 'src/app.js' }, { pattern: 'KEY', file_path: 'src/app.js', path: '' }, { pattern: 'KEY', dir: 'src/app.js' }]) {
      const result = await executeTool('grep', args, ctx);
      assert.equal(result.ok, false, JSON.stringify(args));
      assert.doesNotMatch(result.output, /KEY/);
      assert.equal(gateOperatorNativeToolCall({ chatId, toolName: 'Grep', args, workspaceRoot: w.root }).deny, true, `claude Grep ${JSON.stringify(args)}`);
    }
    assert.equal(gateOperatorNativeToolCall({ chatId, toolName: 'Grep', args: { pattern: 'APP', path: 'src/app.js' }, workspaceRoot: w.root }).deny, false);
  } finally { w.cleanup(); }
});

test('F8: the executor passes the pattern as -e and paths after --; the operator denies dash patterns', async () => {
  const w = workspace();
  try {
    const spawned = [];
    const executionEnvironment = {
      spawn(_ctx, command, args) {
        spawned.push([command, ...args]);
        const handlers = {};
        const stream = { on() {} };
        const child = { stdout: stream, stderr: stream, kill() {}, on(event, fn) { handlers[event] = fn; if (event === 'close') setImmediate(() => fn(1)); } };
        return child;
      },
    };
    await executeTool('grep', { pattern: '--pre=./a.sh', path: 'src/app.js' }, { cwd: w.root, mode: 'agent', executionEnvironment });
    const argv = spawned.at(-1);
    assert.equal(argv[0], 'rg');
    const e = argv.indexOf('-e');
    assert.ok(e > 0 && argv[e + 1] === '--pre=./a.sh', 'pattern follows -e');
    assert.equal(argv[e + 2], '--', 'paths follow the option terminator');
    assert.equal(argv.at(-1), path.join(w.root, 'src/app.js'));

    spawned.length = 0;
    const chatId = operatorChat('f8', w.root);
    const denied = await executeTool('grep', { pattern: '--pre=./a.sh', path: 'src/app.js' }, { cwd: w.root, mode: 'agent', operatorRun: true, chatId, executionEnvironment });
    assert.equal(denied.ok, false);
    assert.equal(spawned.length, 0, 'nothing is spawned for a dash pattern');
  } finally { w.cleanup(); }
});

test('F9: one audit row per native decision on executor, claude hook and canUseTool; an audit failure blocks Read', async () => {
  const w = workspace();
  try {
    const chatId = operatorChat('f9', w.root);
    const ctx = { cwd: w.root, mode: 'agent', operatorRun: true, chatId };
    let before = auditCount();
    assert.equal((await executeTool('read_file', { path: 'src/app.js' }, ctx)).ok, true);
    assert.equal(auditCount(), before + 1);
    assert.equal(auditRows().at(-1).outcome, 'allowed');
    assert.equal(auditRows().at(-1).run_id, 'run-f9');
    before = auditCount();
    assert.equal((await executeTool('run_terminal_command', { command: 'ls' }, ctx)).ok, false);
    assert.equal(auditCount(), before + 1);
    assert.equal(auditRows().at(-1).outcome, 'denied');

    const room = { chatId, cwd: w.root, _activeRunMode: 'plan', sdkMode: 'plan', delegationAssignment: '' };
    const hook = createRoomClaudePreToolUseHook(room);
    const canUse = createRoomClaudeCanUseTool(room, { loadSettings: () => ({}) });
    before = auditCount();
    assert.equal((await hook({ tool_name: 'Read', tool_input: { file_path: 'src/app.js' }, tool_use_id: 'u1' })).continue, true);
    assert.equal((await canUse('Read', { file_path: 'src/app.js' }, { toolUseID: 'u1' })).behavior, 'allow');
    assert.equal(auditCount(), before + 1, 'hook + canUseTool of the same tool use leave one row');
    before = auditCount();
    assert.equal((await canUse('Read', { file_path: 'src/app.js' }, { toolUseID: 'u-solo' })).behavior, 'allow');
    assert.equal(auditCount(), before + 1, 'canUseTool alone audits itself');
    before = auditCount();
    assert.equal((await hook({ tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'u2' })).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(auditCount(), before + 1);
    assert.equal(auditRows().at(-1).outcome, 'denied');

    const restore = breakAudit();
    try {
      assert.equal((await executeTool('read_file', { path: 'src/app.js' }, ctx)).ok, false, 'executor Read blocked');
      assert.equal((await hook({ tool_name: 'Read', tool_input: { file_path: 'src/app.js' }, tool_use_id: 'u3' })).hookSpecificOutput.permissionDecision, 'deny');
      assert.equal((await canUse('Read', { file_path: 'src/app.js' }, { toolUseID: 'u4' })).behavior, 'deny');
    } finally { restore(); }
    assert.equal((await executeTool('read_file', { path: 'src/app.js' }, ctx)).ok, true, 'recovers once the audit works');
  } finally { w.cleanup(); }
});

test('F9: an external MCP server rejection is audited (listing/call by the gate, call by the service)', async () => {
  const chatId = operatorChat('f9-mcp', '/tmp/f9-mcp');
  const before = auditCount();
  const result = await callContextTool({ chatId, harness: 'claude', workspaceFolder: '/tmp/f9-mcp', mode: 'agent' }, 'some-external-server', 'ping', {});
  assert.equal(result.ok, false);
  assert.equal(auditCount(), before + 1);
  const row = auditRows().at(-1);
  assert.equal(row.outcome, 'denied');
  assert.match(row.detail, /external_mcp_server/);
  assert.equal(row.run_id, 'run-f9-mcp');
});

test('F10: identity is tri-state; unknown is denied everywhere, a confirmed normal chat is unaffected', async () => {
  // Cold index.
  assert.equal(getOperatorRunIdentity('cold-chat'), 'unknown');
  assert.equal(getOperatorRunIdentity(''), 'normal', 'no chat id (external /mcp) is normal');
  const ctx = { chatId: 'cold-chat', harness: 'claude', workspaceFolder: '/tmp/f10' };
  const external = [{ id: 'ext-1', kind: 'external', enabled: true, scope: 'all', harnesses: ['claude'] }];
  const ids = (context) => resolveMcpServersForContext(context, external).map((server) => server.id);
  assert.deepEqual(ids(ctx), [BUILTIN_CRETILI_SERVER_ID], 'unknown: external servers are cut');
  // Null row and lookup throw are unknown, not normal.
  assert.equal(await resolveOperatorRunIdentityAsync('cold-chat', { loadChats: async () => [] }), 'unknown');
  assert.equal(await resolveOperatorRunIdentityAsync('cold-chat', { loadChats: async () => { throw new Error('down'); } }), 'unknown');
  assert.equal(resolveOperatorRunIdentity('cold-chat', { loadChats: () => { throw new Error('down'); } }), 'unknown');
  assert.equal(resolveOperatorRunIdentity('cold-chat'), 'unknown');
  // Catalog gate with a null row / a throwing lookup: denied and audited.
  for (const findChatById of [async () => null, async () => { throw new Error('store down'); }]) {
    resetOperatorRunChatRegistry();
    const client = createOperatorClientMethods({ chatId: 'cold-chat' }, { findChatById, dataDir: () => ISOLATED_DATA_DIR });
    const before = auditCount();
    const result = await createCretliMcpToolHandlers(client, { mode: 'agent' }).todo_list({});
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /operator/i);
    assert.equal(auditCount(), before + 1);
    assert.equal(auditRows().at(-1).outcome, 'denied');
  }
  // Native policy: unknown chat denies even a plain Read.
  assert.equal(gateOperatorNativeToolCall({ chatId: 'cold-chat', toolName: 'Read', args: { file_path: 'x' }, workspaceRoot: os.tmpdir() }).deny, true);
  // A confirmed normal chat with a readable row behaves exactly as before.
  noteChatRowsForOperatorIndex({ id: 'normal-chat', pickPurpose: '' });
  assert.equal(getOperatorRunIdentity('normal-chat'), 'normal');
  assert.deepEqual(ids({ ...ctx, chatId: 'normal-chat' }), [BUILTIN_CRETILI_SERVER_ID, 'ext-1']);
  const normalClient = createOperatorClientMethods({ chatId: 'normal-chat' }, { findChatById: async () => ({ id: 'normal-chat', pickPurpose: '' }), dataDir: () => ISOLATED_DATA_DIR });
  const before = auditCount();
  const planDenied = await createCretliMcpToolHandlers(normalClient, { mode: 'plan' }).todo_update({ todo_id: 'x', patch: {} });
  assert.match(JSON.stringify(planDenied), /Plan mode/);
  assert.equal(auditCount(), before, 'no operator audit for a normal chat');
  // A row that reads fine later confirms the identity.
  assert.equal(await resolveOperatorRunIdentityAsync('late-chat', { loadChats: async () => [{ id: 'late-chat', pickPurpose: '' }] }), 'normal');
  assert.equal(getOperatorRunIdentity('late-chat'), 'normal');
});

test('F11: builtin MCP calls of an operator run reach the catalog gate through the executor and are audited once', async () => {
  const w = workspace();
  try {
    const chatId = operatorChat('f11', w.root);
    const db = openOperatorStore({ dataDir: ISOLATED_DATA_DIR });
    try {
      const now = new Date().toISOString();
      db.prepare("INSERT INTO operator_runs(id, state, workspace, owner_instance_id, heartbeat_at, lease_expires_at, started_at) VALUES ('run-f11', 'running', ?, 'i1', ?, ?, ?)")
        .run(w.root, now, new Date(Date.now() + 60_000).toISOString(), now);
    } finally { db.close(); }
    const mcpContext = buildMcpRuntimeContext({ chat: operatorRunChatRow({ id: chatId, operatorRunId: 'run-f11', workspaceFolder: w.root }), room: { cwd: w.root, sdkMode: 'agent' }, harness: 'sdk', mode: 'agent' });
    const ctx = { cwd: w.root, mode: 'agent', operatorRun: true, chatId, mcpContext };
    let before = auditCount();
    const list = await executeTool(`${BRIDGE}todo_list`, {}, ctx);
    assert.equal(list.ok, true, list.error || list.output);
    assert.equal(auditCount(), before + 1);
    assert.deepEqual([auditRows().at(-1).tool, auditRows().at(-1).outcome], ['todo_list', 'allowed']);
    before = auditCount();
    const report = await executeTool(`${BRIDGE}operator_report`, { summary: 'done' }, ctx);
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.equal(auditCount(), before + 1);
    assert.deepEqual([auditRows().at(-1).tool, auditRows().at(-1).outcome], ['operator_report', 'allowed']);
    before = auditCount();
    const denied = await executeTool(`${BRIDGE}todo_update`, { todo_id: 'x', patch: {} }, ctx);
    assert.equal(denied.ok, false);
    assert.equal(auditCount(), before + 1);
    assert.equal(auditRows().at(-1).outcome, 'denied');
  } finally { w.cleanup(); }
});

test('F12: non-tool stream events never abort an operator run (claude and sdk)', () => {
  const base = { mode: 'agent', operatorRun: true, projectRoot: os.tmpdir() };
  for (const transport of ['claude', 'sdk']) {
    for (const event of [{ type: 'assistant', text: 'hello' }, { type: 'text', delta: 'x' }, { type: 'status', status: 'running' }, {}, null]) {
      assert.deepEqual(resolvePlanModeSdkEventDecision({ ...base, transport, event }), { deny: false, abortRun: false, notify: false }, `${transport} ${JSON.stringify(event)}`);
    }
    assert.equal(resolvePlanModeSdkEventDecision({ ...base, transport, event: { type: 'tool_call', name: 'bash', args: { command: 'ls' } } }).abortRun, true);
    assert.equal(resolvePlanModeSdkEventDecision({ ...base, transport, event: { type: 'tool_call', name: '', args: {} } }).deny, true, 'a nameless tool call fails closed');
  }
});

test('F13: an operator run gets no SDK custom tools and their execute callbacks refuse it', async () => {
  const chatId = operatorChat('f13', os.tmpdir());
  const room = { sessionKey: 'sess-f13', chatId, cwd: os.tmpdir(), sdkMode: 'agent' };
  sdkRoomsForTests.set(room.sessionKey, room);
  try {
    assert.deepEqual(Object.keys(await buildSdkCustomTools(room.sessionKey, 'agent')), []);
    // A reused connection whose chat later turns out to be an operator run: execute denies.
    noteChatRowsForOperatorIndex({ id: 'f13-normal', pickPurpose: '' });
    let ran = false;
    const guarded = denyCustomToolsForOperatorRuns('sess-f13-b', { chat_pin_url: { description: 'd', execute: async () => { ran = true; return 'ok'; } } });
    sdkRoomsForTests.set('sess-f13-b', { sessionKey: 'sess-f13-b', chatId: 'f13-normal' });
    assert.equal(await guarded.chat_pin_url.execute({}), 'ok');
    ran = false;
    noteChatRowsForOperatorIndex(operatorRunChatRow({ id: 'f13-normal' }));
    await assert.rejects(() => guarded.chat_pin_url.execute({}), /operator run/);
    assert.equal(ran, false);
    // A normal chat still gets its host tools.
    noteChatRowsForOperatorIndex({ id: 'f13-plain', pickPurpose: '' });
    sdkRoomsForTests.set('sess-f13-c', { sessionKey: 'sess-f13-c', chatId: 'f13-plain', cwd: os.tmpdir(), sdkMode: 'agent' });
    assert.ok('chat_pin_url' in await buildSdkCustomTools('sess-f13-c', 'agent'));
  } finally {
    for (const key of ['sess-f13', 'sess-f13-b', 'sess-f13-c']) sdkRoomsForTests.delete(key);
  }
});

test('F14: concurrent opens of an old operator_runs schema all succeed and add the report columns once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-operator-migrate-'));
  try {
    const db = new DatabaseSync(path.join(dir, 'operator-journal.sqlite'));
    db.exec(`CREATE TABLE operator_runs (
      id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK (state IN ('running','completed','failed','interrupted')),
      workspace TEXT, trigger_event_id TEXT, trigger_kind TEXT, owner_instance_id TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL, lease_expires_at TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, failure_reason TEXT);`);
    db.close();
    const script = `import { openOperatorStore } from ${JSON.stringify(path.resolve('lib/operator/operator-internal-store.js'))};
      const db = openOperatorStore({ dataDir: ${JSON.stringify(dir)} });
      const cols = db.prepare('PRAGMA table_info(operator_runs)').all().map((c) => c.name);
      db.close(); console.log(cols.join(','));`;
    const results = await Promise.all(Array.from({ length: 4 }, () => execFileAsync(process.execPath, ['--input-type=module', '-e', script],
      { env: { ...process.env, CRETLI_DATA_DIR: dir } })));
    for (const { stdout } of results) {
      const cols = stdout.trim().split(',');
      for (const column of ['reported_at', 'report_summary', 'report_proposals']) assert.equal(cols.filter((c) => c === column).length, 1, column);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('operator tool names fit the bridge name limit', () => {
  for (const name of ['operator_note', 'operator_report']) {
    assert.ok(mcpBuiltinToolBridgeEncodedName(name).length <= MCP_BUILTIN_TOOL_NAME_LIMIT, name);
  }
});
