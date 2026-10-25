/**
 * Encrypted backup envelope v1 (B5). Frozen format: docs/backup/encrypted-envelope.md.
 *
 * Layout (all integers big-endian):
 *
 *   header   magic "CRETLIBK"[8] | version u8 (=1) | kdf u8 (=1 scrypt) | cipher u8 (=1 AES-256-GCM)
 *            | 0 | log2N u8 | r u8 | p u8 | 0 | chunkSize u32 | salt[16] | noncePrefix[4]
 *            | descriptorLen u16 | descriptor (JSON, <= 512 bytes: createdAt + profile only)
 *   records  type u8 | ctLen u32 | ciphertext[ctLen] | tag[16]
 *            'H' header-auth record (empty plaintext, record index 0)
 *            'C' chunk records, indices 1..n (every chunk is full except the last, never empty)
 *            'F' final record, index n+1: chunkCount u64 | plainLength u64 | sha256(plaintext)[32]
 *
 * Every record is AES-256-GCM with nonce = noncePrefix || u64(index) and
 * AAD = header bytes || type || u64(index). The header is therefore authenticated by every record,
 * reordering / dropping / duplicating a record changes its index and fails authentication, the
 * final record authenticates count, length and digest of the whole stream, and anything after it is
 * rejected. The record layout is not parsed as ZIP/JSON/pack by this module: callers consume the
 * decrypted file only after `decryptToFile` returned successfully.
 *
 * The key is scrypt(NFKC(password), salt) -> HKDF-SHA256. Header-declared KDF cost and sizes are
 * range-checked BEFORE any key derivation or buffer allocation.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { OfflineDataError } from '../offline/offline-errors.js';

const scrypt = /** @type {(pw: Buffer, salt: Buffer, len: number, opts: object) => Promise<Buffer>} */ (promisify(crypto.scrypt));

export const ENVELOPE_MAGIC = Buffer.from('CRETLIBK', 'latin1');
export const ENVELOPE_VERSION = 1;
const KDF_SCRYPT = 1;
const CIPHER_AES_256_GCM = 1;
const FIXED_HEADER = 42;
const TAG_LEN = 16;
const REC_OVERHEAD = 1 + 4 + TAG_LEN;
const TYPE_HEADER = 0x48;
const TYPE_CHUNK = 0x43;
const TYPE_FINAL = 0x46;
const FINAL_PLAIN = 8 + 8 + 32;
const HKDF_INFO = 'cretli-backup-envelope-v1/aes-256-gcm';

/** Hard bounds enforced on every (untrusted) header before the KDF runs or memory is reserved. */
export const ENVELOPE_LIMITS = Object.freeze({
  minLog2N: 14,
  maxLog2N: 17,
  maxR: 8,
  maxP: 4,
  /** Upper bound of N * r * p (CPU cost); the default 2^15 * 8 * 1 = 2^18 sits well below it. */
  maxWork: 2 ** 21,
  minChunkSize: 64 * 1024,
  maxChunkSize: 4 * 1024 * 1024,
  maxDescriptorBytes: 512,
  /** Default cap of the plaintext stream (the packed backup). */
  defaultMaxPlainBytes: 8 * 1024 ** 3,
  minPasswordChars: 8,
  maxPasswordChars: 1024,
});

export const DEFAULT_KDF = Object.freeze({ log2N: 15, r: 8, p: 1 });
export const DEFAULT_CHUNK_SIZE = 1024 * 1024;

const DESCRIPTOR_KEYS = new Set(['createdAt', 'profile']);
const PROFILES = new Set(['data', 'data-credentials']);

/**
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 */
const fail = (code, message, details = {}) => new OfflineDataError(code, message, details);

/**
 * @param {unknown} password
 * @param {{ create?: boolean }} [opts]
 * @returns {Buffer}
 */
function passwordBytes(password, opts = {}) {
  if (typeof password !== 'string' || !password) throw fail('PASSWORD_REQUIRED', 'a non-empty password is required');
  const text = password.normalize('NFKC');
  if (text.length > ENVELOPE_LIMITS.maxPasswordChars) throw fail('PASSWORD_INVALID', 'password is too long');
  if (opts.create && text.length < ENVELOPE_LIMITS.minPasswordChars) {
    throw fail('PASSWORD_WEAK', `password must have at least ${ENVELOPE_LIMITS.minPasswordChars} characters`);
  }
  return Buffer.from(text, 'utf8');
}

/**
 * @param {{ log2N: number, r: number, p: number }} k
 * @returns {OfflineDataError | null}
 */
function kdfProblem(k) {
  const L = ENVELOPE_LIMITS;
  if (!Number.isInteger(k.log2N) || k.log2N < L.minLog2N || k.log2N > L.maxLog2N
    || !Number.isInteger(k.r) || k.r < 1 || k.r > L.maxR
    || !Number.isInteger(k.p) || k.p < 1 || k.p > L.maxP
    || (2 ** k.log2N) * k.r * k.p > L.maxWork) {
    return fail('ENVELOPE_KDF_LIMIT', `KDF parameters outside the accepted bounds (log2N=${k.log2N}, r=${k.r}, p=${k.p})`);
  }
  return null;
}

/**
 * @param {bigint | number} n
 * @returns {Buffer}
 */
function u64(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
}

/**
 * @param {Buffer} prefix
 * @param {number} index
 */
function nonceFor(prefix, index) {
  return Buffer.concat([prefix, u64(index)]);
}

/**
 * @param {Buffer} header
 * @param {number} type
 * @param {number} index
 */
function aadFor(header, type, index) {
  return Buffer.concat([header, Buffer.from([type]), u64(index)]);
}

/**
 * @param {Buffer} pw
 * @param {Buffer} salt
 * @param {{ log2N: number, r: number, p: number }} k
 * @param {{ onKdf?: (k: object) => void }} [hooks]
 * @returns {Promise<Buffer>} 32-byte AEAD key
 */
async function deriveKey(pw, salt, k, hooks) {
  const problem = kdfProblem(k);
  if (problem) throw problem;
  hooks?.onKdf?.({ ...k });
  const N = 2 ** k.log2N;
  const master = await scrypt(pw, salt, 32, { N, r: k.r, p: k.p, maxmem: 128 * N * k.r * 2 + (1 << 20) });
  try {
    return Buffer.from(crypto.hkdfSync('sha256', master, salt, HKDF_INFO, 32));
  } finally {
    master.fill(0);
  }
}

/**
 * @param {{ createdAt: string, profile: string }} d
 * @returns {Buffer}
 */
function encodeDescriptor(d) {
  if (!PROFILES.has(d.profile)) throw fail('ENVELOPE_FORMAT', `unknown profile ${JSON.stringify(d.profile)}`);
  const bytes = Buffer.from(JSON.stringify({ createdAt: String(d.createdAt), profile: d.profile }), 'utf8');
  if (bytes.length > ENVELOPE_LIMITS.maxDescriptorBytes) throw fail('ENVELOPE_FORMAT', 'descriptor too large');
  return bytes;
}

/**
 * Strict descriptor parse: only the agreed non-sensitive keys, bounded, plain strings.
 *
 * @param {Buffer} bytes
 * @returns {{ createdAt: string, profile: string }}
 */
function decodeDescriptor(bytes) {
  let d;
  try { d = JSON.parse(bytes.toString('utf8')); } catch { throw fail('ENVELOPE_FORMAT', 'descriptor is not valid JSON'); }
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw fail('ENVELOPE_FORMAT', 'descriptor is not an object');
  const keys = Object.keys(d);
  if (keys.length !== DESCRIPTOR_KEYS.size || keys.some((k) => !DESCRIPTOR_KEYS.has(k))) throw fail('ENVELOPE_FORMAT', 'descriptor has unexpected fields');
  if (typeof d.createdAt !== 'string' || d.createdAt.length > 40 || !PROFILES.has(d.profile)) throw fail('ENVELOPE_FORMAT', 'descriptor values are invalid');
  return { createdAt: d.createdAt, profile: d.profile };
}

/**
 * @param {number} fd
 * @param {number} length
 * @param {number} position
 * @returns {Buffer}
 */
function readExact(fd, length, position) {
  const buf = Buffer.allocUnsafe(length);
  let got = 0;
  while (got < length) {
    const n = fs.readSync(fd, buf, got, length - got, position + got);
    if (n === 0) throw fail('ENVELOPE_TRUNCATED', 'envelope ends before the final authentication record');
    got += n;
  }
  return buf;
}

/**
 * Parse and range-check the header of an open file. Reserves nothing large and runs no KDF.
 *
 * @param {number} fd
 * @param {number} fileSize
 */
function parseHeader(fd, fileSize) {
  if (fileSize < FIXED_HEADER + REC_OVERHEAD * 2) throw fail('ENVELOPE_TRUNCATED', 'file is too small to be an encrypted backup');
  const fixed = readExact(fd, FIXED_HEADER, 0);
  if (!fixed.subarray(0, 8).equals(ENVELOPE_MAGIC)) throw fail('ENVELOPE_FORMAT', 'not an encrypted Cretli backup (bad magic)');
  if (fixed[8] !== ENVELOPE_VERSION || fixed[9] !== KDF_SCRYPT || fixed[10] !== CIPHER_AES_256_GCM) {
    throw fail('ENVELOPE_UNSUPPORTED', `unsupported envelope version/kdf/cipher (${fixed[8]}/${fixed[9]}/${fixed[10]})`);
  }
  if (fixed[11] !== 0 || fixed[15] !== 0) throw fail('ENVELOPE_FORMAT', 'reserved header bytes are not zero');
  const kdf = { log2N: fixed[12], r: fixed[13], p: fixed[14] };
  const problem = kdfProblem(kdf);
  if (problem) throw problem;
  const chunkSize = fixed.readUInt32BE(16);
  if (chunkSize < ENVELOPE_LIMITS.minChunkSize || chunkSize > ENVELOPE_LIMITS.maxChunkSize || (chunkSize & (chunkSize - 1)) !== 0) {
    throw fail('ENVELOPE_FORMAT', `chunk size ${chunkSize} outside the accepted bounds`);
  }
  const descLen = fixed.readUInt16BE(40);
  if (descLen === 0 || descLen > ENVELOPE_LIMITS.maxDescriptorBytes || FIXED_HEADER + descLen > fileSize) {
    throw fail('ENVELOPE_FORMAT', 'descriptor length is out of bounds');
  }
  const descriptorBytes = readExact(fd, descLen, FIXED_HEADER);
  return {
    header: Buffer.concat([fixed, descriptorBytes]),
    kdf,
    chunkSize,
    salt: Buffer.from(fixed.subarray(20, 36)),
    noncePrefix: Buffer.from(fixed.subarray(36, 40)),
    descriptor: decodeDescriptor(descriptorBytes),
  };
}

/**
 * Non-sensitive, UNAUTHENTICATED listing fields of an envelope file (no password needed). The
 * descriptor is authenticated later, when the backup is opened with the password.
 *
 * @param {string} file
 * @returns {{ createdAt: string, profile: string, bytes: number, version: number }}
 */
export function readEnvelopeListing(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw fail('ENVELOPE_FORMAT', 'not a regular file');
    const h = parseHeader(fd, st.size);
    return { createdAt: h.descriptor.createdAt, profile: h.descriptor.profile, bytes: st.size, version: ENVELOPE_VERSION };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Encrypt a stream of plaintext buffers into an envelope file (created exclusively, mode 0600,
 * fsynced). The caller publishes it atomically (rename from a `.partial` name).
 *
 * @param {string} outFile
 * @param {string} password
 * @param {(write: (buf: Buffer) => void) => void | Promise<void>} source
 * @param {{
 *   descriptor: { createdAt: string, profile: string },
 *   kdf?: { log2N: number, r: number, p: number },
 *   chunkSize?: number,
 *   maxPlainBytes?: number,
 *   entropy?: { salt: Buffer, noncePrefix: Buffer },
 *   hooks?: { onKdf?: (k: object) => void },
 * }} options `entropy` is for the compatibility fixture only; production always uses fresh random bytes.
 * @returns {Promise<{ chunks: number, plainBytes: number, sha256: string }>}
 */
export async function encryptToFile(outFile, password, source, options) {
  const pw = passwordBytes(password, { create: true });
  const kdf = options.kdf || DEFAULT_KDF;
  const chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE;
  const maxPlain = options.maxPlainBytes || ENVELOPE_LIMITS.defaultMaxPlainBytes;
  const problem = kdfProblem(kdf);
  if (problem) throw problem;
  if (chunkSize < ENVELOPE_LIMITS.minChunkSize || chunkSize > ENVELOPE_LIMITS.maxChunkSize || (chunkSize & (chunkSize - 1)) !== 0) {
    throw fail('ENVELOPE_FORMAT', 'invalid chunk size');
  }
  const salt = options.entropy?.salt || crypto.randomBytes(16);
  const noncePrefix = options.entropy?.noncePrefix || crypto.randomBytes(4);
  const descriptor = encodeDescriptor(options.descriptor);
  const fixed = Buffer.alloc(FIXED_HEADER);
  ENVELOPE_MAGIC.copy(fixed, 0);
  fixed[8] = ENVELOPE_VERSION; fixed[9] = KDF_SCRYPT; fixed[10] = CIPHER_AES_256_GCM;
  fixed[12] = kdf.log2N; fixed[13] = kdf.r; fixed[14] = kdf.p;
  fixed.writeUInt32BE(chunkSize, 16);
  salt.copy(fixed, 20);
  noncePrefix.copy(fixed, 36);
  fixed.writeUInt16BE(descriptor.length, 40);
  const header = Buffer.concat([fixed, descriptor]);
  const key = await deriveKey(pw, salt, kdf, options.hooks);
  pw.fill(0);

  const fd = fs.openSync(outFile, 'wx', 0o600);
  let ok = false;
  try {
    let index = 0;
    const hash = crypto.createHash('sha256');
    let chunks = 0;
    let plainBytes = 0;
    /** @param {number} type @param {Buffer} plain */
    const writeRecord = (type, plain) => {
      const cipher = crypto.createCipheriv('aes-256-gcm', key, nonceFor(noncePrefix, index), { authTagLength: TAG_LEN });
      cipher.setAAD(aadFor(header, type, index));
      const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
      const head = Buffer.alloc(5);
      head[0] = type;
      head.writeUInt32BE(ct.length, 1);
      fs.writeSync(fd, Buffer.concat([head, ct, cipher.getAuthTag()]));
      index += 1;
    };
    fs.writeSync(fd, header);
    writeRecord(TYPE_HEADER, Buffer.alloc(0));
    /** @type {Buffer} */
    let pending = Buffer.alloc(0);
    /** @param {Buffer} buf */
    const write = (buf) => {
      plainBytes += buf.length;
      if (plainBytes > maxPlain) throw fail('ENVELOPE_TOO_LARGE', `plaintext exceeds the ${maxPlain}-byte limit`);
      hash.update(buf);
      pending = pending.length ? Buffer.concat([pending, buf]) : buf;
      while (pending.length >= chunkSize) {
        writeRecord(TYPE_CHUNK, pending.subarray(0, chunkSize));
        chunks += 1;
        pending = pending.subarray(chunkSize);
      }
    };
    await source(write);
    if (pending.length) { writeRecord(TYPE_CHUNK, pending); chunks += 1; }
    const digest = hash.digest();
    writeRecord(TYPE_FINAL, Buffer.concat([u64(chunks), u64(plainBytes), digest]));
    fs.fsyncSync(fd);
    ok = true;
    return { chunks, plainBytes, sha256: digest.toString('hex') };
  } finally {
    key.fill(0);
    fs.closeSync(fd);
    if (!ok) fs.rmSync(outFile, { force: true });
  }
}

/**
 * Authenticate and decrypt an envelope into `outFile` (created exclusively, mode 0600). Returns only
 * after the final record (count, length, digest) verified and the end of the file was reached; any
 * failure deletes `outFile` and throws. Bad password and tampering are indistinguishable by design.
 *
 * @param {string} inFile
 * @param {string} outFile
 * @param {string} password
 * @param {{
 *   maxPlainBytes?: number,
 *   hooks?: { onKdf?: (k: object) => void },
 * }} [options]
 * @returns {Promise<{ descriptor: { createdAt: string, profile: string }, chunks: number, plainBytes: number, sha256: string }>}
 */
export async function decryptToFile(inFile, outFile, password, options = {}) {
  const maxPlain = options.maxPlainBytes || ENVELOPE_LIMITS.defaultMaxPlainBytes;
  const pw = passwordBytes(password);
  const inFd = fs.openSync(inFile, 'r');
  let outFd;
  let key = null;
  let ok = false;
  try {
    const st = fs.fstatSync(inFd);
    if (!st.isFile()) throw fail('ENVELOPE_FORMAT', 'not a regular file');
    const h = parseHeader(inFd, st.size);
    // Size limit BEFORE the KDF and before reading any record body.
    const maxEnvelope = FIXED_HEADER + ENVELOPE_LIMITS.maxDescriptorBytes + REC_OVERHEAD * 2 + FINAL_PLAIN
      + maxPlain + Math.ceil(maxPlain / h.chunkSize) * REC_OVERHEAD;
    if (st.size > maxEnvelope) throw fail('ENVELOPE_TOO_LARGE', `envelope exceeds the size limit for ${maxPlain} plaintext bytes`);
    key = await deriveKey(pw, h.salt, h.kdf, options.hooks);
    pw.fill(0);

    let pos = h.header.length;
    let index = 0;
    /**
     * @param {number} maxCt bound checked BEFORE the record body is read/allocated
     * @returns {{ type: number, ct: Buffer, tag: Buffer }}
     */
    const readRecord = (maxCt) => {
      const head = readExact(inFd, 5, pos);
      const type = head[0];
      const ctLen = head.readUInt32BE(1);
      if (ctLen > maxCt) throw fail('ENVELOPE_FORMAT', `record length ${ctLen} exceeds the bound for its position`);
      const body = readExact(inFd, ctLen + TAG_LEN, pos + 5);
      pos += 5 + ctLen + TAG_LEN;
      return { type, ct: body.subarray(0, ctLen), tag: body.subarray(ctLen) };
    };
    /** @param {{ type: number, ct: Buffer, tag: Buffer }} rec */
    const open = (rec) => {
      const d = crypto.createDecipheriv('aes-256-gcm', /** @type {Buffer} */ (key), nonceFor(h.noncePrefix, index), { authTagLength: TAG_LEN });
      d.setAAD(aadFor(h.header, rec.type, index));
      d.setAuthTag(rec.tag);
      try {
        return Buffer.concat([d.update(rec.ct), d.final()]);
      } catch {
        throw fail('ENVELOPE_AUTH_FAILED', 'authentication failed: wrong password or the backup was modified');
      }
    };

    const first = /** @type {any} */ (readRecord(0));
    if (first.type !== TYPE_HEADER) throw fail('ENVELOPE_AUTH_FAILED', 'authentication failed: wrong password or the backup was modified');
    open(first);
    index += 1;

    outFd = fs.openSync(outFile, 'wx', 0o600);
    const hash = crypto.createHash('sha256');
    let chunks = 0;
    let plainBytes = 0;
    let shortSeen = false;
    let final = null;
    while (!final) {
      const rec = /** @type {any} */ (readRecord(Math.max(h.chunkSize, FINAL_PLAIN)));
      const plain = open(rec);
      if (rec.type === TYPE_FINAL) {
        if (plain.length !== FINAL_PLAIN) throw fail('ENVELOPE_FORMAT', 'final record has an unexpected length');
        final = plain;
        break;
      }
      if (rec.type !== TYPE_CHUNK) throw fail('ENVELOPE_AUTH_FAILED', 'authentication failed: wrong password or the backup was modified');
      if (shortSeen || plain.length === 0 || plain.length > h.chunkSize) throw fail('ENVELOPE_FORMAT', 'non-canonical chunk sequence');
      if (plain.length < h.chunkSize) shortSeen = true;
      plainBytes += plain.length;
      if (plainBytes > maxPlain) throw fail('ENVELOPE_TOO_LARGE', `plaintext exceeds the ${maxPlain}-byte limit`);
      hash.update(plain);
      fs.writeSync(outFd, plain);
      chunks += 1;
      index += 1;
    }
    const digest = hash.digest();
    if (u64(chunks).compare(final, 0, 8) !== 0 || u64(plainBytes).compare(final, 8, 16) !== 0 || !digest.equals(final.subarray(16))) {
      throw fail('ENVELOPE_AUTH_FAILED', 'final authentication (count/length/digest) does not match the decrypted stream');
    }
    if (pos !== st.size) throw fail('ENVELOPE_TRAILING', `${st.size - pos} unexpected byte(s) after the final record`);
    fs.fsyncSync(outFd);
    ok = true;
    return { descriptor: h.descriptor, chunks, plainBytes, sha256: digest.toString('hex') };
  } finally {
    key?.fill(0);
    pw.fill(0);
    fs.closeSync(inFd);
    if (outFd !== undefined) fs.closeSync(outFd);
    if (!ok) fs.rmSync(outFile, { force: true });
  }
}
