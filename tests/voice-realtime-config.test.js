import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRealtimeClientSecretBody,
  DEFAULT_REALTIME_MODEL,
  DEFAULT_REALTIME_VOICE,
  REALTIME_FLAGSHIP_MODEL,
  REALTIME_MAX_OUTPUT_TOKENS,
  REALTIME_MINI_MODEL,
  REALTIME_TOOLS,
  resolveRealtimeModel,
} from '../lib/voice/realtime-session-config.js';

test('defaults to the mini model and accepts the flagship by name', () => {
  assert.equal(resolveRealtimeModel(''), DEFAULT_REALTIME_MODEL);
  assert.equal(resolveRealtimeModel('mini'), REALTIME_MINI_MODEL);
  assert.equal(resolveRealtimeModel('flagship'), REALTIME_FLAGSHIP_MODEL);
  assert.equal(resolveRealtimeModel('gpt-realtime'), REALTIME_FLAGSHIP_MODEL);
  assert.equal(buildRealtimeClientSecretBody({}).session.model, DEFAULT_REALTIME_MODEL);
  assert.equal(buildRealtimeClientSecretBody({ model: 'flagship' }).session.model, REALTIME_FLAGSHIP_MODEL);
  assert.equal(buildRealtimeClientSecretBody({}).session.max_output_tokens, REALTIME_MAX_OUTPUT_TOKENS);
});

test('pins instructions, tools and audio config to the minted session', () => {
  const actual = buildRealtimeClientSecretBody({ lang: 'pl' });
  assert.equal(actual.session.type, 'realtime');
  assert.equal(actual.session.model, DEFAULT_REALTIME_MODEL);
  assert.ok(actual.session.instructions.includes('Polish'), 'language is baked into the prompt');
  assert.ok(
    actual.session.instructions.includes('open_chat_sidebar'),
    'the model is told when to open the chat sidebar'
  );
  assert.ok(
    actual.session.instructions.includes('close_chat_sidebar'),
    'the model is told when to hide the chat sidebar'
  );
  assert.ok(
    actual.session.instructions.includes('set_chat_mode'),
    'the model is told when to switch plan or agent mode'
  );
  assert.ok(
    actual.session.instructions.includes('delete_chat'),
    'the model is told when to delete a chat'
  );
  assert.ok(
    actual.session.instructions.includes('switch_workspace'),
    'the model is told when to switch project'
  );
  assert.ok(
    actual.session.instructions.includes('list_tasks'),
    'the model is told when to list tasks'
  );
  assert.ok(
    actual.session.instructions.includes('send_nav'),
    'the model is told when to send terminal keys'
  );
  assert.ok(
    actual.session.instructions.includes('set_model'),
    'the model is told when to change the chat model'
  );
  assert.ok(
    actual.session.instructions.includes('switch_harness'),
    'the model is told when to switch harness'
  );
  assert.ok(
    actual.session.instructions.includes('end_voice_mode'),
    'the model is told when to end voice mode'
  );
  assert.equal(actual.session.tools, REALTIME_TOOLS);
  assert.equal(actual.session.audio.input.turn_detection.type, 'semantic_vad');
  assert.equal(actual.session.audio.input.transcription.language, 'pl');
  assert.ok(actual.expires_after.seconds > 0, 'the secret must expire');
});

test('falls back to the default voice when the client asks for an unknown one', () => {
  const actualUnknown = buildRealtimeClientSecretBody({ voice: 'not-a-voice' });
  assert.equal(actualUnknown.session.audio.output.voice, DEFAULT_REALTIME_VOICE);
  const actualAllowed = buildRealtimeClientSecretBody({ voice: 'cedar' });
  assert.equal(actualAllowed.session.audio.output.voice, 'cedar');
});

test('every tool declares a closed parameter schema', () => {
  for (const tool of REALTIME_TOOLS) {
    assert.equal(tool.type, 'function', `${tool.name} must be a function tool`);
    assert.ok(tool.description, `${tool.name} needs a description for the model`);
    assert.equal(tool.parameters.type, 'object', `${tool.name} parameters must be an object`);
    assert.equal(
      tool.parameters.additionalProperties,
      false,
      `${tool.name} must not accept free-form arguments`
    );
  }
});

test('the tool set matches the frontend executor', () => {
  const expectedNames = [
    'send_prompt',
    'stop_agent',
    'read_last_answer',
    'get_chat_status',
    'list_chats',
    'switch_chat',
    'create_chat',
    'delete_chat',
    'open_chat_sidebar',
    'close_chat_sidebar',
    'set_chat_mode',
    'run_task',
    'list_tasks',
    'list_workspaces',
    'switch_workspace',
    'list_folders',
    'switch_folder',
    'close_chat',
    'rename_chat',
    'send_nav',
    'list_models',
    'set_model',
    'switch_harness',
    'fork_chat',
    'set_read_mode',
    'get_cost',
    'end_voice_mode',
  ];
  assert.deepEqual(REALTIME_TOOLS.map((tool) => tool.name).sort(), [...expectedNames].sort());
});

test('delete_chat and switch_harness require an explicit confirm flag', () => {
  const deleteChat = REALTIME_TOOLS.find((tool) => tool.name === 'delete_chat');
  assert.equal(deleteChat.parameters.properties.confirm.type, 'boolean');
  const switchHarness = REALTIME_TOOLS.find((tool) => tool.name === 'switch_harness');
  assert.equal(switchHarness.parameters.properties.confirm.type, 'boolean');
});
