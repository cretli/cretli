// Lock contender: node todos-lock-child.mjs <dataDir> <logFile>. Logs enter/exit/takeover lines.
import fs from 'node:fs';
const [dataDir, logFile] = process.argv.slice(2);
const { withRollbackStateLockSync } = await import('../../lib/persist/todos-backend-rollback.js');
const log = (line) => fs.appendFileSync(logFile, `${line}\n`);
withRollbackStateLockSync(dataDir, () => {
  log(`enter ${process.pid}`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  log(`exit ${process.pid}`);
}, { onTakeover: () => log(`takeover ${process.pid}`) });
process.exit(0);
