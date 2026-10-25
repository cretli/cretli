import assert from 'node:assert/strict';
import { parseTerminalInteraction, resolveTerminalState } from '../lib/status-parser.js';
import statusParserUnitFixtures from '../public/fixtures/status-parser-unit.json' with { type: 'json' };

const STATUS_TEST_FIXTURES = statusParserUnitFixtures.fixtures;

let failed = 0;

function runCase(name, fn) {
  try {
    fn();
    console.log('OK:', name);
  } catch (err) {
    failed += 1;
    console.error('FAIL:', name);
    console.error(err && err.stack ? err.stack : String(err));
  }
}

for (const fixture of STATUS_TEST_FIXTURES) {
  runCase(`fixture ${fixture.id}`, () => {
    const parsed = parseTerminalInteraction(fixture.input);
    const state = resolveTerminalState(
      parsed,
      fixture.connection || 'connected',
      fixture.agent || 'idle',
      fixture.recentOutput === true
    );
    assert.equal(state.tone, fixture.expectedTone);
    if (typeof fixture.expectedGenerating === 'boolean') {
      assert.equal(parsed.generating, fixture.expectedGenerating);
    }
  });
}

runCase('generating wins over textarea when explicit status line exists', () => {
  const parsed = parseTerminalInteraction('• Generating.\n→ Add a follow-up\nctrl+c to stop');
  const state = resolveTerminalState(parsed, 'connected', 'active', false);
  assert.equal(parsed.generating, true);
  assert.equal(state.tone, 'generating');
});

if (failed > 0) {
  console.error(`\nStatus parser tests failed: ${failed}`);
  process.exit(1);
}

console.log('\nAll status parser tests passed.');
