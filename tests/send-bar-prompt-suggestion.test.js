import assert from 'node:assert/strict';
import { createSendBarPromptSuggestion } from '../app_front/features/sendBar/sendBarPromptSuggestion.js';

const previousDocument = globalThis.document;
const created = [];
globalThis.document = {
  createElement() {
    const listeners = new Map();
    const node = {
      type: '', className: '', textContent: '', hidden: false, children: [], attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, fn) { listeners.set(name, fn); },
      dispatch(name) { listeners.get(name)?.(); },
      appendChild(child) { this.children.push(child); },
    };
    created.push(node);
    return node;
  },
};

try {
  const inputListeners = new Map();
  const input = {
    value: '',
    addEventListener(name, fn) { inputListeners.set(name, fn); },
    dispatchEvent() { inputListeners.get('input')?.(); },
  };
  const host = { hidden: true, children: [], replaceChildren() { this.children = []; }, appendChild(child) { this.children.push(child); } };
  let focused = false;
  let sendCount = 0;
  const chip = createSendBarPromptSuggestion({ host, input, focusInput: () => { focused = true; } });
  chip.set({ text: 'Ask for a test' });
  assert.equal(host.hidden, false);
  assert.equal(host.children[0].textContent, 'Ask for a test');
  host.children[0].dispatch('click');
  assert.equal(input.value, 'Ask for a test');
  assert.equal(focused, true);
  assert.equal(sendCount, 0);
  assert.equal(host.hidden, true);

  input.value = '';
  chip.set({ text: 'Another suggestion' });
  input.value = 'typed';
  host.children[0].dispatch('click');
  assert.equal(input.value, 'typed');
  inputListeners.get('input')();
  assert.equal(host.hidden, true);
  chip.set({ text: 'Clear on new turn' });
  chip.clear();
  assert.equal(host.hidden, true);
  assert.equal(host.children.length, 0);
  void sendCount;
} finally {
  if (previousDocument === undefined) delete globalThis.document;
  else globalThis.document = previousDocument;
}

console.log('send-bar-prompt-suggestion.test.js OK');
