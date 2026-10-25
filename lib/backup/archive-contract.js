/**
 * Versioned backup/archive contract: profile IDs, frozen v1 limits, registry
 * consumption checklist and proposed store adapter IDs.
 *
 * This module is the machine-readable B1 contract. `docs/backup/archive-profiles.md`
 * and `docs/storage-contract.md` document the prose; values here MUST stay aligned.
 *
 * Scope: describes archive shapes and registry entry requirements only. No I/O,
 * no ZIP building, no restore apply (B4/B6).
 */

/** Human-readable revision tracked inside exported manifests. */
export const ARCHIVE_CONTRACT_REVISION = '2026-10-13.1';

/** Supported archive profile identifiers. */
export const ARCHIVE_PROFILES = Object.freeze([
  'portable-settings-v1',
  'conversations-v1',
  'data-backup-v1',
]);

/** Current manifest format version per profile (increment on breaking shape change). */
export const MANIFEST_FORMAT_VERSION = Object.freeze({
  'portable-settings-v1': 1,
  'conversations-v1': 1,
  'data-backup-v1': 1,
});

/** Frozen v1 size and shape limits (see docs/backup/archive-profiles.md). */
export const ARCHIVE_LIMITS_V1 = Object.freeze({
  maxMemberBytes: 512 * 1024 * 1024,
  maxArchiveBytes: 8 * 1024 * 1024 * 1024,
  maxCategories: 64,
  maxOmissions: 4096,
  maxRelativePathLength: 512,
});

/** Field classification for portable settings projection. */
export const SECRET_FIELD_CLASSES = Object.freeze([
  'portable',
  'machine',
  'secret',
  'transient',
]);

/** Omission reason codes shared across profiles. */
export const ARCHIVE_OMISSION_REASONS = Object.freeze([
  'secret',
  'machine',
  'unclassified',
  'operator_excluded',
  'dependency_not_exported',
  'corrupt_source',
  'browser_unavailable',
  'retained_path',
  'pruned_history',
  'attachment_missing',
  'optional_category_skipped',
  'usage_not_included',
]);

/**
 * Registry fields B1 requires on every store entry (A1 populates `store-registry.js`).
 * Used for acceptance tests and snapshot capability documentation.
 */
export const REGISTRY_CAPABILITY_FIELDS = Object.freeze([
  'storeId',
  'domainOwner',
  'backend',
  'schemaVersion',
  'managedPaths',
  'writers',
  'lockOrderRank',
  'flushStrategy',
  'secretClassification',
  'dependsOn',
  'rawValidatorId',
  'exportAdapterId',
  'restoreAdapterId',
  'cacheInvalidationHooks',
]);

/**
 * Proposed stable store IDs referenced by manifests and A1 inventory (not the registry itself).
 */
export const ARCHIVE_STORE_IDS = Object.freeze([
  'settings',
  'sidebar-layout',
  'chats-metadata',
  'chat-history',
  'chat-title-history',
  'todos',
  'workspace-memory',
  'workspace-watchers',
  'delegations',
  'recovery',
  'usage-ledger',
  'mcp-config',
  'attachments',
]);

/**
 * Paths that must never be exported or restored from archives (retained boundary).
 */
export const RETAINED_PATH_PREFIXES = Object.freeze([
  '.env',
  'sessions.json',
  'mcp-secrets.json',
]);

/**
 * @param {unknown} profile
 * @returns {profile is (typeof ARCHIVE_PROFILES)[number]}
 */
export function isArchiveProfile(profile) {
  return typeof profile === 'string' && ARCHIVE_PROFILES.includes(profile);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return String(value ?? '').trim();
}

/**
 * Validates a registry entry shape for backup consumption (A1 acceptance helper).
 *
 * @param {Record<string, unknown>} entry
 * @returns {{ ok: true } | { ok: false, missing: string[] }}
 */
export function validateStoreRegistryEntry(entry) {
  if (entry == null || typeof entry !== 'object') {
    return { ok: false, missing: ['entry'] };
  }
  const missing = REGISTRY_CAPABILITY_FIELDS.filter((field) => {
    const value = entry[field];
    if (value === undefined || value === null) return true;
    if (field === 'managedPaths' || field === 'writers' || field === 'dependsOn' || field === 'cacheInvalidationHooks') {
      return !Array.isArray(value);
    }
    if (field === 'secretClassification' && typeof value !== 'object') return true;
    if (field === 'schemaVersion' && typeof value !== 'number') return true;
    if (field === 'lockOrderRank' && typeof value !== 'number') return true;
    return text(value) === '';
  });
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true };
}

/**
 * @param {typeof ARCHIVE_PROFILES[number]} profile
 * @param {number} manifestFormatVersion
 * @returns {{ ok: true } | { ok: false, code: string, detail?: string }}
 */
export function resolveManifestFormatSupport(profile, manifestFormatVersion) {
  if (!isArchiveProfile(profile)) {
    return { ok: false, code: 'unsupported_profile', detail: text(profile) };
  }
  const supported = MANIFEST_FORMAT_VERSION[profile];
  const version = Number(manifestFormatVersion);
  if (!Number.isInteger(version) || version < 1) {
    return { ok: false, code: 'invalid_manifest_version' };
  }
  if (version > supported) {
    return { ok: false, code: 'unsupported_manifest_version', detail: `max ${supported}` };
  }
  return { ok: true };
}

/**
 * Semantic totals check for ZIP manifests (after JSON Schema pass).
 *
 * @param {{ categories?: Array<{ byteSize?: number }>, totals?: { uncompressedBytes?: number } }} manifest
 * @returns {{ ok: true } | { ok: false, code: string }}
 */
export function validateArchiveTotals(manifest) {
  const categories = Array.isArray(manifest.categories) ? manifest.categories : [];
  if (categories.length > ARCHIVE_LIMITS_V1.maxCategories) {
    return { ok: false, code: 'category_count_exceeded' };
  }
  let sum = 0;
  for (const category of categories) {
    const size = Number(category?.byteSize ?? 0);
    if (!Number.isFinite(size) || size < 0) return { ok: false, code: 'invalid_member_size' };
    if (size > ARCHIVE_LIMITS_V1.maxMemberBytes) return { ok: false, code: 'member_size_exceeded' };
    sum += size;
  }
  if (sum > ARCHIVE_LIMITS_V1.maxArchiveBytes) return { ok: false, code: 'archive_size_exceeded' };
  const declared = manifest.totals?.uncompressedBytes;
  if (declared != null && Number(declared) !== sum) {
    return { ok: false, code: 'totals_mismatch' };
  }
  return { ok: true };
}

/**
 * Pre-migration preview gate: unsupported reader/migration combinations fail closed.
 *
 * @param {{
 *   persistence?: {
 *     backend?: string,
 *     schemaVersions?: Record<string, unknown>,
 *     bootstrapMarker?: string,
 *     legacyReaderId?: string,
 *     forwardMigrationId?: string,
 *   },
 * }} manifest
 * @param {{
 *   installedBackend: string,
 *   forwardMigrationPaused?: boolean,
 *   hasLegacyReader: (id: string) => boolean,
 *   hasForwardMigration: (id: string) => boolean,
 *   supportsSchemaVersions?: (versions: Record<string, number>) => boolean,
 *   acceptsBootstrapMarker?: (marker: string) => boolean,
 * }} ctx
 * @returns {{ ok: true } | { ok: false, code: string }}
 */
export function validatePreMigrationRestorePreview(manifest, ctx) {
  const persistence = manifest.persistence ?? {};
  const archiveBackend = text(persistence.backend);
  const installedBackend = text(ctx.installedBackend);
  if (archiveBackend === '' || installedBackend === '') {
    return { ok: false, code: 'missing_backend_marker' };
  }
  if (archiveBackend === installedBackend) return { ok: true };
  const rawSchemaVersions = persistence.schemaVersions;
  if (rawSchemaVersions == null || typeof rawSchemaVersions !== 'object' || Array.isArray(rawSchemaVersions)) {
    return { ok: false, code: 'missing_schema_versions' };
  }
  /** @type {Record<string, number>} */
  const schemaVersions = {};
  for (const [storeId, version] of Object.entries(rawSchemaVersions)) {
    const numeric = Number(version);
    if (!Number.isInteger(numeric) || numeric < 0) {
      return { ok: false, code: 'unsupported_schema_version' };
    }
    schemaVersions[storeId] = numeric;
  }
  if (Object.keys(schemaVersions).length === 0) {
    return { ok: false, code: 'missing_schema_versions' };
  }
  if (typeof ctx.supportsSchemaVersions === 'function') {
    if (!ctx.supportsSchemaVersions(schemaVersions)) {
      return { ok: false, code: 'unsupported_schema_version' };
    }
  }
  const bootstrapMarker = text(persistence.bootstrapMarker);
  if (bootstrapMarker !== '' && typeof ctx.acceptsBootstrapMarker === 'function') {
    if (!ctx.acceptsBootstrapMarker(bootstrapMarker)) {
      return { ok: false, code: 'unsupported_bootstrap_override' };
    }
  }
  const readerId = text(persistence.legacyReaderId);
  if (readerId === '' || !ctx.hasLegacyReader(readerId)) {
    return { ok: false, code: 'unsupported_legacy_reader' };
  }
  const migrationId = text(persistence.forwardMigrationId);
  if (migrationId === '' || !ctx.hasForwardMigration(migrationId)) {
    return { ok: false, code: 'unsupported_forward_migration' };
  }
  if (ctx.forwardMigrationPaused !== true) {
    return { ok: false, code: 'forward_migration_not_paused' };
  }
  return { ok: true };
}
