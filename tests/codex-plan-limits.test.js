import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { normalizeCodexPlanLimits, readCodexRateLimits } from '../lib/codex/codex-plan-limits.js';
import { renderPlanLimitsHtml } from '../app_front/features/usage/planLimitsView.js';

function createTransport(reply) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => { child.killed = true; };
  const requests = [];
  child.stdin.on('data', (buffer) => {
    const request = JSON.parse(buffer.toString());
    requests.push(request);
    queueMicrotask(() => reply(child, request));
  });
  return { child, requests, spawnFn: () => child };
}

test('quota windows use durations, preserve zero and omit account/reset identifiers', () => {
  const result = normalizeCodexPlanLimits({
    accountId: 'private-account',
    rateLimits: { planType: 'plus', credits: { balance: '0', unlimited: false } },
    rateLimitsByLimitId: { codex: { limitId: 'codex', primary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 2000000000 }, secondary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1900000000 } } },
    rateLimitResetCredits: { availableCount: 1, credits: [{ id: 'private-reset' }] },
  });
  assert.equal(result.windows[0].rateLimitType, 'seven_day');
  assert.equal(result.windows[0].utilization, 0);
  assert.equal(result.windows[1].rateLimitType, 'five_hour');
  assert.equal(result.windows[1].utilization, 10);
  assert.equal(result.windows[1].resetsAt, new Date(1900000000000).toISOString());
  assert.equal(result.resetCreditsAvailable, 1);
  assert.equal(result.credits.balance, '0');
  assert.doesNotMatch(JSON.stringify(result), /private-/);
});

test('missing or invalid percentages stay unknown and extra buckets remain distinct', () => {
  const result = normalizeCodexPlanLimits({ rateLimitsByLimitId: {
    codex: { limitId: 'codex', primary: { windowDurationMins: 300, usedPercent: null }, secondary: null },
    other: { limitId: 'other', primary: { windowDurationMins: 300, usedPercent: 150, resetsAt: 1e100 } },
  } });
  assert.equal(result.windows.length, 2);
  assert.equal(result.windows[0].utilization, undefined);
  assert.equal(result.windows[1].rateLimitType, 'other:five_hour');
  assert.equal(result.windows[1].utilization, undefined);
  assert.equal(result.windows[1].resetsAt, undefined);
  assert.equal(result.resetCreditsAvailable, null);
});

test('JSON-RPC initializes before reading quotas, ignores notifications and stops child', async () => {
  const transport = createTransport((child, request) => {
    if (request.id === 1) child.stdout.write('{"id":1,"result":{}}\n');
    if (request.id === 2) {
      child.stdout.write('not-json\n{"method":"account/updated","params":{}}\n');
      child.stdout.write('{"id":2,"result":{"rateLimits":{"primary":null}}}\n');
    }
  });
  const result = await readCodexRateLimits({ spawnFn: transport.spawnFn });
  assert.deepEqual(transport.requests.map((row) => row.method), ['initialize', 'initialized', 'account/rateLimits/read']);
  assert.equal(result.rateLimits.primary, null);
  assert.equal(transport.child.killed, true);
});

test('RPC errors are sanitized and terminate child', async () => {
  const transport = createTransport((child, request) => child.stdout.write(JSON.stringify({ id: request.id, error: { message: 'private token' } }) + '\n'));
  await assert.rejects(readCodexRateLimits({ spawnFn: transport.spawnFn }), (error) => /unavailable/.test(error.message) && !/private/.test(error.message));
  assert.equal(transport.child.killed, true);
});

test('timeout and premature exit reject and clean up', async () => {
  const transport = createTransport(() => {});
  await assert.rejects(readCodexRateLimits({ spawnFn: transport.spawnFn, timeoutMs: 10 }), /timed out/);
  assert.equal(transport.child.killed, true);
  const closed = createTransport((child) => child.emit('close', 1));
  await assert.rejects(readCodexRateLimits({ spawnFn: closed.spawnFn }), /closed/);
});

test('usage view shows credit/reset metadata and read failures', () => {
  const t = (key, values) => `${key} ${JSON.stringify(values || {})}`;
  const html = renderPlanLimitsHtml({ codex: { available: true, credits: { balance: '0' }, resetCreditsAvailable: 1 } }, { t });
  assert.match(html, /planCodexCredits/);
  assert.match(html, /planCodexResets/);
  assert.match(renderPlanLimitsHtml({ codex: { reason: 'read-failed' } }, { t }), /planCodexReadFailed/);
});
