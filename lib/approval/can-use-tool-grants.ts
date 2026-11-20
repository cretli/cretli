import { GATED_PERMISSION_HARNESSES } from './harness-permission-controls.ts';
/** Persistent human grants scoped to one workspace and harness. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveDataPath } from '../runtime-paths.js';
import { writeJsonAtomic } from '../persist/atomic-write.js';

export type CanUseToolGrantKeys = {
  harness: string,
  tool: string,
  metadata: { harness: string, workspace: string, toolName: string },
};

type StoredGrant = {
  id: string,
  scope: string,
  harness?: string,
  workspace?: string,
  toolName?: string,
  createdAt?: string,
};

/** Canonical serialization makes object key order irrelevant to exact grants. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as object).sort().map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]));
  }
  return value;
}

/** Compute opaque scope keys and display metadata without commands or arguments. */
export function buildCanUseToolGrantKeys(
  { harness, workspace, toolName, input = {} }: { harness: string, workspace: string, toolName: unknown, input?: Record<string, unknown> },
): CanUseToolGrantKeys | null {
  if (!String(workspace || '').trim() || !GATED_PERMISSION_HARNESSES.includes(harness)) return null;
  const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const scope = [harness, path.resolve(workspace)];
  return {
    harness: digest(scope), tool: digest([...scope, toolName, canonicalize(input)]),
    metadata: { harness, workspace: path.basename(path.resolve(workspace)), toolName: String(toolName || '') },
  };
}

/** Missing or unreadable storage never supplies a grant. */
function readGrants(file: string): StoredGrant[] {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data) ? data.flatMap((entry) => {
      if (typeof entry === 'string') return [{ id: entry, scope: 'legacy' }];
      return entry && typeof entry.id === 'string' ? [entry] : [];
    }) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return [];
    throw error;
  }
}

export const DEFAULT_CAN_USE_TOOL_GRANTS_FILE = resolveDataPath('approval-human-grants.json');

/** Check grants on every invocation so revocation and restarts take effect. */
export function hasCanUseToolGrant(keys: CanUseToolGrantKeys | null | undefined, file: string = DEFAULT_CAN_USE_TOOL_GRANTS_FILE) {
  if (!keys) return false;
  const grants = readGrants(file);
  return grants.some((grant) => grant.id === keys.harness || grant.id === keys.tool);
}

/** Persist only an explicit human choice; advisors cannot create grants. */
export function saveCanUseToolGrant(keys: CanUseToolGrantKeys | null | undefined, scope: string, file: string = DEFAULT_CAN_USE_TOOL_GRANTS_FILE) {
  if (!keys || !['tool', 'harness'].includes(scope)) throw new Error('Invalid permission grant scope');
  const grants = readGrants(file).filter((grant) => grant.id !== keys[scope as 'tool' | 'harness']);
  writeJsonAtomic(file, [...grants, {
    id: keys[scope as 'tool' | 'harness'], scope, harness: keys.metadata?.harness || '',
    workspace: keys.metadata?.workspace || '',
    toolName: scope === 'tool' ? keys.metadata?.toolName || '' : '',
    createdAt: new Date().toISOString(),
  }]);
}

/** Public metadata excludes arguments and absolute workspace paths. */
export function listCanUseToolGrants(file: string = DEFAULT_CAN_USE_TOOL_GRANTS_FILE) {
  return readGrants(file).map((grant) => ({
    id: grant.id,
    scope: ['tool', 'harness'].includes(grant.scope) ? grant.scope : 'legacy',
    harness: GATED_PERMISSION_HARNESSES.includes(grant.harness as string) ? grant.harness : '',
    workspace: path.basename(String(grant.workspace || '')),
    toolName: String(grant.toolName || '').slice(0, 300),
    createdAt: String(grant.createdAt || ''),
  }));
}

/** Revoke explicit ids, leaving grants created concurrently by other chats intact. */
export function revokeCanUseToolGrants(ids: unknown, file: string = DEFAULT_CAN_USE_TOOL_GRANTS_FILE) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 10000
    || ids.some((id) => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))) {
    throw new TypeError('Invalid grant ids');
  }
  const removed = new Set(ids);
  const grants = readGrants(file);
  const remaining = grants.filter((grant) => !removed.has(grant.id));
  writeJsonAtomic(file, remaining);
  return grants.length - remaining.length;
}
