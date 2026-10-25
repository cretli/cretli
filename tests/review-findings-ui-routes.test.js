import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { registerReviewLessonsRoutes } from '../lib/routes/review-lessons-routes.js';
import {
  applyRejectedReviewFindings,
  getReviewFindingsLedger,
  recordReviewFindings,
} from '../lib/persist/review-findings-ledger-persist.js';

const routes = new Map();
const reg = (method) => (p, fn) => routes.set(`${method} ${p}`, fn);
registerReviewLessonsRoutes({ get: reg('GET'), post: reg('POST'), patch: reg('PATCH'), delete: reg('DELETE') }, { getCurrentWorkspace: () => ISOLATED_DATA_DIR });
async function invoke(method, route, req) {
  let status = 200;
  let body;
  const res = { status(code) { status = code; return this; }, json(data) { body = data; return this; } };
  await routes.get(`${method} ${route}`)({ query: {}, params: {}, body: {}, ...req }, res);
  return { status, body };
}
const foreign = `${ISOLATED_DATA_DIR}-foreign`;
const leafId = crypto.randomUUID();
recordReviewFindings({
  workspaceFolder: ISOLATED_DATA_DIR,
  leafId,
  delegationId: crypto.randomUUID(),
  mode: 'audit',
  findings: [
    { id: 'F1', status: 'NEW', priority: 'P2', category: 'missing-test', files: ['/home/someone/www/proj/lib/a.js'], summary: 'Missing test for /home/someone/www/proj/lib/a.js' },
    { id: 'F2', status: 'OUT_OF_SCOPE', priority: 'P3', category: 'other', files: [], summary: 'elsewhere' },
  ],
});
const reject = (body) => invoke('POST', '/api/review-findings/reject', { body: { workspaceFolder: ISOLATED_DATA_DIR, leafId, ...body } });

// Workspace scoping: same resolveScope rule as the lessons routes.
assert.equal((await invoke('GET', '/api/review-findings', { query: { workspaceFolder: foreign, leafId } })).status, 403);
assert.equal((await invoke('GET', '/api/review-findings', { query: { workspaceFolder: ISOLATED_DATA_DIR } })).status, 400);
assert.equal((await invoke('POST', '/api/review-findings/reject', { body: { workspaceFolder: foreign, leafId, key: 'R1A1-F1', reason: 'wont_fix' } })).status, 403);
assert.equal((await invoke('POST', '/api/review-findings/reject', { body: { leafId, key: 'R1A1-F1', reason: 'wont_fix' } })).status, 400);
assert.equal(getReviewFindingsLedger(ISOLATED_DATA_DIR, leafId).entries[0].rejection, null, 'a denied request must not write');

// Read model is scrubbed.
const listed = await invoke('GET', '/api/review-findings', { query: { workspaceFolder: ISOLATED_DATA_DIR, leafId } });
assert.equal(listed.status, 200);
assert.ok(!JSON.stringify(listed.body).includes('/home/someone'));
assert.equal(listed.body.findings.length, 2);

// Validation.
assert.equal((await reject({ key: 'R1A1-F1', reason: 'because' })).status, 400);
assert.equal((await reject({ key: 'R1A1-F1' })).status, 400);
assert.equal((await reject({ reason: 'wont_fix' })).status, 400);
assert.equal((await reject({ key: 'R1A1-F1', reason: 'wont_fix', expectedSeq: 'x' })).status, 400);
assert.equal((await reject({ key: 'R1A1-NOPE', reason: 'wont_fix' })).status, 404);
const oos = await reject({ key: 'R1A1-F2', reason: 'wont_fix' });
assert.equal(oos.status, 409);
assert.equal(oos.body.code, 'NOT_REJECTABLE');
assert.equal(getReviewFindingsLedger(ISOLATED_DATA_DIR, leafId).entries[1].outcome, 'out_of_scope');

// Human reject overrides an orchestrator rejection.
applyRejectedReviewFindings({ workspaceFolder: ISOLATED_DATA_DIR, leafId, rejected: [{ key: 'R1A1-F1', reason: 'wont_fix' }] });
assert.equal(getReviewFindingsLedger(ISOLATED_DATA_DIR, leafId).entries[0].rejection.actor, 'orchestrator');
const first = await reject({ key: 'R1A1-F1', reason: 'false_positive', note: 'checked in /home/someone/www/proj/lib/a.js' });
assert.equal(first.status, 200);
assert.equal(first.body.changed, true);
assert.equal(first.body.finding.rejection.actor, 'human');
assert.equal(first.body.finding.rejection.reason, 'false_positive');
assert.ok(!first.body.finding.rejection.note.includes('/home/someone'), 'note is scrubbed');

// Idempotent replay: same reason + note changes nothing.
const replay = await reject({ key: 'R1A1-F1', reason: 'false_positive', note: 'checked in /home/someone/www/proj/lib/a.js' });
assert.equal(replay.status, 200);
assert.equal(replay.body.changed, false);
assert.equal(replay.body.seq, first.body.seq);

// An orchestrator can no longer overwrite the human decision.
const locked = applyRejectedReviewFindings({ workspaceFolder: ISOLATED_DATA_DIR, leafId, rejected: [{ key: 'R1A1-F1', reason: 'duplicate' }] });
assert.deepEqual(locked.applied, []);
assert.deepEqual(locked.humanLocked, ['R1A1-F1']);
assert.equal(getReviewFindingsLedger(ISOLATED_DATA_DIR, leafId).entries[0].rejection.reason, 'false_positive');

// CAS: a stale expectedSeq is a 409 and does not write; the current one succeeds.
const stale = await reject({ key: 'R1A1-F1', reason: 'duplicate', expectedSeq: first.body.seq - 1 });
assert.equal(stale.status, 409);
assert.equal(stale.body.code, 'CONFLICT');
assert.equal(getReviewFindingsLedger(ISOLATED_DATA_DIR, leafId).entries[0].rejection.reason, 'false_positive');
const fresh = await reject({ key: 'R1A1-F1', reason: 'duplicate', expectedSeq: first.body.seq });
assert.equal(fresh.status, 200);
assert.equal(fresh.body.finding.rejection.reason, 'duplicate');
console.log('review-findings-ui-routes tests passed');
