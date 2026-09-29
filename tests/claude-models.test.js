import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import {
  DEFAULT_CLAUDE_MODEL,
  catalogFromClaudeModelsPayload,
  invalidateClaudeModelsCache,
  listClaudeModels,
  listFallbackClaudeModels,
  resolveClaudeRunModel,
  resolveDefaultClaudeModel,
} from '../lib/claude/claude-models.js';

assert.equal(DEFAULT_CLAUDE_MODEL, 'claude-sonnet-4-6');
assert.equal(resolveDefaultClaudeModel(), 'claude-sonnet-4-6');

const fallback = listFallbackClaudeModels();
assert.ok(fallback.some((row) => row.value === 'claude-opus-4-8'));
assert.ok(fallback.some((row) => row.value === 'claude-sonnet-4-6'));
assert.ok(fallback.some((row) => row.value === 'claude-haiku-4'));

const mapped = catalogFromClaudeModelsPayload({
  data: [
    { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' },
    { id: 'claude-sonnet-4-6' },
    { id: 'claude-opus-4-8' },
  ],
});
assert.deepEqual(mapped.map((row) => row.value), ['claude-opus-4-8', 'claude-sonnet-4-6']);
assert.equal(mapped[0].label, 'Claude Opus 4.8');
assert.equal(mapped[0].provider, 'anthropic');

assert.equal(resolveClaudeRunModel('claude-opus-4-8'), 'claude-opus-4-8');
assert.equal(resolveClaudeRunModel(''), DEFAULT_CLAUDE_MODEL);
assert.equal(resolveClaudeRunModel('   '), DEFAULT_CLAUDE_MODEL);

const previousKey = process.env.ANTHROPIC_API_KEY;
const previousFetch = globalThis.fetch;
process.env.ANTHROPIC_API_KEY = 'claude-test-key';

try {
  invalidateClaudeModelsCache();
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /\/v1\/models/);
    assert.equal(init?.headers?.['x-api-key'], 'claude-test-key');
    return new Response(JSON.stringify({
      data: [{ id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' }],
    }), { status: 200 });
  };
  const liveListed = await listClaudeModels({ refresh: true });
  assert.equal(liveListed.modelsSource, 'live');
  assert.equal(liveListed.models[0].id, 'claude-opus-4-8');

  globalThis.fetch = async () => new Response('nope', { status: 502 });
  const fallbackListed = await listClaudeModels({ refresh: true });
  assert.equal(fallbackListed.modelsSource, 'fallback');
  assert.ok(fallbackListed.catalog.length > 0);
  assert.ok(fallbackListed.models.every((row) => !row.id.includes('::')));
} finally {
  globalThis.fetch = previousFetch;
  if (typeof previousKey === 'string') process.env.ANTHROPIC_API_KEY = previousKey;
  else delete process.env.ANTHROPIC_API_KEY;
  invalidateClaudeModelsCache();
  removeIsolatedDataDir();
}

console.log('claude-models.test.js OK');
