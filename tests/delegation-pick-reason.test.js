/**
 * Regression test for the optional `pickReason` carried by a delegation start.
 *
 * Covers: normalization/validation, JSON + SQLite persistence, the summarize
 * API shape, the delegation card model with and without a reason, and the
 * `delegation_start` MCP tool passing the value through to the client.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import {
  MAX_DELEGATION_PICK_REASON_LENGTH,
  isDelegationPickReasonTooLong,
  normalizeDelegationPickReason,
} from '../lib/delegation-request.js';
import {
  createDelegationRecord,
  getDelegationById,
  loadDelegations,
  updateDelegationRecord,
} from '../lib/persist/delegations-persist.js';
import { setDelegationStoreBackend } from '../lib/persist/delegation-store-backend.js';
import { closeDelegationSqlite, openDelegationSqlite } from '../lib/persist/delegation-sqlite.js';
import { summarizeDelegation } from '../lib/delegation-query.js';
import { buildDelegationCardModel } from '../lib/delegation-card-model.js';
import { DELEGATION_MCP_TOOLS } from '../lib/mcp/builtin/delegation-tools.js';

// --- Normalization + length validation --------------------------------------
assert.equal(normalizeDelegationPickReason('  score=9 rotation=balanced  '), 'score=9 rotation=balanced');
assert.equal(normalizeDelegationPickReason(undefined), '');
assert.equal(normalizeDelegationPickReason(null), '');
assert.equal(normalizeDelegationPickReason(42), '42');
assert.equal(isDelegationPickReasonTooLong('ok'), false);
assert.equal(
  isDelegationPickReasonTooLong('x'.repeat(MAX_DELEGATION_PICK_REASON_LENGTH)),
  false,
  'exactly at the limit is allowed',
);
assert.equal(
  isDelegationPickReasonTooLong('x'.repeat(MAX_DELEGATION_PICK_REASON_LENGTH + 1)),
  true,
);

// --- JSON backend: stored, read back and summarized --------------------------
const jsonRecord = createDelegationRecord({
  parentChatId: 'p-json',
  workspaceFolder: '/tmp/ws-json',
  assignment: 'implement',
  executionMode: 'agent',
  status: 'queued',
  pickReason: '  observed n=7 pass=0.86  ',
});
const jsonLoaded = loadDelegations().find((row) => row.id === jsonRecord.id);
assert.ok(jsonLoaded, 'JSON record is persisted');
assert.equal(jsonLoaded.pickReason, 'observed n=7 pass=0.86');
const jsonById = getDelegationById(jsonRecord.id);
assert.equal(jsonById.pickReason, 'observed n=7 pass=0.86');
const jsonSummary = summarizeDelegation(jsonById);
assert.equal(jsonSummary.pickReason, 'observed n=7 pass=0.86');
assert.equal('pickReason' in jsonSummary, true);

// An update patch (status/report) must not drop the reason.
updateDelegationRecord(jsonRecord.id, { status: 'completed', report: 'ok' });
assert.equal(getDelegationById(jsonRecord.id).pickReason, 'observed n=7 pass=0.86');

// A legacy row and a record created without a reason both read back as ''.
const noReason = createDelegationRecord({ parentChatId: 'p-legacy', workspaceFolder: '/tmp/ws-json' });
assert.equal(getDelegationById(noReason.id).pickReason, '');
assert.equal(summarizeDelegation({ id: 'legacy' }).pickReason, '');

// --- SQLite backend: the JSON blob inside the adapter keeps the field ---------
setDelegationStoreBackend('sqlite');
closeDelegationSqlite();
try {
  const sqliteRecord = createDelegationRecord({
    parentChatId: 'p-sqlite',
    workspaceFolder: '/tmp/ws-sqlite',
    assignment: 'review',
    executionMode: 'agent',
    status: 'queued',
    pickReason: 'reviewer != last implementer',
  });
  const sqliteLoaded = loadDelegations().find((row) => row.id === sqliteRecord.id);
  assert.ok(sqliteLoaded, 'SQLite record is persisted');
  assert.equal(sqliteLoaded.pickReason, 'reviewer != last implementer');
  assert.equal(getDelegationById(sqliteRecord.id).pickReason, 'reviewer != last implementer');

  const database = openDelegationSqlite();
  const raw = database.prepare('SELECT json FROM delegations WHERE id = ?').get(sqliteRecord.id);
  assert.ok(raw, 'raw SQLite row exists');
  assert.equal(JSON.parse(String(raw.json)).pickReason, 'reviewer != last implementer');
} finally {
  closeDelegationSqlite();
  setDelegationStoreBackend('json');
}

// --- Delegation card model: with and without a reason ------------------------
assert.equal(buildDelegationCardModel({ pickReason: ' rotation=balanced ' }).pickReason, 'rotation=balanced');
assert.equal(buildDelegationCardModel({}).pickReason, '');
assert.equal(buildDelegationCardModel({ pickReason: null }).pickReason, '');

// --- MCP delegation_start passes pick_reason / pickReason through ------------
const startTool = DELEGATION_MCP_TOOLS.find((tool) => tool.name === 'delegation_start');
assert.ok(startTool, 'delegation_start tool exists');
assert.equal(startTool.inputSchema.properties.pick_reason.maxLength, MAX_DELEGATION_PICK_REASON_LENGTH);
assert.equal(startTool.inputSchema.properties.pickReason.type, 'string');

const captured = [];
const session = { chatId: 'chat-1', workspaceFolder: '/tmp/ws-mcp', mode: 'agent' };
const client = {
  async getChat() {
    return { id: 'chat-1', workspaceFolder: '/tmp/ws-mcp' };
  },
  async startDelegation(args) {
    captured.push(args);
    return {
      ok: true,
      delegation: {
        id: 'delegation-1',
        status: 'starting',
        assignment: 'implement',
        executor: { transport: 'opencode', model: 'opencode/test' },
      },
    };
  },
};

const snake = await startTool.handler({
  task_text: 'do the thing',
  harness: 'opencode',
  model: 'opencode/test',
  idempotency_key: 'pick-snake',
  pick_reason: '  score DESC, band=1  ',
}, { client, session });
assert.notEqual(snake.isError, true);
assert.equal(captured[0].pickReason, 'score DESC, band=1');

const camel = await startTool.handler({
  task_text: 'do the thing',
  harness: 'opencode',
  model: 'opencode/test',
  idempotency_key: 'pick-camel',
  pickReason: 'cold-start explore',
}, { client, session });
assert.notEqual(camel.isError, true);
assert.equal(captured[1].pickReason, 'cold-start explore');

let tooLongCode = '';
try {
  await startTool.handler({
    task_text: 'do the thing',
    harness: 'opencode',
    model: 'opencode/test',
    idempotency_key: 'pick-long',
    pick_reason: 'x'.repeat(MAX_DELEGATION_PICK_REASON_LENGTH + 1),
  }, { client, session });
} catch (err) {
  tooLongCode = err?.code || '';
}
assert.equal(tooLongCode, 'VALIDATION_ERROR', 'an over-long pick reason is rejected');
assert.equal(captured.length, 2, 'no extra start call for the rejected reason');

console.log('delegation-pick-reason.test.js OK');
