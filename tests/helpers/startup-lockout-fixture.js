import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { workspaceKeyFromCwd } from '../../lib/persist/todos-persist.js';

/**
 * Isolated logical workspace folders for startup-lockout tests.
 *
 * @returns {{ wsA: string, wsB: string, keyA: string, keyB: string }}
 */
export function createStartupLockoutWorkspacePair() {
  const wsA = mkdtempSync(path.join(tmpdir(), 'cr-ws-a-'));
  const wsB = mkdtempSync(path.join(tmpdir(), 'cr-ws-b-'));
  const keyA = workspaceKeyFromCwd(wsA);
  const keyB = workspaceKeyFromCwd(wsB);
  if (!keyA || !keyB) throw new Error('workspaceKeyFromCwd failed for test fixture');
  return { wsA, wsB, keyA, keyB };
}
