import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cancelWidgetHostClipboardPending,
  handleWidgetHostClipboardMessage,
  requestWidgetHostCopyText,
} from '../app_front/embed/widgetHostClipboard.js';
import { setWidgetHostPort } from '../app_front/embed/widgetHostScreenshot.js';

function createMockPort() {
  /** @type {Array<unknown>} */
  const sent = [];
  /** @type {((event: MessageEvent) => void) | null} */
  let onmessage = null;
  return {
    sent,
    get onmessage() {
      return onmessage;
    },
    set onmessage(handler) {
      onmessage = handler;
    },
    postMessage(data) {
      sent.push(data);
    },
    start() {},
  };
}

test('requestWidgetHostCopyText resolves when host replies ok', async () => {
  const port = createMockPort();
  setWidgetHostPort(port);
  const promise = requestWidgetHostCopyText('hello widget');
  assert.equal(port.sent.length, 1);
  assert.equal(port.sent[0].type, 'cretli-widget-copy-text');
  assert.equal(port.sent[0].text, 'hello widget');

  const handled = handleWidgetHostClipboardMessage({
    data: {
      type: 'cretli-widget-copy-text-result',
      id: port.sent[0].id,
      ok: true,
    },
  });
  assert.equal(handled, true);
  await assert.doesNotReject(promise);
  setWidgetHostPort(null);
});

test('requestWidgetHostCopyText rejects when host replies with error', async () => {
  const port = createMockPort();
  setWidgetHostPort(port);
  const promise = requestWidgetHostCopyText('fail copy');
  const handled = handleWidgetHostClipboardMessage({
    data: {
      type: 'cretli-widget-copy-text-result',
      id: port.sent[0].id,
      ok: false,
      error: 'Permission denied',
    },
  });
  assert.equal(handled, true);
  await assert.rejects(promise, /Permission denied/);
  setWidgetHostPort(null);
});

test('cancelWidgetHostClipboardPending rejects pending requests', async () => {
  const port = createMockPort();
  setWidgetHostPort(port);
  const promise = requestWidgetHostCopyText('pending');
  cancelWidgetHostClipboardPending();
  // Expected message is produced by widgetHostClipboard.js.
  await assert.rejects(promise, /Connection to the host page was closed/);
  setWidgetHostPort(null);
});
