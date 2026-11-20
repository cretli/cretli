import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Hot read-only paths must not deep-clone the whole store (loadDelegations) on every call.
const source = fs.readFileSync(new URL('../lib/delegation-service.js', import.meta.url), 'utf8');

test('drainQueue reads the store through the frozen read-only snapshot', () => {
  const start = source.indexOf('async function drainQueue(');
  assert.ok(start > 0);
  const body = source.slice(start, source.indexOf('\n  }\n', start));
  assert.match(body, /loadDelegationsReadonly\(\)/);
  assert.doesNotMatch(body, /loadDelegations\(\)/);
});

test('only the mutating boot/restart loops still take caller-owned copies', () => {
  const copies = source.split('\n').filter((line) => /\bloadDelegations\(\)/.test(line) && !/^\s*(\/\/|\*)/.test(line));
  assert.ok(copies.length <= 2, `unexpected loadDelegations() callers: ${copies.join('\n')}`);
});
