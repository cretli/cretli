/**
 * Child process for the cross-process Workspace Memory CAS test.
 *
 * Usage:
 *   node tests/helpers/workspace-memory-add-child.js <dataDir> <workspaceFolder> <tag> <count> [sharedKey]
 *
 * Adds `count` entries with keys `<tag>-<i>` and exits. Several of these run at
 * once against the same workspace file; the test asserts that every entry from
 * every child survives, which only holds if the writer lock + CAS is real. When
 * `sharedKey` is given every child writes that one key instead, so the test can
 * assert that concurrent upserts converge on a single row.
 */

import { addWorkspaceMemory } from '../../lib/persist/workspace-memory-persist.js';

const [dataDir, workspaceFolder, tag, countRaw, sharedKey] = process.argv.slice(2);
const count = Number(countRaw);

if (!dataDir || !workspaceFolder || !tag || !Number.isInteger(count) || count < 1) {
  console.error('usage: workspace-memory-add-child.js <dataDir> <workspaceFolder> <tag> <count> [sharedKey]');
  process.exit(2);
}

for (let i = 0; i < count; i += 1) {
  addWorkspaceMemory(workspaceFolder, {
    type: sharedKey ? 'blocker' : (i % 2 === 0 ? 'finding' : 'context'),
    key: sharedKey || `${tag}-${i}`,
    value: `child ${tag} entry ${i}`,
  }, { dataDir });
}

// Synchronous write: the parent's close handler must not race a buffered flush.
process.stdout.write('DONE\n');
