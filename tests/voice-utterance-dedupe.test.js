import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { decideEmit } from '../app_front/features/voice/utteranceDedupe.js';

test('decideEmit emits the full candidate when coverage is empty', () => {
  assert.deepEqual(decideEmit('', 'Run The Test'), { emit: 'Run The Test', covered: 'run the test' });
});

test('decideEmit emits only words beyond an exact word prefix', () => {
  assert.deepEqual(decideEmit('run the test', 'RUN THE TEST please'), {
    emit: 'please', covered: 'run the test please',
  });
});

test('decideEmit advances coverage for a longer revision sharing its first word', () => {
  assert.deepEqual(decideEmit('run the test', 'run the tests please'), {
    emit: '', covered: 'run the tests please',
  });
});

test('decideEmit keeps coverage when a candidate shrinks', () => {
  assert.deepEqual(decideEmit('run the tests please', 'run the'), {
    emit: '', covered: 'run the tests please',
  });
});

test('decideEmit does not re-emit words when a shrunken candidate regrows', () => {
  const shrunk = decideEmit('run the', 'run');
  assert.deepEqual(shrunk, { emit: '', covered: 'run the' });
  assert.deepEqual(decideEmit(shrunk.covered, 'run the'), { emit: '', covered: 'run the' });
});

test('decideEmit emits an unrelated new utterance', () => {
  assert.deepEqual(decideEmit('run the tests', 'Stop now'), { emit: 'Stop now', covered: 'stop now' });
});

test('decideEmit emits nothing for an already covered candidate', () => {
  assert.deepEqual(decideEmit('run the tests', 'RUN THE TESTS'), { emit: '', covered: 'run the tests' });
});
