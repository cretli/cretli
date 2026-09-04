import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveSendBarEnterAction } from '../app_front/features/sendBar/sendBarInput.js';

test('Enter in a single-line field sends', () => {
  assert.equal(resolveSendBarEnterAction({ key: 'Enter' }, { isTextarea: false }), 'send');
});

test('Shift+Enter in a single-line field expands and inserts a newline', () => {
  assert.equal(
    resolveSendBarEnterAction({ key: 'Enter', shiftKey: true }, { isTextarea: false }),
    'expand-newline'
  );
});

test('Enter still sends after the compact field was expanded to a textarea', () => {
  assert.equal(
    resolveSendBarEnterAction({ key: 'Enter' }, { isTextarea: true, isMultilineMode: false }),
    'send'
  );
});

test('Shift+Enter in a compact textarea inserts a newline without sending', () => {
  assert.equal(
    resolveSendBarEnterAction({ key: 'Enter', shiftKey: true }, { isTextarea: true, isMultilineMode: false }),
    'newline'
  );
});

test('Enter in dedicated multiline mode inserts a newline', () => {
  assert.equal(
    resolveSendBarEnterAction({ key: 'Enter' }, { isTextarea: true, isMultilineMode: true }),
    'newline'
  );
});

test('Ctrl+Enter or Cmd+Enter in multiline mode sends', () => {
  assert.equal(
    resolveSendBarEnterAction(
      { key: 'Enter', ctrlKey: true },
      { isTextarea: true, isMultilineMode: true }
    ),
    'send'
  );
  assert.equal(
    resolveSendBarEnterAction(
      { key: 'Enter', metaKey: true },
      { isTextarea: true, isMultilineMode: true }
    ),
    'send'
  );
});

test('Shift+Enter never sends, even with Ctrl', () => {
  assert.equal(
    resolveSendBarEnterAction({ key: 'Enter', shiftKey: true, ctrlKey: true }, { isTextarea: false }),
    'expand-newline'
  );
  assert.equal(
    resolveSendBarEnterAction(
      { key: 'Enter', shiftKey: true, ctrlKey: true },
      { isTextarea: true, isMultilineMode: true }
    ),
    'newline'
  );
});

test('IME composition does not send or insert a newline', () => {
  assert.equal(
    resolveSendBarEnterAction({ key: 'Enter', isComposing: true }, { isTextarea: false }),
    'ignore'
  );
  assert.equal(
    resolveSendBarEnterAction({ key: 'Enter', keyCode: 229 }, { isTextarea: false }),
    'ignore'
  );
});

test('other keys are ignored', () => {
  assert.equal(resolveSendBarEnterAction({ key: 'a' }, { isTextarea: false }), 'ignore');
  assert.equal(resolveSendBarEnterAction({}, { isTextarea: false }), 'ignore');
});
