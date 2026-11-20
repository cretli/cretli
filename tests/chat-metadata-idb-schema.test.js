/**
 * Task 5.1 — metadata IDB schema helpers (node).
 *
 * Run: node tests/chat-metadata-idb-schema.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildChatMetadataRecord,
  deriveArchivedFlag,
  deriveWorkspaceKey,
  selectChatMetadataRetentionDeletes,
  stripRuntimeFields,
  CHAT_METADATA_MAX_CHAT_ROWS,
} from '../app_front/features/chat/chatMetadataIdbSchema.js';

test('stripRuntimeFields removes pane/ws/socket and underscore keys', () => {
  const input = {
    id: 'c1',
    title: 'T',
    pane: { el: 1 },
    ws: {},
    _buffer: 'x',
    workspaceFile: 'ws.code-workspace',
  };
  const stripped = stripRuntimeFields(input);
  assert.equal(stripped.id, 'c1');
  assert.equal(stripped.title, 'T');
  assert.equal(stripped.workspaceFile, 'ws.code-workspace');
  assert.equal(stripped.pane, undefined);
  assert.equal(stripped.ws, undefined);
  assert.equal(stripped._buffer, undefined);
});

test('buildChatMetadataRecord round-trip excludes runtime objects', () => {
  const record = buildChatMetadataRecord(
    {
      id: 'chat-a',
      title: 'Hello',
      updatedAt: '2026-01-02T00:00:00.000Z',
      workspaceFile: 'proj.code-workspace',
      workspaceFolder: '/src',
      archivedAt: '2026-01-01T00:00:00.000Z',
      pane: documentLike(),
      ws: { send() {} },
    },
    { sessionId: 'sess-1', generation: 2, savedAt: 1000 }
  );
  assert.ok(record);
  assert.equal(record.id, 'chat-a');
  assert.equal(record.sessionId, 'sess-1');
  assert.equal(record.generation, 2);
  assert.equal(record.workspaceKey, 'proj.code-workspace\0/src');
  assert.equal(record.archivedFlag, 1);
  assert.ok(record.rankingUpdatedAtMs > 0);
  assert.equal(record.pane, undefined);
  assert.equal(record.ws, undefined);
  assert.equal(JSON.stringify(record).includes('pane'), false);
});

test('selectChatMetadataRetentionDeletes prunes lowest rank and keeps pinned', () => {
  const rows = [];
  for (let i = 0; i < CHAT_METADATA_MAX_CHAT_ROWS + 5; i += 1) {
    rows.push({
      id: `id-${i}`,
      rankingUpdatedAtMs: i,
      watcherPinned: i === 3,
    });
  }
  const deletes = selectChatMetadataRetentionDeletes(rows);
  assert.equal(deletes.length, 5);
  assert.equal(deletes.includes('id-3'), false);
  assert.deepEqual(deletes.slice(0, 3), ['id-0', 'id-1', 'id-2']);
});

test('deriveWorkspaceKey and archived flag', () => {
  assert.equal(deriveWorkspaceKey({ workspaceFile: 'a', workspaceFolder: 'b' }), 'a\0b');
  assert.equal(deriveArchivedFlag({}), 0);
  assert.equal(deriveArchivedFlag({ archivedAt: '2026-01-01' }), 1);
});

/** @returns {object} */
function documentLike() {
  return { nodeType: 1, tagName: 'DIV' };
}
