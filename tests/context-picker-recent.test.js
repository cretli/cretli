import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRecentRankMap,
  loadRecentEntries,
  normalizeRecentEntries,
  pickRecentItems,
  saveRecentEntries,
  sortItemsByRecent,
  touchRecentEntry,
} from '../app_front/features/sendBar/contextPickerRecent.js';

test('normalizeRecentEntries deduplicates and caps entries', () => {
  const entries = normalizeRecentEntries([
    { id: 'cmd:a.md', usedAt: 10 },
    { id: 'cmd:a.md', usedAt: 20 },
    { id: 'pskill:foo', usedAt: 30 },
    'uskill:bar',
    { id: '', usedAt: 40 },
  ]);

  assert.deepEqual(entries, [
    { id: 'cmd:a.md', usedAt: 10 },
    { id: 'pskill:foo', usedAt: 30 },
    { id: 'uskill:bar', usedAt: 0 },
  ]);
});

test('touchRecentEntry moves item to front and persists order', () => {
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => { storage.set(key, value); },
    removeItem: (key) => { storage.delete(key); },
  };

  saveRecentEntries([
    { id: 'cmd:a', usedAt: 1 },
    { id: 'pskill:b', usedAt: 2 },
  ]);

  const next = touchRecentEntry('pskill:b');
  assert.equal(next[0].id, 'pskill:b');
  assert.equal(next[1].id, 'cmd:a');

  const loaded = loadRecentEntries();
  assert.equal(loaded[0].id, 'pskill:b');
  assert.equal(loaded[1].id, 'cmd:a');
});

test('sortItemsByRecent keeps unknown items alphabetically after recent ones', () => {
  const recentRank = buildRecentRankMap([
    { id: 'cmd:z', usedAt: 3 },
    { id: 'cmd:a', usedAt: 2 },
  ]);

  const sorted = sortItemsByRecent([
    { id: 'cmd:m', label: 'middle' },
    { id: 'cmd:z', label: 'zeta' },
    { id: 'cmd:a', label: 'alpha' },
    { id: 'cmd:b', label: 'beta' },
  ], recentRank);

  assert.deepEqual(sorted.map((item) => item.id), ['cmd:z', 'cmd:a', 'cmd:b', 'cmd:m']);
});

test('pickRecentItems returns only existing items in recent order', () => {
  const allItems = [
    { id: 'cmd:a', label: 'A', insert: '@a ' },
    { id: 'cmd:b', label: 'B', insert: '@b ' },
    { id: 'pskill:c', label: 'C', insert: 'skill c' },
  ];

  const picked = pickRecentItems(allItems, [
    { id: 'missing', usedAt: 99 },
    { id: 'cmd:b', usedAt: 50 },
    { id: 'cmd:a', usedAt: 40 },
  ], 5);

  assert.deepEqual(picked.map((item) => item.id), ['cmd:b', 'cmd:a']);
});
