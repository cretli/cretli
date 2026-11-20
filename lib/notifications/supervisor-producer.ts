import { createHash } from 'node:crypto';
import path from 'node:path';
import { readSupervisorStatus } from '../autostart/supervisor-status.js';
import { publishNotification } from './notification-store.ts';

export async function publishSupervisorAlert(options: { dataDir: string; storePath?: string; broadcast?: any }) {
  const state = readSupervisorStatus({ statePath: path.join(options.dataDir, 'supervisor-state.json') });
  if (!state.crashLoopAt) return { created: false };
  return publishNotification({ category: 'system', severity: 'warning', title: 'Server crash loop detected',
    body: `Crash loop at ${state.crashLoopAt}. ${state.crashLoopReason || ''}`,
    actionUrl: '', fingerprint: `supervisor-crash-loop:${createHash('sha256').update(state.crashLoopAt).digest('hex')}`,
  }, { storePath: options.storePath, broadcast: options.broadcast });
}
