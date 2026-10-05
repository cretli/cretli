import assert from 'node:assert/strict';
import {
  HISTORY_BUDGET_MS,
  HISTORY_SYNC_CARDS_BUDGET,
  HTTP_BURST_COUNT,
  HTTP_BURST_WINDOW_MS,
  HTTP_SLOW_MS,
  LONG_TASK_IDLE_MS,
  LONG_TASK_RESUME_MS,
  MARKDOWN_CHARS_BUDGET,
  MARKDOWN_FLUSH_BUDGET_MS,
  STREAM_CHILDREN_BUDGET,
  beginSpan,
  createRequestLedger,
  currentSpanName,
  endSpan,
  evaluateBudget,
  normalizeApiPath,
  observeSample,
  recentSpanName,
  recordHttpSample,
  resetChatPerfBudget,
  setChatPerfReporter,
  spanDuring,
} from '../app_front/lib/chatPerfBudget.js';

assert.equal(MARKDOWN_FLUSH_BUDGET_MS, 32);
assert.equal(MARKDOWN_CHARS_BUDGET, 20000);
assert.equal(HISTORY_BUDGET_MS, 100);
assert.equal(HISTORY_SYNC_CARDS_BUDGET, 40);
assert.equal(STREAM_CHILDREN_BUDGET, 160);
assert.equal(HTTP_BURST_COUNT, 8);
assert.equal(HTTP_BURST_WINDOW_MS, 2000);
assert.equal(HTTP_SLOW_MS, 800);
assert.equal(LONG_TASK_RESUME_MS, 50);
assert.equal(LONG_TASK_IDLE_MS, 200);

assert.deepEqual(evaluateBudget(null), []);
assert.deepEqual(evaluateBudget({
  kind: 'markdown.flush',
  durationMs: MARKDOWN_FLUSH_BUDGET_MS,
  chars: MARKDOWN_CHARS_BUDGET,
  children: STREAM_CHILDREN_BUDGET,
}), []);

const markdownOver = evaluateBudget({
  kind: 'markdown.flush',
  durationMs: 180,
  chars: 42000,
  children: 96,
});
assert.equal(markdownOver.length, 1);
assert.equal(markdownOver[0].code, 'markdown.flush');
assert.equal(markdownOver[0].message, 'markdown.flush 180ms chars=42000 children=96');

const childrenOver = evaluateBudget({
  kind: 'markdown.flush',
  durationMs: 1,
  chars: 10,
  children: STREAM_CHILDREN_BUDGET + 1,
});
assert.equal(childrenOver.some((item) => item.code === 'stream.children'), true);
assert.equal(childrenOver.some((item) => item.code === 'markdown.flush'), false);

assert.deepEqual(evaluateBudget({
  kind: 'history.replay',
  durationMs: HISTORY_BUDGET_MS,
  cards: HISTORY_SYNC_CARDS_BUDGET,
  children: 10,
}), []);

const replayOver = evaluateBudget({
  kind: 'history.prepend',
  durationMs: 40,
  cards: 80,
  children: 200,
});
assert.equal(replayOver.some((item) => item.code === 'history.prepend'), true);
assert.equal(replayOver.some((item) => item.code === 'stream.children'), true);
assert.match(replayOver[0].message, /history.prepend 40ms cards=80 children=200/);

assert.deepEqual(evaluateBudget({
  kind: 'longtask',
  durationMs: LONG_TASK_IDLE_MS - 1,
  span: 'idle',
  inResumeWindow: false,
}), []);
assert.equal(evaluateBudget({
  kind: 'longtask',
  durationMs: LONG_TASK_RESUME_MS - 1,
  span: 'idle',
  inResumeWindow: true,
}).length, 0);

const longTask = evaluateBudget({
  kind: 'longtask',
  durationMs: LONG_TASK_IDLE_MS,
  span: 'markdown.flush',
  inResumeWindow: false,
});
assert.equal(longTask[0].message, 'longtask 200ms span=markdown.flush');
assert.equal(evaluateBudget({
  kind: 'longtask',
  durationMs: LONG_TASK_RESUME_MS,
  span: 'history.replay',
  inResumeWindow: true,
})[0].fields.span, 'history.replay');

assert.equal(normalizeApiPath('/api/chats/history-batch?ids=1'), '/api/chats/history-batch');
assert.equal(
  normalizeApiPath('https://localhost:3011/api/chats?x=1'),
  '/api/chats',
);

let now = 10000;
const ledger = createRequestLedger({ now: () => now, windowMs: HTTP_BURST_WINDOW_MS });
for (let index = 0; index < HTTP_BURST_COUNT; index += 1) {
  const quiet = ledger.record({
    at: now,
    method: 'GET',
    path: '/api/chats',
    elapsedMs: 10,
    status: 200,
  });
  assert.equal(quiet.violations.length, 0);
  assert.equal(quiet.count, index + 1);
}
const burst = ledger.record({
  at: now,
  method: 'get',
  path: '/api/chats/history-batch?x=1',
  elapsedMs: 1200,
  status: 200,
});
assert.equal(burst.count, HTTP_BURST_COUNT + 1);
assert.equal(burst.violations.some((item) => item.code === 'http.burst'), true);
assert.equal(burst.violations.some((item) => item.code === 'http.slow'), true);
const burstMessage = burst.violations.find((item) => item.code === 'http.burst').message;
assert.equal(
  burstMessage,
  'http-burst 9/2s slowest=GET /api/chats/history-batch 1200ms',
);
const again = ledger.record({
  at: now,
  method: 'GET',
  path: '/api/chats',
  elapsedMs: 12,
  status: 200,
});
assert.equal(again.violations.some((item) => item.code === 'http.burst'), false);

now += HTTP_BURST_WINDOW_MS;
const rotated = ledger.record({
  at: now,
  method: 'GET',
  path: '/api/chats',
  elapsedMs: 5,
  status: 200,
});
assert.equal(rotated.count, 1);
assert.equal(rotated.violations.length, 0);

resetChatPerfBudget();
const outer = beginSpan('history.replay');
const inner = beginSpan('markdown.flush');
assert.equal(currentSpanName(), 'markdown.flush');
const openTask = evaluateBudget({
  kind: 'longtask',
  durationMs: 220,
  span: currentSpanName(),
  inResumeWindow: false,
});
assert.equal(openTask[0].fields.span, 'markdown.flush');
assert.equal(spanDuring(inner.startedAt, 1), 'markdown.flush');
endSpan();
assert.equal(spanDuring(outer.startedAt, inner.startedAt - outer.startedAt + 5), 'markdown.flush');
endSpan();
assert.equal(currentSpanName(), 'idle');
assert.equal(spanDuring(outer.startedAt + 100000, 10), 'idle');
assert.equal(recentSpanName(1000), 'history.replay');

resetChatPerfBudget();
const reported = [];
setChatPerfReporter((item) => {
  reported.push(item.code);
});
observeSample({ kind: 'markdown.flush', durationMs: 90, chars: 10, children: 1 }, 5000);
observeSample({ kind: 'markdown.flush', durationMs: 90, chars: 10, children: 1 }, 5000 + 100);
assert.deepEqual(reported, ['markdown.flush']);
observeSample({ kind: 'markdown.flush', durationMs: 90, chars: 10, children: 1 }, 5000 + 2000);
assert.deepEqual(reported, ['markdown.flush', 'markdown.flush']);

resetChatPerfBudget();
const httpReports = [];
setChatPerfReporter((item) => {
  httpReports.push(item.code);
});
recordHttpSample({ method: 'GET', path: '/api/chats', elapsedMs: 900, status: 200, at: 1000 });
recordHttpSample({ method: 'POST', path: '/api/chats', elapsedMs: 900, status: 200, at: 1100 });
assert.deepEqual(httpReports, ['http.slow', 'http.slow']);

console.log('chat-perf-budget.test.js: ok');
