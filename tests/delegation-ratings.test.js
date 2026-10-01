/**
 * TODO 4 — delegation ratings end to end.
 *
 * Covers: the pure validation kernel, the append-only JSONL persistence
 * (rotation, no report text), replay/conflict immutability, terminal-only and
 * scope gates, the parent MCP channel (in-process + remote HTTP client), the
 * user HTTP channel, aggregation with the user=2 weight, the model_pick
 * blending formula (and its exact no-op without ratings), the card model and
 * the stats endpoint fields. The front-end transport and card wiring contract
 * live in `tests/delegation-rate-ui.test.js`.
 */
import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { addChat } from '../lib/persist/chats-persist.js';
import {
  createDelegationRecord,
  getDelegationById,
  updateDelegationRecord,
} from '../lib/persist/delegations-persist.js';
import { loadChatHistory } from '../lib/persist/chat-history-persist.js';
import { registerDelegationsRoutes } from '../lib/routes/delegations-routes.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';
import { createCretliMcpToolHandlers } from '../lib/mcp/mcp-builtin-tools.js';
import { DELEGATION_MCP_TOOLS } from '../lib/mcp/builtin/delegation-tools.js';
import { CretliApiClient } from '../lib/remote-api-client.js';
import {
  DELEGATION_RATING_TAGS,
  fingerprintDelegationRating,
  normalizeDelegationRatingPayload,
  normalizeDelegationRatingRater,
  summarizeDelegationRatings,
} from '../lib/delegation-ratings.js';
import {
  appendDelegationRating,
  findDelegationRating,
  readDelegationRatings,
} from '../lib/persist/delegation-ratings-persist.js';
import {
  buildDelegationOutcomes,
  summarizeDelegationOutcomes,
} from '../lib/model-pick-history.js';
import { selectModelPick } from '../lib/model-role-profiles.js';
import { buildDelegationCardModel } from '../lib/delegation-card-model.js';

const workspace = ISOLATED_DATA_DIR;
const now = Date.parse('2026-10-01T12:00:00.000Z');
const minutesAgo = (m) => new Date(now - (m * 60000)).toISOString();

const parent = addChat(crypto.randomUUID(), 'rating-parent', null, workspace, 'opencode/test', {
  agentTransport: 'opencode',
  sdkMode: 'agent',
});
const child = addChat(crypto.randomUUID(), 'rating-child', null, workspace, 'sdk/composer', {
  agentTransport: 'sdk',
  sdkMode: 'agent',
  delegationParentChatId: parent.id,
});
const other = addChat(crypto.randomUUID(), 'rating-other', null, workspace, 'sdk/composer', {
  agentTransport: 'sdk',
  sdkMode: 'agent',
});

/** @param {object} overrides */
function terminalJob(overrides = {}) {
  const row = createDelegationRecord({
    parentChatId: parent.id,
    workspaceFolder: workspace,
    executor: { transport: 'opencode', model: 'zai-coding-plan/glm-5.3' },
    assignment: 'implement',
    executionMode: 'agent',
    ...overrides,
  });
  updateDelegationRecord(row.id, {
    status: 'completed',
    runStoppingAt: '',
    report: 'TASK: implement\nVERDICT: PASS\nSECRET-REPORT-TEXT',
  });
  return getDelegationById(row.id);
}

const jobUser = terminalJob();
const jobParent = terminalJob();
const jobMcp = terminalJob();
const jobStats = terminalJob();
const jobBias = terminalJob({ executor: { transport: 'opencode', model: 'opencode/test' } });
const running = createDelegationRecord({
  parentChatId: parent.id,
  workspaceFolder: workspace,
  executor: { transport: 'opencode', model: 'zai-coding-plan/glm-5.3' },
  assignment: 'implement',
});
updateDelegationRecord(running.id, { status: 'running' });

// --- 1. Pure kernel: validation, fingerprint, weighted mean ------------------
const valid = normalizeDelegationRatingPayload({
  score: 5,
  tags: ['Great', 'great', 'missed_bug'],
  note: '  solid work  ',
});
assert.equal(valid.ok, true);
assert.deepEqual(valid.value, {
  score: 5,
  tags: ['great', 'missed_bug'],
  note: 'solid work',
});
for (const score of [0, 6, 4.5, '4', null, undefined, NaN]) {
  const result = normalizeDelegationRatingPayload({ score });
  assert.equal(result.ok, false, `score ${String(score)} must be rejected`);
  assert.equal(result.code, 'invalid_rating_score');
}
assert.equal(normalizeDelegationRatingPayload({ score: 3, tags: 'great' }).code, 'invalid_rating_tags');
assert.equal(
  normalizeDelegationRatingPayload({ score: 3, tags: ['nope'] }).code,
  'invalid_rating_tags',
);
assert.equal(
  normalizeDelegationRatingPayload({ score: 3, note: 'x'.repeat(501) }).code,
  'invalid_rating_note',
);
assert.equal(normalizeDelegationRatingPayload({ score: 3, note: 7 }).code, 'invalid_rating_note');
// Unknown fields are never read, so no input can smuggle a rater.
const smuggled = normalizeDelegationRatingPayload({ score: 3, rater: 'root', delegationId: 'x' });
assert.equal(smuggled.ok, true);
assert.deepEqual(Object.keys(smuggled.value).sort(), ['note', 'score', 'tags']);

assert.equal(normalizeDelegationRatingRater('parent'), 'parent');
assert.equal(normalizeDelegationRatingRater(' USER '), 'user');
assert.equal(normalizeDelegationRatingRater('root'), '');

const baseFingerprint = fingerprintDelegationRating({ score: 4, tags: ['b', 'a'], note: 'x' });
assert.equal(
  baseFingerprint,
  fingerprintDelegationRating({ score: 4, tags: ['a', 'b'], note: 'x' }),
  'tag order does not change the fingerprint',
);
assert.notEqual(
  baseFingerprint,
  fingerprintDelegationRating({ score: 5, tags: ['a', 'b'], note: 'x' }),
  'a changed score is a different payload',
);
assert.notEqual(
  baseFingerprint,
  fingerprintDelegationRating({ score: 4, tags: ['a', 'b'], note: 'y' }),
  'a changed note is a different payload',
);

assert.deepEqual(summarizeDelegationRatings([]), { rating_avg: null, rating_n: 0 });
const weighted = summarizeDelegationRatings([
  { delegationId: 'd', rater: 'parent', score: 4, tags: [], note: '', ts: minutesAgo(1) },
  { delegationId: 'd', rater: 'user', score: 5, tags: [], note: '', ts: minutesAgo(1) },
]);
assert.equal(weighted.rating_n, 2);
assert.equal(Math.round(weighted.rating_avg * 1000) / 1000, Math.round((14 / 3) * 1000) / 1000);
assert.equal(
  summarizeDelegationRatings([{ delegationId: 'd', rater: 'user', score: 5 }]).rating_n,
  0,
  'an incomplete record is not counted',
);

// --- 2. Persistence: append, corruption tolerance, rotation, no report -------
const tempFile = path.join(workspace, 'ratings-rotation.jsonl');
assert.equal(appendDelegationRating({ nope: true }, { file: tempFile }), false, 'invalid records never hit the disk');
const recordA = {
  delegationId: 'job-a',
  parentChatId: parent.id,
  harness: 'opencode',
  model: 'glm-5.3',
  role: 'implement',
  rater: 'user',
  score: 4,
  tags: ['great'],
  note: 'ok',
  ts: minutesAgo(2),
  fingerprint: 'fp-a',
};
assert.equal(appendDelegationRating(recordA, { file: tempFile }), true);
assert.equal(appendDelegationRating({ ...recordA, delegationId: 'job-b', rater: 'parent' }, { file: tempFile }), true);
fs.appendFileSync(tempFile, '{"delegationId":"job-a","rater":', 'utf8');
const readBack = readDelegationRatings({ file: tempFile });
assert.equal(readBack.length, 2, 'a truncated trailing line is skipped, valid lines survive');
assert.equal(readBack[0].delegationId, 'job-a');
assert.equal(findDelegationRating('job-a', 'parent', { file: tempFile }), null);
assert.equal(findDelegationRating('job-a', 'user', { file: tempFile }).score, 4);

const rotationFile = path.join(workspace, 'ratings-rotate-small.jsonl');
for (let i = 0; i < 4; i += 1) {
  assert.equal(
    appendDelegationRating({ ...recordA, delegationId: `rot-${i}`, note: 'x'.repeat(80) }, {
      file: rotationFile,
      maxBytes: 400,
    }),
    true,
  );
}
assert.ok(fs.existsSync(`${rotationFile}.1`), 'the file rotates at the byte cap');
assert.equal(
  appendDelegationRating({ ...recordA, delegationId: 'rot-final', note: 'x'.repeat(80) }, {
    file: rotationFile,
    maxBytes: 400,
  }),
  true,
);
assert.ok(fs.statSync(rotationFile).size < 400, 'the live file starts fresh after rotation');
assert.equal(readDelegationRatings({ file: rotationFile }).length >= 1, true);

// --- 3. HTTP user channel (rater fixed to `user`, scope + terminal gates) ----
const routes = new Map();
registerDelegationsRoutes({
  get: (p, fn) => routes.set(`GET ${p}`, fn),
  post: (p, fn) => routes.set(`POST ${p}`, fn),
}, { workspaceDirForAgent: () => workspace });

/**
 * @param {string} method
 * @param {string} route
 * @param {object} [req]
 */
async function invokeRoute(method, route, req = {}) {
  let status = 200;
  let body;
  const res = {
    status(code) { status = code; return this; },
    json(payload) { body = payload; return this; },
  };
  await routes.get(`${method} ${route}`)({ params: {}, query: {}, body: {}, ...req }, res);
  return { status, body };
}

const userPayload = { score: 5, tags: ['missed_bug', 'great'], note: 'ship it' };
const userFirst = await invokeRoute('POST', '/api/delegations/:id/rate', {
  params: { id: jobUser.id },
  body: { ...userPayload, rater: 'parent' },
});
assert.equal(userFirst.status, 200);
assert.equal(userFirst.body.ok, true);
assert.equal(userFirst.body.replayed, false);
assert.equal(userFirst.body.rating.rater, 'user', 'a body rater is ignored; the channel decides');
assert.equal(findDelegationRating(jobUser.id, 'user').score, 5);
assert.equal(findDelegationRating(jobUser.id, 'parent'), null);

const userReplay = await invokeRoute('POST', '/api/delegations/:id/rate', {
  params: { id: jobUser.id },
  body: { ...userPayload },
});
assert.equal(userReplay.status, 200, 'an identical replay succeeds');
assert.equal(userReplay.body.replayed, true);

const userReplayReordered = await invokeRoute('POST', '/api/delegations/:id/rate', {
  params: { id: jobUser.id },
  body: { score: 5, tags: ['great', 'missed_bug'], note: 'ship it' },
});
assert.equal(userReplayReordered.status, 200, 'tags are order-insensitive in the fingerprint');
assert.equal(userReplayReordered.body.replayed, true);

const userConflict = await invokeRoute('POST', '/api/delegations/:id/rate', {
  params: { id: jobUser.id },
  body: { score: 1, tags: ['great'], note: 'ship it' },
});
assert.equal(userConflict.status, 409);
assert.equal(userConflict.body.code, 'idempotency_conflict');

const userBadScore = await invokeRoute('POST', '/api/delegations/:id/rate', {
  params: { id: jobUser.id },
  body: { score: 9 },
});
assert.equal(userBadScore.status, 400);
assert.equal(userBadScore.body.code, 'invalid_rating_score');

const runningRate = await invokeRoute('POST', '/api/delegations/:id/rate', {
  params: { id: running.id },
  body: { score: 5 },
});
assert.equal(runningRate.status, 409, 'terminal jobs only');
assert.equal(runningRate.body.code, 'not_terminal');

const missingRate = await invokeRoute('POST', '/api/delegations/:id/rate', {
  params: { id: 'nope' },
  body: { score: 5 },
});
assert.equal(missingRate.status, 404);

const widgetDenied = await invokeRoute('POST', '/api/delegations/:id/rate', {
  params: { id: jobUser.id },
  body: { score: 3 },
  widgetAccess: { installationId: 'inst-other', pageSessionId: 'page-other' },
});
assert.equal(widgetDenied.status, 404, 'a foreign widget sees no delegation');

const workspaceDenied = await invokeRoute('POST', '/api/delegations/:id/rate', {
  params: { id: jobUser.id },
  query: { workspaceFolder: '/another-workspace' },
  body: { score: 3 },
});
assert.equal(workspaceDenied.status, 403);
assert.equal(workspaceDenied.body.code, 'OUT_OF_SCOPE');

// The persisted user rating is published on the card payload (metadata only).
const parentEvents = loadChatHistory(parent.id)?.events || [];
const ratedPayloads = parentEvents
  .map((event) => {
    try {
      return JSON.parse(String(event?.rec?.payload || ''));
    } catch {
      return null;
    }
  })
  .filter((payload) => payload && payload.id === jobUser.id && payload.userRating);
assert.ok(ratedPayloads.length > 0, 'the card payload carries the persisted user rating');
const lastRated = ratedPayloads[ratedPayloads.length - 1];
assert.equal(lastRated.userRating.score, 5);
assert.deepEqual(lastRated.userRating.tags, ['missed_bug', 'great']);
const ratedCard = buildDelegationCardModel(lastRated);
assert.equal(ratedCard.canRate, false, 'a rated card is read-only');
assert.equal(ratedCard.userRating.score, 5);
assert.equal(
  fs.readFileSync(path.join(workspace, 'delegation-ratings.jsonl'), 'utf8').includes('SECRET-REPORT-TEXT'),
  false,
  'the ratings file never contains report text',
);

// --- 4. HTTP parent channel (MCP over the remote transport) -----------------
const parentFirst = await invokeRoute('POST', '/api/chats/:id/delegation-rate', {
  params: { id: parent.id },
  body: { delegationId: jobParent.id, workspaceFolder: workspace, score: 4, tags: ['missed_bug'] },
});
assert.equal(parentFirst.status, 200);
assert.equal(parentFirst.body.rating.rater, 'parent');
assert.equal(findDelegationRating(jobParent.id, 'parent').score, 4);

const parentReplay = await invokeRoute('POST', '/api/chats/:id/delegation-rate', {
  params: { id: parent.id },
  body: { delegationId: jobParent.id, score: 4, tags: ['missed_bug'] },
});
assert.equal(parentReplay.body.replayed, true);

const childRate = await invokeRoute('POST', '/api/chats/:id/delegation-rate', {
  params: { id: child.id },
  body: { delegationId: jobParent.id, score: 5 },
});
assert.equal(childRate.status, 409, 'a child chat cannot rate');
assert.equal(childRate.body.code, 'rating_parent_required');

const foreignParent = await invokeRoute('POST', '/api/chats/:id/delegation-rate', {
  params: { id: other.id },
  body: { delegationId: jobParent.id, score: 5 },
});
assert.equal(foreignParent.status, 403, "another chat's job is out of scope");
assert.equal(foreignParent.body.code, 'OUT_OF_SCOPE');

const noId = await invokeRoute('POST', '/api/chats/:id/delegation-rate', {
  params: { id: parent.id },
  body: {},
});
assert.equal(noId.status, 400);

// Anti-bias: the parent's own base model is denied (user ratings unaffected).
const biasBlocked = await invokeRoute('POST', '/api/chats/:id/delegation-rate', {
  params: { id: parent.id },
  body: { delegationId: jobBias.id, score: 5 },
});
assert.equal(biasBlocked.status, 409);
assert.equal(biasBlocked.body.code, 'self_model_rating_denied');
assert.equal(findDelegationRating(jobBias.id, 'parent'), null);

// --- 5. Aggregation: per (harness, base model, role), user weight 2 ----------
const statsJob = jobStats;
const aggregationRows = [statsJob];
const ratings = [
  {
    delegationId: statsJob.id,
    parentChatId: parent.id,
    harness: 'opencode',
    model: 'zai-coding-plan/glm-5.3',
    role: 'implement',
    rater: 'parent',
    score: 4,
    tags: [],
    note: '',
    ts: minutesAgo(3),
    fingerprint: 'f1',
  },
  {
    delegationId: statsJob.id,
    parentChatId: parent.id,
    harness: 'opencode',
    model: 'zai-coding-plan/glm-5.3',
    role: 'implement',
    rater: 'user',
    score: 5,
    tags: [],
    note: '',
    ts: minutesAgo(3),
    fingerprint: 'f2',
  },
  {
    // Out of the 30d window: dropped.
    delegationId: statsJob.id,
    parentChatId: parent.id,
    harness: 'opencode',
    model: 'zai-coding-plan/glm-5.3',
    role: 'implement',
    rater: 'user',
    score: 1,
    tags: [],
    note: '',
    ts: minutesAgo(45 * 24 * 60),
    fingerprint: 'f3',
  },
  {
    // Orphan rating: no terminal job for that key in the window.
    delegationId: 'ghost-job',
    parentChatId: parent.id,
    harness: 'ghost',
    model: 'ghost-model',
    role: 'review',
    rater: 'user',
    score: 1,
    tags: [],
    note: '',
    ts: minutesAgo(5),
    fingerprint: 'f4',
  },
];
const aggregated = summarizeDelegationOutcomes({ rows: aggregationRows, ratings, now });
const implementRow = aggregated.roles.implement['opencode/zai-coding-plan/glm-5.3'];
assert.ok(implementRow, 'the rated job key exists');
assert.equal(implementRow.rating_n, 2, 'out-of-window ratings do not count');
assert.equal(implementRow.rating_avg, 4.67, 'user weight 2, parent weight 1 → 14/3 rounded');
assert.equal(
  aggregated.list.some((row) => row.harness === 'ghost'),
  false,
  'an orphan rating cannot invent a stats row',
);

// The loader wrapper passes injected ratings through unchanged.
const viaLoader = buildDelegationOutcomes({ rows: aggregationRows, ratings, now });
assert.equal(
  viaLoader.roles.implement['opencode/zai-coding-plan/glm-5.3'].rating_avg,
  4.67,
);

// Stats endpoint exposes rating_avg / rating_n.
const stats = await invokeRoute('GET', '/api/delegations/stats', { query: {} });
assert.equal(stats.status, 200);
const statsRow = stats.body.list.find(
  (row) => row.harness === 'opencode' && row.model === 'zai-coding-plan/glm-5.3' && row.role === 'implement',
);
assert.ok(statsRow, 'the implement row is in the stats feed');
assert.equal(statsRow.rating_n, 2, 'the two stored ratings reach the stats feed');
assert.equal(statsRow.rating_avg, 4.67, 'the feed reports the weighted mean (user 2, parent 1)');

// --- 6. model_pick blending --------------------------------------------------
const harnesses = [
  { id: 'ha', enabled: true, ready: true, can_delegate: true },
  { id: 'hb', enabled: true, ready: true, can_delegate: true },
];
const modelsByHarness = {
  ha: { favorites_configured: true, items: [{ id: 'model-a', roles: ['implement'], cost_tier: 2, quality_tier: 4, speed_tier: 3 }] },
  hb: { favorites_configured: true, items: [{ id: 'model-b', roles: ['implement'], cost_tier: 2, quality_tier: 4, speed_tier: 3 }] },
};
const sharedObserved = {
  'ha/model-a': { n: 10, pass_rate: 1, infra_fail_rate: 0, median_min: 4, quality: 5 },
  'hb/model-b': { n: 10, pass_rate: 1, infra_fail_rate: 0, median_min: 4, quality: 5 },
};
const project = (response) => response.candidates.map((row) => ({
  key: `${row.harness}/${row.model}`,
  score: row.score,
  reason: row.reason,
  rating_applied: row.rating_applied,
}));

// Zero ratings: bit-for-bit the pre-rating output.
const withoutRatings = selectModelPick({
  role: 'implement',
  harnesses,
  modelsByHarness,
  history: { observed: sharedObserved },
});
const withEmptyRatings = selectModelPick({
  role: 'implement',
  harnesses,
  modelsByHarness,
  history: {
    observed: {
      'ha/model-a': { ...sharedObserved['ha/model-a'], rating_avg: null, rating_n: 0 },
      'hb/model-b': { ...sharedObserved['hb/model-b'], rating_avg: null, rating_n: 0 },
    },
  },
});
assert.deepEqual(
  project(withEmptyRatings),
  project(withoutRatings),
  'rating_n = 0 keeps the exact previous scores and reasons',
);

const ratedPick = selectModelPick({
  role: 'implement',
  harnesses,
  modelsByHarness,
  history: {
    observed: {
      'ha/model-a': { ...sharedObserved['ha/model-a'], rating_avg: 1, rating_n: 5 },
      'hb/model-b': { ...sharedObserved['hb/model-b'], rating_avg: 5, rating_n: 5 },
    },
  },
});
const ratedA = ratedPick.candidates.find((row) => row.harness === 'ha');
const ratedB = ratedPick.candidates.find((row) => row.harness === 'hb');
assert.equal(ratedA.rating_applied, true);
assert.equal(ratedB.rating_applied, true);
assert.ok(ratedA.score < ratedB.score, 'a low star average lowers the score');
// share = 0.25 * 5/(5+5) = 0.125; quality 5 → 4.5 for the 1-star model:
// delta = 0.25 * (4.5 - 5) / 5 = -0.025 (quality weight of implement = 0.25).
assert.ok(
  Math.abs((ratedB.score - ratedA.score) - 0.025) < 1e-9,
  'the recorded formula gives a 0.025 spread at n=5, share 0.125',
);
assert.match(ratedA.reason, /rating 1\.00 \(n=5\)/);

// Review: the verdict-based quality blend stays off, ratings still apply.
const reviewModels = {
  ha: { favorites_configured: true, items: [{ id: 'model-a', roles: ['review'], cost_tier: 2, quality_tier: 4, speed_tier: 3 }] },
  hb: { favorites_configured: true, items: [{ id: 'model-b', roles: ['review'], cost_tier: 2, quality_tier: 4, speed_tier: 3 }] },
};
const reviewBaseline = selectModelPick({
  role: 'review',
  harnesses,
  modelsByHarness: reviewModels,
  history: {
    prior: { infra_fail_rate: 0, role: 'review' },
    observed: {
      'ha/model-a': { n: 10, pass_rate: 1, infra_fail_rate: 0, quality: 5 },
      'hb/model-b': { n: 10, pass_rate: 1, infra_fail_rate: 0, quality: 5 },
    },
  },
});
const reviewRated = selectModelPick({
  role: 'review',
  harnesses,
  modelsByHarness: reviewModels,
  history: {
    prior: { infra_fail_rate: 0, role: 'review' },
    observed: {
      'ha/model-a': { n: 10, pass_rate: 1, infra_fail_rate: 0, quality: 5, rating_avg: 5, rating_n: 5 },
      'hb/model-b': { n: 10, pass_rate: 1, infra_fail_rate: 0, quality: 5, rating_avg: 1, rating_n: 5 },
    },
  },
});
const reviewBaselineA = reviewBaseline.candidates.find((row) => row.harness === 'ha');
const reviewBaselineB = reviewBaseline.candidates.find((row) => row.harness === 'hb');
assert.equal(
  reviewBaselineA.score,
  reviewBaselineB.score,
  'without ratings review candidates of the same tier stay equal',
);
const reviewRatedA = reviewRated.candidates.find((row) => row.harness === 'ha');
const reviewRatedB = reviewRated.candidates.find((row) => row.harness === 'hb');
assert.ok(
  reviewRatedA.score > reviewRatedB.score,
  'ratings move review quality even though the verdict blend is disabled',
);
assert.equal(reviewRatedA.rating_applied, true);

// --- 7. MCP delegation_rate: schema + in-process parent channel -------------
const rateTool = DELEGATION_MCP_TOOLS.find((tool) => tool.name === 'delegation_rate');
assert.ok(rateTool, 'delegation_rate is registered');
assert.equal(rateTool.readOnly, false, 'a rating is a write and needs Agent mode');
assert.equal(rateTool.inputSchema.properties.rater, undefined, 'the rater is never an input');
assert.deepEqual([...rateTool.inputSchema.properties.tags.items.enum].sort(), [...DELEGATION_RATING_TAGS].sort());
assert.deepEqual([...rateTool.inputSchema.required].sort(), ['delegation_id', 'score']);

const inProcess = createInProcessMcpClient({
  harness: 'opencode',
  chatId: parent.id,
  workspaceFolder: workspace,
});
const parentHandlers = createCretliMcpToolHandlers(inProcess, {
  chatId: parent.id,
  workspaceFolder: workspace,
  mode: 'agent',
});

const parentToolOk = await parentHandlers.delegation_rate({
  delegation_id: jobMcp.id,
  score: 3,
  tags: ['too_slow'],
  note: 'rework took a while',
});
assert.equal(parentToolOk.isError, false);
assert.equal(parentToolOk.structuredContent.rater, 'parent');
assert.equal(parentToolOk.structuredContent.replayed, false);

const parentToolReplay = await parentHandlers.delegation_rate({
  delegation_id: jobMcp.id,
  score: 3,
  tags: ['too_slow'],
  note: 'rework took a while',
});
assert.equal(parentToolReplay.isError, false);
assert.equal(parentToolReplay.structuredContent.replayed, true);

const parentToolConflict = await parentHandlers.delegation_rate({
  delegation_id: jobMcp.id,
  score: 5,
});
assert.equal(parentToolConflict.isError, true);
assert.equal(parentToolConflict.structuredContent.code, 'CONFLICT');

const runningTool = await parentHandlers.delegation_rate({ delegation_id: running.id, score: 5 });
assert.equal(runningTool.isError, true);
assert.match(runningTool.content[0].text, /finished job/i);

const biasTool = await parentHandlers.delegation_rate({ delegation_id: jobBias.id, score: 5 });
assert.equal(biasTool.isError, true);
assert.match(biasTool.content[0].text, /own base model/i);

const childHandlers = createCretliMcpToolHandlers(createInProcessMcpClient({
  harness: 'sdk',
  chatId: child.id,
  workspaceFolder: workspace,
}), { chatId: child.id, workspaceFolder: workspace, mode: 'agent' });
const childTool = await childHandlers.delegation_rate({ delegation_id: jobParent.id, score: 5 });
assert.equal(childTool.isError, true);
assert.match(childTool.content[0].text, /CONFLICT/i);

const otherHandlers = createCretliMcpToolHandlers(createInProcessMcpClient({
  harness: 'sdk',
  chatId: other.id,
  workspaceFolder: workspace,
}), { chatId: other.id, workspaceFolder: workspace, mode: 'agent' });
const otherTool = await otherHandlers.delegation_rate({ delegation_id: jobParent.id, score: 5 });
assert.equal(otherTool.isError, true);
assert.match(otherTool.content[0].text, /OUT_OF_SCOPE/i);

const planHandlers = createCretliMcpToolHandlers(inProcess, {
  chatId: parent.id,
  workspaceFolder: workspace,
  mode: 'plan',
});
const planTool = await planHandlers.delegation_rate({ delegation_id: jobParent.id, score: 2 });
assert.equal(planTool.isError, true);
assert.equal(planTool.structuredContent.code, 'PLAN_MODE_DENIED');

// --- 8. Remote transport: the same tool over HTTP ---------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const reply = (status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const readBody = () => new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += String(chunk); });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
  if (req.method === 'POST' && url.pathname === '/api/login') {
    req.resume();
    req.on('end', () => reply(200, { ok: true, csrfToken: 'csrf' }, {
      'Set-Cookie': 'cr_session=tok; Path=/; HttpOnly',
    }));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/chats') {
    return reply(200, { ok: true, chats: [parent, child, other] });
  }
  // Dispatch through the real registered route handlers.
  for (const [key, handler] of routes) {
    const [method, pattern] = key.split(' ');
    if (method !== req.method) continue;
    const patternParts = pattern.split('/');
    const pathParts = url.pathname.split('/');
    if (patternParts.length !== pathParts.length) continue;
    const params = {};
    let matched = true;
    for (let i = 0; i < patternParts.length; i += 1) {
      if (patternParts[i].startsWith(':')) {
        params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
      } else if (patternParts[i] !== pathParts[i]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    const body = await readBody();
    let status = 200;
    let payload;
    const resAdapter = {
      status(code) { status = code; return this; },
      json(value) { payload = value; return this; },
    };
    try {
      await handler({
        params,
        query: Object.fromEntries(url.searchParams),
        body,
        widgetAccess: undefined,
      }, resAdapter);
    } catch (err) {
      reply(500, { ok: false, error: String(err?.message || err) });
      return;
    }
    reply(status, payload || {});
    return;
  }
  reply(404, { ok: false, error: 'Not found' });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
try {
  const remote = new CretliApiClient({ baseUrl: `http://127.0.0.1:${port}`, password: 'good' });
  const remoteHandlers = createCretliMcpToolHandlers(remote, {
    chatId: parent.id,
    workspaceFolder: workspace,
    mode: 'agent',
  });
  const jobRemote = terminalJob();
  const remoteOk = await remoteHandlers.delegation_rate({
    delegation_id: jobRemote.id,
    score: 4,
    tags: ['false_positive'],
  });
  assert.equal(remoteOk.isError, false, `remote rate failed: ${remoteOk.content?.[0]?.text}`);
  assert.equal(remoteOk.structuredContent.rater, 'parent');
  assert.equal(findDelegationRating(jobRemote.id, 'parent').score, 4);

  const remoteConflict = await remoteHandlers.delegation_rate({
    delegation_id: jobRemote.id,
    score: 1,
  });
  assert.equal(remoteConflict.isError, true, 'a changed payload maps to a structured conflict');
  assert.equal(remoteConflict.structuredContent.code, 'CONFLICT');

  const jobRemoteChild = terminalJob();
  const remoteChildHandlers = createCretliMcpToolHandlers(remote, {
    chatId: child.id,
    workspaceFolder: workspace,
    mode: 'agent',
  });
  const remoteChild = await remoteChildHandlers.delegation_rate({
    delegation_id: jobRemoteChild.id,
    score: 5,
  });
  assert.equal(remoteChild.isError, true, 'the child session is rejected over the remote transport too');
} finally {
  server.close();
}

removeIsolatedDataDir();
console.log('delegation-ratings.test.js OK');
