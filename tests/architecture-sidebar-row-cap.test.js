import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRowCap, RENDERED_ROW_CAP } from '../scripts/architecture-sidebar-row-cap.mjs';

test('300 rendered rows with no exceptions satisfy the cap', () => {
  const state = classifyRowCap({ renderedRows: 300 });
  assert.equal(state.rowsOverCap, 0);
  assert.equal(state.unclassifiedRows, 0);
  assert.equal(state.rowCapOk, true);
});

test('303 rows explained by the three allowed exceptions satisfy the cap', () => {
  const state = classifyRowCap({ renderedRows: 303, allowedExceptions: 3 });
  assert.equal(RENDERED_ROW_CAP, 300);
  assert.equal(state.rowsOverCap, 3);
  assert.equal(state.unclassifiedRows, 0);
  assert.equal(state.rowCapOk, true);
});

test('303 rows with an unexplained ancestor row do not satisfy the cap', () => {
  const state = classifyRowCap({ renderedRows: 303, allowedExceptions: 2, ancestorRows: 1 });
  assert.equal(state.rowsOverCap, 3);
  assert.equal(state.unclassifiedRows, 1);
  assert.equal(state.ancestorDecisionOpen, true);
  assert.equal(state.rowCapOk, false);
});

test('320 rows exceed the cap even when one active row is allowed', () => {
  const state = classifyRowCap({ renderedRows: 320, allowedExceptions: 1 });
  assert.equal(state.rowsOverCap, 20);
  assert.equal(state.unclassifiedRows, 19);
  assert.equal(state.rowCapOk, false);
});

test('an active nested row below the cap does not veto a compliant state', () => {
  const state = classifyRowCap({ renderedRows: 41, allowedExceptions: 1, ancestorRows: 2 });
  assert.equal(state.rowsOverCap, 0);
  assert.equal(state.ancestorDecisionOpen, false);
  assert.equal(state.rowCapOk, true);
});

test('exceptions do not hide rows beyond them', () => {
  const state = classifyRowCap({ renderedRows: 310, allowedExceptions: 3 });
  assert.equal(state.rowsOverCap, 10);
  assert.equal(state.unclassifiedRows, 7);
  assert.equal(state.rowCapOk, false);
});
