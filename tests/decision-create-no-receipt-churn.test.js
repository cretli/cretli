import './helpers/isolated-data-dir.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ISOLATED_DATA_DIR as dataDir } from './helpers/isolated-data-dir.js';
import { closeDecisionStores, createDecision } from '../lib/decisions/decision-store.js';

after(() => closeDecisionStores());

const options = [{ id: 'yes', label: 'Yes', effect: 'Do it' }, { id: 'no', label: 'No', effect: 'Skip' }];
const input = (updatedAt) => ({
  kind: 'scout_finding', workspaceFolder: '/tmp/ws-receipt-churn', title: 'Finding', dedupeKey: 'scout:churn',
  subject: { findingId: 'churn', updatedAt }, options, recommended: 'yes',
});

function receiptCount() {
  const db = new DatabaseSync(path.join(dataDir, 'decisions', 'decisions.sqlite'), { readOnly: true });
  try {
    return Number(db.prepare('SELECT count(*) AS n FROM command_receipts').get().n);
  } finally {
    db.close();
  }
}

test('re-creating an existing card reads it back without writing another command receipt', async () => {
  const first = await createDecision(dataDir, input('1'));
  const receipts = receiptCount();
  for (let i = 0; i < 5; i += 1) {
    const again = await createDecision(dataDir, input('1'));
    assert.equal(again.id, first.id, 'the existing card is returned');
  }
  assert.equal(receiptCount(), receipts, 'gate refreshes of an existing card write no receipts');

  const next = await createDecision(dataDir, input('2'));
  assert.notEqual(next.id, first.id, 'a new subject revision still creates a new card');
  assert.equal(receiptCount(), receipts + 1);
});
