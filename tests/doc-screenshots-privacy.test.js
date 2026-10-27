import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { findPrivateMatches, assertScreenshotClean, collectScreenshotDomText } from '../scripts/lib/doc-screenshot-privacy.mjs';

test('privacy gate rejects private paths, addresses and injected identifiers', () => {
  const ctx = { username: 'private-user', hostname: 'private-host', privateTokens: 'secret-brand' };
  for (const text of ['/home/x/', '/Users/x/', 'C:\\Users\\x', '192.168.1.5', '10.0.0.7', '172.31.2.5', 'jan@firma.pl', 'PRIVATE-USER', 'private-host', 'secret-brand']) {
    assert.ok(findPrivateMatches(text, ctx).length, text);
  }
  for (const text of ['Neutral demo text', 'v10.2.1', 'user@example.com', 'user@example.org', 'prefixprivate-hostsuffix']) {
    assert.deepEqual(findPrivateMatches(text, ctx), []);
  }
  assert.throws(() => assertScreenshotClean({ domText: 'Clean', ocrText: '/home/x/', ctx }), /Privacy gate/);
  assert.doesNotThrow(() => assertScreenshotClean({ domText: 'Clean', ocrText: 'Also clean', ctx }));
});

test('DOM collector includes ordinary shadow text, live fields and nested shadow roots', () => {
  const field = (tag, value) => ({ matches: selector => selector.split(',').includes(tag), value });
  const host = shadowRoot => ({ matches: () => false, shadowRoot });
  const shadow = (textContent, elements) => ({ textContent, querySelectorAll: () => elements });
  const documentWith = shadowRoot => ({
    title: 'Demo title',
    body: { innerText: 'Light DOM text', querySelectorAll: () => [field('input', 'Light field'), host(shadowRoot)] },
  });
  for (const location of ['ordinary shadow text', 'nested shadow text', 'input', 'textarea', 'nested input']) {
    const secret = '/home/x/';
    const nested = shadow(location === 'nested shadow text' ? secret : 'Nested text', [
      field('input', location === 'nested input' ? secret : 'Nested field'),
    ]);
    const root = shadow(location === 'ordinary shadow text' ? secret : 'Shadow text', [
      field('input', location === 'input' ? secret : 'Shadow input'),
      field('textarea', location === 'textarea' ? secret : 'Shadow textarea'),
      host(nested),
    ]);
    const doc = documentWith(root);
    const text = collectScreenshotDomText(doc);
    assert.ok(text.includes(secret), location);
    assert.ok(text.includes('Demo title\nLight DOM text\nLight field'), location);
    assert.throws(() => assertScreenshotClean({ domText: text, ocrText: 'Clean OCR', ctx: {} }), /home path/, location);
    // Match page.evaluate serialization: no module bindings are available.
    assert.equal(runInNewContext(`(${collectScreenshotDomText.toString()})()`, { document: doc }), text);
  }
  const clean = collectScreenshotDomText(documentWith(shadow('Neutral shadow text', [])));
  assert.doesNotThrow(() => assertScreenshotClean({ domText: clean, ocrText: '', ctx: {} }));
});
