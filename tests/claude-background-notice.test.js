import assert from 'node:assert/strict';
import { installViewApiTail } from '../app_front/features/chat/history/services/viewApiTail.js';
import { installRunLifecycle } from '../app_front/features/chat/history/services/runLifecycle.js';

// Exercise the actual rich-view notice renderer, not only the WS payload.
const lines = [];
const records = [];
const plain = [];
const rv = {
  chat: {}, mountEl: {}, viewPublicApi: {},
  hooks: { appendPlain: (text) => plain.push(text), onHistoryRecord: (record) => records.push(record) },
  stopTimeoutProgressSeries() {},
  lineMeta: (className, html) => { lines.push({ className, html }); return '2026-01-01T00:00:00Z'; },
};
installRunLifecycle(rv);
const view = installViewApiTail(rv);
const notice = { phase: 'notice', transport: 'claude', noticeType: 'background_tasks', message: 'Background tasks: 2 <live>' };
view.appendSdkRunProgress(notice);
assert.equal(lines.length, 1, 'notice creates a visible rich-view line');
assert.equal(lines[0].className, 'sdk-rich-line--notice');
assert.ok(lines[0].html.includes('2 &lt;live&gt;'), 'notice text is escaped');
assert.equal(records.length, 1, 'one history record per live notice');
assert.equal(records[0].variant, 'notice');
assert.equal(plain.length, 1);
view.appendSdkRunProgress(notice, { silent: true });
assert.equal(lines.length, 2, 'history replay renders the notice');
assert.equal(records.length, 1, 'replay does not persist a duplicate');
assert.equal(plain.length, 1);
console.log('claude-background-notice.test.js OK');
