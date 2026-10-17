#!/usr/bin/env node
/**
 * Renames an oversized server log aside so a restart can start a fresh file.
 * Rotate only after the previous writer is verified gone; see
 * `scripts/lib/restart-log-guard.sh` and `scripts/restart-server-helper.js`.
 *
 * Usage: node scripts/rotate-log.js <file> [maxBytes] [keep]
 */

import { rotateLogIfNeeded } from '../lib/log-rotate.js';

const [filePath, maxBytesRaw, keepRaw] = process.argv.slice(2);

if (!filePath) {
  console.error('Usage: node scripts/rotate-log.js <file> [maxBytes] [keep]');
  process.exitCode = 1;
} else {
  const maxBytes = Number.parseInt(maxBytesRaw ?? '', 10);
  const keep = Number.parseInt(keepRaw ?? '', 10);
  const rotated = rotateLogIfNeeded(filePath, {
    ...(Number.isFinite(maxBytes) && maxBytes > 0 ? { maxBytes } : {}),
    ...(Number.isFinite(keep) && keep > 0 ? { keep } : {}),
  });
  if (rotated) console.log(`[rotate-log] rotated ${filePath}`);
}
