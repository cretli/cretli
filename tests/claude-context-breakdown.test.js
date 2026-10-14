import assert from 'node:assert/strict';
import test from 'node:test';
import { buildClaudeContextBreakdown, readClaudeContextBreakdown } from '../lib/claude/claude-context-breakdown.js';
import { applyClaudeContextBreakdown, applyClaudeMeasuredContextUsage } from '../app_front/features/chat/chatContextMeter.js';

const response = {
  totalTokens: 50000, maxTokens: 200000, model: 'test-model',
  categories: [{ name: 'Autocompact buffer', tokens: 33000, kind: 'buffer' }, { name: 'Free space', tokens: 117000, kind: 'free' }],
  systemPromptSections: [{ name: 'private-name', tokens: 3000 }],
  systemTools: [{ name: 'Bash', tokens: 1000 }, { name: 'Read', tokens: 500 }],
  mcpTools: [{ name: 'a', serverName: 's', tokens: 700, isLoaded: true }, { name: 'b', serverName: 's', tokens: 900, isLoaded: false }],
  memoryFiles: [{ path: '/private/CLAUDE.md', type: 'project', tokens: 2000 }],
  agents: [], skills: { totalSkills: 4, includedSkills: 3, tokens: 400, skillFrontmatter: [] },
  messageBreakdown: { toolCallTokens: 2000, toolResultTokens: 20000, attachmentTokens: 100, assistantMessageTokens: 5000, userMessageTokens: 1000, redirectedContextTokens: 0, unattributedTokens: 50 },
};

test('maps SDK categories onto shared numeric rows without names or paths', () => {
  const built = buildClaudeContextBreakdown(response);
  const byId = Object.fromEntries(built.breakdown.rows.map((entry) => [entry.id, entry]));
  assert.equal(built.totalTokens, 50000);
  assert.equal(built.contextWindowTokens, 200000);
  assert.equal(byId.messages.tokens, 6150);
  assert.equal(byId.toolResults.tokens, 20000);
  assert.equal(byId.systemTools.tokens, 1500);
  assert.equal(byId.mcpTools.tokens, 700);
  assert.equal(byId.memory.count, 1);
  assert.equal(byId.skills.count, 3);
  assert.equal(byId.compactBuffer.tokens, 33000);
  assert.equal(byId.reasoning.tokens, null);
  assert.doesNotMatch(JSON.stringify(built), /private/);
});

test('breakdown read never rejects or blocks on a failing query', async () => {
  assert.equal(await readClaudeContextBreakdown({}), null);
  assert.equal(await readClaudeContextBreakdown({ getContextUsage: async () => { throw new Error('x'); } }), null);
  const read = await readClaudeContextBreakdown({ getContextUsage: async () => response });
  assert.equal(read.totalTokens, 50000);
});

test('meter keeps cache share and breakdown for a Claude chat only', () => {
  const chat = { agentTransport: 'claude' };
  assert.equal(applyClaudeMeasuredContextUsage(chat, { inputTokens: 1000, outputTokens: 10, totalTokens: 1010, cacheReadTokens: 900 }, 'm', 200000), true);
  assert.equal(chat._contextCacheReadTokens, 900);
  assert.equal(applyClaudeContextBreakdown(chat, { rows: [] }), true);
  assert.equal(applyClaudeContextBreakdown({ agentTransport: 'codex' }, { rows: [] }), false);
});
