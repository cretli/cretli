/**
 * Encrypted per-workspace Browser `storageState` (P2a).
 *
 * The built-in Browser can persist cookies and localStorage between sessions,
 * but only when the operator explicitly consents per workspace. This module is
 * the only place that reads or writes that state:
 *
 * - the payload is AES-256-GCM encrypted with a key derived from a server
 *   secret (`CRETLI_BROWSER_STORAGE_KEY` env var or a `browser-storage.key`
 *   file). Without a secret the functions return an explicit error status and
 *   never fall back to plaintext;
 * - the store is keyed by a stable `sha256` hash of the normalized workspace
 *   path, so the raw path is never persisted next to the cookies;
 * - consent defaults to off on every read and write;
 * - entries carry a TTL and are dropped on read/sweep once expired;
 * - `clear` wipes one workspace or the whole store.
 *
 * Security contract: raw cookies/tokens are never returned to the chat, an
 * agent, a log or an export. Only metadata/counters leave this module through
 * `publicStorageStateStatus()`. The decrypted payload is only ever handed to
 * `browser.newContext({ storageState })` inside the session manager.
 */

import fs from 'fs';
import path from 'path';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from 'crypto';
import { writeJsonAtomic } from '../persist/atomic-write.js';

/** Store file (encrypted payloads + consent flags + metadata) inside `dataDir`. */
export const STORAGE_STATE_FILE = 'browser-storage-state.json';
/** Secret file fallback; its content is never written to the store. */
export const STORAGE_STATE_KEY_FILE = 'browser-storage.key';
/** Domain separation for the HKDF derivation. */
const SECRET_CONTEXT = 'cretli-browser-storage-v1';
/** Default maximum age of a persisted entry (7 days). */
export const DEFAULT_STORAGE_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** AES-256-GCM parameters. */
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;

/**
 * Recoverable failures of the storage-state module. The message never contains
 * the secret, the workspace path or the decrypted payload.
 */
export class BrowserStorageError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} [status]
   */
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'BrowserStorageError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Normalizes a workspace key to an absolute path (same contract as the policy
 * store). An empty value stays empty so a caller can fail closed.
 * @param {unknown} workspaceKey
 * @returns {string}
 */
export function normalizeWorkspaceKey(workspaceKey) {
  const raw = String(workspaceKey ?? '').trim();
  if (!raw) return '';
  return path.resolve(raw);
}

/**
 * Stable, non-reversible profile id for a workspace. The store never persists
 * the raw path; only this hash is used as a key.
 * @param {unknown} workspaceKey
 * @returns {string} lowercase sha256 hex, or '' when no workspace is given
 */
export function workspaceProfile(workspaceKey) {
  const normalized = normalizeWorkspaceKey(workspaceKey);
  if (!normalized) return '';
  return createHash('sha256')
    .update(`${SECRET_CONTEXT}:profile\0${normalized}`)
    .digest('hex');
}

/**
 * @param {string} dataDir
 * @returns {string}
 */
export function storageStateFilePath(dataDir) {
  return path.join(String(dataDir || ''), STORAGE_STATE_FILE);
}

/**
 * @param {string} dataDir
 * @returns {string}
 */
export function storageKeyFilePath(dataDir) {
  return path.join(String(dataDir || ''), STORAGE_STATE_KEY_FILE);
}

/**
 * Resolves the server secret used to derive the encryption key. Order:
 * an explicit `secret`, then `CRETLI_BROWSER_STORAGE_KEY`, then the key file.
 * Never auto-creates the file: a missing secret must be an explicit error.
 * @param {{ dataDir?: string, secret?: unknown, env?: Record<string, string|undefined> }} [options]
 * @returns {{ ok: true, secret: string, source: 'explicit'|'env'|'file' } | { ok: false, source: 'none', code: string }}
 */
export function resolveStorageSecret(options = {}) {
  const explicit = String(options.secret ?? '').trim();
  if (explicit) return { ok: true, secret: explicit, source: 'explicit' };

  const env = options.env || process.env || {};
  const fromEnv = String(env.CRETLI_BROWSER_STORAGE_KEY ?? '').trim();
  if (fromEnv) return { ok: true, secret: fromEnv, source: 'env' };

  const dataDir = String(options.dataDir || '');
  if (dataDir) {
    try {
      const file = storageKeyFilePath(dataDir);
      if (fs.existsSync(file)) {
        const fromFile = fs.readFileSync(file, 'utf8').trim();
        if (fromFile) return { ok: true, secret: fromFile, source: 'file' };
      }
    } catch {
      // An unreadable key file is treated as a missing secret (fail closed).
    }
  }
  return { ok: false, source: 'none', code: 'storage-key-missing' };
}

/**
 * Derives the 32-byte AES key from the resolved secret via HKDF. Deterministic
 * for a given secret so entries survive a restart.
 * @param {string} secret
 * @returns {Buffer}
 */
export function deriveStorageKey(secret) {
  const raw = Buffer.from(String(secret ?? ''), 'utf8');
  if (raw.length === 0) throw new BrowserStorageError('storage-key-missing', 'Browser storage secret is missing');
  return Buffer.from(hkdfSync('sha256', raw, SECRET_CONTEXT, 'aes-256-gcm', KEY_BYTES));
}

/**
 * @param {unknown} dataDir
 * @returns {{ v: number, workspaces: Record<string, any> }}
 */
function loadStore(dataDir) {
  const dir = String(dataDir || '');
  if (!dir) return { v: 1, workspaces: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(storageStateFilePath(dir), 'utf8'));
    const workspaces = raw && typeof raw.workspaces === 'object' && raw.workspaces ? raw.workspaces : {};
    return { v: 1, workspaces };
  } catch {
    return { v: 1, workspaces: {} };
  }
}

/**
 * @param {unknown} dataDir
 * @param {{ v: number, workspaces: Record<string, any> }} store
 */
function saveStore(dataDir, store) {
  const dir = String(dataDir || '');
  if (!dir) throw new BrowserStorageError('no-data-dir', 'No data directory for Browser storage state');
  writeJsonAtomic(storageStateFilePath(dir), { v: 1, workspaces: store.workspaces }, 'utf8');
}

/**
 * Reads a workspace entry (never the decrypted payload) or null.
 * @param {string} dataDir
 * @param {string} profile
 * @returns {any|null}
 */
function readEntry(dataDir, profile) {
  if (!profile) return null;
  const store = loadStore(dataDir);
  const entry = store.workspaces[profile];
  return entry && typeof entry === 'object' ? entry : null;
}

/**
 * @param {string} dataDir
 * @param {string} profile
 * @param {(entry: any) => any} mutate Returns the replacement entry or null to delete.
 * @returns {any|null} the stored entry after the mutation
 */
function updateEntry(dataDir, profile, mutate) {
  const store = loadStore(dataDir);
  const current = store.workspaces[profile] && typeof store.workspaces[profile] === 'object'
    ? store.workspaces[profile]
    : {};
  const next = mutate(current);
  if (next === null || next === undefined) delete store.workspaces[profile];
  else store.workspaces[profile] = next;
  saveStore(dataDir, store);
  return next === undefined ? null : next;
}

/**
 * @param {unknown} storageState
 * @returns {{ cookies: number, origins: number }|null}
 */
function stateShape(storageState) {
  if (!storageState || typeof storageState !== 'object') return null;
  const cookies = Array.isArray(storageState.cookies) ? storageState.cookies : null;
  const origins = Array.isArray(storageState.origins) ? storageState.origins : null;
  if (!cookies && !origins) return null;
  return { cookies: cookies ? cookies.length : 0, origins: origins ? origins.length : 0 };
}

/**
 * Encrypts a storage state with AES-256-GCM.
 * @param {Buffer} key
 * @param {unknown} storageState
 * @returns {{ iv: string, tag: string, data: string, byteLength: number }}
 */
function encryptState(key, storageState) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(storageState), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: ciphertext.toString('base64'),
    byteLength: ciphertext.length,
  };
}

/**
 * @param {Buffer} key
 * @param {{ iv: string, tag: string, data: string }} payload
 * @returns {{ ok: true, state: unknown } | { ok: false, reason: string }}
 */
function decryptState(key, payload) {
  try {
    const iv = Buffer.from(String(payload?.iv || ''), 'base64');
    const tag = Buffer.from(String(payload?.tag || ''), 'base64');
    const data = Buffer.from(String(payload?.data || ''), 'base64');
    if (iv.length !== IV_BYTES || tag.length !== 16 || data.length === 0) {
      return { ok: false, reason: 'decrypt-failed' };
    }
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    return { ok: true, state: JSON.parse(plaintext) };
  } catch {
    // Wrong key, tampered ciphertext or malformed JSON: never surface details.
    return { ok: false, reason: 'decrypt-failed' };
  }
}

/**
 * Effective TTL in milliseconds.
 * @param {unknown} ttlMs
 * @returns {number}
 */
function normalizeTtl(ttlMs) {
  const value = Number(ttlMs);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_STORAGE_STATE_TTL_MS;
  return Math.floor(value);
}

/**
 * Whether the user consented to persistent storage for this workspace.
 * Consent is off by default and off for an empty workspace.
 * @param {string} dataDir
 * @param {unknown} workspaceKey
 * @returns {boolean}
 */
export function getConsent(dataDir, workspaceKey) {
  const profile = workspaceProfile(workspaceKey);
  if (!profile) return false;
  const entry = readEntry(dataDir, profile);
  return entry?.consent === true;
}

/**
 * Grants or revokes consent for one workspace. Revoking drops the stored
 * (encrypted) state immediately; granting keeps an existing entry.
 * @param {string} dataDir
 * @param {unknown} workspaceKey
 * @param {boolean} enabled
 * @param {{ now?: number }} [options]
 * @returns {{ workspace: string, consent: boolean }}
 */
export function setConsent(dataDir, workspaceKey, enabled, options = {}) {
  const profile = workspaceProfile(workspaceKey);
  if (!profile) throw new BrowserStorageError('workspace-required', 'A workspace is required for Browser storage consent');
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const consent = enabled === true;
  updateEntry(dataDir, profile, (current) => {
    if (!consent) return null;
    return { ...current, consent: true, consentUpdatedAt: now };
  });
  return { workspace: profile, consent };
}

/**
 * Encrypts and persists a Playwright `storageState` for one workspace.
 *
 * Returns an explicit status instead of writing anything when there is no
 * consent (`consent-required`), no secret (`storage-key-missing`) or no state
 * (`empty-state`). Never writes plaintext.
 *
 * @param {string} dataDir
 * @param {unknown} workspaceKey
 * @param {unknown} storageState
 * @param {{ secret?: unknown, env?: Record<string, string|undefined>, ttlMs?: number, now?: number }} [options]
 * @returns {{
 *   saved: boolean,
 *   reason?: string,
 *   workspace?: string,
 *   savedAt?: number,
 *   expiresAt?: number,
 *   cookieCount?: number,
 *   originCount?: number,
 *   byteLength?: number,
 * }}
 */
export function saveStorageState(dataDir, workspaceKey, storageState, options = {}) {
  const profile = workspaceProfile(workspaceKey);
  if (!profile) throw new BrowserStorageError('workspace-required', 'A workspace is required for Browser storage state');
  if (!String(dataDir || '')) return { saved: false, reason: 'no-data-dir' };

  const shape = stateShape(storageState);
  if (!shape || (shape.cookies === 0 && shape.origins === 0)) return { saved: false, reason: 'empty-state' };

  const entry = readEntry(dataDir, profile);
  if (entry?.consent !== true) return { saved: false, reason: 'consent-required' };

  const resolved = resolveStorageSecret({ dataDir, secret: options.secret, env: options.env });
  if (!resolved.ok) return { saved: false, reason: resolved.code };

  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const ttlMs = normalizeTtl(options.ttlMs);
  const encrypted = encryptState(deriveStorageKey(resolved.secret), storageState);
  const savedAt = now;
  const expiresAt = now + ttlMs;

  updateEntry(dataDir, profile, (current) => ({
    ...current,
    consent: current.consent === true,
    state: {
      v: 1,
      alg: ALGORITHM,
      savedAt,
      expiresAt,
      iv: encrypted.iv,
      tag: encrypted.tag,
      data: encrypted.data,
      byteLength: encrypted.byteLength,
      cookieCount: shape.cookies,
      originCount: shape.origins,
    },
  }));

  return {
    saved: true,
    workspace: profile,
    savedAt,
    expiresAt,
    cookieCount: shape.cookies,
    originCount: shape.origins,
    byteLength: encrypted.byteLength,
  };
}

/**
 * Reads and decrypts the persisted state for one workspace.
 *
 * Returns `{ ok: false, reason }` when consent is missing, the secret is
 * missing, nothing is stored or the entry expired. An expired entry is removed
 * here (retention). A payload that fails authentication is never returned and
 * is reported as `decrypt-failed`.
 *
 * @param {string} dataDir
 * @param {unknown} workspaceKey
 * @param {{ secret?: unknown, env?: Record<string, string|undefined>, now?: number }} [options]
 * @returns {{
 *   ok: boolean,
 *   reason?: string,
 *   state?: unknown,
 *   savedAt?: number,
 *   expiresAt?: number,
 *   cookieCount?: number,
 *   originCount?: number,
 *   byteLength?: number,
 *   workspace?: string,
 * }}
 */
export function readStorageState(dataDir, workspaceKey, options = {}) {
  const profile = workspaceProfile(workspaceKey);
  if (!profile) return { ok: false, reason: 'workspace-required' };
  if (!String(dataDir || '')) return { ok: false, reason: 'no-data-dir' };

  const entry = readEntry(dataDir, profile);
  // Consent is the primary gate: without it the workspace has no readable
  // state, whether or not an entry was ever stored.
  if (!entry || entry.consent !== true) return { ok: false, reason: 'consent-required' };

  // Resolve the secret before reporting a missing entry so a misconfigured
  // server surfaces `storage-key-missing` explicitly.
  const resolved = resolveStorageSecret({ dataDir, secret: options.secret, env: options.env });
  if (!resolved.ok) return { ok: false, reason: resolved.code };

  const stored = entry.state;
  if (!stored || typeof stored !== 'object') return { ok: false, reason: 'not-found' };

  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const expiresAt = Number(stored.expiresAt);
  if (Number.isFinite(expiresAt) && now >= expiresAt) {
    // Retention: an expired entry is dropped on read, not returned.
    updateEntry(dataDir, profile, (current) => ({ ...current, state: null }));
    return { ok: false, reason: 'expired' };
  }

  const decrypted = decryptState(deriveStorageKey(resolved.secret), stored);
  if (!decrypted.ok) return { ok: false, reason: decrypted.reason };

  return {
    ok: true,
    state: decrypted.state,
    savedAt: Number(stored.savedAt) || 0,
    expiresAt: Number(stored.expiresAt) || 0,
    cookieCount: Number(stored.cookieCount) || 0,
    originCount: Number(stored.originCount) || 0,
    byteLength: Number(stored.byteLength) || 0,
    workspace: profile,
  };
}

/**
 * Removes every expired payload. Consent flags stay (they are not payloads).
 * @param {string} dataDir
 * @param {{ now?: number }} [options]
 * @returns {{ removed: number, profiles: string[] }}
 */
export function sweepExpiredStorageState(dataDir, options = {}) {
  const dir = String(dataDir || '');
  if (!dir) return { removed: 0, profiles: [] };
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const store = loadStore(dir);
  const profiles = [];
  for (const [profile, entry] of Object.entries(store.workspaces)) {
    const expiresAt = Number(entry?.state?.expiresAt);
    if (!Number.isFinite(expiresAt) || now < expiresAt) continue;
    store.workspaces[profile] = { ...entry, state: null };
    profiles.push(profile);
  }
  if (profiles.length > 0) saveStore(dir, store);
  return { removed: profiles.length, profiles };
}

/**
 * Clears the persisted state of one workspace. By default this also revokes
 * consent (a full wipe); pass `{ keepConsent: true }` to keep the flag and only
 * drop the encrypted payload.
 * @param {string} dataDir
 * @param {unknown} workspaceKey
 * @param {{ keepConsent?: boolean }} [options]
 * @returns {{ cleared: boolean, workspace: string, consent: boolean }}
 */
export function clearWorkspaceStorageState(dataDir, workspaceKey, options = {}) {
  const profile = workspaceProfile(workspaceKey);
  if (!profile) throw new BrowserStorageError('workspace-required', 'A workspace is required for Browser storage state');
  const keepConsent = options.keepConsent === true;
  let consent = false;
  if (String(dataDir || '')) {
    updateEntry(dataDir, profile, (current) => {
      consent = keepConsent && current.consent === true;
      if (!consent) return null;
      const next = { ...current };
      delete next.state;
      return next;
    });
  }
  return { cleared: true, workspace: profile, consent };
}

/**
 * Wipes the whole store (every workspace, payload and consent flag).
 * @param {string} dataDir
 * @returns {{ cleared: number }}
 */
export function clearAllStorageState(dataDir) {
  const dir = String(dataDir || '');
  if (!dir) return { cleared: 0 };
  const store = loadStore(dir);
  const cleared = Object.keys(store.workspaces).length;
  saveStore(dir, { v: 1, workspaces: {} });
  return { cleared };
}

/**
 * Metadata-only view for the status API/agent surface. Never contains cookies,
 * tokens or the raw workspace path — only the profile hash and counters.
 * @param {string} dataDir
 * @param {unknown} workspaceKey
 * @param {{ now?: number, secret?: unknown, env?: Record<string, string|undefined> }} [options]
 * @returns {{
 *   workspace: string,
 *   consent: boolean,
 *   keyAvailable: boolean,
 *   hasState: boolean,
 *   expired: boolean,
 *   savedAt: number|null,
 *   expiresAt: number|null,
 *   cookieCount: number,
 *   originCount: number,
 *   byteLength: number,
 * }}
 */
export function publicStorageStateStatus(dataDir, workspaceKey, options = {}) {
  const profile = workspaceProfile(workspaceKey);
  const keyAvailable = resolveStorageSecret({
    dataDir,
    secret: options.secret,
    env: options.env,
  }).ok;
  const empty = {
    workspace: profile,
    consent: false,
    keyAvailable,
    hasState: false,
    expired: false,
    savedAt: null,
    expiresAt: null,
    cookieCount: 0,
    originCount: 0,
    byteLength: 0,
  };
  if (!profile) return empty;
  const entry = readEntry(dataDir, profile);
  if (!entry) return empty;
  const stored = entry.state;
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const expiresAt = Number(stored?.expiresAt);
  const expired = Boolean(stored) && Number.isFinite(expiresAt) && now >= expiresAt;
  return {
    workspace: profile,
    consent: entry.consent === true,
    keyAvailable,
    hasState: Boolean(stored) && !expired,
    expired,
    savedAt: stored ? (Number(stored.savedAt) || 0) : null,
    expiresAt: stored ? (Number(stored.expiresAt) || 0) : null,
    cookieCount: stored ? (Number(stored.cookieCount) || 0) : 0,
    originCount: stored ? (Number(stored.originCount) || 0) : 0,
    byteLength: stored ? (Number(stored.byteLength) || 0) : 0,
  };
}
