/**
 * Settings → Usage tab UI contract (source assertions, no jsdom).
 * Pattern: tests/widgets-mcp-settings-ui.test.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAppScssSource } from './helpers/app-scss-source.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const html = read('public/index.html');
const usage = read('app_front/css/features/settings/_usage.scss');
const sdkChat = read('app_front/css/features/chat/_sdk-rich-chat.scss');

// The partial used to carry Chat/Terminal rules; those now live in their own
// partials, so the whole file is the Usage tab. Keep honouring the legacy
// marker if it ever returns.
const usageTabEnd = usage.indexOf('/* Chat/Terminal settings rules');
const usageTabHead = usageTabEnd > 0 ? usage.slice(0, usageTabEnd) : usage;
// The chat-titles / auto-archive rules also sit in this partial and keep their
// own legacy sizes; they are outside the Usage migration.
const chatTitlesStart = usageTabHead.indexOf('.auto-name-chat-row');
const chatTitlesEnd = usageTabHead.indexOf('.settings-usage-flag');
const usageTab = chatTitlesStart > 0 && chatTitlesEnd > chatTitlesStart
  ? usageTabHead.slice(0, chatTitlesStart) + usageTabHead.slice(chatTitlesEnd)
  : usageTabHead;

test('Usage panel opts into .cr-form', () => {
  assert.match(html, /<section class="settings-section cr-form" data-settings-tab="usage"/);
  assert.doesNotMatch(html, /settings-usage-select/, 'no orphan select class');
});

test('Chat sub-tabs (General / Titles / Archiving) use cr-* controls', () => {
  for (const tab of ['chat-titles', 'chat-archive']) {
    assert.match(html, new RegExp(`<section class="settings-section cr-form" data-settings-tab="${tab}"`), `${tab} opts into .cr-form`);
  }
  for (const id of ['auto-title-mode', 'auto-title-source', 'auto-title-provider', 'auto-title-model', 'chat-auto-archive-unit']) {
    assert.match(html, new RegExp(`<cr-bar-select id="${id}"`), `${id} is a cr-bar-select`);
  }
  assert.match(html, /<cr-bar-button id="auto-title-test"/, 'Test is a cr-bar-button');
  assert.match(html, /<cr-bar-input type="number" id="chat-auto-archive-value"/, 'archive value is a cr-bar-input');
  assert.match(html, /<cr-bar-textarea id="quick-commands-input"/, 'quick commands textarea is a cr-bar-textarea');
  const start = html.indexOf('data-settings-tab="chat" role="tabpanel"');
  const end = html.indexOf('data-settings-tab="harness-sdk-models"');
  const chatTabs = html.slice(start, end);
  assert.doesNotMatch(chatTabs, /<(select|textarea|button)\b|<input\b/, 'no native controls in the Chat sub-tabs');
  assert.doesNotMatch(chatTabs, /settings-auto-title-select/);
  assert.doesNotMatch(sdkChat, /\.settings-auto-title-select\s*\{/, 'legacy auto-title select skin removed');
  assert.doesNotMatch(sdkChat, /\.settings-usage-select\b/, 'no Usage select rule in the chat partial');
});

test('Usage rules live in their own app.scss partial on tokens', () => {
  const appScss = readAppScssSource();
  assert.match(appScss, /@use '\.\/features\/settings\/usage';/);
  for (const m of usageTab.matchAll(/font-size:\s*([^;]+);/g)) {
    assert.match(
      m[1].trim(),
      /var\(--cr-font-size-(xs|sm|md|lg|xl)\)/,
      `usage font-size ${m[1]}`,
    );
  }
  assert.doesNotMatch(usageTab, /font-size:[^;]*px/, 'usage has no px font-size');
  // The only intentional !important is the [hidden] override for the error state.
  const withoutHiddenOverride = usageTab.replace(
    /\.settings-usage-state\[hidden\]\s*\{[^}]*\}/,
    '',
  );
  assert.doesNotMatch(withoutHiddenOverride, /!important/, 'no new !important');
  // Input look comes from .cr-form: no duplicated control skin here.
  assert.doesNotMatch(usageTab, /--cr-input-bg|appearance:/, 'usage has no input skin');
  assert.doesNotMatch(usageTab, /\.settings-usage-select\b/, 'usage select rule removed');
  // The step-0 split left Usage rules in the chat partial; they moved out.
  assert.doesNotMatch(sdkChat, /\.settings-usage-/, 'chat partial has no Usage rules');
});

test('TODO usage statistics marker block and hex-colour check stay intact', () => {
  const todoUsage = read('app_front/css/features/todo/_todo-usage.scss');
  assert.match(todoUsage, /TODO usage statistics/);
  assert.equal(/#[0-9a-fA-F]{3,6}\b/.test(todoUsage), false);
});

test('Usage panel carries the resume-advice controls', () => {
  assert.match(html, /id="usage-resume-advice-enabled"/);
  assert.match(html, /id="usage-resume-advice-min-tokens"/);
  const form = read('app_front/features/usage/services/usageSettingsPanel.js');
  assert.match(form, /usage-resume-advice-min-tokens/);
});
