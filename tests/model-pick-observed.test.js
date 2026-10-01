/**
 * Task 3 of the "Delegacja v2" plan: observed outcomes from delegation history
 * (per harness x base model x role) fed back into model_pick.
 *
 * `summarizeDelegationOutcomes` is pure (rows injected), so every fixture here
 * is an in-memory delegation record; `selectModelPick` gets the stats through
 * `history.observed` exactly like `buildModelPickHistory` supplies them.
 */

import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  OBSERVED_WINDOW_MS,
  buildDelegationOutcomes,
  buildModelPickHistory,
  rolePriorInfra,
  summarizeDelegationOutcomes,
  summarizeReviewTestObservations,
} from '../lib/model-pick-history.js';
import {
  loadAdaptiveConfig,
  normalizeAdaptiveConfig,
  selectModelPick,
} from '../lib/model-role-profiles.js';
import { createCretliMcpToolHandlers } from '../lib/mcp/mcp-builtin-tools.js';

const now = Date.parse('2026-10-01T12:00:00.000Z');
const minutesAgo = (m) => new Date(now - (m * 60000)).toISOString();
let chatSeq = 0;
const nextChat = () => `observed-chat-${process.pid}-${chatSeq++}`;
const verdictReport = (verdict) => `TASK: review\nVERDICT: ${verdict}\n`;

/**
 * @param {object} overrides
 * @returns {object}
 */
function delegationRow(overrides) {
  return {
    parentChatId: nextChat(),
    workspaceFolder: '/tmp/observed',
    status: 'completed',
    executionMode: 'agent',
    createdAt: minutesAgo(1),
    ...overrides,
  };
}

// --- summarizeDelegationOutcomes: implement quality comes from the NEXT review --
const selfPassChat = nextChat();
const selfPassRows = [
  delegationRow({
    parentChatId: selfPassChat,
    assignment: 'implement',
    report: 'TASK: implement\nVERDICT: PASS\n',
    executor: { transport: 'deepseek', model: 'deepseek-flash' },
    createdAt: minutesAgo(40),
    startedAt: minutesAgo(40),
    finishedAt: minutesAgo(34),
  }),
  delegationRow({
    parentChatId: selfPassChat,
    assignment: 'review',
    report: verdictReport('FAIL'),
    executor: { transport: 'sdk', model: 'grok-4.7' },
    createdAt: minutesAgo(30),
    startedAt: minutesAgo(30),
    finishedAt: minutesAgo(26),
  }),
];
const selfPass = summarizeDelegationOutcomes({ rows: selfPassRows, now });
const selfPassImpl = selfPass.roles.implement['deepseek/deepseek-flash'];
assert.equal(selfPassImpl.n, 1);
assert.equal(selfPassImpl.decided, 1, 'the implement cycle has one review');
assert.equal(selfPassImpl.pass_rate, 0, 'own VERDICT: PASS must not count when the next review FAILs');
assert.equal(selfPassImpl.quality, 1, 'observed quality is the review-confirmed rate (1..5)');
assert.equal(selfPassImpl.median_min, 6, 'median uses startedAt -> finishedAt over completed jobs');
assert.equal(selfPassImpl.p95_min, 6);

const selfFailChat = nextChat();
const selfFailRows = [
  delegationRow({
    parentChatId: selfFailChat,
    assignment: 'implement',
    report: 'TASK: implement\nVERDICT: FAIL\n',
    executor: { transport: 'deepseek', model: 'deepseek-flash' },
    createdAt: minutesAgo(40),
  }),
  delegationRow({
    parentChatId: selfFailChat,
    assignment: 'review',
    report: verdictReport('PASS'),
    executor: { transport: 'sdk', model: 'grok-4.7' },
    createdAt: minutesAgo(30),
  }),
];
const selfFail = summarizeDelegationOutcomes({ rows: selfFailRows, now });
assert.equal(
  selfFail.roles.implement['deepseek/deepseek-flash'].pass_rate,
  1,
  'own VERDICT: FAIL must not count when the next review PASSes',
);

// --- Late adapter noise on a completed review is not infra ---
const lateNoise = summarizeDelegationOutcomes({
  rows: [
    delegationRow({
      assignment: 'review',
      report: verdictReport('FAIL'),
      executor: { transport: 'claude', model: 'claude-sonnet-5-5::effort=medium' },
      errors: [{ code: 'adapter_after_terminal', message: '[adapter_incomplete] Review ended without a VERDICT report.' }],
    }),
    delegationRow({
      assignment: 'review',
      report: verdictReport('PASS'),
      executor: { transport: 'claude', model: 'claude-sonnet-5-5::effort=medium' },
      errors: [{ code: 'adapter_after_terminal', message: 'Aborted' }],
    }),
  ],
  now,
});
assert.equal(
  lateNoise.roles.review['claude/claude-sonnet-5-5'].infra_fail_rate,
  0,
  'adapter_after_terminal entries on a completed job with a VERDICT are not infra',
);

// --- Fanout: PASS + FAIL in one cycle is a FAIL for the implement ---
const fanoutChat = nextChat();
const fanoutRows = [
  delegationRow({
    parentChatId: fanoutChat,
    assignment: 'implement',
    executor: { transport: 'deepseek', model: 'deepseek-flash' },
    createdAt: minutesAgo(40),
  }),
  delegationRow({
    parentChatId: fanoutChat,
    assignment: 'review',
    report: verdictReport('PASS'),
    executor: { transport: 'sdk', model: 'grok-4.7' },
    createdAt: minutesAgo(30),
  }),
  delegationRow({
    parentChatId: fanoutChat,
    assignment: 'review',
    report: verdictReport('FAIL'),
    executor: { transport: 'sdk', model: 'grok-4.6' },
    createdAt: minutesAgo(29),
  }),
];
const fanout = summarizeDelegationOutcomes({ rows: fanoutRows, now });
assert.equal(
  fanout.roles.implement['deepseek/deepseek-flash'].decided,
  1,
  'a fanout is one implement cycle',
);
assert.equal(
  fanout.roles.implement['deepseek/deepseek-flash'].pass_rate,
  0,
  'a PASS+FAIL fanout must not count as an implement PASS',
);

// Implement with no following review is excluded from the pass_rate denominator.
const noReviewRows = [
  delegationRow({
    assignment: 'implement',
    executor: { transport: 'deepseek', model: 'deepseek-flash' },
    createdAt: minutesAgo(10),
  }),
];
const noReview = summarizeDelegationOutcomes({ rows: noReviewRows, now });
assert.equal(noReview.roles.implement['deepseek/deepseek-flash'].n, 1);
assert.equal(noReview.roles.implement['deepseek/deepseek-flash'].decided, 0);
assert.equal(noReview.roles.implement['deepseek/deepseek-flash'].pass_rate, null);

// --- Review usefulness: FAIL + fix + next PASS is useful; FAIL + fix + FAIL is not --
const usefulChat = nextChat();
const usefulRows = [
  delegationRow({
    parentChatId: usefulChat,
    assignment: 'review',
    report: verdictReport('FAIL'),
    executor: { transport: 'sdk', model: 'grok-4.7' },
    createdAt: minutesAgo(50),
  }),
  delegationRow({
    parentChatId: usefulChat,
    assignment: 'implement',
    executor: { transport: 'deepseek', model: 'deepseek-flash' },
    createdAt: minutesAgo(40),
  }),
  delegationRow({
    parentChatId: usefulChat,
    assignment: 'review',
    report: verdictReport('PASS'),
    executor: { transport: 'sdk', model: 'grok-4.7' },
    createdAt: minutesAgo(30),
  }),
];
const useful = summarizeDelegationOutcomes({ rows: usefulRows, now });
const usefulGrok = useful.roles.review['sdk/grok-4.7'];
assert.equal(usefulGrok.verdict_fail_rate, 0.5, 'one of two decided reviews is FAIL');
assert.equal(usefulGrok.useful_rate, 1, 'the FAIL was confirmed by a fix followed by PASS');
assert.equal(usefulGrok.quality, 5);

const unproductiveChat = nextChat();
const unproductiveRows = [
  delegationRow({
    parentChatId: unproductiveChat,
    assignment: 'review',
    report: verdictReport('FAIL'),
    executor: { transport: 'sdk', model: 'grok-4.7' },
    createdAt: minutesAgo(50),
  }),
  delegationRow({
    parentChatId: unproductiveChat,
    assignment: 'implement',
    executor: { transport: 'deepseek', model: 'deepseek-flash' },
    createdAt: minutesAgo(40),
  }),
  delegationRow({
    parentChatId: unproductiveChat,
    assignment: 'review',
    report: verdictReport('FAIL'),
    executor: { transport: 'sdk', model: 'grok-4.7' },
    createdAt: minutesAgo(30),
  }),
];
const unproductive = summarizeDelegationOutcomes({ rows: unproductiveRows, now });
assert.equal(
  unproductive.roles.review['sdk/grok-4.7'].useful_rate,
  0,
  'a FAIL whose next review also FAILs is not useful',
);

// --- Infra classification -----------------------------------------------------
const infraRows = [
  delegationRow({
    assignment: 'review',
    status: 'cancelled',
    error: '',
    report: '',
    executor: { transport: 'sdk', model: 'grok-4.7' },
    createdAt: minutesAgo(20),
  }),
  delegationRow({
    assignment: 'review',
    status: 'failed',
    error: '[adapter_incomplete] Review ended without a VERDICT report.',
    report: '',
    executor: { transport: 'opencode', model: 'zai-coding-plan/glm-5.3' },
    createdAt: minutesAgo(19),
  }),
  delegationRow({
    assignment: 'review',
    status: 'completed',
    report: 'A long review report with plenty of prose but no verdict line at all. '.repeat(20),
    executor: { transport: 'sdk', model: 'grok-4.6' },
    createdAt: minutesAgo(18),
  }),
  delegationRow({
    assignment: 'review',
    status: 'failed',
    error: "You've hit your usage limit. Upgrade to Pro",
    report: '',
    executor: { transport: 'codex', model: 'gpt-6-astra' },
    createdAt: minutesAgo(17),
  }),
  delegationRow({
    assignment: 'review',
    status: 'failed',
    error: 'OpenCode prompt first event timed out',
    report: '',
    executor: { transport: 'opencode', model: 'zai-coding-plan/glm-5.3-flash' },
    createdAt: minutesAgo(16),
  }),
];
const infra = summarizeDelegationOutcomes({ rows: infraRows, now });
assert.equal(infra.roles.review['sdk/grok-4.7'].infra_fail_rate, 1, 'a parent cancel counts as infra');
assert.equal(infra.roles.review['opencode/zai-coding-plan/glm-5.3'].infra_fails, 1);
assert.equal(infra.roles.review['sdk/grok-4.6'].infra_fails, 1, 'a review without a VERDICT is infra');
assert.equal(infra.roles.review['codex/gpt-6-astra'].infra_fails, 1, 'a usage limit is infra');
assert.equal(infra.roles.review['opencode/zai-coding-plan/glm-5.3-flash'].infra_fails, 1, 'a timeout is infra');

// Implement self-verdict is not part of the infra contract.
const implementNoVerdict = summarizeDelegationOutcomes({
  rows: [delegationRow({
    assignment: 'implement',
    status: 'completed',
    report: 'A normal implement report without a VERDICT line. '.repeat(20),
    executor: { transport: 'deepseek', model: 'deepseek-flash' },
    createdAt: minutesAgo(5),
  })],
  now,
});
assert.equal(
  implementNoVerdict.roles.implement['deepseek/deepseek-flash'].infra_fails,
  0,
  'a missing self-verdict in an implement report is not infra',
);

// Non-terminal rows (queued/starting/running) are not outcomes yet: they count
// neither as infra nor in any denominator.
const liveRows = [
  delegationRow({
    assignment: 'review',
    status: 'running',
    error: 'OpenCode prompt first event timed out',
    report: '',
    executor: { transport: 'sdk', model: 'grok-4.7' },
    createdAt: minutesAgo(4),
  }),
  delegationRow({
    assignment: 'implement',
    status: 'queued',
    executor: { transport: 'deepseek', model: 'deepseek-flash' },
    createdAt: minutesAgo(3),
  }),
  delegationRow({
    assignment: 'implement',
    status: 'starting',
    executor: { transport: 'deepseek', model: 'deepseek-flash' },
    createdAt: minutesAgo(2),
  }),
];
const liveOnly = summarizeDelegationOutcomes({ rows: liveRows, now });
assert.equal(liveOnly.list.length, 0, 'non-terminal rows contribute nothing');
const livePlusDone = summarizeDelegationOutcomes({
  rows: [
    ...liveRows,
    delegationRow({
      assignment: 'implement',
      status: 'completed',
      executor: { transport: 'deepseek', model: 'deepseek-flash' },
      createdAt: minutesAgo(1),
    }),
  ],
  now,
});
assert.equal(livePlusDone.roles.implement['deepseek/deepseek-flash'].n, 1, 'only the terminal row counts');
assert.equal(livePlusDone.roles.implement['deepseek/deepseek-flash'].infra_fails, 0);

// A review report that merely mentions a rate limit is not an infra signal:
// only the row's `error` string and structured `errors` entries are scanned.
const reportMentionsLimit = summarizeDelegationOutcomes({
  rows: [delegationRow({
    assignment: 'review',
    status: 'completed',
    report: 'TASK: review\nVERDICT: PASS\n\nProvider hit a rate limit mid-run but recovered.\n',
    executor: { transport: 'sdk', model: 'grok-4.7' },
    createdAt: minutesAgo(2),
  })],
  now,
});
assert.equal(
  reportMentionsLimit.roles.review['sdk/grok-4.7'].infra_fails,
  0,
  'report prose is not an infra signal',
);
assert.equal(reportMentionsLimit.roles.review['sdk/grok-4.7'].pass_rate, 1);

const structuredLimit = summarizeDelegationOutcomes({
  rows: [delegationRow({
    assignment: 'review',
    status: 'failed',
    error: '',
    errors: [{ code: 'quota', message: "You've hit your usage limit. Upgrade to Pro" }],
    report: '',
    executor: { transport: 'codex', model: 'gpt-6-astra' },
    createdAt: minutesAgo(2),
  })],
  now,
});
assert.equal(
  structuredLimit.roles.review['codex/gpt-6-astra'].infra_fails,
  1,
  'a usage limit in errors[] is still infra',
);

// --- Role prior: job-weighted mean over pairs with data ----------------------
assert.equal(rolePriorInfra({}), 0, 'an empty role has a 0 prior');
assert.equal(
  rolePriorInfra({
    'a/m': { n: 10, infra_fail_rate: 0.5 },
    'b/m': { n: 30, infra_fail_rate: 0.1 },
    'c/m': { n: 0, infra_fail_rate: 1 },
  }),
  0.2,
  'the prior weights each pair by its job count and ignores n=0 pairs',
);
const craftedOutcomes = {
  roles: {
    implement: {
      'ha/model-a': { n: 10, infra_fail_rate: 0.5 },
      'hb/model-b': { n: 30, infra_fail_rate: 0.1 },
    },
    review: {},
    plan: {},
  },
};
const priorHistory = buildModelPickHistory({
  role: 'implement',
  delegations: [],
  outcomes: craftedOutcomes,
  now,
});
assert.equal(
  priorHistory.prior.infra_fail_rate,
  0.2,
  'buildModelPickHistory passes the job-weighted role prior through history.prior',
);
assert.equal(priorHistory.prior.role, 'implement');

// Older rows outside the window are ignored; the window is overridable.
const windowOut = summarizeDelegationOutcomes({ rows: selfPassRows, now, windowMs: 1000 });
assert.equal(windowOut.list.length, 0, 'a 1s window drops rows from minutes ago');
assert.equal(OBSERVED_WINDOW_MS, 30 * 24 * 60 * 60 * 1000);

// --- selectModelPick: 50% infra fail drops a same-tier model -----------------
const harnesses = [
  { id: 'ha', enabled: true, ready: true, can_delegate: true },
  { id: 'hb', enabled: true, ready: true, can_delegate: true },
];
const modelsByHarness = {
  ha: {
    favorites_configured: true,
    items: [{ id: 'model-a', roles: ['implement'], cost_tier: 2, quality_tier: 4, speed_tier: 3 }],
  },
  hb: {
    favorites_configured: true,
    items: [{ id: 'model-b', roles: ['implement'], cost_tier: 2, quality_tier: 4, speed_tier: 3 }],
  },
};
const observedBoth = {
  'ha/model-a': { n: 10, pass_rate: 0.5, infra_fail_rate: 0.5, median_min: 5, quality: 3 },
  'hb/model-b': { n: 10, pass_rate: 1, infra_fail_rate: 0, median_min: 4, quality: 5 },
};
// Review skips the quality blend (every PASS counts as productive, so it would
// reward lenient reviewers); only the infra term moves the score.
const reviewModels = {
  ha: { favorites_configured: true, items: [{ ...modelsByHarness.ha.items[0], roles: ['review'] }] },
  hb: { favorites_configured: true, items: [{ ...modelsByHarness.hb.items[0], roles: ['review'] }] },
};
const reviewPick = selectModelPick({
  role: 'review',
  harnesses,
  modelsByHarness: reviewModels,
  rotation: 'off',
  history: {
    observed: {
      'ha/model-a': { n: 10, pass_rate: 1, infra_fail_rate: 0, quality: 5 },
      'hb/model-b': { n: 10, pass_rate: 0, infra_fail_rate: 0, quality: 1 },
    },
    prior: { infra_fail_rate: 0, role: 'review' },
  },
});
assert.equal(
  reviewPick.candidates.find((row) => row.harness === 'ha').score,
  reviewPick.candidates.find((row) => row.harness === 'hb').score,
  'review quality from verdicts does not change the score',
);

const heuristicOnly = selectModelPick({
  role: 'implement',
  harnesses,
  modelsByHarness,
  adaptive: false,
});
assert.equal(
  heuristicOnly.pick.score,
  heuristicOnly.candidates.find((row) => row.harness === 'hb').score,
  'same tiers start from the same heuristic score',
);

const adaptivePick = selectModelPick({
  role: 'implement',
  harnesses,
  modelsByHarness,
  history: { observed: observedBoth },
  adaptive: true,
});
assert.equal(adaptivePick.pick.harness, 'hb', 'the 50% infra-fail model drops below its same-tier rival');
const loser = adaptivePick.candidates.find((row) => row.harness === 'ha');
const winner = adaptivePick.candidates.find((row) => row.harness === 'hb');
assert.ok(loser.score < winner.score, 'infra penalty and quality blend lower the score');
assert.equal(loser.observed.infra_fail_rate, 0.5);
assert.equal(loser.observed.n, 10);
assert.equal(loser.observed.median_min, 5);
assert.equal(loser.observed.pass_rate, 0.5);
assert.match(loser.reason, /infra fail 50% \(n=10\) penalized/);

const metricsObserved = selectModelPick({
  role: 'implement',
  harnesses,
  modelsByHarness,
  history: {
    observed: {
      'ha/model-a': {
        n: 8,
        pass_rate: 0.75,
        infra_fail_rate: 0,
        median_min: 4,
        quality: 4,
        median_tokens_per_sec: 22.5,
        median_tool_calls: 9,
        median_files_changed: 2,
      },
    },
  },
  adaptive: false,
});
const metricsCand = metricsObserved.candidates.find((row) => row.harness === 'ha');
assert.equal(metricsCand.observed.median_tokens_per_sec, 22.5);
assert.equal(metricsCand.observed.median_tool_calls, 9);
assert.equal(metricsCand.observed.median_files_changed, 2);
const reviewMetricsPick = selectModelPick({
  role: 'review',
  harnesses: [{ id: 'ha', label: 'HA', enabled: true, ready: true, can_delegate: true }],
  modelsByHarness: {
    ha: {
      favorites_configured: true,
      items: [{ id: 'model-a', roles: ['review'], cost_tier: 2, quality_tier: 4, speed_tier: 3 }],
    },
  },
  history: {
    observed: {
      'ha/model-a': {
        n: 3,
        pass_rate: 1,
        infra_fail_rate: 0,
        median_min: 2,
        quality: 5,
        median_tokens_per_sec: 11,
        median_tool_calls: null,
        median_files_changed: null,
      },
    },
  },
  adaptive: false,
});
assert.equal(reviewMetricsPick.candidates[0].observed.median_tokens_per_sec, 11);
assert.equal(reviewMetricsPick.candidates[0].observed.median_tool_calls, null);
assert.equal(reviewMetricsPick.candidates[0].observed.median_files_changed, null);
assert.match(adaptivePick.pick.reason, /observed changed ranking/);
assert.match(adaptivePick.pick.reason, /ha\/model-a/, 'the reason names the demoted pre-observed leader');

// --- Shrinkage to the role prior: no data is not a free pass -----------------
// Both candidates share the same tier, so the heuristic score is identical.
// `ha/model-a` has history whose infra rate equals the role prior; `hb/model-b`
// has no data at all. Both absorb the same prior penalty, so the measured model
// stays in band instead of losing purely because its rival has no data.
const withSharedPrior = (observed) => ({
  prior: { infra_fail_rate: 0.1 },
  observed,
});
const measuredPick = selectModelPick({
  role: 'implement',
  harnesses,
  modelsByHarness,
  history: withSharedPrior({
    'ha/model-a': { n: 20, pass_rate: 0.5, infra_fail_rate: 0.1, median_min: 5, quality: 3 },
  }),
});
const measuredCand = measuredPick.pick;
const noDataCand = measuredPick.candidates.find((row) => row.harness === 'hb');
assert.equal(noDataCand.observed, null, 'the rival has no observed block');
assert.ok(noDataCand.observed_penalty > 0, 'n=0 inherits the role prior instead of a free pass');
assert.ok(
  Math.abs(measuredCand.score - noDataCand.score) <= measuredPick.rotation.band,
  'history ≈ prior keeps the measured model inside the rotation band',
);
assert.equal(measuredCand.in_band, true);
assert.equal(noDataCand.in_band, true);
assert.equal(measuredPick.pick.harness, 'ha', 'the measured model is not beaten only by the rival having no data');

// Infra clearly above the prior still drops the model.
const abovePrior = selectModelPick({
  role: 'implement',
  harnesses,
  modelsByHarness,
  history: withSharedPrior({
    'ha/model-a': { n: 20, pass_rate: 0.5, infra_fail_rate: 0.6, median_min: 5, quality: 4 },
  }),
});
assert.equal(abovePrior.pick.harness, 'hb', 'infra well above the role prior loses the band');
assert.ok(
  abovePrior.candidates.find((row) => row.harness === 'ha').score
    < abovePrior.candidates.find((row) => row.harness === 'hb').score,
  'the above-prior infra penalty lowers the measured score',
);

// --- Fractional quality_tier leaves no residual offset ------------------------
// The quality term is replaced against the same clamped tier the heuristic
// score used, so a 4.4 tier blending down to 4 scores exactly like a 4 tier.
const fractionalModels = {
  ha: { favorites_configured: true, items: [{ id: 'model-a', roles: ['implement'], cost_tier: 2, quality_tier: 4.4, speed_tier: 3 }] },
  hb: { favorites_configured: true, items: [{ id: 'model-b', roles: ['implement'], cost_tier: 2, quality_tier: 4, speed_tier: 3 }] },
};
const fractionalPick = selectModelPick({
  role: 'implement',
  harnesses,
  modelsByHarness: fractionalModels,
  history: {
    prior: { infra_fail_rate: 0 },
    observed: {
      'ha/model-a': { n: 20, pass_rate: 1, infra_fail_rate: 0, median_min: 1, quality: 4 },
      'hb/model-b': { n: 20, pass_rate: 1, infra_fail_rate: 0, median_min: 1, quality: 4 },
    },
  },
});
const fractionalA = fractionalPick.candidates.find((row) => row.harness === 'ha');
const fractionalB = fractionalPick.candidates.find((row) => row.harness === 'hb');
assert.equal(fractionalA.quality_tier, 4.4);
assert.equal(fractionalA.score, fractionalB.score, 'blending against the scored tier avoids a fractional residual');

// --- Keep-winner stays in band despite an observed infra penalty --------------
// deepseek-flash is the proven winner in this chat (last review PASSed) but has
// an observed infra rate above a low role prior; hy3 has no data. Without the
// relaxed keep-winner band the penalised proven model would be rotated away.
const keepModels = {
  deepseek: { favorites_configured: true, items: [{ id: 'deepseek-flash', roles: ['implement'], cost_tier: 2, quality_tier: 4, speed_tier: 3 }] },
  codebuddy: { favorites_configured: true, items: [{ id: 'hy3', roles: ['implement'], cost_tier: 2, quality_tier: 4, speed_tier: 3 }] },
};
const keepHistory = {
  prior: { infra_fail_rate: 0.02 },
  chatUsage: {
    models: { 'deepseek/deepseek-flash': { count: 3, next_review_passed: true } },
  },
  observed: {
    'deepseek/deepseek-flash': { n: 63, pass_rate: 0.58, infra_fail_rate: 0.14, median_min: 5, quality: 3.32 },
  },
};
const keepPick = selectModelPick({
  role: 'implement',
  harnesses: [
    { id: 'deepseek', enabled: true, ready: true, can_delegate: true },
    { id: 'codebuddy', enabled: true, ready: true, can_delegate: true },
  ],
  modelsByHarness: keepModels,
  history: keepHistory,
});
const proven = keepPick.candidates.find((row) => row.harness === 'deepseek');
const coldRival = keepPick.candidates.find((row) => row.harness === 'codebuddy');
assert.ok(proven.score < coldRival.score, 'the observed penalty leaves the proven model below the cold rival');
assert.ok(
  proven.score >= coldRival.score - (2 * keepPick.rotation.band) - 1e-9,
  'the proven model is within the relaxed keep-winner band',
);
assert.equal(proven.in_band, true, 'keep-winner stays in band inside 2×band');
assert.equal(keepPick.pick.harness, 'deepseek', 'the proven winner is not rotated away by the observed penalty');
assert.match(keepPick.pick.reason, /keep winner \(last review PASS in chat\)/);

// Same penalty without the keep-winner signal: the proven model drops out of band.
const droppedHistory = {
  ...keepHistory,
  chatUsage: { models: { 'deepseek/deepseek-flash': { count: 3 } } },
};
const droppedPick = selectModelPick({
  role: 'implement',
  harnesses: [
    { id: 'deepseek', enabled: true, ready: true, can_delegate: true },
    { id: 'codebuddy', enabled: true, ready: true, can_delegate: true },
  ],
  modelsByHarness: keepModels,
  history: droppedHistory,
});
assert.equal(
  droppedPick.candidates.find((row) => row.harness === 'deepseek').in_band,
  false,
  'without keep-winner the penalised model is out of band',
);
assert.equal(droppedPick.pick.harness, 'codebuddy');

// --- adaptive: false restores pre-task-3 output ------------------------------

/**
 * @param {object} response
 * @returns {object}
 */
const projectPick = (response) => ({
  pick: `${response.pick.harness}/${response.pick.model}`,
  score: response.pick.score,
  rotation_score: response.pick.rotation_score,
  reason: response.pick.reason,
  order: response.candidates.map((row) => `${row.harness}/${row.model}`),
  scores: response.candidates.map((row) => row.score),
});

const adaptiveOffWithObserved = selectModelPick({
  role: 'implement',
  harnesses,
  modelsByHarness,
  history: { observed: observedBoth },
  adaptive: false,
});
const adaptiveOffWithout = selectModelPick({
  role: 'implement',
  harnesses,
  modelsByHarness,
  adaptive: false,
});
assert.deepEqual(
  projectPick(adaptiveOffWithObserved),
  projectPick(adaptiveOffWithout),
  'adaptive:false reproduces the pre-task-3 selection exactly',
);

// --- History wiring: buildModelPickHistory exposes observed for the role ------
const recentRows = [
  delegationRow({
    parentChatId: nextChat(),
    assignment: 'implement',
    executor: { transport: 'ha', model: 'model-a' },
    createdAt: minutesAgo(3),
  }),
  delegationRow({
    parentChatId: nextChat(),
    assignment: 'implement',
    executor: { transport: 'ha', model: 'model-a' },
    createdAt: minutesAgo(2),
  }),
  delegationRow({
    parentChatId: nextChat(),
    assignment: 'implement',
    executor: { transport: 'ha', model: 'model-a' },
    createdAt: minutesAgo(1),
  }),
];
const wiredHistory = buildModelPickHistory({
  role: 'implement',
  chatId: 'observed-wiring',
  harnesses: ['ha'],
  delegations: recentRows,
  now,
});
assert.equal(wiredHistory.observed['ha/model-a'].n, 3, 'history carries the observed map for the role');
assert.equal(
  wiredHistory.observed['ha/model-a'].decided,
  0,
  'implements without a review have no pass_rate denominator',
);
const fixHistory = buildModelPickHistory({
  role: 'fix',
  chatId: 'observed-wiring',
  harnesses: ['ha'],
  delegations: recentRows,
  now,
});
assert.equal(fixHistory.observed['ha/model-a'].n, 3, 'fix reads the shared implement stats');

// --- Review-test observation from review reports (prior vs observed) ----------
// Positive: a successful `review-verify` trace. Negative: an explicit "could not
// run" line. Only real (non-plan) review rows in the 30d window count.
const observationRows = [
  delegationRow({
    assignment: 'review',
    report: 'Testy: `node scripts/review-verify.js a b` → exit 0, 2/2 OK.',
    executor: { transport: 'opencode', model: 'glm-5.3' },
    createdAt: minutesAgo(10),
  }),
  delegationRow({
    assignment: 'review',
    report: 'Testy:`node scripts/review-verify.js a b` → OK.',
    executor: { transport: 'opencode', model: 'glm-5.3' },
    createdAt: minutesAgo(9),
  }),
  delegationRow({
    assignment: 'review',
    report: 'Testy: Nie uruchamiałem `review-verify` — no shell.',
    executor: { transport: 'sdk', model: 'grok-4.7' },
    createdAt: minutesAgo(8),
  }),
  delegationRow({
    assignment: 'review',
    report: 'Testy: Nie mogłem uruchomić `node scripts/review-verify.js`.',
    executor: { transport: 'sdk', model: 'grok-4.7' },
    createdAt: minutesAgo(7),
  }),
  delegationRow({
    assignment: 'review',
    report: verdictReport('PASS'),
    executor: { transport: 'qwen', model: 'qwen3.8' },
    createdAt: minutesAgo(6),
  }),
  delegationRow({
    assignment: 'implement',
    report: '`node scripts/review-verify.js` → exit 0 OK',
    executor: { transport: 'claude', model: 'claude-sonnet-5' },
    createdAt: minutesAgo(5),
  }),
  delegationRow({
    assignment: 'review',
    executionMode: 'plan',
    report: '`node scripts/review-verify.js` → OK',
    executor: { transport: 'codex', model: 'gpt-6-astra' },
    createdAt: minutesAgo(4),
  }),
  delegationRow({
    assignment: 'review',
    // The `VERDICT: …|BLOCKED` template must not count as a "blocked" signal.
    report: 'TASK: review\nVERDICT: PASS|FAIL|BLOCKED\n\nRan `node scripts/review-verify.js a` → OK.',
    executor: { transport: 'claude', model: 'claude-sonnet-5' },
    createdAt: minutesAgo(3),
  }),
];
const observations = summarizeReviewTestObservations(observationRows, { now });
assert.deepEqual(observations.opencode, { positive: 2, negative: 0 });
assert.deepEqual(observations.sdk, { positive: 0, negative: 2 });
assert.equal(observations.qwen, undefined, 'a report without a runner signal is not counted');
assert.deepEqual(
  observations.claude,
  { positive: 1, negative: 0 },
  'the verdict template "|BLOCKED" is not an inability signal and an implement row is ignored',
);
assert.equal(observations.codex, undefined, 'plan-mode reviews are ignored');
assert.equal(
  Object.keys(summarizeReviewTestObservations(observationRows, { now, windowMs: 1000 })).length,
  0,
  'rows outside the window are dropped',
);

const observationHistory = buildModelPickHistory({
  role: 'review',
  chatId: 'observation-chat',
  harnesses: ['sdk', 'opencode'],
  delegations: observationRows,
  now,
});
assert.deepEqual(
  observationHistory.reviewTestObservations.opencode,
  { positive: 2, negative: 0 },
  'buildModelPickHistory injects the per-harness observation counts',
);
assert.deepEqual(observationHistory.reviewTestObservations.sdk, { positive: 0, negative: 2 });
const observationPick = selectModelPick({
  role: 'review',
  harnesses: [
    { id: 'sdk', enabled: true, ready: true, can_delegate: true },
    { id: 'opencode', enabled: true, ready: true, can_delegate: true },
  ],
  modelsByHarness: {
    sdk: { favorites_configured: true, items: [{ id: 'glm-5.3', roles: ['review'], cost_tier: 2, quality_tier: 4, speed_tier: 3 }] },
    opencode: { favorites_configured: true, items: [{ id: 'glm-5.3', roles: ['review'], cost_tier: 2, quality_tier: 4, speed_tier: 3 }] },
  },
  history: observationHistory,
});
assert.equal(observationPick.pick.harness, 'opencode');
assert.equal(observationPick.pick.traits.review_can_run_tests_source, 'observed');
assert.equal(
  observationPick.candidates.find((row) => row.harness === 'sdk').traits.review_can_run_tests,
  false,
);
assert.equal(
  observationPick.candidates.find((row) => row.harness === 'sdk').traits.review_can_run_tests_source,
  'observed',
);

// --- Adaptive config: file flag + override -----------------------------------
const adaptiveFile = path.join(os.tmpdir(), `model-adaptive-${process.pid}.json`);
writeFileSync(adaptiveFile, JSON.stringify({ adaptive: { enabled: false } }), 'utf8');
assert.deepEqual(loadAdaptiveConfig({ filePath: adaptiveFile }), { enabled: false });
assert.deepEqual(normalizeAdaptiveConfig({ adaptive: { enabled: true } }), { enabled: true });
assert.deepEqual(normalizeAdaptiveConfig('bogus'), { enabled: true });
assert.deepEqual(normalizeAdaptiveConfig({ delegation: { adaptivePick: false } }), { enabled: false });

// `buildDelegationOutcomes` is the exported loader wrapper for the future UI.
const loaded = buildDelegationOutcomes({ rows: selfPassRows, now });
assert.equal(loaded.roles.implement['deepseek/deepseek-flash'].n, 1);

// --- Handler plumbing: `adaptive` argument and the observed block ------------
const handlerClient = {
  async listHarnessCatalog() {
    return [
      { id: 'ha', enabled: true, ready: true, can_delegate: true },
      { id: 'hb', enabled: true, ready: true, can_delegate: true },
    ];
  },
  async listHarnessModels({ harness }) {
    return modelsByHarness[harness];
  },
};
const handlers = createCretliMcpToolHandlers(handlerClient, { chatId: 'observed-handler', mode: 'agent' });
const handlerPick = await handlers.model_pick({ role: 'implement' });
assert.equal(handlerPick.isError, false);
assert.ok(
  handlerPick.structuredContent.candidates.every((row) => Object.prototype.hasOwnProperty.call(row, 'observed')),
  'every candidate exposes an observed block (null when no data)',
);
const handlerAdaptiveOff = await handlers.model_pick({ role: 'implement', adaptive: false });
assert.equal(handlerAdaptiveOff.isError, false, 'the adaptive argument is accepted by model_pick');

removeIsolatedDataDir();
console.log('model-pick-observed.test.js OK');
