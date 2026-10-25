import test from 'node:test';
import assert from 'node:assert/strict';
import { createWindow } from '@mixmark-io/domino';

test('GitHub run errors render as text, not markup', async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const window = createWindow('<div id="github-runs-list"></div>');
  globalThis.window = window;
  globalThis.document = window.document;
  try {
    const { renderRunsError } = await import('../app_front/features/git/githubPanel.js');
    renderRunsError('<b>x</b>');
    const list = window.document.getElementById('github-runs-list');
    assert.ok(!list.querySelector('b'));
    assert.equal(list.textContent, '<b>x</b>');
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
