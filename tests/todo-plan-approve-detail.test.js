import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeCachedDetail } from '../app_front/features/todo/todoDetailCache.js';
import { shouldOfferPlanApproval } from '../app_front/features/todo/planApprovalVisibility.js';

// A slim PATCH response ships a lean list row and the complete patched item; the
// panel seeds its detail cache from the item, so the row must merge back to the
// approved plan with no extra GET and the approval prompt must disappear.
test('a lean row merges with the cached patched item and hides the approval prompt', () => {
  const chats = [{ id: 'c1', lastAt: '2026-11-07T10:00:00Z' }];
  const lean = {
    id: 't1', updatedAt: 'U2', listSlim: true, chatCount: 1, latestChat: { id: 'c1' }, chatLastAt: '2026-11-07T10:00:00Z',
    plan: { markdown: 'preview', approvedAt: '2026-11-07T10:05:00Z' },
  };
  const detail = {
    updatedAt: 'U2', body: 'full body', changelog: [], chats,
    plan: { markdown: 'full plan', approvedAt: '2026-11-07T10:05:00Z' },
  };
  const merged = mergeCachedDetail(lean, detail);
  assert.equal(merged.listSlim, undefined);
  assert.equal(merged.plan.markdown, 'full plan');
  assert.equal(shouldOfferPlanApproval(merged), false);
  assert.equal(shouldOfferPlanApproval({ plan: { markdown: 'full plan' } }), true);
});

test('a detail cached before the approval is not merged into the newer lean row', () => {
  const lean = { id: 't1', updatedAt: 'U2', listSlim: true, plan: { markdown: 'p', approvedAt: 'x' } };
  const stale = { updatedAt: 'U1', plan: { markdown: 'p' } };
  assert.equal(mergeCachedDetail(lean, stale), lean);
});
