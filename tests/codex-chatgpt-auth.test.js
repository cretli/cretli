import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCodexDeviceAuthOutput } from '../lib/codex/codex-device-auth.js';
import {
  getCodexChatGptAuthMetaForClient,
  isCodexChatGptAuthPayload,
  readChatGptPlanTypeFromAuthPayload,
} from '../lib/codex/codex-chatgpt-auth.js';
import { normalizeCodexAuthMode } from '../lib/codex/codex-auth-mode.js';

/**
 * @param {Record<string, unknown>} payload
 * @returns {string}
 */
function makeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

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

const idToken = makeJwt({
  sub: 'user-1',
  'https://api.openai.com/auth': { chatgpt_plan_type: 'free' },
});
assert.equal(readChatGptPlanTypeFromAuthPayload({
  auth_mode: 'chatgpt',
  tokens: {
    id_token: idToken,
    access_token: 'sk-secret-access',
    refresh_token: 'sk-secret-refresh',
  },
}), 'free');
assert.equal(readChatGptPlanTypeFromAuthPayload({ tokens: { access_token: 'tok' } }), '');

{
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-chatgpt-plan-'));
  fs.writeFileSync(path.join(homeDir, 'auth.json'), JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      id_token: idToken,
      access_token: 'sk-secret-access',
      refresh_token: 'sk-secret-refresh',
    },
  }), 'utf8');
  const meta = getCodexChatGptAuthMetaForClient(homeDir);
  assert.equal(meta.codexChatGptAuthEffective, true);
  assert.equal(meta.chatgptPlanType, 'free');
  const serialized = JSON.stringify(meta);
  assert.equal(serialized.includes('sk-secret'), false);
  assert.equal(serialized.includes(idToken), false);
  assert.equal(serialized.includes('access_token'), false);
  assert.equal(serialized.includes('refresh_token'), false);
  fs.rmSync(homeDir, { recursive: true, force: true });
}

console.log('codex-chatgpt-auth.test.js OK');
