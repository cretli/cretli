import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  SIDEBAR_CHAT_ROW_CHILD_SELECTORS,
  SIDEBAR_CHAT_ROW_CONTRACT_SOURCES,
  SIDEBAR_CHAT_ROW_DATA_ATTRS,
  SIDEBAR_CHAT_ROW_ROOT_CLASS,
  SIDEBAR_CHAT_ROW_SELECTOR,
  SIDEBAR_CHAT_ROW_TRANSIENT_CLASSES,
} from '../app_front/features/sidebar/sidebarLitMigrationContract.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readRepo(relPath) {
  return readFileSync(resolve(repoRoot, relPath), 'utf8');
}

test('contract doc exists and references the contract module', () => {
  const doc = readRepo('docs/sidebar-lit-migration-contracts.md');
  assert.match(doc, /sidebarLitMigrationContract\.js/, 'doc links machine-readable contract');
  assert.match(doc, /light DOM/i, 'doc confirms light DOM render root');
  assert.match(doc, /Shadow DOM/i, 'doc mentions shadow boundary');
});

test('sidebarView and chat.js still expose the row selector contract', () => {
  const viewSource = readRepo('app_front/features/sidebar/sidebarView.js');
  const rowSource = readRepo('app_front/features/sidebar/sidebarChatRowModel.js')
    + readRepo('app_front/features/sidebar/cr-sidebar-chat-row.js');
  const patchSource = readRepo('app_front/features/sidebar/sidebarChatRowVisualPatch.js');
  const chatSource = readRepo('app_front/chat.js');
  assert.match(rowSource, new RegExp(SIDEBAR_CHAT_ROW_ROOT_CLASS), 'Lit row emits row class');
  assert.match(rowSource, /data-chat-id=/, 'Lit row emits data-chat-id');
  assert.match(viewSource, /cr-sidebar-chat-row/, 'sidebarView mounts row host boundary');
  assert.match(viewSource, /cr-sidebar-workspace/, 'sidebarView mounts workspace Lit host');
  assert.match(chatSource, /\.sidebar-chat-item\[data-chat-id=/, 'chat.js queries row selector');
  for (const attr of SIDEBAR_CHAT_ROW_DATA_ATTRS) {
    if (attr === 'data-visual-key') {
      assert.match(patchSource, /visualKey/, 'data-visual-key set by in-place status patch');
      continue;
    }
    assert.match(rowSource, new RegExp(attr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${attr} in row model`);
  }
});

test('contract sources still mention the root row class', () => {
  for (const rel of SIDEBAR_CHAT_ROW_CONTRACT_SOURCES) {
    const source = readRepo(rel);
    assert.match(
      source,
      new RegExp(SIDEBAR_CHAT_ROW_ROOT_CLASS),
      `${rel} references ${SIDEBAR_CHAT_ROW_ROOT_CLASS}`,
    );
  }
});

test('child selectors and transient classes remain in sidebarView or chat patch path', () => {
  const bundle = SIDEBAR_CHAT_ROW_CONTRACT_SOURCES.map((rel) => readRepo(rel)).join('\n')
    + '\n'
    + readRepo('app_front/features/sidebar/sidebarSwipe.js')
    + '\n'
    + readRepo('app_front/features/sidebar/sidebarChatRowModel.js')
    + readRepo('app_front/features/sidebar/sidebarChatRowVisualPatch.js');
  for (const sel of SIDEBAR_CHAT_ROW_CHILD_SELECTORS) {
    const needle = sel.replace(/^\./, '');
    assert.match(bundle, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `child hook ${sel}`);
  }
  for (const cls of SIDEBAR_CHAT_ROW_TRANSIENT_CLASSES) {
    assert.match(
      bundle,
      new RegExp(cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `transient class ${cls} referenced`,
    );
  }
});
