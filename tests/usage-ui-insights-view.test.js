/**
 * Render tests for the stage-8 usage insight panels. `t()` is a passthrough so
 * assertions read the i18n key directly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderChoicesHtml,
  renderCoverageHtml,
  renderSignalsHtml,
  renderTokenBucketsHtml,
} from '../app_front/features/usage/usageInsightsView.js';

const t = (key, params) => (params ? `${key}(${JSON.stringify(params)})` : key);

test('renderTokenBucketsHtml lists disjoint buckets and hides zero rows', () => {
  const html = renderTokenBucketsHtml({
    inputWithoutCache: 50,
    cacheRead: 900,
    cacheWrite: 0,
    outputWithoutReasoning: 80,
    reasoning: 20,
  }, { t, lang: 'en' });
  assert.match(html, /usage\.bucketInput/);
  assert.match(html, /usage\.bucketCacheRead/);
  assert.doesNotMatch(html, /usage\.bucketCacheWrite/);
  assert.match(html, /usage\.bucketsTotal/);
  assert.match(html, /900/);
});

test('renderTokenBucketsHtml shows an explicit empty state for no measurements', () => {
  const html = renderTokenBucketsHtml({}, { t, lang: 'en' });
  assert.match(html, /usage\.bucketsEmpty/);
  assert.doesNotMatch(html, /settings-usage-buckets/);
});

test('renderTokenBucketsHtml shows diagnostic reasoning beside the disjoint total', () => {
  const html = renderTokenBucketsHtml({
    inputWithoutCache: 100,
    outputWithoutReasoning: 50,
    reasoningDiagnosticTokens: 10,
  }, { t, lang: 'en' });
  // Total is the disjoint API total (150), never input + output + diagnostic.
  assert.match(html, /usage\.bucketsTotal\(\{&quot;value&quot;:&quot;150&quot;\}\)/);
  assert.match(html, /usage\.bucketReasoningDiagnostic/);
  assert.match(html, /usage\.bucketDiagnosticTag/);
  assert.match(html, /usage\.bucketsDiagnosticHint/);
});

test('renderCoverageHtml keeps both ratios with denominators and null as an em dash', () => {
  const html = renderCoverageHtml({
    endedWithUsage: { n: 3, denominator: 5, ratio: 0.6 },
    endedComplete: { n: 0, denominator: 0, ratio: null },
    byCompleteness: { complete: 3, partial: 2, missing: 0, unsupported: 0, unknown: 0 },
    runs: { active: 1 },
    legacy: { inferredWithoutRunStart: 2 },
    estimated: { runs: 0 },
    reportedZero: { runs: 0 },
  }, { t, lang: 'en' });
  assert.match(html, /usage\.coverageEndedWithUsage/);
  assert.match(html, /3\/5/);
  assert.match(html, /usage\.coverageEndedComplete/);
  assert.match(html, /—/);
  assert.match(html, /usage\.coverage_complete/);
  assert.doesNotMatch(html, /usage\.coverage_missing/);
});

test('renderChoicesHtml separates proposals from executions and renders groups', () => {
  const html = renderChoicesHtml({
    executed: 4,
    auto: 2,
    manual: 1,
    unknown: 1,
    proposals: 9,
    diagnosticPicks: 5,
    originDetails: { selected: 2, legacy: 1 },
    linkStatuses: { linked: 3 },
    groups: [
      { key: 'sdk/composer-2', harness: 'sdk', model: 'composer-2', executed: 3, auto: 2, manual: 1, unknown: 0, technicalSuccess: 2, technicalOutcomeKnown: 3, technicalSuccessRate: 0.6667 },
    ],
  }, { t, lang: 'en' });
  assert.match(html, /usage\.choicesMeta/);
  assert.match(html, /usage\.choices_auto/);
  assert.match(html, /usage\.originSelected/);
  assert.match(html, /sdk\/composer-2/);
  assert.match(html, /3/);
});

test('renderChoicesHtml marks an unreadable proposal store and an empty cohort', () => {
  const html = renderChoicesHtml({ executed: 0, proposals: null, diagnosticPicks: null, groups: [] }, { t, lang: 'en' });
  assert.match(html, /usage\.choicesProposalsUnknown/);
  assert.match(html, /usage\.choicesEmpty/);
});

test('renderSignalsHtml lists separate signal denominators and a partial-cost warning', () => {
  const html = renderSignalsHtml({
    technicalSuccess: { n: 3, denominator: 4 },
    acceptedByReview: { n: 2, denominator: 4 },
    manualAccepted: { n: 1, denominator: 4 },
    rejectedByReview: { n: 1, denominator: 4 },
    cost: { actualUsd: 2, estimatedUsd: 0.5, subscriptionEvents: 1, unpricedEvents: 2, partial: true },
  }, { t, lang: 'en' });
  assert.match(html, /usage\.signalTechnical/);
  assert.match(html, /usage\.signalAccepted/);
  assert.match(html, /usage\.signalManualAccepted/);
  assert.match(html, /usage\.costPartial/);
});
