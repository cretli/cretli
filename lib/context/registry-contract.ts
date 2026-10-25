/**
 * Static context registry contract (rules, skills, commands, agents).
 * Stable identity, content versioning, manifest, epoch, and two separate hierarchies.
 */

import crypto from 'node:crypto';
import path from 'node:path';

export type RegistryEntryKind = 'rule' | 'skill' | 'command' | 'agent';

export interface RegistryEntryRecord {
  id: string;
  kind: RegistryEntryKind;
  source: string;
  relPath: string;
  callName: string;
  contentHash: string;
  sizeBytes: number;
}

export interface ContextManifest {
  registryEpoch: string;
  assembledAt: string;
  projectRoot: string;
  contentRevision: string;
  entries: object[];
  warnings: string[];
}

export const REGISTRY_ENTRY_KINDS = Object.freeze(['rule', 'skill', 'command', 'agent']);

/**
 * Name resolution order for ambiguous @name references (picker / catalog only).
 * Does not remove other IDs from the catalog or auto-load all skills sharing a name.
 */
export const NAME_RESOLUTION_ORDER = Object.freeze([
  'explicit_chat_id',
  'nearest_project_entry',
  'project_root_entry',
  'assigned_shared_ordered',
  'user_sources',
  'bundled',
]);

/**
 * Instruction stacking order (separate from name resolution).
 * Host documents provenance; harness may still apply its own system layers.
 */
export const INSTRUCTION_PRECEDENCE_ORDER = Object.freeze([
  'explicit_user_turn',
  'active_project_instructions_local_first',
  'shared_user_bundled_supplemental',
]);

export function buildRegistryEntryId(source: string, relPath: string, kind: RegistryEntryKind): string {
  const src = String(source || '').trim();
  const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const k = String(kind || '').trim();
  return `${src}::${k}::${rel}`;
}

/**
 * Content hash is the entry version, not part of the stable ID.
 */
export function computeRegistryContentHash(content: string): string {
  return crypto.createHash('sha256').update(String(content ?? ''), 'utf8').digest('hex');
}

export function buildRegistryEntryRecord(input: {
  id: string;
  kind: RegistryEntryKind;
  source: string;
  relPath: string;
  callName: string;
  contentHash: string;
  sizeBytes?: number;
}): RegistryEntryRecord {
  return {
    id: input.id,
    kind: input.kind,
    source: input.source,
    relPath: input.relPath.replace(/\\/g, '/'),
    callName: input.callName,
    contentHash: input.contentHash,
    sizeBytes: typeof input.sizeBytes === 'number' ? input.sizeBytes : 0,
  };
}

export function buildContextManifest(input: {
  registryEpoch: string;
  assembledAt: string;
  projectRoot: string;
  contentRevision?: string;
  entries: object[];
  warnings?: string[];
}): ContextManifest {
  return {
    registryEpoch: String(input.registryEpoch || ''),
    assembledAt: String(input.assembledAt || ''),
    projectRoot: String(input.projectRoot || ''),
    contentRevision: String(input.contentRevision || ''),
    entries: Array.isArray(input.entries) ? input.entries : [],
    warnings: Array.isArray(input.warnings) ? input.warnings : [],
  };
}

/**
 * Optional per-project config file (`.cretli/context.json`) schema version.
 */
export const PROJECT_CONTEXT_CONFIG_VERSION = 1;

export function parseProjectContextConfig(raw: unknown): { ok: boolean, value?: Record<string, unknown>, error?: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Config must be a JSON object' };
  }
  const version = Number((raw as Record<string, unknown>).version);
  if (!Number.isInteger(version) || version < 1 || version > PROJECT_CONTEXT_CONFIG_VERSION) {
    return { ok: false, error: 'Unsupported context config version' };
  }
  const entries = (raw as Record<string, unknown>).entries;
  if (entries !== undefined && !Array.isArray(entries)) {
    return { ok: false, error: 'entries must be an array when present' };
  }
  return { ok: true, value: raw as Record<string, unknown> };
}

/**
 * Relative path inside the project root for config references.
 */
export function joinProjectRelativePath(projectRoot: string, relPath: string): string {
  const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  return path.join(projectRoot, rel);
}
