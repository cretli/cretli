import assert from 'node:assert/strict';
import test from 'node:test';
import { isSidebarDocked, shouldCloseSidebarOnResume } from '../app_front/features/sidebar/sidebarDock.js';

test('docks when pinned, open, and desktop', () => {
  const actual = isSidebarDocked({ pinned: true, open: true, isMobile: false });
  assert.equal(actual, true);
});

test('stays overlay when unpinned on desktop', () => {
  const actual = isSidebarDocked({ pinned: false, open: true, isMobile: false });
  assert.equal(actual, false);
});

test('does not dock when the drawer is closed', () => {
  const actual = isSidebarDocked({ pinned: true, open: false, isMobile: false });
  assert.equal(actual, false);
});

test('ignores pin on a mobile viewport', () => {
  const actual = isSidebarDocked({ pinned: true, open: true, isMobile: true });
  assert.equal(actual, false);
});

test('defaults missing flags to not docked', () => {
  assert.equal(isSidebarDocked(), false);
});

test('keeps a pinned sidebar open after page resume', () => {
  const actual = shouldCloseSidebarOnResume({
    isOpen: true,
    isPinned: true,
    isMobile: false,
  });
  assert.equal(actual, false);
});

test('keeps an open desktop overlay after page resume', () => {
  const actual = shouldCloseSidebarOnResume({
    isOpen: true,
    isPinned: false,
    isMobile: false,
  });
  assert.equal(actual, false);
});

test('closes a mobile overlay on page resume', () => {
  const actual = shouldCloseSidebarOnResume({
    isOpen: true,
    isPinned: false,
    isMobile: true,
  });
  assert.equal(actual, true);
});

test('does not close a closed sidebar on resume', () => {
  const actual = shouldCloseSidebarOnResume({
    isOpen: false,
    isPinned: true,
    isMobile: true,
  });
  assert.equal(actual, false);
});
