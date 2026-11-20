/**
 * Backend parameterization for the tests of the converted chats callers (leaf B2).
 *
 * `runOnChatsBackends(fn)` runs the same scenario on the legacy adapter and on a SQLite adapter that lives in an
 * isolated runtime (a real storage worker over a fresh chats.sqlite). The runtime is installed as the active chats
 * runtime for the duration of the scenario only; the global default stays legacy, so no marker is read and the
 * production gate (`CHATS_SQLITE_RUNTIME_ENABLED`) is never touched.
 */
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The persistence modules resolve their data paths at load time, so they are imported lazily: a test that sets up its
// isolated data dir with a dynamic import still gets there first.
const persist = () => import('../../lib/persist/chats-persist.js');
const runtimes = () => import('../../lib/persist/chats-runtime.js');

const HANDLERS_PATH = fileURLToPath(new URL('../fixtures/storage-chats-handlers.js', import.meta.url));

const BUILTIN_TRANSPORTS = new Set(['sdk', 'opencode', 'claude', 'codex', 'codebuddy', 'deepseek', 'qwen', 'openrouter', 'mistral', 'mimo', 'zai']);

/** @type {ReadonlyArray<'legacy' | 'sqlite'>} */
export const CHATS_BACKEND_KINDS = Object.freeze(['legacy', 'sqlite']);

/**
 * Installs an isolated runtime of the given kind as the active chats runtime.
 *
 * @param {'legacy' | 'sqlite'} kind
 * @returns {Promise<{ kind: string, runtime: ReturnType<typeof createChatsRuntime>, close: () => Promise<void> }>}
 */
export async function activateChatsBackend(kind) {
  const { legacyChatsBackend, saveChatsAsync } = await persist();
  const { createChatsRuntime, setActiveChatsRuntime } = await runtimes();
  if (kind === 'legacy') {
    await saveChatsAsync([]);
    const runtime = createChatsRuntime({ backend: legacyChatsBackend, backendKind: 'legacy' });
    setActiveChatsRuntime(runtime);
    return { kind, runtime, close: async () => { setActiveChatsRuntime(null); } };
  }
  const [{ createStorageWorkerHost }, { createChatsStore }, { WRITE_GATE_TEST_EXEMPTION }, { createSqliteChatsBackend }] = await Promise.all([
    import('../../lib/storage/worker-host.js'),
    import('../../lib/storage/chats-store.js'),
    import('../../lib/storage/maintenance-coordinator.js'),
    import('../../lib/persist/chats-backend-sqlite.js'),
  ]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-chats-b2-'));
  const host = createStorageWorkerHost({
    dbDir: dir, filename: 'chats.sqlite', handlersPath: HANDLERS_PATH,
    writeGate: WRITE_GATE_TEST_EXEMPTION, restartBackoffMs: { initial: 5, max: 20 },
  });
  await host.start();
  const store = createChatsStore({ host, datasetGeneration: 'gen-b2' });
  const runtime = createChatsRuntime({
    backend: createSqliteChatsBackend({ store }),
    backendKind: 'sqlite',
    close: async () => { await host.close().catch(() => {}); },
  });
  setActiveChatsRuntime(runtime);
  return {
    kind,
    runtime,
    close: async () => {
      // Post-commit effects of the last write (list broadcast, indexes) are still in flight; let them settle first.
      await new Promise((resolve) => setTimeout(resolve, 150));
      setActiveChatsRuntime(null);
      await runtime.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Runs `fn(kind)` once per backend, each on a fresh, empty chats store.
 *
 * @param {(kind: 'legacy' | 'sqlite') => Promise<void> | void} fn
 * @param {{ kinds?: ReadonlyArray<'legacy' | 'sqlite'> }} [options]
 * @returns {Promise<void>}
 */
export async function runOnChatsBackends(fn, options = {}) {
  for (const kind of options.kinds || CHATS_BACKEND_KINDS) {
    const active = await activateChatsBackend(kind);
    try {
      await fn(kind);
    } finally {
      await active.close();
    }
  }
}

/** @type {Awaited<ReturnType<typeof activateChatsBackend>> | null} */
let envBackend = null;

/**
 * For a test file that is run once per backend by `tests/chats-b2-backend-matrix.test.js`: reads
 * `CHATS_TEST_BACKEND` (default `legacy`) and installs that backend for the whole process. Call it with top-level
 * `await` before the first chat is seeded, and call `registerChatsBackendTeardown()` as the LAST statement of the file.
 *
 * @returns {Promise<'legacy' | 'sqlite'>}
 */
export async function useChatsBackendFromEnv() {
  const kind = process.env.CHATS_TEST_BACKEND === 'sqlite' ? 'sqlite' : 'legacy';
  envBackend = await activateChatsBackend(kind);
  return kind;
}

/**
 * Registers the teardown as a test, so it runs after every test registered before it (and after a script-style file
 * finished its top-level code). Closing the storage worker is what lets the test process exit.
 *
 * @returns {void}
 */
export function registerChatsBackendTeardown() {
  test('chats backend teardown', async () => {
    const active = envBackend;
    envBackend = null;
    if (active) await active.close();
  });
}

/**
 * Seeds raw chat rows on whichever backend is active.
 *
 * Legacy rewrites the collection (`saveChatsAsync`). The SQLite adapter refuses a whole-collection save by design, so
 * the same rows are replayed through `addChatAsync` (+ `updateChatAsync` for the archive flag): the row keeps its id,
 * transport, parents and every field `addChat` accepts. Rows must be listed parents-first.
 *
 * @param {Array<Record<string, any>>} rows
 * @param {{ append?: boolean }} [options] append = keep the existing chats (`[...existing, ...rows]`)
 * @returns {Promise<void>}
 */
export async function seedChatRows(rows, options = {}) {
  const { addChatAsync, loadChatsAsync, removeChatAsync, saveChatsAsync, updateChatAsync } = await persist();
  const { getActiveChatsRuntime } = await runtimes();
  if (getActiveChatsRuntime().backendKind === 'legacy') {
    const base = options.append ? await loadChatsAsync() : [];
    await saveChatsAsync([...base, ...rows]);
    return;
  }
  if (!options.append) {
    for (const row of await loadChatsAsync()) await removeChatAsync(row.id);
  }
  for (const row of rows) {
    const { id, title, workspaceFile, workspaceFolder, model, cursorSessionId, ...rest } = row;
    const extras = { ...rest, id };
    // An unknown transport is only persisted verbatim when it is flagged as a local harness plugin.
    if (typeof extras.agentTransport === 'string' && !BUILTIN_TRANSPORTS.has(extras.agentTransport)) extras.localHarnessTransport = true;
    delete extras.createdAt;
    delete extras.updatedAt;
    const archivedAt = extras.archivedAt;
    delete extras.archivedAt;
    await addChatAsync(cursorSessionId || `sess-${id}`, title, workspaceFile, workspaceFolder, model, extras);
    if (archivedAt) await updateChatAsync(id, { archived: true });
  }
}
