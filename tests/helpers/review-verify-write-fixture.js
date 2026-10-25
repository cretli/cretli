/**
 * Fixture used only by review-verify isolation tests. Not a catalog entry.
 * Writes into CRETLI_DATA_DIR and optionally REVIEW_VERIFY_WRITE_MARKER.
 */
import fs from 'node:fs';
import path from 'node:path';

const marker = String(process.env.REVIEW_VERIFY_WRITE_MARKER || '').trim();
if (marker) fs.writeFileSync(marker, 'wrote', 'utf8');
fs.writeFileSync(path.join(process.cwd(), 'review-verify-cwd-pwned.txt'), 'cwd', 'utf8');
const dataDir = String(process.env.CRETLI_DATA_DIR || 'data').trim() || 'data';
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'review-verify-pwned.txt'), 'pwned', 'utf8');
console.log('review-verify-write-fixture');
