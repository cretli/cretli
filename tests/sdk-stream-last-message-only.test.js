import assert from 'node:assert/strict';
import { readRichViewSource } from './helpers/rich-view-source.js';
import fs from 'node:fs';
import test from 'node:test';

/**
 * Source-contract proof that an assistant stream delta repaints only the live
 * answer block's markdown host: earlier message blocks are never re-rendered,
 * so their DOM nodes keep identity. The rich view is a 7k-line closure that
 * needs a DOM, so the contract is asserted on the handler's source.
 */
const source = readRichViewSource();
const start = source.indexOf("if (eventType === 'assistant') {");
const end = source.indexOf('closeLiveTurn();', start);
const handler = source.slice(start, end);

test('assistant delta handler is located', () => {
  assert.ok(start > 0 && end > start);
});

test('delta handler never rebuilds the message list', () => {
  assert.doesNotMatch(handler, /mountEl\.innerHTML|mountEl\.replaceChildren|replaceChildren\(/);
  assert.doesNotMatch(handler, /renderHistory|rebuild|querySelectorAll\('cr-sdk-block'\)/);
});

test('delta handler repaints only the live assistant markdown host', () => {
  const paints = handler.match(/(flushMarkdown|scheduleMd)\(([^,]+),/g) || [];
  assert.ok(paints.length >= 2);
  for (const paint of paints) assert.match(paint, /\((rv\.)?assistantMdEl,/);
});

test('an existing block is adopted (keyed reuse) before a new one is created', () => {
  const adopt = handler.indexOf('adoptAssistantBlock(');
  const create = handler.indexOf('createAssistantBlock()');
  assert.ok(adopt > 0 && create > adopt, 'adopt by order key / reuse before create');
  assert.match(handler, /findStreamChildByOrderKey\(/);
});

test('markdown paint writes a single host', () => {
  const body = source.slice(source.indexOf('function paintMarkdown('), source.indexOf('function paintMarkdown(') + 700);
  assert.match(body, /mdHost\.innerHTML = /);
  assert.doesNotMatch(body, /mountEl/);
});
