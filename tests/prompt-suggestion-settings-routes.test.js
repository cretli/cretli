import assert from 'node:assert/strict';
import test from 'node:test';
import { applySettingsPatch } from '../lib/routes/settings-routes.js';
import { clearClaudePromptSuggestions } from '../lib/claude/prompt-suggestion-state.ts';

test('turning prompt suggestions off through settings clears and broadcasts the room state', async () => {
  const room = {
    chatId: 'settings-off-room',
    promptSuggestion: { text: 'stale suggestion', turnRunId: 'run-1' },
  };
  const frames = [];
  const settings = {};
  const result = await applySettingsPatch(
    { body: { claudePromptSuggestionEnabled: false } },
    settings,
    {
      setClaudePromptSuggestionsEnabled(enabled) {
        assert.equal(enabled, false);
        clearClaudePromptSuggestions([room], (_target, frame) => frames.push(frame));
      },
    },
  );

  assert.deepEqual(result, { changed: true });
  assert.equal(settings.claudePromptSuggestionEnabled, false);
  assert.equal(room.promptSuggestion, null);
  assert.deepEqual(frames, [{
    type: 'promptSuggestion', chatId: 'settings-off-room', text: '', turnRunId: '',
  }]);
});
