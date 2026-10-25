import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { resolveReviewVerifyCatalog } from '../lib/sdk/sdk-review-verify.ts';
const catalog = resolveReviewVerifyCatalog(undefined, { refresh: true });
for (const id of ['review-lessons-store', 'review-lessons-service', 'review-lessons-routes', 'review-lessons-transport', 'review-lessons-catalog', 'review-lessons-select', 'review-lessons-inject', 'review-lessons-distill', 'review-lessons-distill-trigger', 'review-lessons-distill-transport', 'review-lessons-privacy', 'review-findings-backfill', 'review-lessons-feedback', 'review-lessons-checks', 'review-lessons-checks-transport']) {
  assert.equal(catalog[id], `tests/${id}.test.js`, `${id} is selectable from the review-verify catalog`);
}
console.log('review-lessons-catalog tests passed');
