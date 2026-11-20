import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { dispatchSidebarChatRowStatusPatch, subscribeSidebarChatRowStatusPatch } from '../app_front/features/sidebar/sidebarChatRowRefreshBus.js';

const source = readFileSync(new URL('../app_front/features/chat/services/chatSidebarState.js', import.meta.url), 'utf8');
const update = source.slice(source.indexOf('export function updateSidebarChatStates('), source.indexOf('export function refreshSidebarChatStates(')).replace('export ', '');

for (const all of [false, true]) {
  test(`${all ? 'full' : 'dirty'} status refresh patches each managed or legacy row once`, () => {
    const managed = { dataset: { chatId: 'managed' } };
    const legacy = { dataset: { chatId: all ? 'managed' : 'legacy' } };
    const counts = new Map();
    const patch = (row) => counts.set(row, (counts.get(row) || 0) + 1);
    const body = {
      querySelectorAll: () => [managed, legacy],
      querySelector: (selector) => selector.includes('"managed"') ? managed : legacy,
    };
    const off = subscribeSidebarChatRowStatusPatch((event) => {
      patch(managed);
      event.patchedRows.add(managed);
    });
    try {
      const context = vm.createContext({
        document: { getElementById: () => ({ hidden: false, querySelector: () => body }) },
        isUiFreezeTraceActive: () => false,
        chatShell: { pendingSidebarDirtyIds: new Set(all ? ['*'] : ['managed', 'legacy']) },
        dispatchSidebarChatRowStatusPatch,
        syncActiveChatArchiveNotice: () => {},
        getSidebarChatStateMeta: () => ({}),
        applyChatListItemVisualState: patch,
      });
      vm.runInContext(update, context);
      context.updateSidebarChatStates(new Map());
      assert.equal(counts.get(managed), 1, 'Lit subscriber owns its row');
      assert.equal(counts.get(legacy), 1, 'legacy copy still receives the fallback');
    } finally {
      off();
    }
  });
}
