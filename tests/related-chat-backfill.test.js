/**
 * Child-chat link backfill placement.
 *
 * The stream only mounts the last HISTORY window; metadata knows about every
 * child. Appending the unmounted ones put all older "Child chat" rows at the
 * bottom after a resume. A child link may only be placed next to the delegation
 * card that created it, otherwise it is skipped and its own history record
 * paints it inline later.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { planRelatedChatChildBackfill } from '../app_front/features/chat/relatedChatBackfill.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'app_front/lib/sdk-rich-view.js'), 'utf8');

test('an already mounted child card is left where it is', () => {
  const plan = planRelatedChatChildBackfill({
    children: [{ chatId: 'child-1' }, { chatId: 'child-2' }],
    hasRelatedCard: (chatId) => chatId === 'child-1',
    findAnchor: () => ({ id: 'delegation-card' }),
  });
  assert.deepEqual(plan.map((row) => row.chatId), ['child-2']);
});

test('a missing child is anchored to the delegation card that created it', () => {
  const anchor = { id: 'delegation-card' };
  const plan = planRelatedChatChildBackfill({
    children: [{ chatId: 'child-1', title: 'Task' }],
    hasRelatedCard: () => false,
    findAnchor: (chatId) => (chatId === 'child-1' ? anchor : null),
  });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].child.title, 'Task');
  assert.equal(plan[0].anchor, anchor);
});

test('a missing child without a mounted delegation card is skipped, never appended', () => {
  const plan = planRelatedChatChildBackfill({
    children: [
      { chatId: 'older-child' },
      { chatId: 'unrelated-child' },
    ],
    hasRelatedCard: () => false,
    findAnchor: () => null,
  });
  assert.deepEqual(plan, []);
});

test('empty and malformed child entries are ignored', () => {
  const plan = planRelatedChatChildBackfill({
    children: [null, {}, { chatId: '   ' }, { chatId: 'ok' }],
    hasRelatedCard: () => false,
    findAnchor: () => ({ id: 'anchor' }),
  });
  assert.deepEqual(plan.map((row) => row.chatId), ['ok']);
});

test('sdk-rich-view wires the child backfill to the anchor-only plan', () => {
  assert.match(source, /planRelatedChatChildBackfill/);
  assert.match(
    source,
    /findAnchor: \(chatId\) => findDelegationCardByChildChatId\(chatId\)/,
  );
  assert.match(source, /insertBefore: anchor/);
  assert.match(source, /data-child-chat-id/);
  assert.match(source, /card\.dataset\.childChatId = relatedChatDomId\(childChatId\)/);
  // The old loop appended every missing child at the stream tail.
  assert.doesNotMatch(source, /for \(const child of Array\.isArray\(input\.children\)/);
});

console.log('related-chat-backfill.test.js OK');
