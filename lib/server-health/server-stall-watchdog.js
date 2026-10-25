import path from 'node:path';
import { createStallWatchdog } from './stall-watchdog.js';
import { signatureMarker } from './cpu-profile-summary.js';

/** Keep server-wide incidents in the server checkout, independent of the active workspace. */
export function createServerStallWatchdog({
  repoRoot, dataDir, addTodo, loadTodosData, publishNotification,
  createWatchdog = createStallWatchdog,
}) {
  return createWatchdog({
    repoRoot,
    registryPath: path.join(dataDir, 'stall-watchdog-registry.json'),
    // Leave enough of a seven-second stall to capture its hot frames.
    thresholdMs: 3000,
    heartbeatMs: 250,
    checkMs: 250,
    profileMs: 2000,
    createTodo: (input) => addTodo(dataDir, repoRoot, { ...input, status: 'idea' }),
    findTodoBySignature: (signature) => loadTodosData(dataDir, repoRoot).items
      .find((item) => String(item.body || '').includes(signatureMarker(signature))),
    notify: ({ signature, outcome, stalledForMs }) => publishNotification({
      category: 'system',
      severity: 'warning',
      title: 'Server event-loop stall',
      body: `Main thread heartbeat delayed by ${stalledForMs} ms; incident ${outcome}.`,
      fingerprint: `stall-watchdog:${signature}`,
      actionUrl: '',
    }),
  });
}
