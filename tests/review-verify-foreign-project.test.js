/**
 * Review verify in a workspace that is not a Cretli checkout: Cretli's curated
 * catalog never applies there, a run with nothing to verify is "not
 * applicable" (not a failure), and such a project owes no parent verify.
 */
import './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  REVIEW_VERIFY_IDS,
  isCretliReviewVerifyProject,
  resolveDefaultReviewVerifyIds,
  resolveReviewVerifyCatalog,
  runReviewVerify,
} from '../lib/sdk/sdk-review-verify.ts';
import { resolveDelegationReviewVerifyPlan } from '../lib/delegation-review-verify-plan.js';

const cretliRoot = path.resolve(import.meta.dirname, '..');

/**
 * @param {string} prefix
 */
function createForeignProject(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('the curated catalog applies only to a Cretli checkout', () => {
  const foreignRoot = createForeignProject('verify-foreign-catalog-');
  try {
    assert.equal(isCretliReviewVerifyProject(cretliRoot), true);
    assert.equal(isCretliReviewVerifyProject(foreignRoot), false);
    assert.deepEqual(resolveDefaultReviewVerifyIds(cretliRoot), [...REVIEW_VERIFY_IDS]);
    assert.deepEqual(resolveDefaultReviewVerifyIds(foreignRoot), []);
    const actualCatalog = resolveReviewVerifyCatalog(foreignRoot);
    assert.equal(Object.prototype.hasOwnProperty.call(actualCatalog, REVIEW_VERIFY_IDS[0]), false);
  } finally {
    fs.rmSync(foreignRoot, { recursive: true, force: true });
  }
});

test('a run without ids in a foreign project is not applicable, not failed', async () => {
  const foreignRoot = createForeignProject('verify-foreign-run-');
  try {
    const actual = await runReviewVerify({ ids: [], projectRoot: foreignRoot });
    assert.equal(actual.notApplicable, true);
    assert.equal(actual.ok, false);
    assert.equal(actual.dataDir, '');
    const unknown = await runReviewVerify({ ids: [REVIEW_VERIFY_IDS[0]], projectRoot: foreignRoot });
    assert.equal(unknown.notApplicable, undefined);
    assert.match(unknown.error || '', /Unknown review verify id/);
  } finally {
    fs.rmSync(foreignRoot, { recursive: true, force: true });
  }
});

test('plan reviews and projects without verify tests owe no parent verify', () => {
  const planReview = resolveDelegationReviewVerifyPlan({
    assignment: 'review',
    executionMode: 'agent',
    transport: 'testfakeb',
    reviewSubject: 'plan',
  });
  assert.equal(planReview.applies, false);
  assert.equal(planReview.required, false);
  assert.equal(planReview.source, 'plan-review');
  const noTests = resolveDelegationReviewVerifyPlan({
    assignment: 'review',
    executionMode: 'agent',
    transport: 'testfakeb',
    reviewSubject: 'code',
    hasVerifyTests: false,
  });
  assert.equal(noTests.applies, true);
  assert.equal(noTests.required, false);
  const withTests = resolveDelegationReviewVerifyPlan({
    assignment: 'review',
    executionMode: 'agent',
    transport: 'testfakeb',
    reviewSubject: 'code',
    hasVerifyTests: true,
  });
  assert.equal(withTests.required, true);
});
