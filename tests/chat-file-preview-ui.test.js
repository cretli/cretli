import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function previewHarness(fetch) {
  const elements = [];
  const document = {
    createElement(tag) {
      const element = {
        tag, children: [], listeners: {}, isConnected: false,
        style: { setProperty() {} },
        append(child) { this.children.push(child); child.isConnected = true; },
        replaceChildren(...children) { this.children = children; },
        addEventListener(type, handler) { this.listeners[type] = handler; },
        remove() { this.isConnected = false; },
        show() {},
        querySelectorAll() { return []; },
      };
      elements.push(element);
      return element;
    },
    body: { append(element) { element.isConnected = true; } },
  };
  const source = readFileSync(new URL('../app_front/features/chat/history/services/workspaceFilePreview.js', import.meta.url), 'utf8')
    .replace(/^import\b[\s\S]*?;\s*/gm, '').replace(/^export /gm, '');
  const context = vm.createContext({
    document, fetch, URLSearchParams, t: (key) => key,
    preloadMarkdown: async () => {}, renderMarkdownHtml: (text) => text,
    unsafeHTML: (text) => text,
    render: (text, element) => { element.textContent = text; },
    bindWorkspaceFileLinks() {},
  });
  vm.runInContext(source, context);
  return { elements, open: context.openWorkspaceFilePreview };
}

test('external preview waits for a click and asks again on a new preview', async () => {
  const requests = [];
  const harness = previewHarness(async (url) => {
    const query = new URL(url, 'http://localhost').searchParams;
    requests.push(query);
    const approved = query.get('allowOutsideWorkspace') === '1';
    return { ok: approved, json: async () => approved
      ? { ok: true, path: '/tmp/my-app/report.md', content: 'Report' }
      : { ok: false, code: 'files.outsideWorkspace' } };
  });
  await harness.open('chat-id', '/tmp/my-app/report.md');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].has('allowOutsideWorkspace'), false);
  const button = harness.elements.find((element) => element.tag === 'cr-bar-button');
  assert.equal(button.textContent, 'files.openExternalPreview');
  button.listeners.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 2);
  assert.equal(requests[1].get('allowOutsideWorkspace'), '1');
  assert.equal(requests[1].get('path'), '/tmp/my-app/report.md');
  assert.equal(harness.elements.find((element) => element.tag === 'div').textContent, 'Report');
  await harness.open('chat-id', '/tmp/my-app/other.md');
  assert.equal(requests.length, 3);
  assert.equal(requests[2].has('allowOutsideWorkspace'), false);
});

test('closing a preview before the read completes does not add an external action', async () => {
  let respond;
  const harness = previewHarness(() => new Promise((resolve) => { respond = resolve; }));
  const opened = harness.open('chat-id', '/tmp/my-app/report.md');
  harness.elements[0].listeners['cr-dialog-close']();
  respond({ ok: false, json: async () => ({ ok: false, code: 'files.outsideWorkspace' }) });
  await opened;
  assert.equal(harness.elements.some((element) => element.tag === 'cr-bar-button'), false);
});
