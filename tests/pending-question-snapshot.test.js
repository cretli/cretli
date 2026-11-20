import test from 'node:test';
import assert from 'node:assert/strict';
import { installViewApiHead } from '../app_front/features/chat/history/services/viewApiHead.js';

test('live question snapshot restores missing cards without adding history records', () => {
  const rendered = [];
  const resolved = [];
  const rv = {
    chat: {},
    openCodeQuestionByRequestId: new Map([['old', {}]]),
    renderOpenCodeQuestion: (event, options) => rendered.push({ event, options }),
    markOpenCodeQuestionResolved: (id, meta) => {
      resolved.push({ id, meta });
      rv.openCodeQuestionByRequestId.delete(id);
    },
  };
  installViewApiHead(rv);
  const question = { type: 'opencode_question', requestId: 'live', questions: [{ question: 'Continue?' }] };
  rv.chat._sdkHistoryHydrating = true;
  rv.viewPublicApi.syncPendingQuestions([question]);
  assert.deepEqual(rendered, [], 'Hydration must finish before repairing the current view');
  rv.chat._sdkHistoryHydrating = false;
  rv.viewPublicApi.syncPendingQuestions([question]);
  assert.deepEqual(rendered, [{ event: question, options: { persist: false } }]);
  assert.deepEqual(resolved, [{ id: 'old', meta: { status: 'expired' } }]);
});
