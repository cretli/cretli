/**
 * Child process for the Scout cross-process merge race test.
 *
 * Usage: node workspace-scout-merge-child.js <dataDir> <workspaceFolder> <scanId> <chatId> <startAtMs>
 *
 * It waits for the shared start timestamp so both children reach
 * `recordScoutFindings` at the same moment, then prints one JSON line with the
 * record result. A non-zero exit or a missing JSON line fails the parent test.
 *
 * The child receives the isolated data dir through the spawn environment, but
 * every store call below also passes it explicitly so the child never depends
 * on the parent's module-level path resolution.
 */
import { recordScoutFindings } from '../../lib/workspace-watcher-scout.js';

const [dataDir, workspaceFolder, scanId, chatId, startAtRaw] = process.argv.slice(2);
const startAt = Number(startAtRaw) || 0;

const wait = Math.max(0, startAt - Date.now());
if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));

const result = recordScoutFindings(workspaceFolder, [{ title: 'Cross process race', category: 'bug' }], {
  dataDir,
  scanId,
  sourceChatId: chatId,
  now: Date.parse('2026-06-06T10:00:00.000Z'),
});

process.stdout.write(`${JSON.stringify({
  scanId,
  added: result.added,
  merged: result.merged,
  capacityExceeded: result.capacityExceeded,
})}\n`);
