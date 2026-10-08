import assert from 'node:assert/strict';
import {
  SDK_SYSTEM_PROMPT_MAX_CHARS,
  SDK_SYSTEM_PROMPT_UNAUTHORIZED_CODE,
  applySdkSystemPromptOptions,
  isSdkCustomSystemPromptEnabled,
  isSdkSystemPromptUnauthorizedError,
  normalizeSdkSystemPromptText,
  resolveSdkSystemPrompt,
  sdkSystemPromptCacheKey,
  shouldDropSdkSystemPromptAfterError,
} from '../lib/sdk/sdk-system-prompt.js';
import {
  getSdkCustomSystemPromptSettings,
  normalizeSdkCustomSystemPromptPatch,
} from '../lib/persist/settings.js';

assert.equal(isSdkCustomSystemPromptEnabled(null), false);
assert.equal(isSdkCustomSystemPromptEnabled({ sdkCustomSystemPrompt: { enabled: true } }), true);
assert.equal(normalizeSdkSystemPromptText('  '), '');
assert.equal(normalizeSdkSystemPromptText('a'.repeat(SDK_SYSTEM_PROMPT_MAX_CHARS + 10)).length, SDK_SYSTEM_PROMPT_MAX_CHARS);

const settings = { sdkCustomSystemPrompt: { enabled: true, text: 'account default' } };
const chatOverride = resolveSdkSystemPrompt({
  settings,
  chat: { sdkSystemPrompt: ' chat wins ' },
  isLocalAgent: true,
});
assert.equal(chatOverride.source, 'chat');
assert.equal(chatOverride.text, 'chat wins');

const fromSettings = resolveSdkSystemPrompt({ settings, chat: {}, isLocalAgent: true });
assert.equal(fromSettings.source, 'settings');

const keyA = sdkSystemPromptCacheKey({ text: 'alpha' });
const keyB = sdkSystemPromptCacheKey({ text: 'beta' });
assert.notEqual(keyA, keyB);

const opts = { model: { id: 'auto' }, local: { cwd: '/tmp' } };
applySdkSystemPromptOptions(opts, { text: 'custom' });
assert.equal(opts.systemPrompt, 'custom');
applySdkSystemPromptOptions(opts, { text: '' });
assert.equal(Object.prototype.hasOwnProperty.call(opts, 'systemPrompt'), false);

assert.equal(
  isSdkSystemPromptUnauthorizedError(new Error('InvalidArgument: --system-prompt not allowed')),
  true
);
assert.equal(
  isSdkSystemPromptUnauthorizedError({
    message: 'InvalidArgument: --system-prompt denied',
    code: 'invalid_argument',
  }),
  true
);
assert.equal(isSdkSystemPromptUnauthorizedError(new Error('other failure')), false);

assert.equal(
  shouldDropSdkSystemPromptAfterError(
    new Error('InvalidArgument for --system-prompt'),
    { text: 'x' }
  ),
  true
);
assert.equal(shouldDropSdkSystemPromptAfterError(new Error('--system-prompt'), { text: '' }), false);

assert.equal(SDK_SYSTEM_PROMPT_UNAUTHORIZED_CODE, 'system_prompt_unauthorized');

assert.deepEqual(getSdkCustomSystemPromptSettings({ enabled: true, text: '  hi  ' }), {
  enabled: true,
  text: 'hi',
});
assert.deepEqual(normalizeSdkCustomSystemPromptPatch({ enabled: true, text: '   ' }), {
  enabled: true,
  text: '',
});

console.log('sdk-system-prompt.test.js: ok');
