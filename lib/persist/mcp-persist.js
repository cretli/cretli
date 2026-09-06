/**
 * Durable MCP registry + secrets with a recoverable write journal.
 * Two files cannot be updated atomically; the journal completes or rolls
 * forward a crashed mutation after restart.
 */

import fs from 'fs';
import path from 'path';
import { writeJsonAtomic } from './atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';

export const MCP_SCHEMA_VERSION = 1;
export const MCP_SECRETS_SCHEMA_VERSION = 1;

export class McpConfigCorruptError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'McpConfigCorruptError';
    this.code = 'MCP_CONFIG_CORRUPT';
  }
}

export class McpRevisionConflictError extends Error {
  /**
   * @param {number} currentRevision
   */
  constructor(currentRevision) {
    super('MCP configuration was updated by another request');
    this.name = 'McpRevisionConflictError';
    this.code = 'MCP_REVISION_CONFLICT';
    this.currentRevision = currentRevision;
  }
}

/**
 * @returns {string}
 */
export function getMcpConfigPath() {
  return resolveDataPath('mcp.json');
}

/**
 * @returns {string}
 */
export function getMcpSecretsPath() {
  return resolveDataPath('mcp-secrets.json');
}

/**
 * @returns {string}
 */
export function getMcpJournalPath() {
  return resolveDataPath('mcp-tx.json');
}

/**
 * @typedef {{
 *   schemaVersion: number,
 *   revision: number,
 *   servers: object[],
 * }} McpDocument
 */

/** @type {Promise<unknown>} */
let writeQueue = Promise.resolve();

/**
 * @param {() => Promise<T> | T} task
 * @returns {Promise<T>}
 * @template T
 */
function enqueueWrite(task) {
  const run = writeQueue.then(task, task);
  writeQueue = run.then(() => undefined, () => undefined);
  return run;
}

function ensureDir() {
  const dir = path.dirname(getMcpConfigPath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * @param {string} filePath
 * @param {number} mode
 */
function chmodBestEffort(filePath, mode) {
  try {
    fs.chmodSync(filePath, mode);
  } catch {
    // Some test filesystems ignore chmod.
  }
}

/**
 * @param {unknown} parsed
 * @returns {Record<string, Record<string, string>>}
 */
function normalizeSecretsMap(parsed) {
  const secrets = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed
    : {};
  /** @type {Record<string, Record<string, string>>} */
  const normalized = {};
  for (const [serverId, bag] of Object.entries(secrets)) {
    if (!bag || typeof bag !== 'object' || Array.isArray(bag)) continue;
    /** @type {Record<string, string>} */
    const nextBag = {};
    for (const [key, value] of Object.entries(bag)) {
      if (typeof value === 'string' && value) nextBag[key] = value;
    }
    if (Object.keys(nextBag).length > 0) normalized[serverId] = nextBag;
  }
  return normalized;
}

/**
 * @returns {{ schemaVersion: number, revision: number, secrets: Record<string, Record<string, string>> }}
 */
export function loadMcpSecretsDocument() {
  ensureDir();
  const filePath = getMcpSecretsPath();
  if (!fs.existsSync(filePath)) {
    return { schemaVersion: MCP_SECRETS_SCHEMA_VERSION, revision: 0, secrets: {} };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new McpConfigCorruptError(
      `MCP secrets file is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new McpConfigCorruptError('MCP secrets file is not an object');
  }
  if (parsed.secrets != null && (typeof parsed.secrets !== 'object' || Array.isArray(parsed.secrets))) {
    throw new McpConfigCorruptError('MCP secrets file is corrupt');
  }
  const revision = Number(parsed.revision);
  return {
    schemaVersion: MCP_SECRETS_SCHEMA_VERSION,
    revision: Number.isInteger(revision) && revision >= 0 ? revision : 0,
    secrets: normalizeSecretsMap(parsed.secrets),
  };
}

/**
 * @returns {McpDocument}
 */
export function loadMcpDocumentRaw() {
  ensureDir();
  const filePath = getMcpConfigPath();
  if (!fs.existsSync(filePath)) {
    return { schemaVersion: MCP_SCHEMA_VERSION, revision: 0, servers: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new McpConfigCorruptError(
      `MCP configuration file is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new McpConfigCorruptError('MCP configuration file is not an object');
  }
  if (parsed.schemaVersion !== MCP_SCHEMA_VERSION) {
    throw new McpConfigCorruptError(
      `Unsupported MCP schemaVersion ${String(parsed.schemaVersion)}`,
    );
  }
  const revision = Number(parsed.revision);
  if (!Number.isInteger(revision) || revision < 0) {
    throw new McpConfigCorruptError('MCP configuration revision is invalid');
  }
  const servers = Array.isArray(parsed.servers)
    ? parsed.servers.filter((row) => row && typeof row === 'object')
    : [];
  return { schemaVersion: MCP_SCHEMA_VERSION, revision, servers };
}

/**
 * @returns {object | null}
 */
function readJournal() {
  const filePath = getMcpJournalPath();
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function clearJournal() {
  const filePath = getMcpJournalPath();
  if (!fs.existsSync(filePath)) return;
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

/**
 * @param {object[]} servers
 * @param {Record<string, Record<string, string>>} secrets
 * @param {number} revision
 */
function writeCommittedFiles(servers, secrets, revision) {
  const secretsPath = getMcpSecretsPath();
  writeJsonAtomic(secretsPath, {
    schemaVersion: MCP_SECRETS_SCHEMA_VERSION,
    revision,
    secrets,
  });
  chmodBestEffort(secretsPath, 0o600);
  writeJsonAtomic(getMcpConfigPath(), {
    schemaVersion: MCP_SCHEMA_VERSION,
    revision,
    servers,
  });
  chmodBestEffort(getMcpConfigPath(), 0o600);
}

/**
 * Complete a journal left by a crashed write. Never logs secret values.
 *
 * @returns {boolean} true when a journal was applied or discarded
 */
export function recoverMcpTransaction() {
  const journal = readJournal();
  if (!journal) return false;
  const nextRevision = Number(journal.nextRevision);
  const expectedRevision = Number(journal.expectedRevision);
  if (!Number.isInteger(nextRevision) || !Number.isInteger(expectedRevision)) {
    clearJournal();
    return true;
  }
  let current;
  try {
    current = loadMcpDocumentRaw();
  } catch {
    current = { schemaVersion: MCP_SCHEMA_VERSION, revision: expectedRevision, servers: [] };
  }
  const secretsDoc = loadMcpSecretsDocument();
  if (current.revision >= nextRevision && secretsDoc.revision >= nextRevision) {
    clearJournal();
    return true;
  }
  if (current.revision !== expectedRevision && current.revision !== nextRevision) {
    clearJournal();
    return true;
  }
  const servers = Array.isArray(journal.servers) ? journal.servers : current.servers;
  const secrets = normalizeSecretsMap(journal.secrets);
  writeCommittedFiles(servers, secrets, nextRevision);
  clearJournal();
  return true;
}

/**
 * @returns {McpDocument}
 */
export function loadMcpDocument() {
  recoverMcpTransaction();
  return loadMcpDocumentRaw();
}

/**
 * @param {number} expectedRevision
 * @param {(state: {
 *   servers: object[],
 *   secrets: Record<string, Record<string, string>>,
 *   revision: number,
 * }) => {
 *   servers: object[],
 *   secrets: Record<string, Record<string, string>>,
 * }} operation
 * @returns {Promise<McpDocument>}
 */
export function mutateMcpConfiguration(expectedRevision, operation) {
  return enqueueWrite(() => {
    recoverMcpTransaction();
    if (!Number.isInteger(expectedRevision)) {
      const err = new Error('expectedRevision is required');
      err.code = 'VALIDATION';
      throw err;
    }
    const current = loadMcpDocumentRaw();
    if (current.revision !== expectedRevision) {
      throw new McpRevisionConflictError(current.revision);
    }
    const secretsDoc = loadMcpSecretsDocument();
    const nextState = operation({
      servers: current.servers,
      secrets: { ...secretsDoc.secrets },
      revision: current.revision,
    });
    const nextRevision = current.revision + 1;
    const servers = Array.isArray(nextState?.servers) ? nextState.servers : current.servers;
    const secrets = normalizeSecretsMap(nextState?.secrets);
    const journal = {
      expectedRevision,
      nextRevision,
      servers,
      secrets,
    };
    const journalPath = getMcpJournalPath();
    writeJsonAtomic(journalPath, journal);
    chmodBestEffort(journalPath, 0o600);
    writeCommittedFiles(servers, secrets, nextRevision);
    clearJournal();
    return {
      schemaVersion: MCP_SCHEMA_VERSION,
      revision: nextRevision,
      servers,
    };
  });
}

/**
 * @param {object[]} servers
 * @param {number} expectedRevision
 * @returns {Promise<McpDocument>}
 */
export function saveMcpDocument(servers, expectedRevision) {
  return mutateMcpConfiguration(expectedRevision, (state) => ({
    servers,
    secrets: state.secrets,
  }));
}
