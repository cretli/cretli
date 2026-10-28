import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { en } from '../app_front/i18n/en.js';
import { BROWSER_ERROR_CODES, errorText, externalHolderText } from '../app_front/features/browser/browserErrors.js';

const knownCodes = [
  'auth-required',
  'browser-error',
  'browser-unavailable',
  'external-browser-consent-required',
  'chat-bind-conflict',
  'confirmation-required',
  'dialog-action-invalid',
  'dialog-failed',
  'dialog-not-found',
  'dom-failed',
  'drag-target-required',
  'elements-failed',
  'elements-unavailable',
  'explicit-target-required',
  'external-session-busy',
  'forbidden-chat',
  'forbidden-owner',
  'forbidden-workspace',
  'input-rate-limited',
  'invalid-argument',
  'invalid-chat',
  'invalid-owner',
  'invalid-url',
  'invalid-wait-until',
  'locator-failed',
  'locator-index-invalid',
  'locator-required',
  'mode-required',
  'navigation-blocked',
  'navigation-failed',
  'no-workspace',
  'not-external',
  'not-found',
  'page-closed',
  'plan-mode-readonly',
  'rate-limited',
  'review-mode-readonly',
  'screenshot-busy',
  'screenshot-failed',
  'screenshot-too-large',
  'select-option-invalid',
  'select-option-required',
  'session-limit',
  'tab-limit',
  'tab-not-found',
  'unknown-action',
  'unsupported-input',
  'upload-file-limit',
  'upload-files-required',
  'upload-path-forbidden',
  'upload-path-not-found',
  'wait-loadstate-invalid',
  'wait-state-invalid',
  'wait-target-required',
  'widget-auth-forbidden',
];

test('browser error codes retain their complete ordered list', () => {
  assert.deepEqual(Array.from(BROWSER_ERROR_CODES), knownCodes);
});

test('known and unknown errors retain their text and length limit', () => {
  const known = Object.assign(new Error('driver detail'), { code: 'browser-error' });
  assert.equal(errorText(known), en.browser.error['browser-error'].replace('{detail}', 'driver detail'));
  assert.equal(errorText(Object.assign(new Error('server detail'), { code: 'new-code' })), 'server detail');
  assert.equal(errorText(new Error('x'.repeat(250))), `${'x'.repeat(200)}…`);
});

test('external holder categories and busy errors use the translated holder', () => {
  assert.equal(externalHolderText('agent'), en.browser.externalHolder.agent);
  assert.equal(externalHolderText('unknown-holder'), en.browser.externalHolder.pending);
  const busy = Object.assign(new Error('raw server detail'), { code: 'external-session-busy', holder: 'agent' });
  assert.equal(errorText(busy), en.browser.error['external-session-busy'].replace('{detail}', externalHolderText('agent')));
});

test('external busy rendering builds text nodes and a release button', () => {
  const source = readFileSync(fileURLToPath(new URL('../app_front/features/browser/browserPanel.js', import.meta.url)), 'utf8');
  const branch = source.split('function renderSessionList(sessions) {', 2)[1].split("listEl.innerHTML = `<div class=\"browser-empty\">", 1)[0];
  assert.ok(branch);
  assert.doesNotMatch(branch, /\.innerHTML\b/);
  assert.match(branch, /browser-external-busy/);
  assert.match(branch, /data-browser-external-release/);
  assert.match(branch, /textContent/);
});
