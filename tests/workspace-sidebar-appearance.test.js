import assert from 'node:assert/strict';
import {
  mergeWorkspaceSidebarConfig,
  sanitizeWorkspaceSidebarConfig,
} from '../lib/persist/settings-sidebar.js';
import { buildWorkspacesList } from '../lib/workspace-list.js';

const clean = sanitizeWorkspaceSidebarConfig({
  a: { color: 'Blue', icon: ' 🚀 ' },
  b: { color: 'neon', icon: '<b>x</b>' },
  c: { color: 'red', icon: 'waytoolongicon' },
});
assert.deepEqual(clean, { a: { color: 'blue', icon: '🚀' }, c: { color: 'red' } });

// Clearing a field in the incoming payload removes it from the stored overlay.
const merged = mergeWorkspaceSidebarConfig({ a: { color: 'blue', icon: '🚀', label: 'A' } }, { a: { label: 'A', color: '' } });
assert.deepEqual(merged, { a: { label: 'A', icon: '🚀' } });
const cleared = mergeWorkspaceSidebarConfig({ a: { color: 'blue', icon: '🚀', label: 'A' } }, { a: { label: 'A', icon: '' } });
assert.deepEqual(cleared, { a: { label: 'A', color: 'blue' } });

// The client list carries colour and icon.
const [row] = buildWorkspacesList({
  registry: [{ id: 'cretli:ws:1', kind: 'folders' }],
  sidebarConfig: { 'cretli:ws:1': { color: 'teal', icon: '🌊', label: 'Sea' } },
});
assert.equal(row.color, 'teal');
assert.equal(row.icon, '🌊');
assert.equal(row.name, 'Sea');

console.log('workspace-sidebar-appearance.test.js: ok');
