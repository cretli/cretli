import assert from 'node:assert/strict';
import { buildClaudeHistoryDigest } from '../lib/claude/claude-history-digest.ts';
import { resolveContextNoticeText } from '../app_front/features/chat/history/services/historyApply.js';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';

const currentMessageId = 'current-message-uuid';
const rows = [
  { seq: 1, rec: { kind: 'localUser', text: 'Prior request' } },
  { seq: 2, rec: { kind: 'sdk', event: { type: 'user', message: { content: [{ type: 'text', text: 'Prior request' }] } } } },
  { seq: 3, rec: { kind: 'sdk', event: { type: 'assistant', message: { content: [{ type: 'text', text: 'Prior answer' }] } } } },
  { seq: 4, rec: { kind: 'localUser', text: 'Current request', contextMessageId: currentMessageId } },
  { seq: 5, rec: { kind: 'sdk', event: { type: 'user', contextMessageId: currentMessageId, message: { content: [{ type: 'text', text: 'Current request' }] } } } },
  { seq: 6, rec: { kind: 'sdk', event: { type: 'assistant', message: { content: [{ type: 'text', text: 'After current turn' }] } } } },
];
const digest = buildClaudeHistoryDigest(rows, '', currentMessageId);
assert.ok(digest);
assert.match(digest.text, /Prior answer/);
assert.doesNotMatch(digest.text, /Current request|After current turn/);
assert.equal(digest.turns, 1, 'paired localUser and SDK user representations count as one user turn');
assert.equal(buildClaudeHistoryDigest([{ rec: { kind: 'localUser', text: 'Current request', contextMessageId: currentMessageId } }], '', currentMessageId), null);
assert.equal(buildClaudeHistoryDigest([]), null);
assert.equal(buildClaudeHistoryDigest([{ rec: { kind: 'sdk', event: { type: 'tool_result', content: 'private payload' } } }]), null, 'standalone tool results are omitted');

const manyRows = [{ rec: { kind: 'localUser', text: 'Turn 0' } }];
for (let i = 1; i < 2000; i += 1) manyRows.push({ rec: { kind: i % 2 ? 'localUser' : 'sdk', text: `Turn ${i}`, event: { type: 'assistant', message: { content: `Turn ${i}` } } } });
const manyDigest = buildClaudeHistoryDigest(manyRows);
assert.ok(manyDigest);
assert.match(manyDigest.text, /Turn 1999/);
assert.doesNotMatch(manyDigest.text, /Turn 0\n/);

const tenTurns = buildClaudeHistoryDigest(Array.from({ length: 12 }, (_, i) => ({ rec: { kind: 'localUser', text: `Turn ${i}` } })));
assert.ok(tenTurns);
assert.doesNotMatch(tenTurns.text, /Turn 0|Turn 1\n/);
assert.match(tenTurns.text, /Turn 2/);

const hugeSummary = `## Plan\n${'summary '.repeat(5000)}`;
const bounded = buildClaudeHistoryDigest([], hugeSummary);
assert.ok(bounded);
assert.match(bounded.text, /## Plan/);
assert.ok(Math.ceil(bounded.text.length / 4) <= 8000);
const hugeHeading = buildClaudeHistoryDigest([], `# ${'H'.repeat(40000)}\nPlan details`);
assert.ok(hugeHeading, 'oversized plan headings are bounded instead of dropping the digest');
assert.ok(hugeHeading.text.length < 32000);
assert.match(hugeHeading.text, /^Plan summary:\n# H+…/);
assert.equal(resolveContextNoticeText('{"code":"context_restored","turns":7}', (key, vars) => en.chat[key.slice(5)].replace('{n}', String(vars.n))), 'Previous chat context restored (7 turns).');
assert.equal(resolveContextNoticeText('{"code":"context_restored","turns":7}', (key, vars) => pl.chat[key.slice(5)].replace('{n}', String(vars.n))), 'Przywrócono wcześniejszy kontekst czatu (7 tur).');
assert.equal(resolveContextNoticeText('{"text":"Legacy fallback"}', () => ''), 'Legacy fallback');

const hugeHistory = buildClaudeHistoryDigest([{ rec: { kind: 'localUser', text: 'x'.repeat(40000) } }]);
assert.ok(hugeHistory);
assert.ok(Math.ceil(hugeHistory.text.length / 4) <= 8000);

// Tool-heavy turns: running+completed twins collapse and never evict user/assistant text.
const toolRows = [{ rec: { kind: 'localUser', text: 'Build the extension' } }];
for (let i = 0; i < 45; i += 1) {
  const name = i % 2 ? 'Read' : 'Bash';
  toolRows.push({ rec: { kind: 'sdk', event: { type: 'tool_call', id: `t${i}`, name, status: 'running' } } });
  toolRows.push({ rec: { kind: 'sdk', event: { type: 'tool_call', id: `t${i}`, name, status: 'completed' } } });
}
const toolOnly = buildClaudeHistoryDigest(toolRows);
assert.ok(toolOnly);
assert.match(toolOnly.text, /User: Build the extension/);
assert.equal(toolOnly.turns, 1);
assert.equal(toolOnly.rows, 1);
assert.match(toolOnly.text, /Tool calls: Bash x23, Read x22/);
assert.doesNotMatch(toolOnly.text, /Tool call: /);
const withAnswer = buildClaudeHistoryDigest([...toolRows, { rec: { kind: 'sdk', event: { type: 'assistant', message: { content: [{ type: 'text', text: 'Done building' }] } } } }]);
assert.match(withAnswer.text, /Build the extension[\s\S]*Tool calls[\s\S]*Assistant: Done building/);
// Without ids the running twin is skipped.
const noIds = buildClaudeHistoryDigest([
  { rec: { kind: 'localUser', text: 'Go' } },
  { rec: { kind: 'sdk', event: { type: 'tool_call', name: 'Bash', status: 'running' } } },
  { rec: { kind: 'sdk', event: { type: 'tool_call', name: 'Bash', status: 'completed' } } },
]);
assert.match(noIds.text, /Tool calls: Bash$/);
// Plan-only digests still carry useful context despite having no transcript rows.
assert.equal(buildClaudeHistoryDigest([], '## Plan\nx').rows, 0);
console.log('claude-history-digest.test.js OK');
