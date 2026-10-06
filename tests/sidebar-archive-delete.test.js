import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readRepo(relPath) {
  return readFileSync(resolve(repoRoot, relPath), 'utf8');
}

const viewSource = readRepo('app_front/features/sidebar/sidebarView.js');
const appSource = readRepo('app_front/App.js');
const cssSource = readRepo('app_front/css/app.scss');

/**
 * Top-level function body inside `createSidebarView` (2-space indented).
 *
 * @param {string} source
 * @param {string} name
 * @returns {string}
 */
function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} located`);
  const rest = source.slice(start + 1);
  const next = rest.indexOf('\n  function ');
  return next >= 0 ? rest.slice(0, next) : rest;
}

test('archived rows emit a trash action, live rows do not', () => {
  const actions = functionBody(viewSource, 'renderChatActionButtonsHtml');
  assert.match(actions, /sidebar-chat-delete-btn/, 'trash button class emitted');
  assert.match(actions, /mdi-trash-can-outline/, 'trash icon emitted');
  assert.match(actions, /if \(archived\)/, 'trash button gated on the archived row');
  // The pin slot is live-only; archived rows free it for the delete action.
  assert.match(actions, /const showPin = !archived && canPinChatToUrl\(\)/);
});

test('the delegated sidebar click routes archived rows into the delete system', () => {
  const handler = functionBody(viewSource, 'handleChatRowAction');
  assert.match(handler, /sidebar-chat-delete-btn/);
  assert.match(handler, /requestDeleteChat\(chatId, \{ preserveListOpen: true \}\)/);
  // Deleting must never fire for a live row even if a stray element appears.
  assert.match(handler, /if \(!isArchived\) return;/);
});

test('createSidebarView receives requestDeleteChat and App.js wires it', () => {
  assert.match(viewSource, /requestDeleteChat = \(\) => \{\}/);
  const wiring = appSource.match(/requestDeleteChat,/g) || [];
  assert.ok(wiring.length >= 2, 'App.js imports and passes requestDeleteChat');
});

test('CSS reserves the archived delete column', () => {
  assert.match(cssSource, /\.sidebar-chat-item\.is-archived \{/);
  assert.match(
    cssSource,
    /\.sidebar-chat-item\.is-archived \.sidebar-chat-delete-btn \{ grid-column: 8; \}/,
  );
});
