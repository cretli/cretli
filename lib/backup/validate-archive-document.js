/**
 * JSON Schema validation for B1 archive manifests and portable settings documents.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import {
  ARCHIVE_CONTRACT_REVISION,
  ARCHIVE_PROFILES,
  isArchiveProfile,
  validateArchiveTotals,
  resolveManifestFormatSupport,
} from './archive-contract.js';

const SCHEMA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'schemas');

/** @type {Map<string, object>} */
const schemaCache = new Map();

/**
 * @param {string} fileName
 * @returns {object}
 */
function loadSchema(fileName) {
  const cached = schemaCache.get(fileName);
  if (cached) return cached;
  const fullPath = path.join(SCHEMA_DIR, fileName);
  const schema = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  schemaCache.set(fileName, schema);
  return schema;
}

/**
 * @returns {import('ajv').default}
 */
function createAjv() {
  const AjvCtor = /** @type {any} */ (Ajv);
  return new AjvCtor({ allErrors: true, strict: false });
}

/** @type {import('ajv').default | null} */
let sharedAjv = null;

/**
 * @returns {import('ajv').default}
 */
function getAjv() {
  if (!sharedAjv) sharedAjv = createAjv();
  return sharedAjv;
}

const PROFILE_SCHEMA_FILE = Object.freeze({
  'portable-settings-v1': 'portable-settings-v1.schema.json',
  'conversations-v1': 'conversations-manifest-v1.schema.json',
  'data-backup-v1': 'data-backup-manifest-v1.schema.json',
});

/**
 * @param {typeof ARCHIVE_PROFILES[number]} profile
 * @returns {import('ajv').ValidateFunction}
 */
export function compileArchiveValidator(profile) {
  if (!isArchiveProfile(profile)) {
    throw new Error(`Unsupported archive profile: ${profile}`);
  }
  const ajv = getAjv();
  const schema = loadSchema(PROFILE_SCHEMA_FILE[profile]);
  return ajv.compile(schema);
}

/**
 * @param {unknown} doc
 * @param {typeof ARCHIVE_PROFILES[number]} profile
 * @returns {{ ok: true, value: Record<string, unknown> } | { ok: false, errors: string[] }}
 */
export function validateArchiveDocument(doc, profile) {
  if (!isArchiveProfile(profile)) {
    return { ok: false, errors: [`unsupported profile: ${profile}`] };
  }
  const validate = compileArchiveValidator(profile);
  if (!validate(doc)) {
    const errors = (validate.errors ?? []).map(
      (err) => `${err.instancePath || '/'} ${err.message ?? 'invalid'}`.trim(),
    );
    return { ok: false, errors };
  }
  const value = /** @type {Record<string, unknown>} */ (doc);
  if (value.archiveContractRevision !== ARCHIVE_CONTRACT_REVISION) {
    return {
      ok: false,
      errors: [
        `archiveContractRevision must be ${ARCHIVE_CONTRACT_REVISION}, got ${value.archiveContractRevision}`,
      ],
    };
  }
  const formatCheck = /** @type {any} */ (resolveManifestFormatSupport(profile, Number(value.manifestFormatVersion)));
  if (!formatCheck.ok) {
    return { ok: false, errors: [formatCheck.code + (formatCheck.detail ? `: ${formatCheck.detail}` : '')] };
  }
  if (profile === 'conversations-v1' || profile === 'data-backup-v1') {
    const totalsCheck = /** @type {any} */ (validateArchiveTotals(value));
    if (!totalsCheck.ok) return { ok: false, errors: [totalsCheck.code] };
  }
  const omissionCheck = /** @type {any} */ (validateCorruptSourceOmissions(value));
  if (!omissionCheck.ok) return { ok: false, errors: omissionCheck.errors };
  return { ok: true, value };
}

const RAW_SHA256_PATTERN = /^[a-f0-9]{64}$/;

/**
 * @param {{ omissions?: Array<{ reason?: string, rawSha256?: string }> }} doc
 * @returns {{ ok: true } | { ok: false, errors: string[] }}
 */
export function validateCorruptSourceOmissions(doc) {
  const omissions = Array.isArray(doc.omissions) ? doc.omissions : [];
  const errors = [];
  for (const [index, omission] of omissions.entries()) {
    if (omission?.reason !== 'corrupt_source') continue;
    const digest = omission.rawSha256;
    if (typeof digest !== 'string' || !RAW_SHA256_PATTERN.test(digest)) {
      errors.push(`omissions[${index}] corrupt_source requires rawSha256`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true };
}

/**
 * Detect profile from document or fail.
 *
 * @param {unknown} doc
 * @returns {{ ok: true, profile: typeof ARCHIVE_PROFILES[number] } | { ok: false, errors: string[] }}
 */
export function detectArchiveProfile(doc) {
  if (doc == null || typeof doc !== 'object') {
    return { ok: false, errors: ['document must be an object'] };
  }
  const profile = /** @type {Record<string, unknown>} */ (doc).profile;
  if (!isArchiveProfile(profile)) {
    return { ok: false, errors: [`unknown or missing profile: ${profile}`] };
  }
  return { ok: true, profile };
}

/**
 * @param {unknown} doc
 * @returns {{ ok: true, profile: typeof ARCHIVE_PROFILES[number], value: Record<string, unknown> } | { ok: false, errors: string[] }}
 */
export function validateArchiveDocumentAuto(doc) {
  const detected = detectArchiveProfile(doc);
  if (!detected.ok) return { ok: false, errors: /** @type {any} */ (detected).errors };
  const validated = /** @type {any} */ (validateArchiveDocument(doc, detected.profile));
  if (!validated.ok) return { ok: false, errors: validated.errors };
  return { ok: true, profile: detected.profile, value: validated.value };
}
