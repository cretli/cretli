import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import {
  DEFAULT_CLAUDE_MODEL,
  catalogFromClaudeModelInfo,
  catalogFromClaudeModelsPayload,
  invalidateClaudeModelsCache,
  isClaudeSessionModelCatalogFresh,
  listClaudeModels,
  listFallbackClaudeModels,
  resolveClaudeApiBaseUrl,
  resolveClaudeRunModel,
  resolveDefaultClaudeModel,
  setClaudeSessionModelCatalog,
} from '../lib/claude/claude-models.js';

assert.equal(DEFAULT_CLAUDE_MODEL, 'sonnet');
assert.equal(resolveDefaultClaudeModel(), 'sonnet');

// Fallback is the Claude Code alias list plus the known-model overlay; context
// window is unknown, not 200k.
const fallback = listFallbackClaudeModels();
assert.deepEqual(fallback.map((row) => row.value), ['default', 'opus', 'sonnet', 'haiku', 'claude-haiku-5-5']);
assert.ok(fallback.every((row) => row.contextWindowTokens === null));
assert.ok(
  fallback
    .filter((row) => /^claude-/.test(row.value))
    .every((row) => row.value === 'claude-haiku-5-5'),
);
assert.ok(fallback.every((row) => typeof row.label === 'string' && row.label.length > 0));

const mapped = catalogFromClaudeModelsPayload({
  data: [
    { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8', context_window: 200000 },
    { id: 'claude-sonnet-4-6' },
    { id: 'claude-opus-4-8' },
  ],
});
assert.deepEqual(mapped.map((row) => row.value), ['claude-opus-4-8', 'claude-sonnet-4-6']);
assert.equal(mapped[0].label, 'Claude Opus 4.8');
assert.equal(mapped[0].provider, 'anthropic');
assert.equal(mapped[0].contextWindowTokens, 200000);
assert.equal(mapped[1].contextWindowTokens, null);

// `ModelInfo` rows from query.supportedModels().
const fromInfo = catalogFromClaudeModelInfo([
  { value: 'sonnet', displayName: 'Sonnet', description: 'balanced', contextWindow: 200000 },
  { value: 'haiku', displayName: 'Haiku', description: 'fast' },
]);
assert.deepEqual(fromInfo.map((row) => row.value), ['sonnet', 'haiku']);
assert.equal(fromInfo[0].contextWindowTokens, 200000);
assert.equal(fromInfo[1].contextWindowTokens, null);

assert.equal(resolveClaudeRunModel('claude-opus-4-8'), 'claude-opus-4-8');
assert.equal(resolveClaudeRunModel(''), DEFAULT_CLAUDE_MODEL);
assert.equal(resolveClaudeRunModel('   '), DEFAULT_CLAUDE_MODEL);
assert.equal(resolveClaudeApiBaseUrl({ ANTHROPIC_BASE_URL: 'https://proxy.example.com/' }), 'https://api.anthropic.com');
assert.equal(resolveClaudeApiBaseUrl({}), 'https://api.anthropic.com');

const previousKey = process.env.ANTHROPIC_API_KEY;
const previousBaseUrl = process.env.ANTHROPIC_BASE_URL;
const previousBedrock = process.env.CLAUDE_CODE_USE_BEDROCK;
const previousVertex = process.env.CLAUDE_CODE_USE_VERTEX;
const previousFetch = globalThis.fetch;
delete process.env.CLAUDE_CODE_USE_BEDROCK;
delete process.env.CLAUDE_CODE_USE_VERTEX;
delete process.env.ANTHROPIC_BASE_URL;
process.env.ANTHROPIC_API_KEY = 'claude-test-key';

try {
  // Session source (query.supportedModels) wins and needs no network.
  invalidateClaudeModelsCache();
  assert.equal(isClaudeSessionModelCatalogFresh(), false);
  assert.equal(setClaudeSessionModelCatalog([]), false);
  assert.equal(setClaudeSessionModelCatalog([
    { value: 'opus', displayName: 'Opus' },
  ]), true);
  assert.equal(isClaudeSessionModelCatalogFresh(), true);
  globalThis.fetch = async () => {
    throw new Error('fetch must not run for the session source');
  };
  const sessionListed = await listClaudeModels();
  assert.equal(sessionListed.modelsSource, 'session');
  assert.deepEqual(sessionListed.models.map((row) => row.id), ['opus', 'claude-haiku-5-5']);
  assert.ok(sessionListed.catalog.some((row) => row.value === 'claude-haiku-5-5::effort=high'));

  // Live source uses Anthropic's API endpoint and the user's x-api-key.
  invalidateClaudeModelsCache();
  let seenUrl = '';
  globalThis.fetch = async (url, init) => {
    seenUrl = String(url);
    assert.equal(init?.headers?.['x-api-key'], 'claude-test-key');
    return new Response(JSON.stringify({
      data: [{ id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' }],
    }), { status: 200 });
  };
  process.env.ANTHROPIC_BASE_URL = 'https://gateway.example.com/';
  const liveListed = await listClaudeModels({ refresh: true });
  assert.equal(liveListed.modelsSource, 'live');
  assert.equal(liveListed.models[0].id, 'claude-opus-4-8');
  assert.match(seenUrl, /^https:\/\/api\.anthropic\.com\/v1\/models/);
  delete process.env.ANTHROPIC_BASE_URL;

  // A failed live call falls back to aliases.
  globalThis.fetch = async () => new Response('nope', { status: 502 });
  const fallbackListed = await listClaudeModels({ refresh: true });
  assert.equal(fallbackListed.modelsSource, 'fallback');
  assert.ok(fallbackListed.catalog.length > 0);
  assert.ok(fallbackListed.models.every((row) => !row.id.includes('::')));

  // Bedrock/Vertex never hit the Anthropic Models API.
  invalidateClaudeModelsCache();
  globalThis.fetch = async () => {
    throw new Error('fetch must not run for Bedrock/Vertex');
  };
  process.env.CLAUDE_CODE_USE_BEDROCK = '1';
  const bedrock = await listClaudeModels({ refresh: true });
  assert.equal(bedrock.modelsSource, 'fallback');
  delete process.env.CLAUDE_CODE_USE_BEDROCK;
  process.env.CLAUDE_CODE_USE_VERTEX = '1';
  const vertex = await listClaudeModels({ refresh: true });
  assert.equal(vertex.modelsSource, 'fallback');
  delete process.env.CLAUDE_CODE_USE_VERTEX;
} finally {
  globalThis.fetch = previousFetch;
  if (typeof previousKey === 'string') process.env.ANTHROPIC_API_KEY = previousKey;
  else delete process.env.ANTHROPIC_API_KEY;
  if (typeof previousBaseUrl === 'string') process.env.ANTHROPIC_BASE_URL = previousBaseUrl;
  else delete process.env.ANTHROPIC_BASE_URL;
  if (typeof previousBedrock === 'string') process.env.CLAUDE_CODE_USE_BEDROCK = previousBedrock;
  else delete process.env.CLAUDE_CODE_USE_BEDROCK;
  if (typeof previousVertex === 'string') process.env.CLAUDE_CODE_USE_VERTEX = previousVertex;
  else delete process.env.CLAUDE_CODE_USE_VERTEX;
  invalidateClaudeModelsCache();
  removeIsolatedDataDir();
}

console.log('claude-models.test.js OK');
