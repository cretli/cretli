// Child process of the rollback concurrency tests: node todos-rollback-child.mjs <dataDir> <mode> <fence> [cwd]
const [dataDir, mode, fenceArg, cwd] = process.argv.slice(2);
process.env.CRETLI_DATA_DIR = dataDir;
process.env.CURSOR_REMOTE_DATA_DIR = dataDir;
const { readTodosBackendMarker } = await import('../../lib/persist/todos-backend-marker.js');
const { createRollbackLegacyTodosBackend } = await import('../../lib/persist/todos-backend-rollback.js');
const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
try {
  const backend = createRollbackLegacyTodosBackend({ dataDir, marker: readTodosBackendMarker(dataDir), fence: Number(fenceArg) });
  if (mode === 'open') { out({ ok: true }); process.exit(0); }
  // writer: add todos until a newer owner fences this process out; report every acknowledged write.
  let acked = 0;
  out({ ready: true });
  for (let i = 0; i < 2000; i += 1) {
    try {
      backend.addTodo(dataDir, cwd, { title: `w${i}` });
      acked += 1;
    } catch (error) {
      out({ ok: true, acked, code: error.code });
      process.exit(0);
    }
  }
  out({ ok: true, acked, code: 'none' });
} catch (error) {
  out({ ok: false, code: error.code, message: error.message });
}
process.exit(0);
