import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRingBuffer,
  buildElementPickContext,
  isAllowedNavigation,
  isCrossOriginResource,
  readWebStorage,
  redactInputValue,
  redactStorageEntry,
  serializeDom,
} from '../app_front/embed/pageBridge.js';

function element(tagName, attributes = [], children = []) {
  const localName = tagName.toLowerCase();
  return {
    nodeType: 1,
    tagName,
    localName,
    type: attributes.find(({ name }) => name === 'type')?.value || '',
    attributes,
    childNodes: children,
    matches(selector) {
      if (selector === '[data-cr-widget], [data-cr-private]') {
        return attributes.some(({ name }) => name === 'data-cr-widget' || name === 'data-cr-private');
      }
      if (selector === 'input, textarea') return ['input', 'textarea'].includes(localName);
      return selector === 'input, textarea, select'
        && ['input', 'textarea', 'select'].includes(localName);
    },
  };
}

test('redacts password and ordinary form values', () => {
  assert.equal(
    redactInputValue({ tagName: 'INPUT', type: 'password', value: 'secret' }),
    '[redacted-password]',
  );
  assert.equal(
    redactInputValue({ tagName: 'INPUT', type: 'email', value: 'person@example.com' }),
    '[redacted]',
  );
  assert.equal(
    redactInputValue({ tagName: 'TEXTAREA', value: 'private note' }),
    '[redacted]',
  );
  assert.equal(redactInputValue({ tagName: 'DIV', textContent: 'public' }), undefined);
});

test('DOM serialization omits private subtrees and entered form values', () => {
  const root = element('MAIN', [], [
    element('INPUT', [
      { name: 'type', value: 'password' },
      { name: 'value', value: 'input secret' },
    ]),
    element('TEXTAREA', [], [{ nodeType: 3, textContent: 'textarea secret' }]),
    element('SECTION', [{ name: 'data-cr-private', value: '' }], [
      { nodeType: 3, textContent: 'private subtree secret' },
    ]),
  ]);

  const serialized = serializeDom(root);
  assert.match(serialized, /\[redacted-password\]/);
  assert.match(serialized, /\[redacted\]/);
  assert.doesNotMatch(serialized, /input secret|textarea secret|private subtree secret/);
});

test('ring buffer retains only its newest entries', () => {
  const buffer = createRingBuffer(3);
  buffer.push('first');
  buffer.push('second');
  buffer.push('third');
  buffer.push('fourth');

  assert.equal(buffer.size, 3);
  assert.deepEqual(buffer.values(), ['second', 'third', 'fourth']);

  const copy = buffer.values();
  copy.push('outside');
  assert.deepEqual(buffer.values(), ['second', 'third', 'fourth']);
});

test('navigation requires an exact allowed origin', () => {
  const allowed = ['https://app.example.com', 'https://docs.example.com:8443'];
  const base = 'https://app.example.com/current/page';

  assert.equal(isAllowedNavigation('/settings', allowed, base), true);
  assert.equal(isAllowedNavigation('https://app.example.com/next', allowed, base), true);
  assert.equal(isAllowedNavigation('https://docs.example.com:8443/guide', allowed, base), true);
  assert.equal(isAllowedNavigation('https://docs.example.com/guide', allowed, base), false);
  assert.equal(isAllowedNavigation('https://app.example.com.evil.test/', allowed, base), false);
  assert.equal(isAllowedNavigation('javascript:alert(1)', allowed, base), false);
  assert.equal(isAllowedNavigation('data:text/plain,hello', ['data:text/plain'], base), false);
  assert.equal(isAllowedNavigation('https://user:pass@app.example.com/', allowed, base), false);
  assert.equal(isAllowedNavigation('not a valid url', [], base), false);
});

test('redacts sensitive storage keys', () => {
  assert.equal(redactStorageEntry('authToken', 'abc123'), '[redacted]');
  assert.equal(redactStorageEntry('api_key', 'secret'), '[redacted]');
  assert.equal(redactStorageEntry('theme', 'dark'), 'dark');
});

test('readWebStorage redacts sensitive values from filtered keys', () => {
  const originalLocalStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem(key) {
      const entries = {
        theme: 'dark',
        apiKey: 'secret-value',
      };
      return entries[key] ?? null;
    },
  };
  try {
    const actual = readWebStorage('local', ['theme', 'apiKey']);
    assert.equal(actual.kind, 'local');
    assert.equal(actual.entries.theme, 'dark');
    assert.equal(actual.entries.apiKey, '[redacted]');
    assert.equal(actual.truncated, false);
  } finally {
    globalThis.localStorage = originalLocalStorage;
  }
});

test('detects cross-origin resources for screenshot sanitization', () => {
  const base = 'http://192.168.1.10:8080/items/edit/9';

  assert.equal(isCrossOriginResource('/css/app.css', base), false);
  assert.equal(isCrossOriginResource('https://fonts.googleapis.com/css2?family=Mulish', base), true);
  assert.equal(isCrossOriginResource('data:image/png;base64,abc', base), false);
  assert.equal(isCrossOriginResource('blob:http://192.168.1.10:8080/uuid', base), false);
  assert.equal(
    isCrossOriginResource('https://cdn.jsdelivr.net/gh/mdbassit/Wysi@latest/dist/wysi.min.css', base),
    true,
  );
});

test('buildElementPickContext serializes picked subtree metadata', () => {
  const originalGetComputedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({
    getPropertyValue: () => '',
  });
  try {
    // Polish text on purpose: guards non-ASCII (UTF-8) content in the serialized subtree.
    const root = element('DIV', [{ name: 'class', value: 'card' }], [
      { nodeType: 3, textContent: 'Miesiąc testowy' },
    ]);
    const actual = buildElementPickContext(root);
    assert.ok(actual);
    assert.equal(actual.element.tag, 'div');
    assert.match(actual.subtreeDom, /Miesiąc testowy/);
  } finally {
    globalThis.getComputedStyle = originalGetComputedStyle;
  }
});
