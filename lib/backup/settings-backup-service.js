/**
 * Settings versions and portable import/export (B2).
 *
 * - Named snapshots are `portable-settings-v1` documents wrapped in a small
 *   envelope (`name`, `kind`, `id`) and published with fsync + atomic rename.
 * - Import is preview -> section selection / workspace mapping -> CAS -> apply.
 *   The preview pins the raw-byte digest of `config.json` and the MCP revision;
 *   apply re-reads both under a lock and refuses on any change.
 * - Every imported executable or endpoint definition (MCP command/args/URL,
 *   binary paths, base URLs) is staged disabled and needs a separate activation.
 *   Nothing in this module spawns a process, opens a socket or sends a push.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { resolveDataPath } from '../runtime-paths.js';
import { ARCHIVE_CONTRACT_REVISION } from './archive-contract.js';
import { validateArchiveDocumentAuto } from './validate-archive-document.js';
import { writeFileDurable, verifyFileDigest, DurableWriteError } from './durable-write.js';
import {
  MACHINE_SECTION_IDS,
  SETTINGS_SECTION_IDS,
  looksLikeSecretValue,
  mergeKeepingSecrets,
  projectConfigToSections,
  redactArgs,
  redactUrl,
  sanitizeImportedSection,
  stripSecretsDeep,
} from './settings-classification.js';
import { loadMcpDocument, mutateMcpConfiguration } from '../persist/mcp-persist.js';
import { completeConfigWithWorkspaces, splitConfigWorkspaceSections } from '../persist/settings.js';
import { normalizeMcpServer } from '../mcp/mcp-config.js';

const require = createRequire(import.meta.url);
const CRETLI_VERSION = String(require('../../package.json').version || '0.0.0');

/** Browser keys that may travel in `devicePreferences` (current browser only). */
export const DEVICE_PREFERENCE_ALLOWLIST = Object.freeze(['cretli-theme', 'cretli-theme-dark', 'cretli-theme-light', 'cretli-lang']);

export const SNAPSHOT_NAME_MAX = 80;
export const SNAPSHOT_MAX_COUNT = 500;
export const PREVIEW_TTL_MS = 15 * 60 * 1000;
const PREVIEW_CAP = 20;
const SNAPSHOT_ID_PATTERN = /^s-[a-z0-9]+-[a-f0-9]{8}$/;
const MCP_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export class SettingsBackupError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} [status]
   * @param {Record<string, unknown>} [extra]
   */
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.name = 'SettingsBackupError';
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

/** @returns {string} */
const configPath = () => resolveDataPath('config.json');
/** @returns {string} */
const snapshotDir = () => resolveDataPath('settings-snapshots');
/** @returns {string} */
const recoveryDir = () => resolveDataPath('settings-recovery');
/** @returns {string} */
const pendingPath = () => resolveDataPath('settings-import-pending.json');
/** @returns {string} */
const lockPath = () => resolveDataPath('settings-import.lock');

/**
 * @param {Buffer | string} raw
 * @returns {string}
 */
function sha256(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Strict read of config.json: a corrupt file fails instead of looking empty.
 *
 * @returns {{ raw: Buffer | null, digest: string, stateDigest: string, parsed: Record<string, any> }}
 */
export function readConfigStrict() {
  const file = configPath();
  if (!fs.existsSync(file)) return { raw: null, digest: 'absent', stateDigest: 'absent', parsed: {} };
  const raw = fs.readFileSync(file);
  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    throw new SettingsBackupError('CONFIG_CORRUPT', `config.json is not valid JSON: ${/** @type {any} */ (err).message}`, 500);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SettingsBackupError('CONFIG_CORRUPT', 'config.json is not an object', 500);
  }
  // The workspace sections live in SQL (store.workspaces): complete the view and pin
  // them in the digest so a registry change after the preview is detected.
  const completed = completeConfigWithWorkspaces(parsed);
  const stateDigest = completed === parsed ? sha256(raw) : sha256(Buffer.concat([raw, Buffer.from(JSON.stringify(completed))]));
  return { raw, digest: sha256(raw), stateDigest, parsed: completed };
}

/**
 * Definitions without credentials: env/header values and credential-looking
 * arguments are never exported.
 *
 * @param {Record<string, any>[]} servers
 * @returns {{ servers: Record<string, any>[], omissions: Array<{ path: string, reason: string }> }}
 */
export function projectMcpServers(servers) {
  /** @type {Array<{ path: string, reason: string }>} */
  const omissions = [];
  const out = [];
  for (const raw of Array.isArray(servers) ? servers : []) {
    const server = /** @type {any} */ (raw);
    if (!server || server.kind === 'builtin-cretli' || !MCP_ID_PATTERN.test(String(server.id || ''))) continue;
    const base = `mcp.${server.id}`;
    const conn = server.connection || {};
    /** @type {Record<string, unknown>} */
    let connection;
    if (server.transport === 'http') {
      const headerKeys = Object.keys(conn.headers || {});
      for (const key of headerKeys) omissions.push({ path: `${base}.headers.${key}`, reason: 'secret' });
      connection = { url: redactUrl(String(conn.url || '')), headerKeys };
    } else {
      const envKeys = Object.keys(conn.env || {});
      for (const key of envKeys) omissions.push({ path: `${base}.env.${key}`, reason: 'secret' });
      connection = {
        command: String(conn.command || ''),
        args: redactArgs(Array.isArray(conn.args) ? conn.args.map(String) : [], `${base}.args`, omissions),
        cwd: String(conn.cwd || ''),
        envKeys,
      };
    }
    out.push({
      id: String(server.id),
      name: String(server.name || ''),
      transport: server.transport === 'http' ? 'http' : 'stdio',
      scope: server.scope === 'all' ? 'all' : (Array.isArray(server.scope) ? server.scope.map(String) : 'all'),
      harnesses: Array.isArray(server.harnesses) ? server.harnesses.map(String) : [],
      toolPolicy: server.toolPolicy && typeof server.toolPolicy === 'object' ? server.toolPolicy : { allowInPlan: [] },
      connection,
    });
  }
  return { servers: out, omissions };
}

/**
 * @param {unknown} prefs
 * @returns {Record<string, string> | null}
 */
function filterDevicePreferences(prefs) {
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) return null;
  /** @type {Record<string, string>} */
  const out = {};
  for (const key of DEVICE_PREFERENCE_ALLOWLIST) {
    const value = /** @type {any} */ (prefs)[key];
    if (typeof value === 'string' && value.length <= 64 && !looksLikeSecretValue(value)) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Build a `portable-settings-v1` document from the live state (read-only).
 *
 * @param {{ includeMachine?: boolean, devicePreferences?: unknown }} [options]
 * @returns {Record<string, unknown>}
 */
export function buildSettingsDocument(options = {}) {
  const { parsed } = readConfigStrict();
  const { sections, omissions } = projectConfigToSections(parsed, { includeMachine: options.includeMachine === true });
  const mcp = projectMcpServers(loadMcpDocument().servers);
  sections.mcp = { servers: mcp.servers };
  omissions.push(...mcp.omissions);
  if (options.includeMachine !== true) omissions.push({ path: 'workspaces', reason: 'operator_excluded' });
  const doc = {
    profile: 'portable-settings-v1',
    manifestFormatVersion: 1,
    archiveContractRevision: ARCHIVE_CONTRACT_REVISION,
    archiveId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    cretliVersion: CRETLI_VERSION,
    sections,
    omissions: omissions.slice(0, 4096),
  };
  const device = filterDevicePreferences(options.devicePreferences);
  if (device) doc.devicePreferences = device;
  const checked = validateArchiveDocumentAuto(doc);
  if (!checked.ok) {
    throw new SettingsBackupError('DOCUMENT_INVALID', `generated document failed validation: ${/** @type {any} */ (checked).errors.join('; ')}`, 500);
  }
  return doc;
}

/**
 * @param {string} name
 * @returns {string}
 */
function normalizeSnapshotName(name) {
  const trimmed = String(name ?? '').replace(/\s+/g, ' ').trim();
  // eslint-disable-next-line no-control-regex
  if (!trimmed || trimmed.length > SNAPSHOT_NAME_MAX || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new SettingsBackupError('VALIDATION', `Snapshot name must be 1-${SNAPSHOT_NAME_MAX} printable characters`);
  }
  return trimmed;
}

/**
 * Save a named settings version. Resolves only after the file is fsynced,
 * renamed, directory-synced (where supported) and read back with a matching
 * digest. Any failure throws; nothing reports `saved` otherwise.
 *
 * @param {{ name: string, kind?: 'manual' | 'pre-import', includeMachine?: boolean, devicePreferences?: unknown, fsImpl?: typeof fs }} input
 */
export function createSnapshot(input) {
  const name = normalizeSnapshotName(input.name);
  const dir = snapshotDir();
  if (fs.existsSync(dir) && fs.readdirSync(dir).length >= SNAPSHOT_MAX_COUNT) {
    throw new SettingsBackupError('LIMIT', `Snapshot limit of ${SNAPSHOT_MAX_COUNT} reached`, 409);
  }
  const document = buildSettingsDocument({
    includeMachine: input.includeMachine,
    devicePreferences: input.devicePreferences,
  });
  const id = `s-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  const envelope = {
    snapshotFormat: 1,
    id,
    name,
    kind: input.kind === 'pre-import' ? 'pre-import' : 'manual',
    createdAt: document.createdAt,
    document,
  };
  const target = path.join(dir, `${id}.json`);
  let written;
  try {
    written = writeFileDurable(target, JSON.stringify(envelope, null, 2), { fsImpl: input.fsImpl });
    if (!verifyFileDigest(target, written.sha256, input.fsImpl)) {
      throw new DurableWriteError('read-back digest mismatch', 'verify');
    }
  } catch (err) {
    try { (input.fsImpl || fs).unlinkSync(target); } catch { /* nothing published */ }
    if (err instanceof DurableWriteError) {
      throw new SettingsBackupError('SNAPSHOT_WRITE_FAILED', `Snapshot was not saved: ${err.message}`, 500, { stage: err.stage });
    }
    throw err;
  }
  return {
    status: 'saved',
    snapshot: snapshotMeta(envelope, written.bytes),
    sha256: written.sha256,
    durability: written.durability,
  };
}

/**
 * @param {any} envelope
 * @param {number} bytes
 */
function snapshotMeta(envelope, bytes) {
  const sections = envelope.document?.sections || {};
  return {
    id: envelope.id,
    name: envelope.name,
    kind: envelope.kind,
    createdAt: envelope.createdAt,
    bytes,
    sections: Object.fromEntries(Object.entries(sections).map(([key, value]) => [
      key,
      key === 'mcp' ? (/** @type {any} */ (value).servers || []).length : Object.keys(/** @type {object} */ (value)).length,
    ])),
    hasDevicePreferences: Boolean(envelope.document?.devicePreferences),
  };
}

/**
 * @param {unknown} envelope
 * @param {string} id
 * @returns {any}
 */
function validateEnvelope(envelope, id) {
  const env = /** @type {any} */ (envelope);
  if (!env || typeof env !== 'object' || env.snapshotFormat !== 1 || env.id !== id) {
    throw new SettingsBackupError('SNAPSHOT_CORRUPT', 'Snapshot envelope is invalid', 500);
  }
  const checked = validateArchiveDocumentAuto(env.document);
  if (!checked.ok) {
    throw new SettingsBackupError('SNAPSHOT_CORRUPT', `Snapshot document is invalid: ${/** @type {any} */ (checked).errors.join('; ')}`, 500);
  }
  return env;
}

/** @param {string} id */
function assertSnapshotId(id) {
  if (!SNAPSHOT_ID_PATTERN.test(String(id || ''))) throw new SettingsBackupError('VALIDATION', 'Invalid snapshot id');
}

/**
 * @returns {{ snapshots: Record<string, any>[], corrupt: Array<{ file: string, error: string }> }}
 */
export function listSnapshots() {
  const dir = snapshotDir();
  if (!fs.existsSync(dir)) return { snapshots: [], corrupt: [] };
  const snapshots = [];
  const corrupt = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const id = file.slice(0, -5);
    try {
      assertSnapshotId(id);
      const raw = fs.readFileSync(path.join(dir, file));
      snapshots.push(snapshotMeta(validateEnvelope(JSON.parse(raw.toString('utf8')), id), raw.length));
    } catch (err) {
      corrupt.push({ file, error: /** @type {any} */ (err).message });
    }
  }
  snapshots.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return { snapshots, corrupt };
}

/**
 * @param {string} id
 * @returns {any}
 */
export function readSnapshot(id) {
  assertSnapshotId(id);
  const file = path.join(snapshotDir(), `${id}.json`);
  if (!fs.existsSync(file)) throw new SettingsBackupError('NOT_FOUND', 'Snapshot not found', 404);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new SettingsBackupError('SNAPSHOT_CORRUPT', `Snapshot is not valid JSON: ${/** @type {any} */ (err).message}`, 500);
  }
  return validateEnvelope(parsed, id);
}

/** @param {string} id */
export function deleteSnapshot(id) {
  assertSnapshotId(id);
  const file = path.join(snapshotDir(), `${id}.json`);
  if (!fs.existsSync(file)) throw new SettingsBackupError('NOT_FOUND', 'Snapshot not found', 404);
  fs.unlinkSync(file);
  return { deleted: id };
}

/** @param {unknown} a @param {unknown} b */
function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Canonical comparable form of an MCP definition (secret-free fields only).
 *
 * @param {any} server
 */
function mcpDefinitionKey(server) {
  const conn = server.connection || {};
  return {
    name: server.name,
    transport: server.transport,
    scope: server.scope,
    harnesses: server.harnesses,
    toolPolicy: server.toolPolicy,
    connection: server.transport === 'http'
      ? { url: redactUrl(String(conn.url || '')) }
      : { command: conn.command || '', args: conn.args || [], cwd: conn.cwd || '' },
  };
}

/** @type {Map<string, any>} */
const previews = new Map();

/** Test hook: drop all pending previews. */
export function resetPreviewsForTests() {
  previews.clear();
}

/**
 * Validate an imported document and compute a per-section change preview.
 * Read-only: no writes, no processes, no network.
 *
 * @param {{ document: unknown, source?: string }} input
 */
export function previewImport(input) {
  const checked = validateArchiveDocumentAuto(input.document);
  if (!checked.ok) {
    throw new SettingsBackupError('INVALID_DOCUMENT', `Invalid settings document: ${/** @type {any} */ (checked).errors.slice(0, 5).join('; ')}`);
  }
  if (/** @type {any} */ (checked).profile !== 'portable-settings-v1') {
    throw new SettingsBackupError('UNSUPPORTED_PROFILE', 'Only portable settings documents can be imported here');
  }
  const doc = /** @type {any} */ (checked).value;
  const config = readConfigStrict();
  const mcpDoc = loadMcpDocument();
  const currentMcp = projectMcpServers(mcpDoc.servers).servers;
  const currentSafe = /** @type {Record<string, any>} */ (stripSecretsDeep(config.parsed, '', []));

  /** @type {Record<string, any>} */
  const sanitized = {};
  const sectionPreviews = [];
  const ignoredSections = [];
  for (const [sectionId, raw] of Object.entries(doc.sections)) {
    if (!SETTINGS_SECTION_IDS.includes(sectionId)) {
      ignoredSections.push(sectionId);
      continue;
    }
    if (sectionId === 'mcp') {
      const servers = [];
      const rejected = [];
      for (const row of Array.isArray(/** @type {any} */ (raw).servers) ? /** @type {any} */ (raw).servers : []) {
        const clean = sanitizeImportedMcpServer(row, rejected);
        if (clean) servers.push(clean);
      }
      sanitized.mcp = { servers };
      const entries = servers.map((server) => {
        const existing = currentMcp.find((row) => /** @type {any} */ (row).id === server.id);
        const status = !existing ? 'added' : sameJson(mcpDefinitionKey(existing), mcpDefinitionKey(server)) ? 'unchanged' : 'changed';
        return {
          key: server.id,
          status,
          after: server,
          before: existing || null,
          // A changed or new definition always lands disabled; unchanged ones are left alone.
          startsDisabled: status !== 'unchanged',
          requiresActivation: status !== 'unchanged',
        };
      });
      sectionPreviews.push(summarizeSection('mcp', entries, rejected, false));
      continue;
    }
    const { values, rejected } = sanitizeImportedSection(sectionId, raw);
    sanitized[sectionId] = values;
    const entries = Object.entries(values).map(([key, value]) => {
      if (sectionId === 'workspaces') {
        return { key, status: 'needs-mapping', after: value, before: null, needsMapping: true };
      }
      const before = key === 'approvalBroker.advisor.baseUrl'
        ? currentSafe.approvalBroker?.advisor?.baseUrl
        : currentSafe[key];
      const status = before === undefined ? 'added' : sameJson(before, value) ? 'unchanged' : 'changed';
      return {
        key,
        status,
        after: value,
        before: before === undefined ? null : before,
        ...(sectionId === 'connections' ? { startsDisabled: status !== 'unchanged', requiresActivation: status !== 'unchanged' } : {}),
      };
    });
    sectionPreviews.push(summarizeSection(sectionId, entries, rejected, MACHINE_SECTION_IDS.includes(sectionId)));
  }

  const previewId = crypto.randomUUID();
  const now = Date.now();
  previews.set(previewId, {
    previewId,
    createdAt: now,
    expiresAt: now + PREVIEW_TTL_MS,
    configDigest: config.stateDigest,
    mcpRevision: mcpDoc.revision,
    sanitized,
    archiveId: doc.archiveId,
  });
  while (previews.size > PREVIEW_CAP) previews.delete(previews.keys().next().value);
  return {
    previewId,
    expiresAt: new Date(now + PREVIEW_TTL_MS).toISOString(),
    archiveId: doc.archiveId,
    createdAt: doc.createdAt,
    cretliVersion: doc.cretliVersion,
    configDigest: config.stateDigest,
    mcpRevision: mcpDoc.revision,
    sections: sectionPreviews,
    ignoredSections,
    omissions: doc.omissions,
    devicePreferences: filterDevicePreferences(doc.devicePreferences),
    notes: ['Imported executable and endpoint definitions start disabled and need a separate activation.'],
  };
}

/**
 * @param {string} id
 * @param {any[]} entries
 * @param {Array<{ path: string, reason: string }>} rejected
 * @param {boolean} machine
 */
function summarizeSection(id, entries, rejected, machine) {
  const counts = { added: 0, changed: 0, unchanged: 0, 'needs-mapping': 0 };
  for (const entry of entries) counts[/** @type {keyof typeof counts} */ (entry.status)] += 1;
  return { id, machine, counts, entries, rejected };
}

/**
 * Re-validate one imported MCP definition. Env/header values never survive.
 *
 * @param {any} row
 * @param {Array<{ path: string, reason: string }>} rejected
 */
function sanitizeImportedMcpServer(row, rejected) {
  if (!row || typeof row !== 'object' || !MCP_ID_PATTERN.test(String(row.id || '')) || row.id === 'builtin-cretli') {
    rejected.push({ path: `mcp.${String(row?.id ?? '?')}`, reason: 'unclassified' });
    return null;
  }
  const transport = row.transport === 'http' ? 'http' : 'stdio';
  const conn = row.connection && typeof row.connection === 'object' ? row.connection : {};
  const base = `mcp.${row.id}`;
  /** @type {Record<string, unknown>} */
  const connection = transport === 'http'
    ? { url: redactUrl(String(conn.url || '').trim()), headerKeys: [] }
    : {
      command: String(conn.command || '').trim(),
      args: redactArgs((Array.isArray(conn.args) ? conn.args : []).map(String), `${base}.args`, rejected),
      cwd: String(conn.cwd || '').trim(),
      envKeys: [],
    };
  for (const [kind, key] of [['env', 'envKeys'], ['headers', 'headerKeys']]) {
    if (conn[kind] && typeof conn[kind] === 'object') rejected.push({ path: `${base}.${kind}`, reason: 'secret' });
    // Key names are informational only (the user must re-enter values); they are not applied.
    if (Array.isArray(conn[key])) connection[key] = conn[key].map(String).filter(Boolean).slice(0, 64);
  }
  return {
    id: String(row.id),
    name: String(row.name || '').trim().slice(0, 120) || 'MCP server',
    transport,
    scope: row.scope === 'all' || !Array.isArray(row.scope) ? 'all' : row.scope.map(String),
    harnesses: Array.isArray(row.harnesses) ? row.harnesses.map(String) : [],
    toolPolicy: { allowInPlan: Array.isArray(row.toolPolicy?.allowInPlan) ? row.toolPolicy.allowInPlan.map(String) : [] },
    connection,
  };
}

/** @type {Promise<unknown>} */
let applyChain = Promise.resolve();

/**
 * Cross-process guard for the config critical section (O_EXCL lock file).
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withImportLock(fn) {
  const run = applyChain.then(async () => {
    const lock = lockPath();
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    let fd;
    try {
      fd = fs.openSync(lock, 'wx');
    } catch (err) {
      if (/** @type {any} */ (err).code !== 'EEXIST') throw err;
      const age = Date.now() - fs.statSync(lock).mtimeMs;
      if (age < 60_000) throw new SettingsBackupError('LOCKED', 'Another settings import is running', 409);
      fs.unlinkSync(lock);
      fd = fs.openSync(lock, 'wx');
    }
    try {
      return await fn();
    } finally {
      try { fs.closeSync(fd); } catch { /* ignore */ }
      try { fs.unlinkSync(lock); } catch { /* ignore */ }
    }
  });
  applyChain = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * @param {string} filePath
 * @param {unknown} value
 * @param {{ fsImpl?: typeof fs }} options
 */
function writeJsonVerified(filePath, value, options) {
  const written = writeFileDurable(filePath, JSON.stringify(value, null, 2), { fsImpl: options.fsImpl });
  if (!verifyFileDigest(filePath, written.sha256, options.fsImpl)) {
    throw new DurableWriteError('read-back digest mismatch', 'verify');
  }
  return written;
}

/**
 * Apply selected sections of a previewed document.
 *
 * @param {{
 *   previewId: string,
 *   sections: string[],
 *   workspaceMapping?: Record<string, string | null>,
 *   fsImpl?: typeof fs,
 *   beforeCas?: () => void,
 * }} input
 */
export function applyImport(input) {
  return withImportLock(async () => {
    const preview = previews.get(String(input.previewId || ''));
    if (!preview) throw new SettingsBackupError('PREVIEW_NOT_FOUND', 'Preview not found or already used. Create a new preview.', 410);
    if (Date.now() > preview.expiresAt) {
      previews.delete(preview.previewId);
      throw new SettingsBackupError('PREVIEW_EXPIRED', 'Preview expired. Create a new preview.', 410);
    }
    const selected = [...new Set(Array.isArray(input.sections) ? input.sections.map(String) : [])];
    if (selected.length === 0) throw new SettingsBackupError('VALIDATION', 'Select at least one section to apply');
    for (const id of selected) {
      if (!(id in preview.sanitized)) throw new SettingsBackupError('VALIDATION', `Section "${id}" is not part of this preview`);
    }
    if (typeof input.beforeCas === 'function') input.beforeCas();

    const usesConfig = selected.some((id) => id !== 'mcp');
    // CAS under the lock: raw-byte digest and MCP revision must still match the preview.
    const config = readConfigStrict();
    if (usesConfig && config.stateDigest !== preview.configDigest) {
      previews.delete(preview.previewId);
      throw new SettingsBackupError('PREVIEW_STALE', 'config.json changed after the preview. Create a new preview.', 409);
    }
    if (selected.includes('mcp') && loadMcpDocument().revision !== preview.mcpRevision) {
      previews.delete(preview.previewId);
      throw new SettingsBackupError('PREVIEW_STALE', 'MCP configuration changed after the preview. Create a new preview.', 409);
    }

    // Verified copy of the previous state before the first mutation.
    const backups = createPreImportBackups(selected, config, input);

    /** @type {Array<{ section: string, status: 'applied' | 'error', detail?: unknown, error?: string }>} */
    const results = [];
    let configChanged = false;
    /** @type {Record<string, any>} */
    const nextConfig = JSON.parse(JSON.stringify(config.parsed));

    if (selected.includes('mcp')) {
      try {
        const detail = await applyMcpSection(preview);
        results.push({ section: 'mcp', status: 'applied', detail });
      } catch (err) {
        if (/** @type {any} */ (err).code === 'MCP_REVISION_CONFLICT') {
          previews.delete(preview.previewId);
          throw new SettingsBackupError('PREVIEW_STALE', 'MCP configuration changed after the preview. Create a new preview.', 409);
        }
        results.push({ section: 'mcp', status: 'error', error: /** @type {any} */ (err).message });
      }
    }

    /** @type {string[]} */
    const pendingKeys = [];
    for (const id of selected) {
      if (id === 'mcp') continue;
      const values = preview.sanitized[id];
      if (id === 'connections') {
        for (const key of Object.keys(values)) pendingKeys.push(key);
        results.push({ section: id, status: 'applied', detail: { staged: Object.keys(values), activated: false } });
        continue;
      }
      if (id === 'workspaces') {
        const detail = applyWorkspaces(nextConfig, values, input.workspaceMapping || {});
        if (detail.applied.length > 0) configChanged = true;
        results.push({ section: id, status: 'applied', detail });
        continue;
      }
      for (const [key, value] of Object.entries(values)) {
        const previous = nextConfig[key];
        nextConfig[key] = mergeKeepingSecrets(previous, value);
        if (key === 'approvalBroker') keepAdvisorEndpoint(previous, nextConfig[key]);
        configChanged = true;
      }
      results.push({ section: id, status: 'applied', detail: { keys: Object.keys(values) } });
    }

    let durability = null;
    try {
      if (configChanged) durability = writeJsonVerified(configPath(), splitConfigWorkspaceSections(nextConfig), input).durability;
      if (pendingKeys.length > 0) stagePending(pendingKeys, selected.includes('connections') ? preview.sanitized.connections : {}, preview.archiveId, input);
    } catch (err) {
      previews.delete(preview.previewId);
      for (const row of results) {
        if (row.section !== 'mcp' && row.status === 'applied') {
          row.status = 'error';
          row.error = `write failed: ${/** @type {any} */ (err).message}`;
        }
      }
      throw new SettingsBackupError('APPLY_FAILED', `Settings were not written: ${/** @type {any} */ (err).message}`, 500, { results, backups });
    }
    previews.delete(preview.previewId);
    const failed = results.filter((row) => row.status === 'error');
    return {
      ok: failed.length === 0,
      results,
      pendingActivation: pendingKeys,
      backups,
      durability,
    };
  });
}

/**
 * @param {string[]} selected
 * @param {{ raw: Buffer | null, digest: string }} config
 * @param {{ fsImpl?: typeof fs }} input
 */
function createPreImportBackups(selected, config, input) {
  try {
    /** @type {{ recoveryCopy: string | null, mcpCopy: string | null, snapshotId: string | null }} */
    const out = { recoveryCopy: null, mcpCopy: null, snapshotId: null };
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    if (config.raw) {
      // Raw bytes keep destination credentials restorable; the copy is 0600 and never listed or downloadable.
      const target = path.join(recoveryDir(), `config-${stamp}.json`);
      const written = writeFileDurable(target, config.raw, { mode: 0o600, fsImpl: input.fsImpl });
      if (written.sha256 !== config.digest || !verifyFileDigest(target, config.digest, input.fsImpl)) {
        throw new DurableWriteError('recovery copy digest mismatch', 'verify');
      }
      out.recoveryCopy = path.basename(target);
    }
    if (selected.includes('mcp') && fs.existsSync(resolveDataPath('mcp.json'))) {
      const raw = fs.readFileSync(resolveDataPath('mcp.json'));
      const target = path.join(recoveryDir(), `mcp-${stamp}.json`);
      const written = writeFileDurable(target, raw, { mode: 0o600, fsImpl: input.fsImpl });
      if (written.sha256 !== sha256(raw) || !verifyFileDigest(target, written.sha256, input.fsImpl)) {
        throw new DurableWriteError('MCP recovery copy digest mismatch', 'verify');
      }
      out.mcpCopy = path.basename(target);
    }
    const snap = createSnapshot({ name: `Before import ${new Date().toISOString()}`, kind: 'pre-import', fsImpl: input.fsImpl });
    out.snapshotId = snap.snapshot.id;
    return out;
  } catch (err) {
    throw new SettingsBackupError(
      'PRE_IMPORT_BACKUP_FAILED',
      `Import aborted: the previous state could not be backed up (${/** @type {any} */ (err).message}). Nothing was changed.`,
      500,
    );
  }
}

/**
 * New or changed definitions are written disabled; secrets and env/header
 * values of existing servers are never touched.
 *
 * @param {any} preview
 */
async function applyMcpSection(preview) {
  const incoming = preview.sanitized.mcp.servers;
  const added = [];
  const updated = [];
  const unchanged = [];
  await mutateMcpConfiguration(preview.mcpRevision, (state) => {
    const servers = [...state.servers];
    for (const def of incoming) {
      const index = servers.findIndex((row) => /** @type {any} */ (row).id === def.id);
      const now = new Date().toISOString();
      if (index < 0) {
        const connection = def.transport === 'http'
          ? { url: def.connection.url, headers: {} }
          : { command: def.connection.command, args: def.connection.args, cwd: def.connection.cwd, env: {} };
        servers.push(normalizeMcpServer({
          id: def.id, name: def.name, kind: 'external', enabled: false, scope: def.scope,
          harnesses: def.harnesses, transport: def.transport, connection, toolPolicy: def.toolPolicy,
          createdAt: now, updatedAt: now,
        }));
        added.push(def.id);
        continue;
      }
      const existing = /** @type {any} */ (servers[index]);
      if (sameJson(mcpDefinitionKey(existing), mcpDefinitionKey(def))) {
        unchanged.push(def.id);
        continue;
      }
      const prevConn = existing.connection || {};
      const connection = def.transport === 'http'
        ? { url: def.connection.url, headers: prevConn.headers || {} }
        : { command: def.connection.command, args: def.connection.args, cwd: def.connection.cwd, env: prevConn.env || {} };
      servers[index] = normalizeMcpServer({
        ...existing, name: def.name, scope: def.scope, harnesses: def.harnesses, transport: def.transport,
        connection, toolPolicy: def.toolPolicy, enabled: false, updatedAt: now,
      });
      updated.push(def.id);
    }
    // Secrets map is passed through untouched: omitted secrets preserve credentials.
    return { servers, secrets: state.secrets };
  });
  return { added, updated, unchanged, disabled: [...added, ...updated] };
}

/**
 * The advisor endpoint is a connection definition: the portable approval
 * section never carries it, so the destination's current value survives.
 *
 * @param {any} previous
 * @param {any} next
 */
function keepAdvisorEndpoint(previous, next) {
  if (!next || typeof next !== 'object') return;
  const prevUrl = previous?.advisor?.baseUrl;
  if (prevUrl === undefined) {
    if (next.advisor && typeof next.advisor === 'object') delete next.advisor.baseUrl;
    return;
  }
  next.advisor = next.advisor && typeof next.advisor === 'object' ? next.advisor : {};
  next.advisor.baseUrl = prevUrl;
}

/**
 * @param {Record<string, any>} config
 * @param {Record<string, any>} values
 * @param {Record<string, string | null>} mapping
 */
function applyWorkspaces(config, values, mapping) {
  const rows = Array.isArray(values.workspaces) ? values.workspaces : [];
  const sidebar = values.workspaceSidebarConfig || {};
  const applied = [];
  const unmapped = [];
  const skippedExisting = [];
  const invalid = [];
  const list = Array.isArray(config.workspaces) ? [...config.workspaces] : [];
  const cfg = config.workspaceSidebarConfig && typeof config.workspaceSidebarConfig === 'object' ? { ...config.workspaceSidebarConfig } : {};
  for (const row of rows) {
    const target = mapping[row.id];
    if (typeof target !== 'string' || !target.trim()) {
      unmapped.push(row.id);
      continue;
    }
    // eslint-disable-next-line no-control-regex
    if (!path.isAbsolute(target) || /[\u0000-\u001f]/.test(target)) {
      invalid.push(row.id);
      continue;
    }
    if (list.some((w) => w && w.id === row.id)) {
      skippedExisting.push(row.id);
      continue;
    }
    list.push(row.kind === 'file'
      ? { id: row.id, kind: 'file', workspaceFile: target, ...(row.label ? { label: row.label } : {}) }
      : { id: row.id, kind: 'folders', ...(row.label ? { label: row.label } : {}) });
    if (row.kind !== 'file') cfg[row.id] = { ...(sidebar[row.id] || {}), folder: target };
    else if (sidebar[row.id]) cfg[row.id] = { ...sidebar[row.id] };
    applied.push(row.id);
  }
  if (applied.length > 0) {
    config.workspaces = list;
    config.workspaceSidebarConfig = cfg;
  }
  return { applied, unmapped, skippedExisting, invalid };
}

/**
 * @param {string[]} keys
 * @param {Record<string, unknown>} values
 * @param {string} archiveId
 * @param {{ fsImpl?: typeof fs }} input
 */
function stagePending(keys, values, archiveId, input) {
  const existing = readPending();
  const byKey = new Map(existing.items.map((item) => [item.key, item]));
  for (const key of keys) byKey.set(key, { key, value: values[key], importedAt: new Date().toISOString(), archiveId });
  writeJsonVerified(pendingPath(), { schemaVersion: 1, items: [...byKey.values()] }, input);
}

/** @returns {{ schemaVersion: number, items: Array<{ key: string, value: unknown, importedAt: string, archiveId: string }> }} */
export function readPending() {
  const file = pendingPath();
  if (!fs.existsSync(file)) return { schemaVersion: 1, items: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { schemaVersion: 1, items: Array.isArray(parsed.items) ? parsed.items : [] };
  } catch (err) {
    throw new SettingsBackupError('PENDING_CORRUPT', `Pending activations file is corrupt: ${/** @type {any} */ (err).message}`, 500);
  }
}

/**
 * Explicit, separate activation of staged connection definitions. Only writes
 * config values; it never executes a binary or contacts an endpoint.
 *
 * @param {{ keys: string[], confirm: boolean, fsImpl?: typeof fs }} input
 */
export function activatePending(input) {
  if (input.confirm !== true) throw new SettingsBackupError('CONFIRM_REQUIRED', 'Activation must be confirmed explicitly');
  return withImportLock(async () => {
    const pending = readPending();
    const wanted = new Set((Array.isArray(input.keys) ? input.keys : []).map(String));
    if (wanted.size === 0) throw new SettingsBackupError('VALIDATION', 'Select at least one definition to activate');
    const items = pending.items.filter((item) => wanted.has(item.key));
    if (items.length !== wanted.size) throw new SettingsBackupError('NOT_FOUND', 'Unknown pending definition', 404);
    const config = readConfigStrict();
    const next = JSON.parse(JSON.stringify(config.parsed));
    for (const item of items) {
      if (item.key === 'approvalBroker.advisor.baseUrl') {
        next.approvalBroker = next.approvalBroker && typeof next.approvalBroker === 'object' ? next.approvalBroker : {};
        next.approvalBroker.advisor = next.approvalBroker.advisor && typeof next.approvalBroker.advisor === 'object' ? next.approvalBroker.advisor : {};
        next.approvalBroker.advisor.baseUrl = item.value;
      } else {
        next[item.key] = item.value;
      }
    }
    writeJsonVerified(configPath(), splitConfigWorkspaceSections(next), input);
    writeJsonVerified(pendingPath(), { schemaVersion: 1, items: pending.items.filter((item) => !wanted.has(item.key)) }, input);
    return { activated: items.map((item) => item.key) };
  });
}
