/**
 * Delegation JSON/SQLite schema versions. Unknown future versions are rejected
 * so older code cannot silently rewrite newer data.
 */

export const DELEGATIONS_JSON_SCHEMA_VERSION = 2;
export const MAILBOX_JSON_SCHEMA_VERSION = 1;
export const WORKFLOWS_JSON_SCHEMA_VERSION = 1;
export const DELEGATION_SQLITE_SCHEMA_VERSION = 3;
export const DELEGATION_STORE_MAX_VERSION = 3;

export class UnsupportedDelegationSchemaError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, version?: number }} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'UnsupportedDelegationSchemaError';
    this.code = details.code || 'DELEGATIONS_SCHEMA';
    this.version = Number(details.version) || 0;
  }
}

/**
 * @param {unknown} raw
 * @returns {number}
 */
export function readSchemaVersion(raw) {
  const version = Number(raw);
  if (!Number.isFinite(version) || version <= 0) return 0;
  return Math.floor(version);
}

/**
 * @param {{
 *   version: unknown,
 *   maxVersion: number,
 *   label: string,
 *   code: string,
 * }} input
 * @returns {number}
 */
export function assertSupportedSchemaVersion(input) {
  const version = readSchemaVersion(input.version);
  if (version === 0) return input.maxVersion;
  if (version > input.maxVersion) {
    throw new UnsupportedDelegationSchemaError(
      `${input.label} schema ${version} is newer than this build (max ${input.maxVersion}).`,
      { code: input.code, version },
    );
  }
  return version;
}

/**
 * @param {unknown} version
 * @returns {number}
 */
export function assertDelegationsJsonSchemaVersion(version) {
  return assertSupportedSchemaVersion({
    version,
    maxVersion: DELEGATIONS_JSON_SCHEMA_VERSION,
    label: 'Delegations JSON',
    code: 'DELEGATIONS_SCHEMA',
  });
}

/**
 * @param {unknown} version
 * @returns {number}
 */
export function assertMailboxJsonSchemaVersion(version) {
  return assertSupportedSchemaVersion({
    version,
    maxVersion: MAILBOX_JSON_SCHEMA_VERSION,
    label: 'Mailbox JSON',
    code: 'MAILBOX_SCHEMA',
  });
}

/**
 * @param {unknown} version
 * @returns {number}
 */
export function assertWorkflowsJsonSchemaVersion(version) {
  return assertSupportedSchemaVersion({
    version,
    maxVersion: WORKFLOWS_JSON_SCHEMA_VERSION,
    label: 'Delegation workflows JSON',
    code: 'WORKFLOWS_SCHEMA',
  });
}

/**
 * @param {unknown} version
 * @returns {number}
 */
export function assertSqliteSchemaVersion(version) {
  return assertSupportedSchemaVersion({
    version,
    maxVersion: DELEGATION_SQLITE_SCHEMA_VERSION,
    label: 'Delegations SQLite',
    code: 'DELEGATIONS_SCHEMA',
  });
}
