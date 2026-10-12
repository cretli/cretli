/**
 * Compact diagnostic logs for delegation lifecycle. Events go to stdout and to
 * a daily JSONL file under the data dir so they survive a server restart.
 */
import { appendFileSync, chmodSync, existsSync, readdirSync, statSync, unlinkSync } from 'fs';
import path from 'path';
import { resolveDataPath } from './runtime-paths.js';

const FILE_PREFIX = 'delegation-events-';
const FILE_SUFFIX = '.jsonl';
const RETENTION_DAYS = 14;
const MAX_DAILY_FILE_BYTES = 4 * 1024 * 1024;
let lastPrunedDay = '';

function pruneOldFiles(dataDir, now) {
  const cutoff = now - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const filename of readdirSync(dataDir)) {
    if (!filename.startsWith(FILE_PREFIX) || !filename.endsWith(FILE_SUFFIX)) continue;
    const timestamp = Date.parse(`${filename.slice(FILE_PREFIX.length, -FILE_SUFFIX.length)}T00:00:00.000Z`);
    if (Number.isFinite(timestamp) && timestamp < cutoff) unlinkSync(path.join(dataDir, filename));
  }
}

/**
 * Appends one event line to the daily delegation log. Never throws: a logging
 * failure must not affect delegation handling.
 *
 * @param {{ dataDir: string, payload: object, now?: number }} options
 * @returns {boolean} true when the line was written
 */
export function appendDelegationEventFile({ dataDir, payload, now = Date.now() }) {
  try {
    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== lastPrunedDay) {
      lastPrunedDay = day;
      pruneOldFiles(dataDir, now);
    }
    const filePath = path.join(dataDir, `${FILE_PREFIX}${day}${FILE_SUFFIX}`);
    const isNewFile = !existsSync(filePath);
    const line = `${JSON.stringify({ at: new Date(now).toISOString(), ...payload })}\n`;
    if (!isNewFile && statSync(filePath).size + Buffer.byteLength(line) > MAX_DAILY_FILE_BYTES) return false;
    appendFileSync(filePath, line, { encoding: 'utf8', mode: 0o600 });
    if (isNewFile) chmodSync(filePath, 0o600);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} event
 * @param {object} [record]
 * @param {Record<string, unknown>} [extra]
 */
export function logDelegationEvent(event, record = {}, extra = {}) {
  if (process.env.CRETLI_TEST_DATA_DIR) return;
  const payload = {
    event: String(event || '').trim(),
    delegationId: String(record.id || extra.delegationId || '').trim(),
    attemptId: String(record.attemptId || extra.attemptId || '').trim(),
    runId: String(record.runId || extra.runId || '').trim(),
    messageId: String(extra.messageId || '').trim(),
    status: String(record.status || extra.status || '').trim(),
    queuedAt: String(record.createdAt || '').trim(),
    startedAt: String(record.startedAt || '').trim(),
    runningAt: String(record.runningAt || '').trim(),
    finishedAt: String(record.finishedAt || '').trim(),
    ...extra,
  };
  console.info('[delegation]', JSON.stringify(payload));
  appendDelegationEventFile({ dataDir: resolveDataPath(), payload });
}
