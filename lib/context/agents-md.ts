/**
 * AGENTS.md discovery, delivery decision and path-scoped instruction reads.
 *
 * - **Chain:** AGENTS.md files from the authorized project root down to the cwd
 *   (ancestors stay, the more local file wins on conflict; Cretli does not
 *   resolve semantic conflicts). Other subdirectories are only *indexed*.
 * - **Delivery:** decided per harness by `AGENTS_MD_MATRIX`. Only a confirmed
 *   native read (`native` / `both`) removes the Cretli paste, and only a
 *   confirmed `cretli` channel pastes by default. `unknown` is never injected
 *   automatically; the user may opt in (`mode: 'force'`) and gets a warning.
 * - **Globs:** legacy rule `globs:` are NOT activated by general text. They are
 *   indexed, and applied only to an explicit path (`readInstructionsForPath`).
 *   Without a file-read hook Cretli cannot guarantee activation on every read.
 *
 * Every filesystem access goes through `source-trust.js` (realpath, symlink
 * escape, size limits).
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildRegistryEntryId, computeRegistryContentHash } from './registry-contract.ts';
import {
  assertFileSizeWithinLimit,
  assertPathWithinProjectRoot,
  isInsideTrustedRoot,
  resolveTrustedRoot,
  SOURCE_TRUST_ERROR_CODES,
} from './source-trust.ts';

export const AGENTS_MD_FILE_NAME = 'AGENTS.md';
export const AGENTS_MD_MODES = Object.freeze(['auto', 'off', 'force']);
export const AGENTS_MD_DELIVERY_STATUSES = Object.freeze(['native', 'cretli', 'both', 'unknown']);

/** Subdirectories never indexed for nested AGENTS.md. */
const INDEX_SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.cretli-worktrees']);
const INDEX_MAX_DEPTH = 4;
const INDEX_MAX_DIRS = 300;

/**
 * Confirmed AGENTS.md delivery per harness. `status` is the evidence-backed
 * channel, not what is configured: `settingSources` in an adapter is not proof
 * that the vendor runtime reads AGENTS.md, so every harness stays `unknown`
 * until an adapter test (or a captured run) confirms it. Change a row only
 * together with that evidence.
 *
 */
export const AGENTS_MD_MATRIX: Readonly<Record<string, { status: 'native' | 'cretli' | 'both' | 'unknown', evidence: string }>> = Object.freeze(Object.fromEntries([
  'sdk', 'opencode', 'codex', 'deepseek', 'claude', 'qwen', 'codebuddy', 'openrouter',
  'mimo', 'mistral', 'zai',
].map((id) => [id, Object.freeze({
  status: 'unknown',
  evidence: 'No captured run or adapter test confirms a native AGENTS.md read; settingSources is not proof.',
})])));

export type AgentsMdStatus = 'native' | 'cretli' | 'both' | 'unknown';

export function getAgentsMdDeliveryStatus(
  transport: string,
  matrix: Record<string, { status: string, evidence?: string }> = AGENTS_MD_MATRIX,
): { status: AgentsMdStatus, evidence: string, confirmed: boolean } {
  const row = matrix[String(transport || '').trim().toLowerCase()];
  const status = row && AGENTS_MD_DELIVERY_STATUSES.includes(row.status) ? row.status : 'unknown';
  return {
    status: status as AgentsMdStatus,
    evidence: row?.evidence || 'Harness not in the AGENTS.md matrix.',
    confirmed: status !== 'unknown',
  };
}

/**
 * Whether Cretli itself pastes AGENTS.md for this turn. A confirmed native
 * read never gets a second (pasted) copy, whatever the mode.
 */
export function resolveAgentsMdDelivery(
  input: { transport?: string, mode?: string, matrix?: Record<string, any> } = {},
): { deliver: boolean, reason: string, status: string, confirmed: boolean, warning?: string } {
  const mode = AGENTS_MD_MODES.includes(String(input.mode)) ? String(input.mode) : 'auto';
  const info = getAgentsMdDeliveryStatus(String(input.transport || ''), input.matrix);
  const base = { status: info.status, confirmed: info.confirmed };
  if (mode === 'off') return { ...base, deliver: false, reason: 'disabled' };
  if (info.status === 'native' || info.status === 'both') {
    return { ...base, deliver: false, reason: 'native_confirmed' };
  }
  if (info.status === 'cretli') return { ...base, deliver: true, reason: 'cretli_channel' };
  if (mode === 'force') {
    return {
      ...base,
      deliver: true,
      reason: 'forced_unknown',
      warning: 'agents_md_unknown_forced: delivery path of this harness is unconfirmed; AGENTS.md may reach the model twice.',
    };
  }
  return {
    ...base,
    deliver: false,
    reason: 'unknown_not_injected',
    warning: 'agents_md_unknown_not_injected: harness behaviour is unconfirmed; AGENTS.md is available for explicit read only.',
  };
}

export interface AgentsMdEntry {
  id: string;
  kind: string;
  relPath: string;
  depth: number;
  contentHash: string;
  sizeBytes: number;
  valid: boolean;
  content: string;
  diagnostics: { code: string, message: string }[];
}

/**
 * @param rootForRel Real project root used for relative paths.
 * @returns Entry or null when no AGENTS.md exists.
 */
function readAgentsFile(dir: string, rootReal: string, rootForRel: string): AgentsMdEntry | null {
  const filePath = path.join(dir, AGENTS_MD_FILE_NAME);
  if (!fs.existsSync(filePath)) return null;
  const relPath = path.relative(rootForRel, filePath).split(path.sep).join('/');
  const entry: AgentsMdEntry = {
    id: buildRegistryEntryId('project', relPath, 'instruction' as never),
    kind: 'instruction',
    relPath,
    depth: relPath.split('/').length - 1,
    contentHash: '',
    sizeBytes: 0,
    valid: true,
    content: '',
    diagnostics: [],
  };
  const fail = (code: string, message: string) => {
    entry.valid = false;
    entry.diagnostics.push({ code, message });
  };
  const within = assertPathWithinProjectRoot(rootReal, filePath);
  if (within.ok === false) {
    fail(within.code, within.error);
    return entry;
  }
  const size = assertFileSizeWithinLimit(filePath, 'rule');
  if (size.ok === false) {
    fail(size.code, size.error);
    return entry;
  }
  entry.sizeBytes = size.size;
  try {
    entry.content = fs.readFileSync(filePath, 'utf8');
  } catch {
    fail(SOURCE_TRUST_ERROR_CODES.MISSING, 'File not readable');
    return entry;
  }
  entry.contentHash = computeRegistryContentHash(entry.content);
  return entry;
}

/**
 * AGENTS.md files from the project root to `cwd`, general first, most local last.
 * A cwd outside the authorized root is ignored (chain = root only) with a warning.
 *
 * @param projectRoot Authorized project root (never a client path).
 * @param cwd Directory the chat runs in; defaults to the root.
 */
export function collectAgentsMdChain(
  projectRoot: string,
  cwd?: string,
): { entries: AgentsMdEntry[], warnings: string[], projectRootReal: string, cwdRel: string } {
  const rootReal = resolveTrustedRoot(projectRoot);
  const warnings: string[] = [];
  if (!rootReal) return { entries: [], warnings: ['agents_md_invalid_root'], projectRootReal: '', cwdRel: '' };
  let cwdReal = cwd ? resolveTrustedRoot(cwd) : rootReal;
  if (!cwdReal || !isInsideTrustedRoot(rootReal, cwdReal)) {
    if (cwd) warnings.push('agents_md_cwd_outside_root: using the project root only');
    cwdReal = rootReal;
  }
  const rel = path.relative(rootReal, cwdReal);
  const segments = rel ? rel.split(path.sep) : [];
  const dirs = [rootReal];
  for (const segment of segments) dirs.push(path.join(dirs[dirs.length - 1], segment));
  const entries: AgentsMdEntry[] = [];
  for (const dir of dirs) {
    const entry = readAgentsFile(dir, rootReal, rootReal);
    if (!entry) continue;
    if (!entry.valid) warnings.push(`agents_md_invalid: ${entry.relPath} (${entry.diagnostics.map((d) => d.code).join(',')})`);
    entries.push(entry);
  }
  return { entries, warnings, projectRootReal: rootReal, cwdRel: rel.split(path.sep).join('/') };
}

/**
 * Nested AGENTS.md below `cwd` as an index of scopes (no content is loaded).
 */
export function indexNestedAgentsMd(
  projectRoot: string,
  cwd?: string,
): { scopes: { dir: string, relPath: string, contentHash: string, sizeBytes: number, valid: boolean }[], truncated: boolean } {
  const rootReal = resolveTrustedRoot(projectRoot);
  if (!rootReal) return { scopes: [], truncated: false };
  let startReal = cwd ? resolveTrustedRoot(cwd) : rootReal;
  if (!startReal || !isInsideTrustedRoot(rootReal, startReal)) startReal = rootReal;
  const scopes: { dir: string, relPath: string, contentHash: string, sizeBytes: number, valid: boolean }[] = [];
  let visited = 0;
  let truncated = false;
  const walk = (dir: string, depth: number): void => {
    if (depth > INDEX_MAX_DEPTH) return;
    let dirents: fs.Dirent[] = [];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of dirents) {
      // Symlinked directories report isSymbolicLink(), so they are never followed.
      if (!dirent.isDirectory() || INDEX_SKIP_DIRS.has(dirent.name)) continue;
      if (visited >= INDEX_MAX_DIRS) {
        truncated = true;
        return;
      }
      visited += 1;
      const full = path.join(dir, dirent.name);
      const entry = readAgentsFile(full, rootReal, rootReal);
      if (entry) {
        scopes.push({
          dir: path.relative(rootReal, full).split(path.sep).join('/'),
          relPath: entry.relPath,
          contentHash: entry.contentHash,
          sizeBytes: entry.sizeBytes,
          valid: entry.valid,
        });
      }
      walk(full, depth + 1);
      if (truncated) return;
    }
  };
  walk(startReal, 0);
  return { scopes, truncated };
}

/**
 * Prompt block for the delivered chain; general files first.
 */
export function renderAgentsMdBlock(entries: { relPath: string, content: string, valid?: boolean }[]): string {
  const valid = entries.filter((entry) => entry.valid !== false && String(entry.content || '').trim());
  if (valid.length === 0) return '';
  const chunks = valid.map((entry) => `### ${entry.relPath}\n${entry.content.trim()}`);
  return [
    '[AGENTS.MD INSTRUCTIONS]',
    'Listed from the project root to the working directory; on conflict the more local file (later) takes precedence.',
    ...chunks,
  ].join('\n\n');
}

/**
 * The block Cretli adds to the prompt for this turn, plus the decision.
 */
export function buildAgentsMdPromptBlock(input: {
  projectRoot?: string;
  cwd?: string;
  transport?: string;
  mode?: string;
  matrix?: Record<string, any>;
}): { text: string, entryIds: string[], delivery: ReturnType<typeof resolveAgentsMdDelivery>, warnings: string[] } {
  const delivery = resolveAgentsMdDelivery(input);
  const warnings: string[] = delivery.warning ? [delivery.warning] : [];
  if (!delivery.deliver) return { text: '', entryIds: [], delivery, warnings };
  const chain = collectAgentsMdChain(String(input.projectRoot || input.cwd || ''), input.cwd);
  warnings.push(...chain.warnings);
  const text = renderAgentsMdBlock(chain.entries);
  const entryIds = chain.entries.filter((entry) => entry.valid).map((entry) => entry.id);
  return { text, entryIds, delivery, warnings };
}

/**
 * Translate a legacy `globs:` pattern into a RegExp. A pattern without `/`
 * matches the base name at any depth (gitignore-style).
 */
export function globToRegExp(glob: string): RegExp | null {
  const raw = String(glob || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!raw || raw.length > 256) return null;
  let out = '';
  let braceDepth = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '*') {
      if (raw[i + 1] === '*') {
        i += 1;
        if (raw[i + 1] === '/') {
          i += 1;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') out += '[^/]';
    else if (ch === '{') {
      braceDepth += 1;
      out += '(?:';
    } else if (ch === '}' && braceDepth > 0) {
      braceDepth -= 1;
      out += ')';
    } else if (ch === ',' && braceDepth > 0) out += '|';
    else out += ch.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  if (braceDepth > 0) return null;
  const anchored = raw.includes('/') ? out : `(?:.*/)?${out}`;
  try {
    return new RegExp(`^${anchored}$`);
  } catch {
    return null;
  }
}

/**
 * @param relPath Project-relative POSIX path.
 */
export function matchesAnyGlob(globs: string[], relPath: string): boolean {
  const target = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  return globs.some((glob) => {
    const re = globToRegExp(glob);
    return re ? re.test(target) : false;
  });
}

/**
 * Parse a rule frontmatter `globs` value (string with commas, or list).
 */
export function parseGlobsValue(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const out: string[] = [];
  for (const item of list) {
    // Split on commas outside braces so `*.{ts,js}` stays one pattern.
    let depth = 0;
    let current = '';
    for (const ch of String(item)) {
      if (ch === '{') depth += 1;
      if (ch === '}') depth = Math.max(0, depth - 1);
      if (ch === ',' && depth === 0) {
        if (current.trim()) out.push(current.trim());
        current = '';
      } else current += ch;
    }
    if (current.trim()) out.push(current.trim());
  }
  return out;
}

/**
 * Rules that carry `globs` and are not alwaysApply: the structural scope index.
 * Metadata only, no bodies.
 */
export function buildGlobScopeIndex(
  registry: { entries: any[], getRuleMeta: (id: string) => any },
): { id: string, relPath: string, source: string, globs: string[] }[] {
  const out: { id: string, relPath: string, source: string, globs: string[] }[] = [];
  for (const entry of registry.entries) {
    if (entry.kind !== 'rule' || entry.scope !== 'project' || !entry.valid) continue;
    const meta = registry.getRuleMeta(entry.id);
    const globs = Array.isArray(meta?.globs) ? meta.globs : [];
    if (globs.length === 0 || meta?.alwaysApply) continue;
    out.push({ id: entry.id, relPath: entry.relPath, source: entry.source, globs });
  }
  return out;
}

/**
 * Explicit read of the instructions that apply to one file: AGENTS.md from the
 * root down to the file's directory plus project rules whose globs match.
 * `relPath` is validated against the authorized root (traversal and symlink
 * escapes are rejected).
 */
export function readInstructionsForPath(input: {
  projectRoot: string;
  relPath: string;
  registry: { entries: any[], getRuleMeta: (id: string) => any, getBody: (id: string) => string };
}): { ok: true, path: string, agents: Record<string, any>[], rules: Record<string, any>[], warnings: string[], note: string }
  | { ok: false, code: string, error: string } {
  const rootReal = resolveTrustedRoot(input.projectRoot);
  const rel = String(input.relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const within = assertPathWithinProjectRoot(rootReal, rel);
  if (within.ok === false) return { ok: false, code: within.code, error: within.error };
  const relNormalized = path.relative(rootReal, within.resolvedReal).split(path.sep).join('/');
  let dir = within.resolvedReal;
  try {
    if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
  } catch {
    dir = path.dirname(dir);
  }
  const chain = collectAgentsMdChain(rootReal, dir);
  const rules: Record<string, any>[] = [];
  for (const entry of input.registry.entries) {
    if (entry.kind !== 'rule' || entry.scope !== 'project' || !entry.valid) continue;
    const meta = input.registry.getRuleMeta(entry.id);
    if (!meta?.globs?.length || !matchesAnyGlob(meta.globs, relNormalized)) continue;
    rules.push({
      id: entry.id,
      relPath: entry.relPath,
      globs: meta.globs,
      contentHash: entry.contentHash,
      body: input.registry.getBody(entry.id),
    });
  }
  return {
    ok: true,
    path: relNormalized,
    agents: chain.entries.map((entry) => ({
      id: entry.id,
      relPath: entry.relPath,
      valid: entry.valid,
      contentHash: entry.contentHash,
      content: entry.valid ? entry.content : '',
    })),
    rules,
    warnings: chain.warnings,
    note: 'Explicit read. Cretli does not guarantee automatic activation of these instructions when a harness reads a file.',
  };
}
