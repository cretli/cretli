/** Lossless authorization scope derived from a verified Git patch artifact. */
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { logSlowGitCall, runGitAsync } from './git-worktree.ts';

/** Decode Git's C-style quoting, including octal-escaped UTF-8 bytes. */
function decodePath(value: string): string {
  if (!value.startsWith('"')) return value;
  if (!value.endsWith('"')) throw new Error('Incomplete quoted patch path');
  const bytes: number[] = [];
  const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  const content = value.slice(1, -1);
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] !== '\\') {
      const character = String.fromCodePoint(content.codePointAt(i) as number);
      bytes.push(...Buffer.from(character));
      i += character.length - 1;
      continue;
    }
    const octal = content.slice(i + 1).match(/^[0-7]{1,3}/)?.[0];
    if (octal) {
      bytes.push(parseInt(octal, 8));
      i += octal.length;
    } else {
      const escaped = content[++i];
      if (!(escaped in escapes)) throw new Error('Invalid patch path escape');
      bytes.push(escapes[escaped]);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Unquoted Git names may contain spaces, so ordinary token splitting is unsafe. */
function readDiffPaths(header: string): [string, string] {
  const firstQuoted = header.match(/^"(?:[^"\\]|\\.)*"/);
  if (firstQuoted) return [decodePath(firstQuoted[0]).slice(2), decodePath(header.slice(firstQuoted[0].length + 1)).slice(2)];
  const candidates = [...header.matchAll(/ (?=b\/|"b\/)/g)].map((match) => match.index);
  const split = candidates.find((index) => header.slice(2, index) === decodePath(header.slice(index + 1)).slice(2));
  const index = split ?? candidates[0];
  if (index === undefined || !header.startsWith('a/')) throw new Error('Invalid diff header');
  return [header.slice(2, index), decodePath(header.slice(index + 1)).slice(2)];
}

export interface PatchScopeEntry {
  path: string;
  oldPath?: string;
  status: string;
  mode?: string;
  binary: boolean;
}

/**
 * Parse only extended/file headers before the first hunk or binary payload.
 * Rename/copy headers override the potentially ambiguous unquoted diff header.
 */
export function parsePatchScope(patch: string): PatchScopeEntry[] {
  const files: PatchScopeEntry[] = [];
  let entry: PatchScopeEntry | null = null;
  let inHeaders = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const [oldPath, filePath] = readDiffPaths(line.slice(11));
      entry = { path: filePath, status: 'M', binary: false };
      if (oldPath !== filePath) entry.oldPath = oldPath;
      files.push(entry);
      inHeaders = true;
      continue;
    }
    if (!entry || !inHeaders) continue;
    if (line.startsWith('@@')) { inHeaders = false; continue; }
    if (line === 'GIT binary patch' || line.startsWith('Binary files ')) {
      entry.binary = true;
      inHeaders = false;
    } else if (line.startsWith('rename from ') || line.startsWith('copy from ')) {
      entry.oldPath = decodePath(line.slice(line.indexOf(' from ') + 6));
      entry.status = line.startsWith('rename') ? 'R' : 'C';
    } else if (line.startsWith('rename to ') || line.startsWith('copy to ')) {
      entry.path = decodePath(line.slice(line.indexOf(' to ') + 4));
    } else if (line.startsWith('new file mode ')) {
      entry.status = 'A';
      entry.mode = line.slice(14);
    } else if (line.startsWith('deleted file mode ')) {
      entry.status = 'D';
      entry.mode = line.slice(18);
    } else if (line.startsWith('new mode ')) {
      entry.mode = line.slice(9);
    } else if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const value = line.slice(4).replace(/\t$/, '');
      if (value === '/dev/null') continue;
      const filePath = decodePath(value).slice(2);
      if (line.startsWith('+++ ') || entry.status === 'D') entry.path = filePath;
    }
  }
  return files;
}

/** Atomically replace a derived sidecar; a UUID keeps concurrent writers separate. */
function writeScopeArtifact(patchPath: string, payload: unknown): string {
  const scopePath = `${patchPath}.files.json`;
  const temporaryPath = `${scopePath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(payload, null, 2));
    fs.renameSync(temporaryPath, scopePath);
    return scopePath;
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

/** Preserve overflow conflict hints even when the authorization scope is unavailable. */
export function writePatchConflicts(
  result: { patchPath?: string },
  conflicts: string[],
): string | null {
  if (!result.patchPath) return null;
  try {
    return writeScopeArtifact(result.patchPath, { patchSha256: null, files: [], conflicts, scopeUnavailable: true });
  } catch {
    return null;
  }
}

/** Shared tail: reject a patch whose numstat disagrees with the parsed header scope. */
function assertNumstatMatches(numstat: string, files: PatchScopeEntry[]): void {
  const sizes = numstat.split('\0').filter(Boolean);
  if (sizes.some((size) => !/^(?:\d+|-)\t(?:\d+|-)\t/.test(size)) || sizes.length !== files.length) throw new Error('Patch size cross-check failed');
}

/**
 * Hash before parsing; numstat is only a size cross-check, never a path oracle.
 * A failed read, parse, cross-check or atomic write selects the best-effort fallback.
 * Synchronous (blocks the event loop); server paths use {@link writePatchScopeAsync}.
 */
export function writePatchScope(
  result: { patchPath?: string; patchSha256?: string },
  conflicts: string[] = [],
): string | null {
  try {
    const patch = fs.readFileSync(result.patchPath as string);
    const patchSha256 = createHash('sha256').update(patch).digest('hex');
    if (!result.patchSha256 || patchSha256 !== result.patchSha256) return null;
    const files = parsePatchScope(patch.toString('utf8'));
    const startedAt = Date.now();
    const numstat = patch.length ? execFileSync('git', ['apply', '--numstat', '-z'], { input: patch, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }) : '';
    logSlowGitCall(['apply', '--numstat'], path.dirname(result.patchPath as string), Date.now() - startedAt, 'sync');
    assertNumstatMatches(numstat, files);
    return writeScopeArtifact(result.patchPath as string, { patchSha256, files, conflicts });
  } catch {
    return null;
  }
}

/** Non-blocking twin of {@link writePatchScope}: same fallback contract, async git. */
export async function writePatchScopeAsync(
  result: { patchPath?: string; patchSha256?: string },
  conflicts: string[] = [],
): Promise<string | null> {
  try {
    const patch = await fs.promises.readFile(result.patchPath as string);
    const patchSha256 = createHash('sha256').update(patch).digest('hex');
    if (!result.patchSha256 || patchSha256 !== result.patchSha256) return null;
    const files = parsePatchScope(patch.toString('utf8'));
    const numstat = patch.length
      ? (await runGitAsync(['apply', '--numstat', '-z'], path.dirname(result.patchPath as string), { input: patch, maxBuffer: 64 * 1024 * 1024 })).stdout
      : '';
    assertNumstatMatches(numstat, files);
    return writeScopeArtifact(result.patchPath as string, { patchSha256, files, conflicts });
  } catch {
    return null;
  }
}
