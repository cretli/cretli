import assert from 'node:assert/strict';
import { parseCodexDeviceAuthOutput } from '../lib/codex/codex-device-auth.js';
import { isCodexChatGptAuthPayload } from '../lib/codex/codex-chatgpt-auth.js';
import { normalizeCodexAuthMode } from '../lib/codex/codex-auth-mode.js';

assert.equal(normalizeCodexAuthMode('chatgpt'), 'chatgpt');
assert.equal(normalizeCodexAuthMode('api-key'), 'api-key');
assert.equal(normalizeCodexAuthMode('nope'), 'api-key');

const labeled = parseCodexDeviceAuthOutput(`
Follow these steps to sign in with ChatGPT using device code ABCD-EFGHI:

1. Open this link in your browser and sign in to your account
   https://auth.openai.com/codex/device

2. Enter this one-time code (expires in 15 minutes)
   ABCD-EFGHI
`);
assert.equal(labeled.url, 'https://auth.openai.com/codex/device');
assert.equal(labeled.userCode, 'ABCD-EFGHI');

const visit = parseCodexDeviceAuthOutput(`
Visit https://auth.openai.com/activate
Enter code: WXYZ-1234
`);
assert.equal(visit.url, 'https://auth.openai.com/activate');
assert.equal(visit.userCode, 'WXYZ-1234');

const failedRequest = parseCodexDeviceAuthOutput(`
Error logging in with device code: error sending request for url (https://auth.openai.com/api/accounts/deviceauth/usercode)
`);
assert.equal(failedRequest.url, '');
assert.equal(failedRequest.userCode, '');

const ansi = parseCodexDeviceAuthOutput([
  'Welcome to Codex [v\u001b[90m0.152.1\u001b[0m]',
  '',
  'Follow these steps to sign in with ChatGPT using device code authorization:',
  '',
  '1. Open this link in your browser and sign in to your account',
  '   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m',
  '',
  '2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m',
  '   \u001b[94mREEV-EAYKX\u001b[0m',
  '',
].join('\n'));
assert.equal(ansi.url, 'https://auth.openai.com/codex/device');
assert.equal(ansi.userCode, 'REEV-EAYKX');

assert.equal(isCodexChatGptAuthPayload({
  auth_mode: 'chatgpt',
  tokens: { access_token: 'tok', refresh_token: 'ref' },
}), true);
assert.equal(isCodexChatGptAuthPayload({ OPENAI_API_KEY: 'sk-test' }), false);
assert.equal(isCodexChatGptAuthPayload({ tokens: { access_token: 'tok' } }), true);

console.log('codex-chatgpt-auth.test.js OK');
