import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCatchUpSignature,
  enqueueCatchUpOutputChunk,
  drainCatchUpOutputChunks,
} from '../lib/catchup-flow.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES_FILE = resolve(ROOT, 'public/fixtures/chat-catchup-flow-scenarios.json');

function loadFixtures() {
  const raw = readFileSync(FIXTURES_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.scenarios)) {
    throw new Error('Invalid chat-catchup-flow fixtures format.');
  }
  return parsed.scenarios;
}

function testSignatureUsesMiddleChunk() {
  const head = 'H'.repeat(200);
  const tail = 'T'.repeat(200);
  const payloadA = `${head}__MIDDLE_A__${tail}`;
  const payloadB = `${head}__MIDDLE_B__${tail}`;
  const sigA = buildCatchUpSignature(payloadA);
  const sigB = buildCatchUpSignature(payloadB);
  assert.notEqual(sigA, sigB, 'Catch-up signature should detect a change in the middle of the payload');
  console.log('OK: signature uses middle chunk');
}

function runScenario(scenario) {
  if (!scenario || !Array.isArray(scenario.liveOutputDuringCatchUp)) {
    throw new Error('Scenario without liveOutputDuringCatchUp.');
  }
  const queueLimit = Math.max(1, Number(scenario.queueLimit) || 1);
  const chat = { _catchUpInProgress: true, _pendingOutputChunks: [] };

  for (const chunk of scenario.liveOutputDuringCatchUp) {
    enqueueCatchUpOutputChunk(chat, chunk, queueLimit);
  }

  chat._catchUpInProgress = false;
  const flushed = [];
  const processed = drainCatchUpOutputChunks(chat, (chunk) => flushed.push(chunk));

  const expectedOrder = scenario.expected?.flushedOrder || [];
  const expectedQueueSize = Number(scenario.expected?.remainingQueueSize ?? 0);

  assert.deepEqual(
    flushed,
    expectedOrder,
    `Scenario ${scenario.id}: wrong flush order of the catch-up queue`
  );
  assert.equal(
    (chat._pendingOutputChunks || []).length,
    expectedQueueSize,
    `Scenario ${scenario.id}: queue should be empty after flush`
  );
  assert.equal(processed, expectedOrder.length, `Scenario ${scenario.id}: processed counter has a wrong value`);
  console.log(`OK: catch-up flow ${scenario.id}`);
}

testSignatureUsesMiddleChunk();
for (const scenario of loadFixtures()) {
  runScenario(scenario);
}
console.log('\nAll chat catch-up flow tests passed.');
