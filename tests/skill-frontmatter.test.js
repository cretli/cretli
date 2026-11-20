/**
 * Tests for the shared frontmatter reader used by skill metadata and Cursor
 * rule files: YAML block scalars, quoted values, malformed blocks and the
 * "never show a bare YAML marker as a description" rule.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractFrontmatterBlock,
  frontmatterString,
  oneLineFrontmatterValue,
  parseFrontmatter,
} from '../lib/skills/frontmatter.js';

test('extractFrontmatterBlock returns null without a frontmatter block', () => {
  assert.equal(extractFrontmatterBlock('# Just a heading\n\nbody\n'), null);
  assert.equal(extractFrontmatterBlock(''), null);
  assert.equal(extractFrontmatterBlock('---\nname: a\n'), null);
});

test('parseFrontmatter reads a single-line description', () => {
  const doc = parseFrontmatter('---\nname: alpha\ndescription: Does a thing.\n---\n\nBody\n');
  assert.equal(frontmatterString(doc, 'name'), 'alpha');
  assert.equal(frontmatterString(doc, 'description'), 'Does a thing.');
});

test('parseFrontmatter reads quoted values', () => {
  const doc = parseFrontmatter('---\nname: "beta"\ndescription: \'Use when: X\'\n---\n');
  assert.equal(frontmatterString(doc, 'name'), 'beta');
  assert.equal(frontmatterString(doc, 'description'), 'Use when: X');
});

test('parseFrontmatter reads folded (>-) and literal (|-) block scalars', () => {
  const folded = parseFrontmatter([
    '---',
    'name: gamma',
    'description: >-',
    '  Long folded description',
    '  that continues here.',
    '---',
    '',
  ].join('\n'));
  assert.equal(frontmatterString(folded, 'name'), 'gamma');
  assert.equal(
    oneLineFrontmatterValue(frontmatterString(folded, 'description')),
    'Long folded description that continues here.',
  );

  const literal = parseFrontmatter([
    '---',
    'name: delta',
    'description: |-',
    '  first line',
    '  second line',
    '---',
    '',
  ].join('\n'));
  assert.equal(
    oneLineFrontmatterValue(frontmatterString(literal, 'description')),
    'first line second line',
  );
});

test('parseFrontmatter reads plain > and | block scalars', () => {
  const doc = parseFrontmatter('---\ndescription: >\n  folded plain\n---\n');
  assert.equal(oneLineFrontmatterValue(frontmatterString(doc, 'description')), 'folded plain');
  const pipe = parseFrontmatter('---\ndescription: |\n  kept literal\n---\n');
  assert.equal(oneLineFrontmatterValue(frontmatterString(pipe, 'description')), 'kept literal');
});

test('a bare YAML block marker is never returned as a description', () => {
  assert.equal(oneLineFrontmatterValue('>-'), '');
  assert.equal(oneLineFrontmatterValue('|'), '');
  assert.equal(oneLineFrontmatterValue('   '), '');
});

test('non-scalar frontmatter values read as an empty string', () => {
  const doc = parseFrontmatter('---\ndescription:\n  - one\n  - two\n---\n');
  assert.equal(frontmatterString(doc, 'description'), '');
  assert.equal(frontmatterString(null, 'description'), '');
});

test('malformed YAML falls back to the tolerant scanner', () => {
  const doc = parseFrontmatter('---\nname: eps\ndescription: >-\n  survives a broken block\n\tbad: indent\n---\n');
  assert.equal(frontmatterString(doc, 'name'), 'eps');
  assert.match(frontmatterString(doc, 'description'), /survives a broken block/);
});

test('the tolerant scanner resolves simple keys when YAML cannot parse', () => {
  const doc = parseFrontmatter('---\nname: zeta\ndescription: "unclosed\nmore: [1,\n---\n');
  assert.equal(frontmatterString(doc, 'name'), 'zeta');
  assert.equal(frontmatterString(doc, 'description'), '"unclosed');
});
