/**
 * Plaintext container inside the envelope: a flat, store-only sequence of the backup directory
 * (`manifest.json` + `files/<rel>`), written as a stream and unpacked with hard bounds. It is only
 * ever read from a file the envelope layer fully authenticated.
 *
 *   "CRPK1\0" | repeat( nameLen u16 | name | size u64 | bytes ) | nameLen = 0
 */
import fs from 'node:fs';
import path from 'node:path';
import { OfflineDataError } from '../offline/offline-errors.js';
import { assertSafeRel } from '../offline/managed-files.js';

const MAGIC = Buffer.from('CRPK1\0', 'latin1');
const MAX_NAME = 1024;
const MAX_ENTRIES = 200000;
const COPY_BUF = 1 << 20;

/**
 * Backup directory members in pack order: manifest first, then payload files.
 *
 * @param {string} backupDir
 * @returns {string[]} POSIX names relative to the backup directory
 */
function listMembers(backupDir) {
  const out = ['manifest.json'];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = path.join(dir, e.name);
      if (e.isSymbolicLink()) throw new OfflineDataError('PACK_INVALID', `symlink in backup: ${e.name}`);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) out.push(path.relative(backupDir, abs).split(path.sep).join('/'));
    }
  };
  walk(path.join(backupDir, 'files'));
  return out;
}

/**
 * @param {string} backupDir
 * @returns {(write: (buf: Buffer) => void) => void}
 */
export function packBackupDir(backupDir) {
  return (write) => {
    write(MAGIC);
    const buf = Buffer.allocUnsafe(COPY_BUF);
    for (const name of listMembers(backupDir)) {
      const nameBuf = Buffer.from(name, 'utf8');
      const fd = fs.openSync(path.join(backupDir, name), 'r');
      try {
        const size = fs.fstatSync(fd).size;
        const head = Buffer.alloc(2 + nameBuf.length + 8);
        head.writeUInt16BE(nameBuf.length, 0);
        nameBuf.copy(head, 2);
        head.writeBigUInt64BE(BigInt(size), 2 + nameBuf.length);
        write(head);
        let left = size;
        while (left > 0) {
          const n = fs.readSync(fd, buf, 0, Math.min(buf.length, left), null);
          if (n === 0) throw new OfflineDataError('PACK_INVALID', `${name} shrank while packing`);
          write(Buffer.from(buf.subarray(0, n)));
          left -= n;
        }
      } finally {
        fs.closeSync(fd);
      }
    }
    write(Buffer.alloc(2));
  };
}

/**
 * Unpack an authenticated plaintext stream into a fresh directory. Names are restricted to
 * `manifest.json` and safe `files/<rel>` paths, duplicates and trailing data are refused.
 *
 * @param {string} packFile
 * @param {string} destDir existing empty directory
 * @returns {{ entries: number, bytes: number }}
 */
export function unpackBackup(packFile, destDir) {
  const fd = fs.openSync(packFile, 'r');
  try {
    const total = fs.fstatSync(fd).size;
    let pos = 0;
    const read = (n) => {
      if (pos + n > total) throw new OfflineDataError('PACK_INVALID', 'packed backup is truncated');
      const b = Buffer.allocUnsafe(n);
      if (n) fs.readSync(fd, b, 0, n, pos);
      pos += n;
      return b;
    };
    if (!read(MAGIC.length).equals(MAGIC)) throw new OfflineDataError('PACK_INVALID', 'unknown packed backup format');
    const seen = new Set();
    let bytes = 0;
    const buf = Buffer.allocUnsafe(COPY_BUF);
    for (;;) {
      const nameLen = read(2).readUInt16BE(0);
      if (nameLen === 0) break;
      if (nameLen > MAX_NAME || seen.size >= MAX_ENTRIES) throw new OfflineDataError('PACK_INVALID', 'packed entry bounds exceeded');
      const name = read(nameLen).toString('utf8');
      const size = Number(read(8).readBigUInt64BE(0));
      if (!Number.isSafeInteger(size) || pos + size > total) throw new OfflineDataError('PACK_INVALID', `entry ${JSON.stringify(name)} exceeds the packed stream`);
      if (name !== 'manifest.json') {
        if (!name.startsWith('files/')) throw new OfflineDataError('PACK_INVALID', `unexpected packed entry ${JSON.stringify(name)}`);
        assertSafeRel(name.slice('files/'.length));
      }
      if (seen.has(name)) throw new OfflineDataError('PACK_INVALID', `duplicate packed entry ${name}`);
      seen.add(name);
      const dest = path.join(destDir, ...name.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      const out = fs.openSync(dest, 'wx', 0o600);
      try {
        let left = size;
        while (left > 0) {
          const n = fs.readSync(fd, buf, 0, Math.min(buf.length, left), pos);
          if (n === 0) throw new OfflineDataError('PACK_INVALID', 'packed backup is truncated');
          fs.writeSync(out, buf, 0, n);
          pos += n;
          left -= n;
        }
      } finally {
        fs.closeSync(out);
      }
      bytes += size;
    }
    if (pos !== total) throw new OfflineDataError('PACK_INVALID', 'unexpected data after the packed backup');
    if (!seen.has('manifest.json')) throw new OfflineDataError('PACK_INVALID', 'packed backup has no manifest');
    return { entries: seen.size, bytes };
  } finally {
    fs.closeSync(fd);
  }
}
