/**
 * Minimal store-only ZIP writer and hardened reader for `conversations-v1`
 * archives (docs/backup/archive-profiles.md: "store (ZIP) only; no nested archives").
 *
 * The reader never inflates anything, so a decompression bomb is impossible by
 * construction: any entry with a compression method other than 0 is refused and
 * declared sizes must equal the bytes physically present. Entry names are
 * checked for traversal, absolute paths, drive letters, backslashes, NUL bytes,
 * duplicates and symlink attributes before any content is surfaced.
 */

import fs from 'node:fs';
import zlib from 'node:zlib';
import { ARCHIVE_LIMITS_V1 } from './archive-contract.js';

export class ZipArchiveError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'ZipArchiveError';
    this.code = code;
  }
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
/** Fixed DOS timestamp (1980-01-01): archives are reproducible and carry no wall clock. */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const MAX_ENTRIES = 20000;

/**
 * @param {Buffer} buf
 * @returns {number}
 */
function crc32(buf) {
  return zlib.crc32(buf) >>> 0;
}

/**
 * Validates one archive member name. Returns the canonical name or throws.
 *
 * @param {string} name
 * @returns {string}
 */
export function assertSafeEntryName(name) {
  if (typeof name !== 'string' || !name) throw new ZipArchiveError('path_invalid', 'Empty entry name');
  if (name.length > ARCHIVE_LIMITS_V1.maxRelativePathLength) throw new ZipArchiveError('path_invalid', 'Entry name is too long');
  if (name.includes('\0') || name.includes('\\')) throw new ZipArchiveError('path_invalid', `Illegal characters in entry name: ${JSON.stringify(name)}`);
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw new ZipArchiveError('path_invalid', `Absolute entry name: ${name}`);
  const parts = name.split('/');
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') throw new ZipArchiveError('path_invalid', `Unsafe entry name: ${name}`);
  }
  if (/\.(zip|jar|tar|gz|tgz|7z|rar)$/i.test(name)) throw new ZipArchiveError('nested_archive_forbidden', `Nested archive: ${name}`);
  return name;
}

/**
 * Serializes entries into a store-only ZIP.
 *
 * @param {Array<{ name: string, data: Buffer }>} entries
 * @returns {Buffer}
 */
export function buildStoreZip(entries) {
  /** @type {Buffer[]} */
  const chunks = [];
  /** @type {Buffer[]} */
  const central = [];
  let offset = 0;
  const seen = new Set();
  for (const entry of entries) {
    const name = assertSafeEntryName(entry.name);
    if (seen.has(name)) throw new ZipArchiveError('duplicate_entry', `Duplicate entry: ${name}`);
    seen.add(name);
    const nameBuf = Buffer.from(name, 'utf8');
    const data = entry.data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(SIG_CENTRAL, 0);
    cd.writeUInt16LE(0x031e, 4); // made by: unix, v3.0
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(((0o100644) << 16) >>> 0, 38); // regular file, 0644
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(seen.size, 8);
  eocd.writeUInt16LE(seen.size, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

/**
 * Reads and fully validates a store-only ZIP held in memory.
 *
 * @param {Buffer} buf
 * @param {{ maxMemberBytes?: number, maxTotalBytes?: number, maxEntries?: number }} [limits]
 * @returns {Map<string, Buffer>} entry name -> bytes (CRC verified)
 */
export function readStoreZip(buf, limits = {}) {
  const maxMember = limits.maxMemberBytes ?? ARCHIVE_LIMITS_V1.maxMemberBytes;
  const maxTotal = limits.maxTotalBytes ?? ARCHIVE_LIMITS_V1.maxArchiveBytes;
  const maxEntries = limits.maxEntries ?? MAX_ENTRIES;
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new ZipArchiveError('zip_invalid', 'Not a ZIP archive');
  // The end-of-central-directory record is at most 22 + 65535 bytes from the end.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipArchiveError('zip_invalid', 'End of central directory not found');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0) throw new ZipArchiveError('zip_invalid', 'Multi-disk archives are not supported');
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipArchiveError('zip_invalid', 'ZIP64 is not supported');
  if (count > maxEntries) throw new ZipArchiveError('entry_count_exceeded', `Too many entries (${count})`);
  if (cdOffset + cdSize > eocd) throw new ZipArchiveError('zip_invalid', 'Central directory out of range');
  /** @type {Map<string, Buffer>} */
  const out = new Map();
  /** @type {Array<{ start: number, end: number }>} */
  const spans = [];
  let pos = cdOffset;
  let total = 0;
  for (let n = 0; n < count; n += 1) {
    if (pos + 46 > eocd || buf.readUInt32LE(pos) !== SIG_CENTRAL) throw new ZipArchiveError('zip_invalid', 'Corrupt central directory');
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16);
    const csize = buf.readUInt32LE(pos + 20);
    const usize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const external = buf.readUInt32LE(pos + 38);
    const localOffset = buf.readUInt32LE(pos + 42);
    if (pos + 46 + nameLen + extraLen + commentLen > eocd) throw new ZipArchiveError('zip_invalid', 'Corrupt central directory entry');
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
    pos += 46 + nameLen + extraLen + commentLen;
    if (flags & 0x1) throw new ZipArchiveError('zip_invalid', `Encrypted entry: ${name}`);
    if (flags & 0x8) throw new ZipArchiveError('zip_invalid', `Data-descriptor entries are not supported: ${name}`);
    if (method !== 0) throw new ZipArchiveError('compression_forbidden', `Only stored entries are allowed (${name})`);
    const unixMode = external >>> 16;
    if ((unixMode & 0o170000) === 0o120000) throw new ZipArchiveError('symlink_forbidden', `Symlink entry: ${name}`);
    if (name.endsWith('/')) throw new ZipArchiveError('path_invalid', `Directory entries are not allowed: ${name}`);
    assertSafeEntryName(name);
    if (out.has(name)) throw new ZipArchiveError('duplicate_entry', `Duplicate entry: ${name}`);
    if (csize !== usize) throw new ZipArchiveError('zip_invalid', `Size mismatch for ${name}`);
    if (usize > maxMember) throw new ZipArchiveError('member_size_exceeded', `Member too large: ${name}`);
    total += usize;
    if (total > maxTotal) throw new ZipArchiveError('archive_size_exceeded', 'Archive too large');
    if (localOffset + 30 > cdOffset || buf.readUInt32LE(localOffset) !== SIG_LOCAL) throw new ZipArchiveError('zip_invalid', `Bad local header for ${name}`);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const dataEnd = dataStart + usize;
    if (dataEnd > cdOffset) throw new ZipArchiveError('zip_invalid', `Data out of range for ${name}`);
    if (buf.toString('utf8', localOffset + 30, localOffset + 30 + lNameLen) !== name) throw new ZipArchiveError('zip_invalid', `Local/central name mismatch for ${name}`);
    spans.push({ start: localOffset, end: dataEnd });
    const data = buf.subarray(dataStart, dataEnd);
    if (crc32(data) !== crc) throw new ZipArchiveError('crc_mismatch', `CRC mismatch for ${name}`);
    out.set(name, data);
  }
  // Overlapping entries are a classic zip-bomb construction.
  spans.sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i += 1) {
    if (spans[i].start < spans[i - 1].end) throw new ZipArchiveError('zip_invalid', 'Overlapping entries');
  }
  return out;
}

/**
 * Reads a ZIP file from disk after refusing files above the total limit.
 *
 * @param {string} filePath
 * @param {Parameters<typeof readStoreZip>[1]} [limits]
 * @returns {Map<string, Buffer>}
 */
export function readStoreZipFile(filePath, limits = {}) {
  const maxTotal = limits.maxTotalBytes ?? ARCHIVE_LIMITS_V1.maxArchiveBytes;
  const size = fs.statSync(filePath).size;
  if (size > maxTotal + 1024 * 1024) throw new ZipArchiveError('archive_size_exceeded', 'Archive too large');
  return readStoreZip(fs.readFileSync(filePath), limits);
}
