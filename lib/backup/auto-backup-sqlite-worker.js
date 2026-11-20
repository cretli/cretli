import { parentPort, workerData } from 'node:worker_threads';
import { backup, DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';

try {
  const db = new DatabaseSync(workerData.source, { readOnly: true });
  try { await backup(db, workerData.destination); } finally { db.close(); }
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(workerData.destination)) hash.update(chunk);
  parentPort.postMessage({ ok: true, size: fs.statSync(workerData.destination).size, sha256: hash.digest('hex') });
} catch (error) {
  parentPort.postMessage({ ok: false, error: String(error?.message || error) });
}
