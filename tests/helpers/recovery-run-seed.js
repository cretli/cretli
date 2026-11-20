/**
 * Fast fixture for list/presence regressions that need more runs than the
 * per-state read cap. The public write path commits a transaction per
 * transition, so seeding 500+ rows that way makes the test unnecessarily slow;
 * this helper performs the same durable insert in one transaction. Production
 * code never uses it.
 */

import { createRecoveryIds } from '../../lib/recovery/recovery-ids.ts';

/**
 * @param {object} store
 * @param {{
 *   count: number,
 *   chatId: (index: number) => string,
 *   startAt?: number,
 * }} options `startAt` (ms) keeps the seeded rows older than anything written
 *   afterwards through the real store API.
 * @returns {void}
 */
export function seedInterruptedRuns(store, options) {
  const count = Math.max(0, Math.floor(Number(options?.count) || 0));
  const chatIdFor = typeof options?.chatId === 'function' ? options.chatId : () => '';
  const startAt = Number.isFinite(Number(options?.startAt)) ? Number(options.startAt) : Date.now() - 1_000_000;
  const db = store?.db;
  if (!db || count === 0) return;
  const insert = db.prepare(`
    INSERT INTO recovery_runs(
      logical_run_id, family, owner, state, workspace_folder, chat_id,
      generation, revision, request_id, created_at, updated_at, json
    ) VALUES(?, 'chat', 'chat-run-service', 'interrupted', '', ?, 0, 2, '', ?, ?, ?)
  `);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (let index = 0; index < count; index += 1) {
      const ids = createRecoveryIds();
      const at = new Date(startAt + index).toISOString();
      const run = {
        logicalRunId: ids.logicalRunId,
        attemptId: ids.attemptId,
        requestId: ids.requestId,
        family: 'chat',
        owner: 'chat-run-service',
        state: 'interrupted',
        revision: 2,
        generation: 0,
        workspaceFolder: '',
        chatId: chatIdFor(index),
        reason: 'server_restart',
        createdAt: at,
        updatedAt: at,
      };
      insert.run(ids.logicalRunId, run.chatId, at, at, JSON.stringify(run));
    }
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The transaction may not have started.
    }
    throw err;
  }
}
