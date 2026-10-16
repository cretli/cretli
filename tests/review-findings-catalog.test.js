import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { resolveReviewVerifyCatalog } from '../lib/sdk/sdk-review-verify.js';

// The audited-dir scan makes the review-findings tests valid review-verify ids
// without a curated entry; selection is by file basename.
const catalog = resolveReviewVerifyCatalog(undefined, { refresh: true });
for (const id of [
  'review-findings-parse',
  'review-findings-ledger',
  'review-findings-routes',
  'review-findings-catalog',
  'review-lessons-store',
  'review-lessons-service',
  'review-lessons-routes',
  'review-lessons-transport',
  'review-lessons-catalog',
  'review-lessons-select',
  'review-lessons-inject',
  'review-lessons-distill',
  'review-lessons-distill-trigger',
  'review-lessons-distill-transport',
  'review-findings-backfill',
  'review-lessons-feedback',
  'review-lessons-checks',
  'review-lessons-checks-transport',
]) {
  assert.equal(catalog[id], `tests/${id}.test.js`, `${id} selectable from the catalog`);
}
console.log('review-findings-catalog tests passed');
