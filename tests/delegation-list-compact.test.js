import './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import os from 'os';
import path from 'path';
import { addChat } from '../lib/persist/chats-persist.js';
import { createDelegationRecord, getDelegationById, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';
import { DELEGATION_MCP_TOOLS } from '../lib/mcp/builtin/delegation-tools.js';

const folder = mkdtempSync(path.join(os.tmpdir(), 'cr-list-compact-'));
const tool = (name) => DELEGATION_MCP_TOOLS.find((item) => item.name === name);
const parent = addChat('sess-compact-p', 'compact-parent', null, folder, 'm', { agentTransport: 'testfake', sdkMode: 'agent' });
const ctx = (chatId = parent.id, workspaceFolder = folder) => ({
  client: createInProcessMcpClient({ chatId, workspaceFolder }),
  session: { chatId, workspaceFolder },
});
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

// P1 + VERDICT sit at the very end of a >4000 char report.
const LONG_REPORT = `${'analysis line with unicode zażółć gęślą jaźń\n'.repeat(400)}P1: lost on truncation\nTASK: review\nVERDICT: FAIL`;
const ids = [];
for (let i = 0; i < 30; i += 1) {
  const child = addChat(`sess-compact-c${i}`, `compact-child-${i}`, null, folder, 'm', {
    agentTransport: 'testfake', sdkMode: 'agent', delegationParentChatId: parent.id, delegationDepth: 1, delegationRootChatId: parent.id,
  });
  const row = createDelegationRecord({
    parentChatId: parent.id,
    childChatId: child.id,
    rootChatId: parent.id,
    depth: 1,
    workspaceFolder: folder,
    executionFolder: folder,
    planMarkdown: 'plan', planRevision: 3, runId: `run-compact-${i}`,
    sourceText: 'src',
    executor: { transport: 'testfake', model: 'testfake/test' },
    status: 'completed',
    assignment: 'review',
  });
  updateDelegationRecord(row.id, {
    report: LONG_REPORT, verifyRequired: true, reviewCanRunTests: true, reviewCanRunTestsSource: 'explicit',
    verifyResult: {
      status: 'failed', exitCode: 1, verdict: 'FAIL', source: 'delegation_verify', dataDir: `${folder}/data/${i}`,
      attemptId: row.attemptId || '', materialRevision: 'rev1', ids: ['t1', 't2'], stale: false,
      implementDelegationId: `implement-${i}`, recordedAt: '2026-01-01T00:00:00.000Z',
      newFailures: ['a'], preexistingFailures: ['b', 'c'], flakyFailures: [], baseline: { source: 'base-commit' },
      results: Array.from({ length: 12 }, (_, k) => ({ id: `t${k}`, ok: false, durationMs: 5, outputTail: 'x'.repeat(2000) })),
      outputTail: 'y'.repeat(4096),
    },
  });
  ids.push(row.id);
}

const foreignFolder = mkdtempSync(path.join(os.tmpdir(), 'cr-list-foreign-'));
const foreignParent = addChat('sess-compact-foreign', 'compact-foreign', null, foreignFolder, 'm', { agentTransport: 'testfake', sdkMode: 'agent' });
const foreign = createDelegationRecord({
  parentChatId: foreignParent.id, workspaceFolder: foreignFolder, executionFolder: foreignFolder,
  executor: { transport: 'testfake', model: 'testfake/foreign' }, status: 'completed', assignment: 'implement',
});

test('compact DTO preserves identity, execution, verdict and verify gate fields', async () => {
  const { structuredContent } = await tool('delegation_list').handler({ limit: 30 }, ctx());
  assert.deepEqual(structuredContent.items.map((row) => row.id).sort(), [...ids].sort());
  for (const row of structuredContent.items) {
    const stored = getDelegationById(row.id);
    assert.deepEqual({
      id: row.id, status: row.status, assignment: row.assignment, harness: row.harness, model: row.model,
      attempt_id: row.attempt_id, run_id: row.run_id, slot_occupied: row.slot_occupied, verdict: row.verdict,
      verify_required: row.verify_required, verify_recorded: row.verify_recorded, verify_pending: row.verify_pending,
      review_can_run_tests: row.review_can_run_tests, review_can_run_tests_source: row.review_can_run_tests_source,
    }, {
      id: stored.id, status: 'completed', assignment: 'review', harness: 'testfake', model: 'testfake/test',
      attempt_id: stored.attemptId, run_id: stored.runId, slot_occupied: false, verdict: 'FAIL',
      verify_required: true, verify_recorded: true, verify_pending: false,
      review_can_run_tests: true, review_can_run_tests_source: 'explicit',
    });
    assert.deepEqual(row.verify_result, {
      status: 'failed', exitCode: 1, verdict: 'FAIL', source: 'delegation_verify', recordedAt: '2026-01-01T00:00:00.000Z',
      attemptId: stored.attemptId, materialRevision: 'rev1', ids: ['t1', 't2'], stale: false, rawOk: false,
      implementDelegationId: stored.verifyResult.implementDelegationId,
      new_failure_count: 1, preexisting_failure_count: 2, flaky_failure_count: 0,
      new_failure_ids: ['a'], preexisting_failure_ids: ['b', 'c'], flaky_failure_ids: [],
      baseline_source: 'base-commit', detail_available: true,
    });
  }
});

test('detail=full preserves the complete legacy row shape field-for-field', async () => {
  const { structuredContent } = await tool('delegation_list').handler({ limit: 30, detail: 'full' }, ctx());
  assert.equal(structuredContent.detail, 'full');
  assert.equal(structuredContent.dto_version, 1);
  for (const row of structuredContent.items) {
    const stored = getDelegationById(row.id);
    assert.deepEqual(row, {
      id: stored.id, status: 'completed', parent_chat_id: parent.id, child_chat_id: stored.childChatId,
      harness: 'testfake', model: 'testfake/test', assignment: 'review', pick_reason: '', plan_revision: 3,
      unverified: true, attempt_id: stored.attemptId, run_id: stored.runId, attempt_count: 1, error: '',
      report_preview: LONG_REPORT.slice(0, 240), truncated: true, task_outcome: 'unspecified', interrupt_code: '',
      run_stopping: false, slot_occupied: false, verdict: 'FAIL', report_degraded: false, report_summary: '',
      verify_result: stored.verifyResult, verify_required: true, review_can_run_tests: true,
      review_can_run_tests_source: 'explicit', review_subject: 'other', review_subject_source: 'default',
      queued_at: stored.queuedAt, review_uncertified: null, acknowledged_actor: '',
      allow_recheck: false, work_role: '',
    });
    for (const key of ['outputTail', 'results', 'dataDir', 'newFailures']) {
      assert.ok(Object.hasOwn(row.verify_result, key), `legacy verify_result keeps ${key}`);
    }
  }
});

test('default delegation_list is compact: <=64 KiB and >=80% smaller than the full DTO', async () => {
  const def = tool('delegation_list');
  const compact = await def.handler({ limit: 30 }, ctx());
  const full = await def.handler({ limit: 30, detail: 'full' }, ctx());
  assert.equal(compact.structuredContent.items.length, 30);
  const compactBytes = bytes(compact);
  const fullBytes = bytes({
    ...full,
    structuredContent: { items: full.structuredContent.items, next_cursor: full.structuredContent.next_cursor },
  });
  assert.ok(compactBytes <= 64 * 1024, `compact ${compactBytes}`);
  assert.ok(compactBytes <= fullBytes * 0.2, `compact ${compactBytes} vs full ${fullBytes}`);
  const json = JSON.stringify(compact.structuredContent);
  for (const banned of ['outputTail', 'results', 'dataDir']) assert.ok(!json.includes(`"${banned}"`), banned);
  const row = compact.structuredContent.items[0];
  assert.equal(row.status, 'completed');
  assert.equal(row.verdict, 'FAIL');
  assert.equal(row.verify_result.status, 'failed');
  assert.equal(row.verify_result.new_failure_count, 1);
  assert.equal(row.verify_recorded, true);
  assert.equal(compact.structuredContent.dto_version, 2);
  assert.equal(full.structuredContent.dto_version, 1);
  assert.ok(JSON.stringify(full.structuredContent).includes('"outputTail"'));
  console.log(`[size] compact=${compactBytes}B full=${fullBytes}B reduction=${(100 - (compactBytes / fullBytes) * 100).toFixed(1)}%`);
});

test('compact state preserves occupied slots, pending verify and absent legacy evidence', async () => {
  const stateParent = addChat('sess-compact-state', 'compact-state', null, folder, 'm', { agentTransport: 'testfake', sdkMode: 'agent' });
  const pending = createDelegationRecord({
    parentChatId: stateParent.id, workspaceFolder: folder, executionFolder: folder,
    executor: { transport: 'testfake', model: 'testfake/test' }, status: 'running', assignment: 'review',
  });
  updateDelegationRecord(pending.id, {
    verifyPending: { since: '2026-01-01T00:00:00.000Z', revision: 'rev-pending' },
  });
  const { structuredContent } = await tool('delegation_list').handler({}, ctx(stateParent.id));
  assert.equal(structuredContent.items.length, 1);
  const row = structuredContent.items[0];
  assert.equal(row.id, pending.id);
  assert.equal(row.slot_occupied, true);
  assert.equal(row.verify_pending, true);
  assert.equal(row.verify_recorded, false);
  assert.equal(row.verify_result, null);
  assert.notEqual(row.verdict, 'PASS');
});

test('compact list keeps pagination', async () => {
  const def = tool('delegation_list');
  const seen = [];
  let cursor = '';
  do {
    const page = await def.handler({ limit: 10, cursor }, ctx());
    assert.equal(page.structuredContent.items.length, 10);
    seen.push(...page.structuredContent.items.map((row) => row.id));
    cursor = page.structuredContent.next_cursor;
  } while (cursor);
  assert.equal(new Set(seen).size, 30);
  assert.deepEqual(seen.sort(), [...ids].sort());
});

test('workspace and all scopes retain their existing chat boundary', async () => {
  const def = tool('delegation_list');
  for (const detail of ['compact', 'full']) {
    const own = await def.handler({ limit: 100, scope: 'workspace', detail }, ctx());
    assert.deepEqual(own.structuredContent.items.map((row) => row.id).sort(), [...ids].sort());
    await assert.rejects(
      () => def.handler({ chat_id: foreignParent.id, scope: 'workspace', detail }, ctx()),
      (err) => err.code === 'OUT_OF_SCOPE' || err.code === 'NOT_FOUND',
    );
    const all = await def.handler({ chat_id: foreignParent.id, scope: 'all', detail }, ctx());
    assert.deepEqual(all.structuredContent.items.map((row) => row.id), [foreign.id]);
    assert.equal(all.structuredContent.detail, detail);
  }
});

test('scope=tree retains the existing session-scoped snapshot shape and pagination', async () => {
  const def = tool('delegation_list');
  const clientCtx = ctx();
  const expected = await clientCtx.client.getDelegationTree({ chatId: parent.id, workspaceFolder: folder, limit: 10 });
  for (const detail of ['compact', 'full']) {
    const { structuredContent } = await def.handler({ scope: 'tree', limit: 10, detail }, clientCtx);
    assert.deepEqual(structuredContent, {
      items: expected.nodes, next_cursor: expected.next_cursor, counters: expected.counters,
    });
  }
  const childCtx = ctx(getDelegationById(ids[0]).childChatId);
  const child = await def.handler({ scope: 'tree' }, childCtx);
  assert.deepEqual(child.structuredContent.items.map((row) => row.id), [ids[0]]);
  await assert.rejects(
    () => def.handler({ scope: 'tree', chat_id: foreignParent.id }, clientCtx),
    (err) => err.code === 'CONFLICT',
  );
});

test('detail advertises a compact|full enum and rejects unsupported values for every scope', async () => {
  const def = tool('delegation_list');
  assert.deepEqual(def.inputSchema.properties.detail.enum, ['compact', 'full']);
  assert.match(def.description, /compact/);
  assert.match(def.description, /full/);
  for (const scope of ['workspace', 'all', 'tree']) {
    for (const detail of ['summary', '', null, 2, 'FULL']) {
      await assert.rejects(
        () => def.handler({ scope, detail }, ctx()),
        (err) => err.code === 'VALIDATION_ERROR' && /detail must be compact or full/.test(err.message),
      );
    }
  }
});

test('delegation_show pages a >4000 char report losslessly with the trailing VERDICT', async () => {
  const def = tool('delegation_show');
  let cursor = '';
  let text = '';
  let pages = 0;
  do {
    const res = await def.handler({ delegation_id: ids[0], cursor }, ctx());
    text += res.structuredContent.report;
    cursor = res.structuredContent.next_cursor;
    pages += 1;
    if (cursor) assert.equal(res.structuredContent.truncated, true);
  } while (cursor && pages < 50);
  assert.ok(pages > 1);
  assert.equal(text, LONG_REPORT);
  assert.match(text, /P1: lost on truncation/);
  assert.match(text, /VERDICT: FAIL$/);
  const detail = await def.handler({ delegation_id: ids[0] }, ctx());
  assert.deepEqual(detail.structuredContent.verify_result, getDelegationById(ids[0]).verifyResult);
  assert.equal(detail.structuredContent.verify_result.outputTail, 'y'.repeat(4096));
  assert.equal(detail.structuredContent.verify_result.results.length, 12);
  assert.equal(detail.structuredContent.verify_result.results[0].outputTail, 'x'.repeat(2000));
  assert.equal(detail.structuredContent.verify_result.dataDir, `${folder}/data/0`);
  assert.deepEqual(detail.structuredContent.verify_result.newFailures, ['a']);
});

test('delegation_show rejects a report cursor after the report changes', async () => {
  const def = tool('delegation_show');
  const first = await def.handler({ delegation_id: ids[0] }, ctx());
  assert.ok(first.structuredContent.next_cursor);
  try {
    updateDelegationRecord(ids[0], { report: `${LONG_REPORT}\nupdated report` });
    await assert.rejects(
      () => def.handler({ delegation_id: ids[0], cursor: first.structuredContent.next_cursor }, ctx()),
      (err) => err.code === 'CONFLICT',
    );
    const fresh = await def.handler({ delegation_id: ids[0] }, ctx());
    assert.notEqual(fresh.structuredContent.revision, first.structuredContent.revision);
  } finally {
    updateDelegationRecord(ids[0], { report: LONG_REPORT });
  }
});

test('compact error and failure ids are bounded while full evidence is preserved', async () => {
  const def = tool('delegation_list');
  const original = getDelegationById(ids[0]);
  const error = 'failure details '.repeat(100);
  const failures = Array.from({ length: 14 }, (_, i) => `test-${i}-${'x'.repeat(260)}`);
  try {
    updateDelegationRecord(ids[0], {
      error,
      verifyResult: {
        ...original.verifyResult,
        newFailures: failures,
        preexistingFailures: failures,
        flakyFailures: failures,
      },
    });
    const compact = await def.handler({ limit: 30 }, ctx());
    const row = compact.structuredContent.items.find((item) => item.id === ids[0]);
    assert.equal(row.error, error.slice(0, 240));
    for (const kind of ['new', 'preexisting', 'flaky']) {
      assert.equal(row.verify_result[`${kind}_failure_count`], 14);
      assert.deepEqual(row.verify_result[`${kind}_failure_ids`], failures.slice(0, 10).map((id) => id.slice(0, 240)));
    }
    assert.equal(row.verify_result.implementDelegationId, 'implement-0');
    const full = await def.handler({ limit: 30, detail: 'full' }, ctx());
    const legacy = full.structuredContent.items.find((item) => item.id === ids[0]);
    assert.equal(legacy.error, error);
    assert.deepEqual(legacy.verify_result.newFailures, failures);
    const detail = await tool('delegation_show').handler({ delegation_id: ids[0] }, ctx());
    assert.deepEqual(detail.structuredContent.verify_result.newFailures, failures);
  } finally {
    updateDelegationRecord(ids[0], { error: original.error, verifyResult: original.verifyResult });
  }
});

test('list row flags report preview as truncated, never as a full read', async () => {
  const res = await tool('delegation_list').handler({ limit: 1 }, ctx());
  const row = res.structuredContent.items[0];
  assert.equal(row.truncated, true);
  assert.equal(row.report_full_via, 'delegation_show');
  assert.equal(row.report_length, LONG_REPORT.length);
});
