/**
 * Placement contract for the workspace quick menu in the static shell.
 *
 * The chip lives in the sidebar workspace bar (between the sidebar head and
 * body, NOT inside the hidden `.header-workspace-wrap` fallback) below the search row, whose chat filter toggle sits next to the search field; the popover is a sibling of the hidden wrap and its
 * branch section sits OUTSIDE the workspace `ul[role=listbox]`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

function indexOfOne(needle) {
  const first = html.indexOf(needle);
  assert.notEqual(first, -1, `missing in index.html: ${needle}`);
  const second = html.indexOf(needle, first + 1);
  assert.equal(second, -1, `duplicated in index.html: ${needle}`);
  return first;
}

test('the branch chip and the filter toggle live in the sidebar workspace bar', () => {
  const headIndex = indexOfOne('class="sidebar-head"');
  const barIndex = indexOfOne('id="sidebar-workspace-bar"');
  const chipIndex = indexOfOne('id="header-workspace-branch"');
  const filterIndex = indexOfOne('id="sidebar-only-active-btn"');
  const bodyIndex = indexOfOne('class="sidebar-body"');
  assert.ok(headIndex < barIndex && barIndex < chipIndex, 'chip is inside the bar');
  const searchIndex = indexOfOne('id="sidebar-search"');
  assert.ok(headIndex < searchIndex && searchIndex < filterIndex, 'filter toggle sits in the search row');
  assert.ok(filterIndex < barIndex && chipIndex < bodyIndex, 'filter toggle precedes the bar');
  assert.ok(html.indexOf('header-workspace-wrap') > -1);
});

test('the popover moved out of the hidden wrap and owns the branch section', () => {
  const popoverIndex = indexOfOne('id="header-workspace-popover"');
  const wrapStart = indexOfOne('class="header-workspace-wrap"');
  const wrapEnd = html.indexOf('</div>', html.indexOf('header-workspace-arrow', wrapStart));
  assert.ok(wrapEnd > wrapStart);
  assert.ok(
    popoverIndex > wrapEnd,
    'popover must be a sibling AFTER the hidden wrap, not its child',
  );

  const listboxStart = indexOfOne('id="header-workspace-items"');
  const listboxEnd = html.indexOf('</ul>', listboxStart);
  const branchSection = indexOfOne('id="header-branch-section"');
  assert.ok(branchSection > listboxEnd, 'branch section stays outside the workspace listbox');
});

test('branch section carries its own listbox and new-branch input', () => {
  const sectionStart = indexOfOne('id="header-branch-section"');
  const sectionEnd = html.indexOf('</div>\n    </div>', sectionStart);
  const section = html.slice(sectionStart, sectionEnd);
  assert.match(section, /id="header-branch-list"/);
  assert.match(section, /id="header-branch-new-input"/);
  assert.match(section, /id="header-branch-new-btn"/);
  assert.match(section, /role="listbox"/);
});
