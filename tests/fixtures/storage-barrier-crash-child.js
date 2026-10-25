// Child process fixture for the F29 restart tests: runs a COMMIT-time I/O fault
// and then dies with SIGKILL before the replacement worker can run its barrier,
// like a host/process crash or a lost recycle message. Never closes the host.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [dir, handlersPath, commandId] = process.argv.slice(2);
const root = path.dirname(fileURLToPath(import.meta.url));
const { createStorageWorkerHost } = await import(pathToFileURL(path.join(root, '../../lib/storage/worker-host.js')).href);
const { executeCommand } = await import(pathToFileURL(path.join(root, '../../lib/storage/command-receipts.js')).href);
const { WRITE_GATE_TEST_EXEMPTION } = await import(pathToFileURL(path.join(root, '../../lib/storage/maintenance-coordinator.js')).href);
const host = createStorageWorkerHost({ dbDir: dir, handlersPath, faultInjection: true, restartBackoffMs: { initial: 10, max: 100 }, writeGate: WRITE_GATE_TEST_EXEMPTION });
await host.start();
await host.command('setup', {});
const args = {
  datasetGeneration: 'gen-1', commandId, name: 'putCommitFault',
  payload: { k: 'crash', v: '1', faultMarker: path.join(dir, 'fault-crash') },
};
try { await executeCommand(host, args); } catch { /* unknown_commit expected */ }
process.kill(process.pid, 'SIGKILL');
