/**
 * Persistent state of Cretli's own Chrome extension bridge: pairing codes,
 * installs (token stored only as a sha256 hash), the per-owner domain opt-in
 * list with pending approvals, the kill switch and the download audit log.
 *
 * Files live in `<dir>` (default `data/chrome-ext/`); tests inject a temp dir.
 * Pairing codes are memory-only on purpose: they die with the process.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveDataPath } from '../runtime-paths.js';

export const PAIRING_CODE_TTL_MS = 120_000;
export const PAIRING_MAX_ATTEMPTS = 5;
export const AUDIT_ROTATE_BYTES = 5 * 1024 * 1024;
const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_PENDING_DOMAINS = 50;

/** @param {string} value */
export function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** Constant-time compare of two hex digests. */
function safeEqualHex(a, b) {
  const left = Buffer.from(String(a), 'hex');
  const right = Buffer.from(String(b), 'hex');
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

/**
 * Cretli has a single credential (one password) and its login sessions carry no
 * user identity, so the stable owner of an install and of its domain consents is
 * the instance owner. Every active interactive session maps to it; the session
 * cookie itself is only checked for being a live human session (never stored).
 */
export const INSTANCE_OWNER_ID = 'instance-owner';

/** @param {unknown} sessionId @param {(id: string) => boolean} isActive */
export function stableOwnerId(sessionId, isActive) {
  const id = String(sessionId || '');
  return id && isActive(id) ? INSTANCE_OWNER_ID : '';
}

/**
 * Consent is scoped to the exact host. A registrable-domain heuristic without
 * the public suffix list would let `alice.github.io` approve `bob.github.io`,
 * so each host is approved on its own (and Chrome is asked for that host only).
 * IP literals and single labels are rejected.
 * @param {unknown} hostname
 * @returns {string} lower-case host, or '' when it cannot be opted in
 */
export function consentHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
  if (!host || host.length > 253 || !/^[a-z0-9.-]+$/.test(host)) return '';
  const labels = host.split('.');
  if (labels.length < 2 || labels.some((label) => !label || label.length > 63)) return '';
  if (labels.every((label) => /^\d+$/.test(label))) return '';
  return host;
}

/** Consent host of an https URL on the default port without userinfo, or ''. */
export function domainOfUrl(url) {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return '';
    return consentHost(parsed.hostname);
  } catch {
    return '';
  }
}

function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * @param {{ dir?: string, now?: () => number, random?: (n: number) => Buffer }} [options]
 */
export function createChromeExtStore(options = {}) {
  const dir = options.dir || resolveDataPath('chrome-ext');
  const now = options.now || Date.now;
  const random = options.random || crypto.randomBytes;
  const installsFile = path.join(dir, 'installs.json');
  const domainsFile = path.join(dir, 'domains.json');
  const stateFile = path.join(dir, 'state.json');
  const auditFile = path.join(dir, 'audit.jsonl');
  /** @type {Map<string, { owner: string, expiresAt: number, attempts: number }>} */
  const codes = new Map();

  const loadInstalls = () => readJson(installsFile, { installs: [] }).installs?.filter?.((row) => row && row.installId) || [];
  const saveInstalls = (installs) => writeJson(installsFile, { installs });
  const loadDomains = () => {
    const data = readJson(domainsFile, { owners: {} });
    return data.owners && typeof data.owners === 'object' ? data : { owners: {} };
  };
  const ownerDomains = (data, owner) => {
    if (!data.owners[owner]) data.owners[owner] = { allowed: [], pending: [] };
    const row = data.owners[owner];
    row.allowed = Array.isArray(row.allowed) ? row.allowed : [];
    row.pending = Array.isArray(row.pending) ? row.pending : [];
    return row;
  };

  const publicInstall = (row) => ({
    installId: row.installId,
    ownerId: row.ownerId,
    extensionId: row.extensionId,
    label: row.label,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    revokedAt: row.revokedAt || null,
  });

  return {
    dir,

    /** Issues a one-time pairing code bound to the signed-in owner. */
    createPairingCode(ownerId) {
      const owner = String(ownerId || '');
      if (!owner) throw new Error('owner required');
      for (const [code, row] of codes) {
        if (row.expiresAt <= now() || row.owner === owner) codes.delete(code);
      }
      const bytes = random(8);
      let code = '';
      for (let i = 0; i < 8; i += 1) code += PAIRING_ALPHABET[bytes[i] % PAIRING_ALPHABET.length];
      codes.set(code, { owner, expiresAt: now() + PAIRING_CODE_TTL_MS, attempts: 0 });
      return { code, expiresAt: new Date(now() + PAIRING_CODE_TTL_MS).toISOString(), ttlMs: PAIRING_CODE_TTL_MS };
    },

    /**
     * Exchanges a pairing code for an install and its one-time token. Every
     * failed attempt counts against the most recently issued live code so brute
     * force cannot rotate through guesses: after the cap all live codes die.
     * @param {unknown} code
     * @param {{ extensionId?: string, label?: string }} [claim]
     * @returns {any} `{ ok: true, install, token }` or `{ ok: false, reason }`
     */
    redeemPairingCode(code, { extensionId, label } = {}) {
      const key = String(code || '').trim().toUpperCase();
      const row = codes.get(key);
      if (!row || row.expiresAt <= now()) {
        codes.delete(key);
        // Count the miss against every live code: guessing is bounded globally.
        for (const [other, live] of codes) {
          live.attempts += 1;
          if (live.attempts >= PAIRING_MAX_ATTEMPTS || live.expiresAt <= now()) codes.delete(other);
        }
        return { ok: false, reason: 'invalid-code' };
      }
      // Single use: consumed before any other check.
      codes.delete(key);
      // Nothing may be paired while the kill switch is on.
      if (readJson(stateFile, {}).killed?.[row.owner] === true) return { ok: false, reason: 'killed' };
      if (!/^[a-p]{32}$/.test(String(extensionId || ''))) return { ok: false, reason: 'bad-extension-id' };
      const token = random(32).toString('base64url');
      const stamp = new Date(now()).toISOString();
      const install = {
        installId: crypto.randomUUID(),
        ownerId: row.owner,
        extensionId,
        label: String(label || 'Chrome').replace(/[^\w .-]/g, '').slice(0, 60) || 'Chrome',
        tokenHash: sha256Hex(token),
        createdAt: stamp,
        lastSeenAt: stamp,
        revokedAt: null,
      };
      // One install per owner: pairing again replaces the previous install.
      const installs = loadInstalls().filter((item) => item.ownerId !== row.owner);
      installs.push(install);
      saveInstalls(installs);
      return { ok: true, install: publicInstall(install), token };
    },

    /**
     * Verifies install id + token + origin extension id. Never reveals which one failed.
     * @returns {object | null} public install row
     */
    authenticate(installId, token, extensionId) {
      const installs = loadInstalls();
      const row = installs.find((item) => item.installId === String(installId || ''));
      if (!row || row.revokedAt || typeof token !== 'string' || !token) return null;
      const okToken = safeEqualHex(row.tokenHash, sha256Hex(token));
      if (!okToken || row.extensionId !== extensionId) return null;
      row.lastSeenAt = new Date(now()).toISOString();
      saveInstalls(installs);
      return publicInstall(row);
    },

    getInstallForOwner(ownerId) {
      const row = loadInstalls().find((item) => item.ownerId === String(ownerId || '') && !item.revokedAt);
      return row ? publicInstall(row) : null;
    },

    /** Removes the install (and with it the token hash). @returns {object | null} the removed install */
    revokeOwner(ownerId) {
      const installs = loadInstalls();
      const row = installs.find((item) => item.ownerId === String(ownerId || ''));
      if (!row) return null;
      saveInstalls(installs.filter((item) => item !== row));
      return publicInstall(row);
    },

    listDomains(ownerId) {
      const row = ownerDomains(loadDomains(), String(ownerId || ''));
      return { allowed: [...row.allowed], pending: row.pending.map((item) => ({ ...item })) };
    },

    isDomainAllowed(ownerId, domain) {
      return ownerDomains(loadDomains(), String(ownerId || '')).allowed.includes(String(domain || ''));
    },

    /** Records a pending approval request; the first domain of an owner always needs a human. */
    requestDomain(ownerId, domain, chatId = '') {
      const owner = String(ownerId || '');
      const normalized = consentHost(domain);
      if (!owner || !normalized) return false;
      const data = loadDomains();
      const row = ownerDomains(data, owner);
      if (row.allowed.includes(normalized)) return false;
      if (!row.pending.some((item) => item.domain === normalized) && row.pending.length < MAX_PENDING_DOMAINS) {
        row.pending.push({ domain: normalized, chatId: String(chatId || ''), requestedAt: new Date(now()).toISOString() });
        writeJson(domainsFile, data);
      }
      return true;
    },

    /** Human approval (REST, session cookie). */
    approveDomain(ownerId, domain) {
      const owner = String(ownerId || '');
      const normalized = consentHost(domain);
      if (!owner || !normalized) return false;
      const data = loadDomains();
      const row = ownerDomains(data, owner);
      row.pending = row.pending.filter((item) => item.domain !== normalized);
      if (!row.allowed.includes(normalized)) row.allowed.push(normalized);
      writeJson(domainsFile, data);
      return true;
    },

    removeDomain(ownerId, domain) {
      const owner = String(ownerId || '');
      const normalized = consentHost(domain);
      const data = loadDomains();
      const row = ownerDomains(data, owner);
      const before = row.allowed.length + row.pending.length;
      row.allowed = row.allowed.filter((item) => item !== normalized);
      row.pending = row.pending.filter((item) => item.domain !== normalized);
      writeJson(domainsFile, data);
      return before !== row.allowed.length + row.pending.length;
    },

    isKilled(ownerId) {
      return readJson(stateFile, {}).killed?.[String(ownerId || '')] === true;
    },

    setKilled(ownerId, killed) {
      const state = readJson(stateFile, {});
      state.killed = state.killed && typeof state.killed === 'object' ? state.killed : {};
      if (killed) state.killed[String(ownerId)] = true;
      else delete state.killed[String(ownerId)];
      writeJson(stateFile, state);
    },

    /** Appends one audit line; rotates the file at 5 MB. */
    appendAudit(entry) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        if (fs.statSync(auditFile).size >= AUDIT_ROTATE_BYTES) fs.renameSync(auditFile, `${auditFile}.1`);
      } catch { /* no file yet */ }
      const row = {
        at: new Date(now()).toISOString(),
        owner: String(entry.owner || ''),
        chatId: String(entry.chatId || ''),
        domain: String(entry.domain || ''),
        file: String(entry.file || ''),
        size: Number(entry.size) || 0,
        sha256: String(entry.sha256 || ''),
        result: String(entry.result || ''),
      };
      fs.appendFileSync(auditFile, `${JSON.stringify(row)}\n`, { mode: 0o600 });
      return row;
    },

    /** Newest-first audit entries of one owner. */
    readAudit(ownerId, limit = 100) {
      let text = '';
      try { text = fs.readFileSync(auditFile, 'utf8'); } catch { return []; }
      const rows = [];
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          const row = JSON.parse(line);
          if (row.owner === String(ownerId || '')) rows.push(row);
        } catch { /* skip a torn line */ }
      }
      return rows.reverse().slice(0, Math.max(1, Math.min(500, Number(limit) || 100)));
    },
  };
}

let defaultStore = null;
/** Lazily created so importing the module never resolves the data dir. */
export function getChromeExtStore() {
  if (!defaultStore) defaultStore = createChromeExtStore();
  return defaultStore;
}
