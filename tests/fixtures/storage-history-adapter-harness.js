/**
 * Shared harness of the history adapter tests: a real worker host over a
 * temporary store, the real coordinator, group committer, pending buffer and
 * SQLite backend. Nothing here touches data/ or a live store.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStorageCoordinator } from '../../lib/storage/coordinator.js';
import { createGroupCommitter } from '../../lib/storage/group-commit.js';
import { createStorageWorkerHost } from '../../lib/storage/worker-host.js';
import { createChatHistoryStore, HISTORY_GROUP_MAX_MEMBER_BYTES } from '../../lib/storage/chat-history-store.js';
import { createChatHistoryAdapter } from '../../lib/persist/chat-history-adapter.js';
import { createSqliteHistoryBackend } from '../../lib/persist/chat-history-backend-sqlite.js';
import { createHistoryPendingBuffer } from '../../lib/persist/history-pending-buffer.js';
import { HISTORY_HANDLERS_PATH } from '../../lib/persist/chat-history-runtime.js';
import { WRITE_GATE_TEST_EXEMPTION } from '../../lib/storage/maintenance-coordinator.js';

export const FAULT_HANDLERS_PATH = fileURLToPath(new URL('./storage-chat-history-handlers.js', import.meta.url));
export const GENERATION = 'gen-adapter-1';

/** @returns {string} */
export function makeRoot(prefix = 'cretli-history-adapter-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * @param {string} controlDir
 * @param {{ pid?: number, alive?: Set<number> }} [options]
 */
export function makeCoordinator(controlDir, options = {}) {
  const alive = options.alive;
  return createStorageCoordinator({
    controlDir, autoRenew: false, pid: options.pid, pidStart: 'test',
    ...(alive ? { isOwnerAlive: (owner) => alive.has(owner.pid) } : {}),
  });
}

/**
 * @param {{
 *   root: string, handlersPath?: string, faultInjection?: boolean, generation?: string,
 *   coordinator?: ReturnType<typeof createStorageCoordinator>, wrapStore?: (store: object, host: object) => object,
 *   producerId?: string, onCommitted?: (event: Record<string, unknown>) => void, group?: boolean, loadMaxBytes?: number,
 *   wrapPendingBuffer?: (buffer: ReturnType<typeof createHistoryPendingBuffer>) => object,
 * }} options
 */
export async function bootParts(options) {
  const dbDir = path.join(options.root, 'db');
  fs.mkdirSync(dbDir, { recursive: true });
  const coordinator = options.coordinator ?? makeCoordinator(path.join(options.root, 'control'));
  if (coordinator.state !== 'owner') coordinator.acquire();
  const host = createStorageWorkerHost({
    dbDir, handlersPath: options.handlersPath ?? HISTORY_HANDLERS_PATH, faultInjection: options.faultInjection === true, restartBackoffMs: { initial: 5, max: 20 },
    writeGate: WRITE_GATE_TEST_EXEMPTION,
  });
  await host.start();
  await coordinator.activate(host);
  const guarded = coordinator.guardHost(host);
  const committer = options.group === false ? undefined : createGroupCommitter({ host: guarded, maxMemberBytes: HISTORY_GROUP_MAX_MEMBER_BYTES });
  const baseStore = createChatHistoryStore({ host: guarded, groupCommitter: committer });
  const store = options.wrapStore ? options.wrapStore(baseStore, host) : baseStore;
  const pendingBuffer = createHistoryPendingBuffer({ dir: path.join(options.root, 'pending') });
  await pendingBuffer.open();
  const backend = createSqliteHistoryBackend({
    store, datasetGeneration: options.generation ?? GENERATION, pendingBuffer: options.wrapPendingBuffer ? options.wrapPendingBuffer(pendingBuffer) : pendingBuffer, producerId: options.producerId, onCommitted: options.onCommitted,
    retryDelayMs: 1, loadMaxBytes: options.loadMaxBytes,
  });
  const adapter = createChatHistoryAdapter({ backend, kind: 'sqlite' });
  return {
    host, store, baseStore, backend, adapter, pendingBuffer, coordinator, committer, dbDir,
    async close() {
      await committer?.close().catch(() => {});
      await host.close({ timeoutMs: 1000 }).catch(() => {});
      coordinator.close();
    },
  };
}

/** @param {number} index @returns {string} a legacy-valid chat id */
export const chatIdOf = (index) => `aaaaaaaa-0000-4000-8000-${String(index).padStart(12, '0')}`;

/** @param {string} text @param {string} [createdAt] */
export const userRec = (text, createdAt) => ({ kind: 'localUser', text, ...(createdAt ? { createdAt } : {}) });

/** @param {string} text @param {'delta'|'snapshot'} [mode] */
export const assistantRec = (text, mode = 'delta') => ({
  kind: 'sdk', harness: 'test', event: { type: 'assistant', streamTextMode: mode, message: { role: 'assistant', content: [{ type: 'text', text }] } },
});
