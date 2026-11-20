import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { registerDelegationsRoutes } from '../lib/routes/delegations-routes.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';
import { getReviewFindingsLedger, recordReviewFindings } from '../lib/persist/review-findings-ledger-persist.js';
import { getDelegationById, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import { fingerprintDelegationWorkflowPatch } from '../lib/delegation-workflow.js';
import { DELEGATION_MCP_TOOLS } from '../lib/mcp/builtin/delegation-tools.js';
import { makeParent, makeReview } from './helpers/review-round-fixtures.js';

const routes = new Map();
registerDelegationsRoutes({
  get: (p, fn) => routes.set(`GET ${p}`, fn),
  post: (p, fn) => routes.set(`POST ${p}`, fn),
}, { workspaceDirForAgent: () => ISOLATED_DATA_DIR });

async function invoke(method, route, req) {
  let status = 200;
  let body;
  const res = {
    status(code) { status = code; return this; },
    json(payload) { body = payload; return this; },
  };
  await routes.get(`${method} ${route}`)(req, res);
  return { status, body };
}

const seed = (leafId) => recordReviewFindings({
  workspaceFolder: ISOLATED_DATA_DIR,
  leafId,
  delegationId: crypto.randomUUID(),
  mode: 'audit',
  findings: [{ id: 'F1', status: 'NEW', priority: 'P1', category: 'security', files: [], summary: 'x' }],
});
const entryOf = (leafId, key) => getReviewFindingsLedger(ISOLATED_DATA_DIR, leafId).entries.find((e) => e.key === key);

// Bridged HTTP path.
{
  const parent = makeParent('rej-http');
  const leafId = crypto.randomUUID();
  seed(leafId);
  const body = {
    workspaceFolder: ISOLATED_DATA_DIR,
    leafId,
    role: 'fix',
    idempotencyKey: 'rej-http-1',
    rejected_findings: [{ key: 'R1A1-F1', reason: 'wont_fix', note: 'accepted risk' }],
  };
  const res = await invoke('POST', '/api/chats/:id/delegation-workflow', { params: { id: parent.id }, query: {}, body });
  assert.equal(res.status, 200);
  const entry = entryOf(leafId, 'R1A1-F1');
  assert.equal(entry.outcome, 'rejected');
  assert.equal(entry.rejection.actor, 'orchestrator');
  assert.equal(entry.rejection.reason, 'wont_fix');
  // Same key + different list => CONFLICT.
  const conflict = await invoke('POST', '/api/chats/:id/delegation-workflow', {
    params: { id: parent.id },
    query: {},
    body: { ...body, rejected_findings: [{ key: 'R1A1-F1', reason: 'duplicate' }] },
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'idempotency_conflict');
  // Same key + same list replays.
  const replay = await invoke('POST', '/api/chats/:id/delegation-workflow', { params: { id: parent.id }, query: {}, body });
  assert.equal(replay.body.replayed, true);
}

// In-process client path.
{
  const parent = makeParent('rej-inproc');
  const leafId = crypto.randomUUID();
  seed(leafId);
  const client = createInProcessMcpClient({ harness: 'sdk', chatId: parent.id, workspaceFolder: ISOLATED_DATA_DIR });
  const input = {
    chatId: parent.id,
    workspaceFolder: ISOLATED_DATA_DIR,
    leafId,
    role: 'fix',
    idempotencyKey: 'rej-inproc-1',
    rejectedFindings: [{ key: 'R1A1-F1', reason: 'false_positive' }],
  };
  const ok = await client.updateDelegationWorkflow(input);
  assert.equal(ok.ok, true);
  assert.equal(entryOf(leafId, 'R1A1-F1').outcome, 'rejected');
  const conflict = await client.updateDelegationWorkflow({
    ...input,
    rejectedFindings: [{ key: 'R1A1-F1', reason: 'duplicate' }],
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'idempotency_conflict');
}

// F3: unknown rejected keys are surfaced on the workflow result (HTTP + in-process).
{
  const parent = makeParent('rej-unknown');
  const leafId = crypto.randomUUID();
  seed(leafId);
  const res = await invoke('POST', '/api/chats/:id/delegation-workflow', {
    params: { id: parent.id },
    query: {},
    body: {
      workspaceFolder: ISOLATED_DATA_DIR,
      leafId,
      role: 'fix',
      idempotencyKey: 'rej-unknown-http',
      rejected_findings: [
        { key: 'R1A1-F1', reason: 'wont_fix' },
        { key: 'R9A9-F9', reason: 'duplicate' },
      ],
    },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.workflow.rejectedFindings, { applied: ['R1A1-F1'], unknown: ['R9A9-F9'] });

  const client = createInProcessMcpClient({ harness: 'sdk', chatId: parent.id, workspaceFolder: ISOLATED_DATA_DIR });
  const leafId2 = crypto.randomUUID();
  seed(leafId2);
  const ok = await client.updateDelegationWorkflow({
    chatId: parent.id,
    workspaceFolder: ISOLATED_DATA_DIR,
    leafId: leafId2,
    role: 'fix',
    idempotencyKey: 'rej-unknown-inproc',
    rejectedFindings: [{ key: 'NOPE-1', reason: 'false_positive' }],
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.workflow.rejectedFindings, { applied: [], unknown: ['NOPE-1'] });
}

// Fingerprint: absent list keeps the legacy fingerprint; list order is normalized.
{
  const base = { leafId: 'abc', role: 'fix' };
  const a = fingerprintDelegationWorkflowPatch(base);
  assert.equal(fingerprintDelegationWorkflowPatch({ ...base, rejectedFindings: undefined }), a);
  const x = { key: 'K1', reason: 'duplicate' };
  const y = { key: 'K2', reason: 'wont_fix' };
  assert.equal(
    fingerprintDelegationWorkflowPatch({ ...base, rejected_findings: [x, y] }),
    fingerprintDelegationWorkflowPatch({ ...base, rejectedFindings: [y, x] }),
  );
  assert.notEqual(fingerprintDelegationWorkflowPatch({ ...base, rejectedFindings: [x] }), a);
}

// MCP schema exposes rejected_findings.
{
  const tool = DELEGATION_MCP_TOOLS.find((row) => row.name === 'workflow_update');
  assert.ok(tool?.inputSchema?.properties?.rejected_findings);
  assert.deepEqual(
    tool.inputSchema.properties.rejected_findings.items.properties.reason.enum,
    ['false_positive', 'wont_fix', 'duplicate', 'out_of_scope_elsewhere'],
  );
}

// reviewFindings survives create + patch + reload.
{
  const parent = makeParent('rf-roundtrip');
  const summary = {
    source: 'json', total: 2, byPriority: { P1: 1, P2: 1 }, byCategory: { security: 2 },
    byStatus: { NEW: 2 }, confidence: 'high', parsedAt: '2026-10-15T00:00:00.000Z',
  };
  const review = makeReview({
    parentId: parent.id, leafId: crypto.randomUUID(), verdict: 'FAIL', reviewFindings: summary,
  });
  assert.deepEqual(getDelegationById(review.id).reviewFindings, summary, 'create stores reviewFindings');
  const patched = { ...summary, total: 5, byStatus: { NEW: 5 }, parsedAt: '2026-10-16T00:00:00.000Z' };
  updateDelegationRecord(review.id, { reviewFindings: patched });
  assert.deepEqual(getDelegationById(review.id).reviewFindings, patched, 'patch replaces reviewFindings');
  updateDelegationRecord(review.id, { reviewFindings: { source: 'bogus', total: 3 } });
  assert.equal(getDelegationById(review.id).reviewFindings, null, 'invalid summary normalizes to null');
}

// N1: explicit findings_text is stripped of the findings block before hashing and storing.
{
  const block = '```findings-json\n{"findings":[{"id":"F1","status":"NEW","priority":"P1","summary":"x"}]}\n```';
  const prose = 'F1: missing guard in lib/a.js';
  const run = async (name, findingsText, reportText) => {
    const parent = makeParent(name);
    const res = await invoke('POST', '/api/chats/:id/delegation-workflow', {
      params: { id: parent.id },
      query: {},
      body: {
        workspaceFolder: ISOLATED_DATA_DIR,
        leafId: crypto.randomUUID(),
        role: 'review',
        idempotencyKey: `${name}-k`,
        lastVerdict: 'FAIL',
        ...(findingsText !== undefined ? { findings_text: findingsText } : {}),
        ...(reportText !== undefined ? { report_text: reportText } : {}),
      },
    });
    assert.equal(res.status, 200);
    return res.body.workflow;
  };
  const plain = await run('n1-plain', prose);
  const withBlock = await run('n1-block', `${prose}\n${block}`);
  const fromReport = await run('n1-report', undefined, `${prose}\n${block}\nVERDICT: FAIL`);
  assert.ok(plain.findingsHash);
  assert.equal(withBlock.findingsHash, plain.findingsHash);
  assert.equal(withBlock.findingsText, plain.findingsText);
  assert.equal(withBlock.openFindingsText, plain.openFindingsText);
  assert.ok(!withBlock.openFindingsText.includes('findings-json'));
  assert.ok(!withBlock.findingsText.includes('findings-json'));
  assert.ok(!fromReport.openFindingsText.includes('findings-json'));
}

// N4/N5/N6: invalid rows surfaced, no write for all-unknown lists, OUT_OF_SCOPE never rejectable, replay stable.
{
  const parent = makeParent('rej-meta');
  const leafId = crypto.randomUUID();
  recordReviewFindings({
    workspaceFolder: ISOLATED_DATA_DIR,
    leafId,
    delegationId: crypto.randomUUID(),
    mode: 'audit',
    findings: [
      { id: 'F1', status: 'NEW', priority: 'P1', category: 'security', files: [], summary: 'x' },
      { id: 'F2', status: 'OUT_OF_SCOPE', priority: 'P2', category: 'security', files: [], summary: 'y' },
      { id: 'F3', status: 'FOLLOW_UP', priority: 'P3', category: 'security', files: [], summary: 'z' },
    ],
  });
  const send = (idempotencyKey, rejected) => invoke('POST', '/api/chats/:id/delegation-workflow', {
    params: { id: parent.id },
    query: {},
    body: { workspaceFolder: ISOLATED_DATA_DIR, leafId, role: 'fix', idempotencyKey, rejected_findings: rejected },
  });
  const res = await send('rej-meta-1', [
    { key: 'R1A1-F1', reason: 'wont_fix' },
    { key: 'R1A1-F2', reason: 'wont_fix' },
    { key: 'R1A1-F3', reason: 'wont_fix' },
    { key: 'R1A1-F1X', reason: '' },
    { key: 'R9A9-Z', reason: 'duplicate' },
  ]);
  const result = res.body.workflow.rejectedFindings;
  assert.deepEqual(result.applied, ['R1A1-F1']);
  assert.deepEqual(result.unknown, ['R9A9-Z']);
  assert.deepEqual(result.invalid, ['R1A1-F1X']);
  assert.deepEqual(result.notRejectable.sort(), ['R1A1-F2', 'R1A1-F3']);
  assert.ok(!result.applied.includes('R1A1-F2') && !result.unknown.includes('R1A1-F2'));
  const ledger = getReviewFindingsLedger(ISOLATED_DATA_DIR, leafId);
  assert.equal(ledger.entries.find((e) => e.key === 'R1A1-F2').outcome, 'out_of_scope');
  assert.equal(ledger.entries.find((e) => e.key === 'R1A1-F3').outcome, 'follow_up');
  assert.equal(ledger.entries.find((e) => e.key === 'R1A1-F2').rejection, null);
  // Replay returns the same applied/unknown result and does not re-write.
  const replay = await send('rej-meta-1', [
    { key: 'R1A1-F1', reason: 'wont_fix' },
    { key: 'R1A1-F2', reason: 'wont_fix' },
    { key: 'R1A1-F3', reason: 'wont_fix' },
    { key: 'R1A1-F1X', reason: '' },
    { key: 'R9A9-Z', reason: 'duplicate' },
  ]);
  assert.equal(replay.body.workflow.replayed, true);
  assert.deepEqual(replay.body.workflow.rejectedFindings, result);

  // All-unknown list on a leaf without a ledger persists nothing.
  const emptyLeaf = crypto.randomUUID();
  const res2 = await invoke('POST', '/api/chats/:id/delegation-workflow', {
    params: { id: parent.id },
    query: {},
    body: {
      workspaceFolder: ISOLATED_DATA_DIR,
      leafId: emptyLeaf,
      role: 'fix',
      idempotencyKey: 'rej-meta-2',
      rejected_findings: [{ key: 'NOPE', reason: 'duplicate' }, { key: 'BAD', reason: 'nonsense' }],
    },
  });
  assert.deepEqual(res2.body.workflow.rejectedFindings, { applied: [], unknown: ['NOPE'], invalid: ['BAD'] });
  assert.equal(getReviewFindingsLedger(ISOLATED_DATA_DIR, emptyLeaf), null, 'no empty ledger item persisted');
}

console.log('review-findings-routes tests passed');
