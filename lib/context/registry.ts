/**
 * Shared static context registry: rules, skills, commands and agents.
 *
 * One scan feeds the picker/API (`getCursorContext`) and the registry-based
 * prompt assembler, so both see the same entries, IDs and diagnostics.
 *
 * - **Identity:** stable ID = source label + relative path + kind
 *   (`buildRegistryEntryId`); the SHA-256 of the file is the entry *version*.
 * - **Trust:** every directory and file goes through `source-trust.js`
 *   (realpath, symlink escape, per-kind size limits). Escapes are reported as
 *   diagnostics and never read.
 * - **Validation:** invalid entries (unreadable, too large, malformed
 *   frontmatter, bad skill name) stay in the registry with `valid: false` and
 *   diagnostics, but are never executable: the assembler skips them.
 * - **Collisions:** two skills/commands/agents with the same call name in one
 *   source are both marked `ambiguous` with an error diagnostic. Nothing is
 *   hidden; name-based resolution refuses an ambiguous name, an explicit ID
 *   still reaches the entry.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  buildRegistryEntryId,
  computeRegistryContentHash,
  NAME_RESOLUTION_ORDER,
} from './registry-contract.ts';
import {
  assertFileSizeWithinLimit,
  assertPathWithinProjectRoot,
  resolveTrustedRoot,
  SOURCE_TRUST_ERROR_CODES,
} from './source-trust.ts';
import {
  frontmatterString,
  oneLineFrontmatterValue,
  parseFrontmatterChecked,
} from '../skills/frontmatter.js';
import { resolveCursorRuleScope } from '../sdk/shared-cursor-context.ts';
import { parseGlobsValue } from './agents-md.ts';

/** Bump when registry composition rules change; part of the epoch hash. */
export const REGISTRY_SCHEMA_VERSION = 1;

export const REGISTRY_SCOPES = Object.freeze(['project', 'shared', 'user', 'bundled']);

/** Diagnostic codes that mean the entry must not be listed or read at all. */
const TRUST_REJECTION_CODES = new Set([
  SOURCE_TRUST_ERROR_CODES.OUTSIDE_ROOT,
  SOURCE_TRUST_ERROR_CODES.TRAVERSAL,
  SOURCE_TRUST_ERROR_CODES.SYMLINK_ESCAPE,
]);

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const MAX_DESCRIPTION_CHARS = 1000;

/**
 * Directory layout per source: where each kind lives, relative to the source
 * root. Skills may live in several roots (first listed wins in legacy lists).
 */
const FULL_LAYOUT = Object.freeze({
  rule: ['.cursor/rules'],
  command: ['.cursor/commands'],
  skill: ['.agents/skills', '.cursor/skills'],
  agent: ['.cursor/agents'],
});
const SKILLS_AGENTS_LAYOUT = Object.freeze({
  skill: ['.agents/skills', '.cursor/skills'],
  agent: ['.cursor/agents'],
});
const USER_LAYOUT = Object.freeze({
  skill: ['.agents/skills', '.cursor/skills-cursor'],
  agent: ['.cursor/agents'],
});

export type RegistryDiagnostic = { code: string, severity: 'error' | 'warning', message: string };

export interface RegistryEntry {
  /** Stable ID (source + relPath + kind), independent of content. */
  id: string;
  kind: 'rule' | 'skill' | 'command' | 'agent';
  /** Source label: project, bundled, shared:<dir>, user. */
  source: string;
  scope: 'project' | 'shared' | 'user' | 'bundled';
  /** Path relative to the source root (project: the cwd). */
  relPath: string;
  /** Name used to invoke the entry. */
  callName: string;
  /** Name shown by the legacy lists. */
  listName: string;
  description: string;
  /** SHA-256 of the file (the entry version); '' when unread. */
  contentHash: string;
  sizeBytes: number;
  /** False entries are visible but never executed. */
  valid: boolean;
  /** True when the call name collides inside the source. */
  ambiguous: boolean;
  diagnostics: RegistryDiagnostic[];
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function toPosix(value: string): string {
  return String(value).replace(/\\/g, '/');
}

function shortHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 8);
}

/**
 * Per-file facts a kind needs beyond the common record.
 */
function describeByKind(
  kind: RegistryEntry['kind'],
  fileName: string,
  dirName: string,
  frontmatter: Record<string, unknown> | null,
): { callName: string, listName: string, description: string, diagnostics: RegistryDiagnostic[] } {
  const diagnostics: RegistryDiagnostic[] = [];
  const declaredName = oneLineFrontmatterValue(frontmatterString(frontmatter, 'name'));
  const description = oneLineFrontmatterValue(frontmatterString(frontmatter, 'description'))
    .slice(0, MAX_DESCRIPTION_CHARS);
  const stem = fileName.replace(/\.(md|mdc)$/, '');
  if (kind === 'skill') {
    const callName = declaredName || dirName;
    if (!SKILL_NAME_PATTERN.test(callName)) {
      diagnostics.push({ code: 'invalid_name', severity: 'error', message: `Invalid skill name "${callName}"` });
    }
    if (declaredName && declaredName !== dirName) {
      diagnostics.push({
        code: 'name_folder_mismatch',
        severity: 'warning',
        message: `Frontmatter name "${declaredName}" differs from folder "${dirName}"`,
      });
    }
    return { callName, listName: dirName, description, diagnostics };
  }
  if (kind === 'agent') return { callName: declaredName || stem, listName: stem, description, diagnostics };
  if (kind === 'command') return { callName: declaredName || stem, listName: fileName, description, diagnostics };
  return { callName: declaredName || stem, listName: fileName, description, diagnostics };
}

/**
 * Read one candidate file into a registry entry (or a trust rejection).
 *
 * `dirName` is the containing folder name (skills).
 */
function readEntry({ source, kind, absPath, dirName, internal }: {
  source: { label: string, scope: RegistryEntry['scope'], root: string, trustRootReal: string };
  kind: RegistryEntry['kind'];
  absPath: string;
  dirName: string;
  internal: Map<string, any>;
}): RegistryEntry {
  const relPath = toPosix(path.relative(source.root, absPath));
  const id = buildRegistryEntryId(source.label, relPath, kind);
  const fileName = path.basename(absPath);
  const entry: RegistryEntry = {
    id,
    kind,
    source: source.label,
    scope: source.scope,
    relPath,
    // Provisional names, overwritten once the file is read; a rejected entry keeps them.
    callName: kind === 'skill' ? dirName : fileName.replace(/\.(md|mdc)$/, ''),
    listName: kind === 'skill' ? dirName : fileName,
    description: '',
    contentHash: '',
    sizeBytes: 0,
    valid: true,
    ambiguous: false,
    diagnostics: [],
  };
  const fail = (code: string, message: string) => {
    entry.valid = false;
    entry.diagnostics.push({ code, severity: 'error', message });
  };

  const within = assertPathWithinProjectRoot(source.trustRootReal, absPath);
  if (within.ok === false) {
    fail(within.code, within.error);
    return entry;
  }
  const size = assertFileSizeWithinLimit(absPath, kind);
  if (size.ok === false) {
    fail(size.code, size.error);
    return entry;
  }
  entry.sizeBytes = size.size;
  let content = '';
  try {
    content = fs.readFileSync(absPath, 'utf8');
  } catch {
    fail(SOURCE_TRUST_ERROR_CODES.MISSING, 'File not readable');
    return entry;
  }
  entry.contentHash = computeRegistryContentHash(content);
  const checked = parseFrontmatterChecked(content);
  if (checked.status === 'malformed' || checked.status === 'too_large') {
    fail(checked.status === 'too_large' ? 'frontmatter_too_large' : 'malformed_frontmatter', checked.error || 'Invalid frontmatter');
  }
  const described = describeByKind(kind, fileName, dirName, checked.data);
  entry.callName = described.callName;
  entry.listName = described.listName;
  entry.description = described.description;
  for (const diagnostic of described.diagnostics) {
    entry.diagnostics.push(diagnostic);
    if (diagnostic.severity === 'error') entry.valid = false;
  }
  const frontmatter = checked.data || {};
  internal.set(id, {
    content,
    body: checked.body,
    alwaysApply: frontmatter.alwaysApply === true
      || frontmatterString(frontmatter, 'alwaysApply').trim().toLowerCase() === 'true',
    scope: kind === 'rule' ? resolveCursorRuleScope(frontmatter) : null,
    globs: kind === 'rule' ? parseGlobsValue(frontmatter.globs) : [],
    absPath,
  });
  return entry;
}

/**
 * Candidate files of one kind under one layout directory.
 */
function listCandidates(kind: RegistryEntry['kind'], dir: string): { absPath: string, dirName: string }[] {
  if (!isDirectory(dir)) return [];
  const out: { absPath: string, dirName: string }[] = [];
  if (kind === 'skill') {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).sort();
    } catch {
      return out;
    }
    for (const name of names) {
      const folder = path.join(dir, name);
      if (!isDirectory(folder)) continue;
      const skillFile = path.join(folder, 'SKILL.md');
      try {
        if (!fs.statSync(skillFile).isFile()) continue;
      } catch {
        continue;
      }
      out.push({ absPath: skillFile, dirName: name });
    }
    return out;
  }
  const recursive = kind === 'rule';
  const walk = (current: string): void => {
    let dirents: fs.Dirent[] = [];
    try {
      dirents = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of dirents) {
      const full = path.join(current, dirent.name);
      if (dirent.isDirectory()) {
        if (recursive) walk(full);
        continue;
      }
      if (!dirent.isFile()) continue;
      if (!(dirent.name.endsWith('.md') || dirent.name.endsWith('.mdc'))) continue;
      out.push({ absPath: full, dirName: '' });
    }
  };
  walk(dir);
  return out;
}

/**
 * Mark entries that share a call name inside one source (skills, commands,
 * agents). Rules are not invoked by name, so equal file names stay distinct.
 */
function markCollisions(entries: RegistryEntry[]): void {
  const groups = new Map<string, RegistryEntry[]>();
  for (const entry of entries) {
    if (entry.kind === 'rule' || !isListableEntry(entry) || !entry.callName) continue;
    const key = `${entry.kind}|${entry.source}|${entry.callName.toLowerCase()}`;
    const list = groups.get(key) || [];
    list.push(entry);
    groups.set(key, list);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const entry of group) {
      entry.ambiguous = true;
      const others = group.filter((other) => other !== entry).map((other) => other.relPath);
      entry.diagnostics.push({
        code: 'duplicate_name',
        severity: 'error',
        message: `Call name "${entry.callName}" is also used by ${others.join(', ')}; select by ID`,
      });
    }
  }
}

/**
 * Unique source labels: `shared:<basename>`; a later directory with the same
 * basename gets a short path hash so IDs never collide.
 */
function sharedLabels(dirs: string[]): string[] {
  const used = new Set<string>();
  return dirs.map((dir) => {
    const base = `shared:${path.basename(dir)}`;
    const label = used.has(base) ? `${base}~${shortHash(dir)}` : base;
    used.add(label);
    return label;
  });
}

/**
 * Public record without internals.
 */
export function toPublicRegistryEntry(entry: RegistryEntry): Record<string, any> {
  return {
    id: entry.id,
    kind: entry.kind,
    source: entry.source,
    scope: entry.scope,
    relPath: entry.relPath,
    callName: entry.callName,
    description: entry.description,
    contentHash: entry.contentHash,
    sizeBytes: entry.sizeBytes,
    valid: entry.valid,
    ambiguous: entry.ambiguous,
    diagnostics: entry.diagnostics.map((item) => ({ ...item })),
  };
}

/**
 * Build the registry for one authorized scope.
 *
 * @param workspaceDir The chat cwd; project entries are relative to it.
 * @param options `additionalDirs` are host-configured shared roots; widgets get none.
 */
export function buildContextRegistry(
  workspaceDir: string,
  options: {
    projectRoot?: string;
    audience?: 'host' | 'widget';
    additionalDirs?: string[];
    bundledRoot?: string;
    homeDir?: string;
  } = {},
): {
  entries: RegistryEntry[];
  diagnostics: { source: string, relPath: string, code: string, message: string }[];
  epoch: string;
  contentRevision: string;
  projectRoot: string;
  sourceRoots: Map<string, string>;
  getContent: (id: string) => string;
  getBody: (id: string) => string;
  getAbsPath: (id: string) => string;
  getRuleMeta: (id: string) => { alwaysApply: boolean, scope: any, globs: string[] } | null;
} {
  const audience = options.audience === 'widget' ? 'widget' : 'host';
  const projectDir = workspaceDir ? path.resolve(workspaceDir) : '';
  const projectRootInput = options.projectRoot ? path.resolve(String(options.projectRoot)) : projectDir;
  const sharedDirs = audience === 'widget' ? [] : (options.additionalDirs || []).map((dir) => path.resolve(dir));
  const labels = sharedLabels(sharedDirs);

  const sources: { label: string, scope: RegistryEntry['scope'], root: string, trustRootReal: string, layout: Record<string, readonly string[]> }[] = [];
  if (projectDir) {
    sources.push({
      label: 'project',
      scope: 'project',
      root: projectDir,
      trustRootReal: resolveTrustedRoot(projectRootInput),
      layout: FULL_LAYOUT,
    });
  }
  if (options.bundledRoot) {
    const root = path.resolve(options.bundledRoot);
    sources.push({ label: 'bundled', scope: 'bundled', root, trustRootReal: resolveTrustedRoot(root), layout: SKILLS_AGENTS_LAYOUT });
  }
  sharedDirs.forEach((dir, index) => {
    sources.push({ label: labels[index], scope: 'shared', root: dir, trustRootReal: resolveTrustedRoot(dir), layout: FULL_LAYOUT });
  });
  if (audience === 'host' && options.homeDir) {
    const root = path.resolve(options.homeDir);
    sources.push({ label: 'user', scope: 'user', root, trustRootReal: resolveTrustedRoot(root), layout: USER_LAYOUT });
  }

  const entries: RegistryEntry[] = [];
  const diagnostics: { source: string, relPath: string, code: string, message: string }[] = [];
  const internal = new Map<string, any>();
  const sourceRoots = new Map<string, string>();

  for (const source of sources) {
    sourceRoots.set(source.label, source.root);
    const sourceEntries: RegistryEntry[] = [];
    for (const [kind, relDirs] of Object.entries(source.layout)) {
      for (const relDir of relDirs) {
        const dir = path.join(source.root, relDir);
        if (!source.trustRootReal || !isDirectory(dir)) continue;
        const dirCheck = assertPathWithinProjectRoot(source.trustRootReal, dir);
        if (dirCheck.ok === false) {
          diagnostics.push({ source: source.label, relPath: relDir, code: dirCheck.code, message: dirCheck.error });
          continue;
        }
        for (const candidate of listCandidates(kind as RegistryEntry['kind'], dir)) {
          sourceEntries.push(readEntry({
            source,
            kind: kind as RegistryEntry['kind'],
            absPath: candidate.absPath,
            dirName: candidate.dirName,
            internal,
          }));
        }
      }
    }
    markCollisions(sourceEntries);
    entries.push(...sourceEntries);
  }

  for (const entry of entries) {
    for (const diagnostic of entry.diagnostics) {
      diagnostics.push({ source: entry.source, relPath: entry.relPath, code: diagnostic.code, message: diagnostic.message });
    }
  }

  const epoch = crypto.createHash('sha256')
    .update(`v${REGISTRY_SCHEMA_VERSION}|${audience}|${sources.map((source) => source.label).join(',')}`)
    .digest('hex')
    .slice(0, 16);
  const contentRevision = crypto.createHash('sha256')
    .update(entries.map((entry) => `${entry.id}@${entry.contentHash}:${entry.valid ? 1 : 0}`).sort().join('\n'))
    .digest('hex')
    .slice(0, 16);

  return {
    entries,
    diagnostics,
    epoch,
    contentRevision,
    projectRoot: projectRootInput,
    sourceRoots,
    getContent: (id: string) => internal.get(id)?.content || '',
    getBody: (id: string) => internal.get(id)?.body || '',
    getAbsPath: (id: string) => internal.get(id)?.absPath || '',
    getRuleMeta: (id: string) => {
      const meta = internal.get(id);
      return meta ? { alwaysApply: meta.alwaysApply, scope: meta.scope, globs: meta.globs || [] } : null;
    },
  };
}

/**
 * Entries the legacy lists show: everything except trust-rejected files.
 * Invalid entries stay visible (with `valid: false`), rejected ones are only
 * reported through the registry diagnostics.
 */
export function isListableEntry(entry: RegistryEntry): boolean {
  return !entry.diagnostics.some((item) => (TRUST_REJECTION_CODES as Set<string>).has(item.code));
}

/**
 * Rank of a source for `@name` resolution: lower wins. Mirrors
 * `NAME_RESOLUTION_ORDER` (project → shared → user → bundled).
 */
export function nameResolutionRank(scope: RegistryEntry['scope']): number {
  const order: Record<string, number> = { project: 0, shared: 1, user: 2, bundled: 3 };
  return order[scope] ?? 9;
}

/**
 * Resolve an ambiguous `@name` to one entry. An explicit ID bypasses the name
 * table. A name that collides inside the winning source is reported as
 * ambiguous instead of picking one: the caller must select by ID.
 */
export function resolveEntryByName(
  registry: { entries: RegistryEntry[] },
  name: string,
  options: { kind?: RegistryEntry['kind'], explicitId?: string } = {},
): { entry: RegistryEntry | null, ambiguous: boolean, candidates: RegistryEntry[], via: string } {
  if (options.explicitId) {
    const entry = registry.entries.find((item) => item.id === options.explicitId) || null;
    return { entry, ambiguous: false, candidates: entry ? [entry] : [], via: NAME_RESOLUTION_ORDER[0] };
  }
  const wanted = String(name || '').toLowerCase();
  const candidates = registry.entries.filter((entry) => isListableEntry(entry)
    && (!options.kind || entry.kind === options.kind) && entry.callName.toLowerCase() === wanted);
  if (candidates.length === 0) return { entry: null, ambiguous: false, candidates, via: '' };
  const bestRank = Math.min(...candidates.map((entry) => nameResolutionRank(entry.scope)));
  const tier = candidates.filter((entry) => nameResolutionRank(entry.scope) === bestRank);
  const firstSource = tier[0].source;
  const sameSource = tier.filter((entry) => entry.source === firstSource);
  if (sameSource.length > 1 || sameSource[0].ambiguous || !sameSource[0].valid) {
    return { entry: null, ambiguous: sameSource.length > 1 || sameSource[0].ambiguous, candidates, via: '' };
  }
  const via = ['nearest_project_entry', 'assigned_shared_ordered', 'user_sources', 'bundled'][bestRank] || '';
  return { entry: sameSource[0], ambiguous: false, candidates, via };
}
