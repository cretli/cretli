/**
 * Rolling file for browser debugRemote dumps (inspect on the Node host).
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'fs';
import path from 'path';

const CLIENT_DEBUG_LOG_MAX_BYTES = 6 * 1024 * 1024;

/**
 * @param {string} dataDir
 */
export function createClientDebugLog(dataDir) {
  const logPath = path.join(dataDir, 'client-debug.log');
  const prevPath = path.join(dataDir, 'client-debug-prev.log');

  /**
   * @param {string} reason
   * @param {string} ua
   * @param {string[]} lines
   */
  function appendClientDebugLogFile(reason, ua, lines) {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    const stamp = new Date().toISOString();
    const uaShort = ua ? ua.slice(0, 360).replace(/\s+/g, ' ') : '';
    let block = `\n---------- ${stamp} reason=${reason}${uaShort ? ` ua=${uaShort}` : ''} ----------\n`;
    for (const line of lines) {
      block += `${line}\n`;
    }
    try {
      if (existsSync(logPath) && statSync(logPath).size > CLIENT_DEBUG_LOG_MAX_BYTES) {
        try {
          if (existsSync(prevPath)) unlinkSync(prevPath);
        } catch (err) {
          console.warn('[client-debug-file] prev unlink failed:', err?.message || err);
        }
        try {
          renameSync(logPath, prevPath);
        } catch (err) {
          console.warn('[client-debug-file] rotate failed:', err?.message || err);
        }
      }
      appendFileSync(logPath, block, 'utf8');
    } catch (err) {
      console.error('[client-debug-file]', err?.message || err);
    }
  }

  return { logPath, appendClientDebugLogFile };
}
