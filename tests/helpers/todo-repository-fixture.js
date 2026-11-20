/**
 * Synthetic todo documents for repository/route tests. The document is written
 * directly (not through saveTodosData) so a fixture can hold the full 5,000
 * items with chosen ids and timestamps, unmodified by parent-status sync.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { todosDocumentPath } from '../../lib/persist/todos-persist.js';

export const STATUSES = ['idea', 'ready', 'doing', 'done', 'deferred'];

/** @param {number} n */
export function fixtureId(n) {
  const hex = createHash('sha1').update(`fixture-${n}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * 40 roots x (1 + 5 mids x (1 + 20 leaves)) = 4,240 rows, then plain roots up to `count`.
 *
 * @param {number} [count]
 * @returns {Record<string, any>[]}
 */
export function buildItems(count = 5000) {
  /** @type {Record<string, any>[]} */
  const items = [];
  let n = 0;
  const stamp = (k) => new Date(Date.UTC(2026, 0, 1) + (k % 200) * 60000).toISOString();
  const make = (parentId, siblingIndex) => {
    const i = n++;
    const item = {
      id: fixtureId(i),
      title: `Todo ${i} ${i % 7 === 0 ? 'needle' : 'hay'}`,
      body: `Body ${i} ${'x'.repeat(2000)}`,
      status: STATUSES[i % STATUSES.length],
      createdAt: stamp(i),
      updatedAt: stamp(i * 7),
      siblingIndex,
      plan: { markdown: `# Plan ${i}\n${'p'.repeat(600)}`, ...(i % 3 === 0 ? { approvedAt: stamp(i) } : {}) },
      changelog: [{ at: stamp(i), summary: 'created'.repeat(20) }],
      activity: [{ at: stamp(i), kind: 'x' }],
      leafMaterial: { baseManifest: { 'a.js': 'h'.repeat(40) } },
      linkedChatIds: [],
    };
    if (parentId) item.parentId = parentId;
    if (i % 5 === 0) {
      item.review = { code: { state: i % 10 === 0 ? 'passed' : 'failed', reviewers: [] }, plan: { state: 'pending', reviewers: [] } };
    }
    items.push(item);
    return item;
  };
  for (let r = 0; r < 40 && n < count; r++) {
    const root = make('', r);
    for (let m = 0; m < 5 && n < count; m++) {
      const mid = make(root.id, m);
      // Reverse siblingIndex so tree order differs from document order.
      for (let l = 0; l < 20 && n < count; l++) make(mid.id, 19 - l);
    }
  }
  let r = 40;
  while (n < count) make('', r++);
  return items;
}

/**
 * @param {string} dataDir
 * @param {string} cwd
 * @param {Record<string, any>[]} items
 */
export function writeFixtureDocument(dataDir, cwd, items) {
  const file = todosDocumentPath(dataDir, cwd);
  if (!file) throw new Error('no document path');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 3, updatedAt: '2026-01-01T00:00:00.000Z', items, idempotency: {} }));
}
