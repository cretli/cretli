import assert from 'node:assert/strict';
import { DETAIL_PAGE_CHARS, paginateDetail } from '../lib/mcp/builtin/paging.js';

// A surrogate pair straddling the page boundary must not be split.
{
  const text = `${'a'.repeat(DETAIL_PAGE_CHARS - 1)}😀${'b'.repeat(10)}`;
  const first = paginateDetail(text, { revision: 'r1' });
  assert.equal(first.truncated, true);
  assert.equal(first.text, 'a'.repeat(DETAIL_PAGE_CHARS - 1), 'page ends before the pair');
  assert.doesNotMatch(first.text, /[\ud800-\udbff]$/, 'no dangling high surrogate');
  const second = paginateDetail(text, { revision: 'r1', cursor: first.next_cursor });
  assert.equal(second.text, `😀${'b'.repeat(10)}`, 'next page starts with the whole pair');
  assert.equal(second.truncated, false);
  assert.equal(first.text + second.text, text, 'pages reassemble the source');
}

// A pair that ends exactly on the boundary stays on the first page.
{
  const text = `${'a'.repeat(DETAIL_PAGE_CHARS - 2)}😀tail`;
  const first = paginateDetail(text, { revision: 'r1' });
  assert.equal(first.text, `${'a'.repeat(DETAIL_PAGE_CHARS - 2)}😀`);
  assert.equal(paginateDetail(text, { revision: 'r1', cursor: first.next_cursor }).text, 'tail');
}

// Plain text still pages at exactly DETAIL_PAGE_CHARS.
{
  const text = 'x'.repeat(DETAIL_PAGE_CHARS + 5);
  const first = paginateDetail(text, { revision: 'r1' });
  assert.equal(first.text.length, DETAIL_PAGE_CHARS);
  assert.equal(paginateDetail(text, { revision: 'r1', cursor: first.next_cursor }).text, 'xxxxx');
}

console.log('mcp-paging.test.js OK');
