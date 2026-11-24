import test from 'node:test';
import assert from 'node:assert/strict';
import { getModelIconSrc } from '../app_front/features/chat/modelIcon.js';

test('model family mark wins over the harness mark', () => {
  assert.equal(getModelIconSrc('claude-opus-5-5::effort=high', 'sdk'), '/harness-icons/claude.svg');
  assert.equal(getModelIconSrc('gpt-6.1-sol::effort=low', 'openrouter'), '/harness-icons/codex.svg');
});

test('models without a family mark use the harness mark', () => {
  assert.equal(getModelIconSrc('kimi-k2.5', 'opencode'), '/harness-icons/opencode.svg');
  assert.equal(getModelIconSrc('something-new', 'unknown'), '/harness-icons/cursor.svg');
});
