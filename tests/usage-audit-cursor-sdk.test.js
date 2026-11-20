import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beginHarnessRun } from '../lib/usage/harness-usage.ts';
import {
  USAGE_HARNESS_MATRIX,
  billedTotalTokens,
  buildUsageContractFields,
  containsConversationContent,
  partitionUsageTokens,
  promptTokensForWindow,
  resolveUsageContract,
  resolveWindowSemantics,
} from '../lib/usage/usage-contract.js';
import { createUsageEvent, emptyUsageTokens } from '../lib/usage/usage-event.js';
import { deltaTokens, fromSdkUsage } from '../lib/usage/usage-normalize.js';
import { rememberRoomUsagePayload } from '../lib/sdk/cursor-agent-sdk-ws.ts';

/**
 * Guards the Cursor SDK usage/context audit (docs/usage-audits/cursor-sdk.md).
 *
 * The fixtures are sanitized shapes, not live captures. This test re-runs the
 * documented fixture transform and pins the contract fields the audit claims,
 * so the document cannot drift away from the code it describes.
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(projectRoot, 'tests', 'fixtures', 'usage', 'cursor-sdk');
const docPath = path.join(projectRoot, 'docs', 'usage-audits', 'cursor-sdk.md');
const sdkPackagePath = path.join(projectRoot, 'node_modules', '@cursor', 'sdk', 'package.json');

const rawFixturePath = path.join(fixtureDir, 'raw-sdk-usage-message.json');
const normalizedFixturePath = path.join(fixtureDir, 'normalized-sdk-token-bag.json');
const sequenceFixturePath = path.join(fixtureDir, 'raw-sdk-usage-cumulative-sequence.json');

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function fixtureFiles() {
  return readdirSync(fixtureDir).filter((name) => name.endsWith('.json')).sort();
}

test('every cursor-sdk fixture is free of conversation content', () => {
  const files = fixtureFiles();
  assert.ok(files.length >= 3, 'expected the raw, normalized and sequence fixtures');
  for (const name of files) {
    const fixture = readJson(path.join(fixtureDir, name));
    assert.equal(
      containsConversationContent(fixture),
      false,
      `${name} must not contain a content/messages/text/prompt/transcript/history/reply/completion/system key`
    );
  }
});

test('the raw adapter payload transforms to the documented token bag', () => {
  const raw = readJson(rawFixturePath);
  const expected = readJson(normalizedFixturePath);

  // The adapter reads event.usage only (lib/sdk/cursor-agent-sdk-ws.ts#rememberRoomUsagePayload).
  assert.equal(raw.type, 'sdkEvent');
  assert.equal(raw.event.type, 'usage');

  const actual = fromSdkUsage(raw.event.usage);
  assert.deepEqual(actual, expected.tokens);
  assert.deepEqual(actual, {
    textInput: 1200,
    textOutput: 80,
    audioInput: 0,
    audioOutput: 0,
    cachedInput: 900,
    cacheWrite: 50,
    reasoning: 20,
  });
});

test('the adapter records the same bag with harness sdk and provider cursor', () => {
  const raw = readJson(rawFixturePath);
  const expected = readJson(normalizedFixturePath);
  const records = [];
  const room = { modelId: 'composer-2.5', chatId: 'chat-fixture-0001' };

  const partial = rememberRoomUsagePayload(room, raw, (event) => {
    records.push(event);
    return event;
  });

  assert.equal(partial, undefined, 'the adapter helper records through the callback');
  assert.equal(records.length, 1);
  assert.equal(records[0].harness, 'sdk');
  assert.equal(records[0].provider, 'cursor');
  assert.equal(records[0].eventType, 'delta');
  assert.equal(records[0].model, 'composer-2.5');
  assert.equal(records[0].role, 'chat');
  assert.deepEqual(records[0].tokens, expected.tokens);
});

test('successive snapshots in one run are recorded as diffs', () => {
  const fixture = readJson(sequenceFixturePath);
  assert.equal(fixture.sequence.length, 2);
  assert.equal(fixture.expectedDeltaTokens.length, 2);

  const records = [];
  const room = { modelId: 'composer-2.5', chatId: 'chat-fixture-0002' };
  beginHarnessRun(room, { runId: 'run-fixture-local-0002' });

  for (const payload of fixture.sequence) {
    rememberRoomUsagePayload(room, payload, (event) => {
      records.push(event);
      return event;
    });
  }

  assert.equal(records.length, 2);
  assert.deepEqual(records[0].tokens, fixture.expectedDeltaTokens[0]);
  assert.deepEqual(records[1].tokens, fixture.expectedDeltaTokens[1]);

  // The second delta is current minus previous, not the raw second snapshot.
  const rawSecond = fromSdkUsage(fixture.sequence[1].event.usage);
  assert.deepEqual(deltaTokens(rawSecond, fromSdkUsage(fixture.sequence[0].event.usage)), records[1].tokens);
});

test('the normalized event agrees with the sdk matrix entry', () => {
  const raw = readJson(rawFixturePath);
  const expected = readJson(normalizedFixturePath);
  const matrix = USAGE_HARNESS_MATRIX.sdk;

  const event = createUsageEvent({
    harness: 'sdk',
    provider: 'cursor',
    model: 'composer-2.5',
    runId: 'run-fixture-local-0001',
    sourceSessionId: 'sess-fixture-0001',
    turnId: 'turn-fixture-0001',
    tokens: fromSdkUsage(raw.event.usage),
  });

  assert.equal(event.harness, 'sdk');
  assert.equal(event.provider, 'cursor');
  assert.equal(event.eventType, 'delta');
  assert.deepEqual(event.tokens, expected.tokens);

  // Declared adapter-boundary claims from docs/usage-audits/cursor-sdk.md §8.1.
  assert.equal(event.usageShape, matrix.usageShape);
  assert.equal(event.measurementKind, matrix.measurementKind);
  assert.equal(event.granularity, matrix.granularity);
  assert.equal(event.inputIncludesCache, matrix.payloadInputIncludesCache);
  assert.equal(event.reasoningRelation, matrix.reasoningRelation);
  assert.equal(event.accountingScope, 'own');
  assert.equal(event.provenance, 'reported');
  assert.equal(event.completeness, 'partial');
  assert.equal(event.identityClass, 'durable_sequence');
  assert.equal(event.contextEpoch, undefined);

  // A normalized event must stay free of conversation content too.
  assert.equal(containsConversationContent(event), false);

  const contract = resolveUsageContract('sdk');
  assert.deepEqual(contract.identityFields, ['runId', 'sourceSessionId', 'turnId']);
  assert.equal(contract.cacheRead, true);
  assert.equal(contract.cacheWrite, true);
});

test('the sdk contract derives the buckets documented for the fixture', () => {
  const raw = readJson(rawFixturePath);
  const tokens = fromSdkUsage(raw.event.usage);

  assert.equal(resolveWindowSemantics('sdk'), 'inclusive');
  assert.deepEqual(partitionUsageTokens(tokens, 'sdk'), {
    inputWithoutCache: 250,
    cacheRead: 900,
    cacheWrite: 50,
    outputWithoutReasoning: 60,
    reasoning: 20,
    reasoningDiagnostic: false,
    audioInput: 0,
    audioOutput: 0,
  });
  assert.equal(promptTokensForWindow(tokens, 'sdk'), 1200);
  assert.equal(billedTotalTokens(tokens, 'sdk'), 1280);

  const fields = buildUsageContractFields({
    harness: 'sdk',
    provider: 'cursor',
    eventType: 'delta',
    tokens,
    runId: 'run-fixture-local-0001',
    sourceSessionId: 'sess-fixture-0001',
    turnId: 'turn-fixture-0001',
  });
  assert.equal(fields.usageShape, 'resolved');
  assert.equal(fields.measurementKind, 'snapshot');
  assert.equal(fields.granularity, 'turn');
  assert.equal(fields.inputIncludesCache, true);
});

test('the fixture total follows the SDK implementation formula, not the Cretli bucket total', () => {
  const raw = readJson(rawFixturePath);
  const usage = raw.event.usage;

  // SDK toTokenUsage/sumTokenUsage: input + output + cacheRead + cacheWrite.
  assert.equal(
    usage.totalTokens,
    usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  );
  assert.equal(usage.totalTokens, 2230);

  // The audit's F2: the contract's inclusive assumption produces a different
  // additive total for the same payload. Both facts are pinned so a future
  // contract change is visible here.
  const tokens = fromSdkUsage(usage);
  assert.equal(billedTotalTokens(tokens, 'sdk'), 1280);
  assert.notEqual(usage.totalTokens, billedTotalTokens(tokens, 'sdk'));
});

test('the audit document names the installed @cursor/sdk version and evidence paths', () => {
  assert.equal(existsSync(docPath), true, 'docs/usage-audits/cursor-sdk.md must exist');
  const sdkPackage = readJson(sdkPackagePath);
  const doc = readFileSync(docPath, 'utf8');

  // The version must be tied to the package on one line. A bare version string
  // somewhere else in the document is not evidence that the doc names the SDK
  // build under audit, so match the package name and the exact version with a
  // bounded (same-line) window.
  const escapedVersion = sdkPackage.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `(?<!\^)` keeps a range declaration (`"^1.0.37"`) from satisfying the
  // check: the doc must state the installed version, not only the dependency
  // range. Wording around the pair is free to change as long as both stay on
  // the same line.
  const versionStatement = new RegExp(`@cursor/sdk[^\\n]*(?<!\\^)\\b${escapedVersion}\\b`);
  assert.match(
    doc,
    versionStatement,
    `document must state the installed @cursor/sdk version ${sdkPackage.version} on one line`
  );
  for (const needle of [
    'node_modules/@cursor/sdk/dist/esm/usage-types.d.ts',
    'node_modules/@cursor/sdk/dist/esm/messages.d.ts',
    'node_modules/@cursor/sdk/dist/esm/agent.d.ts',
    'SDKUsageMessage',
    'inputTokens',
    'cacheReadTokens',
    'totalTokens',
    'fromSdkUsage',
    'getUsage',
    'context_window',
    'https://cursor.com/docs/sdk/typescript',
  ]) {
    assert.ok(doc.includes(needle), `document must reference ${needle}`);
  }

  // The doc must keep the evidence-strength vocabulary the audit relies on.
  for (const tag of ['[OBSERVED]', '[DECLARED]', '[DOC]', '[CONFLICT]', '[UNCONFIRMED]']) {
    assert.ok(doc.includes(tag), `document must use the ${tag} tag`);
  }
});

test('empty bags stay empty so a zero snapshot is not invented', () => {
  assert.deepEqual(fromSdkUsage(undefined), emptyUsageTokens());
  assert.deepEqual(fromSdkUsage({}), emptyUsageTokens());
});

test('non-usage and missing-usage sdkEvents never invoke the record callback', () => {
  let recordCalls = 0;
  const record = (event) => {
    recordCalls += 1;
    return event;
  };
  const room = { modelId: 'composer-2.5', chatId: 'chat-fixture-0003' };

  assert.equal(rememberRoomUsagePayload(room, { type: 'sdkEvent' }, record), undefined);
  assert.equal(
    rememberRoomUsagePayload(room, { type: 'sdkEvent', event: { type: 'usage' } }, record),
    undefined
  );

  // rememberRoomUsagePayload() also returns undefined when it records, so the
  // return value proves nothing here. The callback counter is the real
  // assertion: an ignored event must never reach the recorder.
  assert.equal(recordCalls, 0, 'ignored sdkEvents must not be recorded as zero usage');
});
