import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { createDelegationRecord, getDelegationById } from '../lib/persist/delegations-persist.js';

const LEAF = crypto.randomUUID();
const base = { parentChatId: 'p-ru', childChatId: 'c-ru' };

const certified = createDelegationRecord({ ...base, assignment: 'review', reviewUncertified: false, planReviewerSessionId: 's-1', leafId: LEAF });
const uncertified = createDelegationRecord({ ...base, assignment: 'review', reviewUncertified: true });
const legacy = createDelegationRecord({ ...base, assignment: 'implement' });

// Reload from the store (restart simulation: values come from persistence).
assert.equal(getDelegationById(certified.id).reviewUncertified, false);
assert.equal(getDelegationById(uncertified.id).reviewUncertified, true);
assert.equal(getDelegationById(legacy.id).reviewUncertified, null);
assert.equal(getDelegationById(certified.id).planReviewerSessionId, 's-1');
assert.equal(getDelegationById(certified.id).leafId, LEAF);
assert.equal(getDelegationById(legacy.id).planReviewerSessionId, '');
assert.equal(getDelegationById(legacy.id).planReviewerPhase, 'independent');
console.log('delegation-review-uncertified-persist.test.js OK');
