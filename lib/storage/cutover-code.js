/**
 * Code side of the history cutover (stage 3 preparation; docs/storage-pre-cutover-runbook.md).
 *
 * `planCodeCandidates` derives, per path, what the reviewed worktree would change in a main checkout whose HEAD and
 * working tree may have moved: a three-way decision over base / worktree / main (never a git merge, never a commit).
 * `applyCodeCandidates` publishes the candidates file by file with a rollback checkpoint and a recoverable journal,
 * and refuses when any target changed since the plan. Protected (user-dirty) paths are hashed and never written.
 *
 * Reads only repository code. It is used by an operator, never by the server.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HistoryMigrationError, refuse } from './history-legacy-format.js';
import { digestCanonical } from './history-sidecar.js';
import { fsyncDirectory, lstatOrNull, replaceOwnFileDurable } from './history-migration-fs.js';

export const CODE_MANIFEST_SCHEMA = 'cretli-cutover-code-manifest-v1';
export const CODE_JOURNAL_SCHEMA = 'cretli-cutover-code-journal-v1';
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
/** Paths never taken from a worktree, whatever git says (runtime data and build output). */
const ALWAYS_EXCLUDED_PREFIXES = Object.freeze(['.git/', 'data/', 'node_modules/', 'public/dist/']);

/** @param {Buffer | string} bytes @returns {string} */
export const sha256Of = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** @param {string} root @param {string[]} args @returns {Buffer} */
function git(root, args) {
  // Command-scoped trust of exactly this root (resolved, no wildcard): a minimal-environment operator process may run as a
  // different uid than the checkout owner, and git refuses such a repository ("dubious ownership") without it.
  const canonicalRoot = fs.realpathSync(root);
  return execFileSync('git', ['-c', `safe.directory=${canonicalRoot}`, '-C', canonicalRoot, ...args], { maxBuffer: GIT_MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
}

/** @param {string} root @param {string} rev @param {string} file @returns {Buffer | null} */
function gitShowOrNull(root, rev, file) {
  try {
    return git(root, ['show', `${rev}:${file}`]);
  } catch {
    return null;
  }
}

/**
 * @param {string} file
 * @returns {{ buf: Buffer, sha256: string, mode: number } | null} null when the path does not exist
 */
function readRegularOrNull(file) {
  const stat = lstatOrNull(file);
  if (!stat) return null;
  if (!stat.isFile()) refuse('code_path_not_regular', 'A scoped path is a symlink or not a regular file', { path: path.basename(file) });
  const buf = fs.readFileSync(file);
  return { buf, sha256: sha256Of(buf), mode: stat.mode & 0o777 };
}

/** @param {string} rel @returns {void} */
function assertSafeRelativePath(rel) {
  const normal = path.posix.normalize(rel);
  if (!rel || normal !== rel || rel.startsWith('/') || rel.startsWith('../') || rel === '..' || rel.includes('\0')) {
    refuse('code_path_invalid', 'A scoped path is not a clean relative path', { path: rel });
  }
}

/**
 * Paths the worktree changes relative to its own HEAD (modified, added, deleted, untracked; ignored files excluded).
 *
 * @param {string} codeRoot
 * @returns {string[]}
 */
export function listWorktreeChanges(codeRoot) {
  const raw = git(codeRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']).toString('utf8');
  const paths = [];
  for (const record of raw.split('\0')) {
    if (record.length < 4) continue;
    paths.push(record.slice(3));
  }
  return [...new Set(paths)].filter((rel) => !ALWAYS_EXCLUDED_PREFIXES.some((prefix) => rel.startsWith(prefix))).sort();
}

/**
 * Three-way merge of text with `git merge-file` (a plumbing tool on three temp files; no repository state involved).
 *
 * @param {{ ours: Buffer, base: Buffer, theirs: Buffer }} input
 * @returns {{ ok: true, merged: Buffer } | { ok: false, reason: string }}
 */
function mergeThreeWay({ ours, base, theirs }) {
  if ([ours, base, theirs].some((buf) => buf.includes(0))) return { ok: false, reason: 'binary' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-merge-'));
  try {
    const files = { ours: path.join(dir, 'ours'), base: path.join(dir, 'base'), theirs: path.join(dir, 'theirs') };
    fs.writeFileSync(files.ours, ours);
    fs.writeFileSync(files.base, base);
    fs.writeFileSync(files.theirs, theirs);
    const result = spawnSync('git', ['merge-file', '-p', files.ours, files.base, files.theirs], { maxBuffer: GIT_MAX_BUFFER });
    if (result.error || result.status === null || result.status < 0 || result.status > 127) return { ok: false, reason: 'tool_error' };
    if (result.status === 0) return { ok: true, merged: result.stdout };
    return { ok: false, reason: 'conflict' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * @typedef {{
 *   path: string, action: 'copy' | 'merge' | 'delete' | 'already-applied' | 'conflict' | 'protected-skip',
 *   reason: string, baseSha256: string | null, worktreeSha256: string | null, mainSha256: string | null, headSha256: string | null,
 *   resultSha256?: string | null, resultMode?: number, candidate?: string,
 * }} CodeEntry
 */

/**
 * Per-path candidate plan. Candidate bytes are written to `candidatesDir` (a private directory outside every
 * repository); the manifest carries only hashes, classes and paths.
 *
 * Base choice per path: the worktree's own HEAD blob; for a path the worktree HEAD lacks (a restored or new file)
 * the main HEAD blob when one exists, so restored files are not reported as additions.
 *
 * @param {{
 *   codeRoot: string, mainRoot: string, candidatesDir: string, protectedPaths?: string[], extraPaths?: string[],
 *   baseRev?: string,
 * }} options
 * @returns {{ manifest: Record<string, any>, entries: CodeEntry[] }}
 */
export function planCodeCandidates(options) {
  const { codeRoot, mainRoot, candidatesDir } = options;
  const protectedPaths = [...new Set(options.protectedPaths ?? [])].sort();
  for (const rel of protectedPaths) assertSafeRelativePath(rel);
  const baseRev = options.baseRev ?? git(codeRoot, ['rev-parse', 'HEAD']).toString('utf8').trim();
  const mainHead = git(mainRoot, ['rev-parse', 'HEAD']).toString('utf8').trim();
  const scope = [...new Set([...listWorktreeChanges(codeRoot), ...(options.extraPaths ?? [])])].sort();
  for (const rel of scope) assertSafeRelativePath(rel);
  fs.mkdirSync(candidatesDir, { recursive: true, mode: 0o700 });
  /** @type {CodeEntry[]} */
  const entries = [];
  for (const rel of scope) {
    const work = readRegularOrNull(path.join(codeRoot, rel));
    const main = readRegularOrNull(path.join(mainRoot, rel));
    const baseBuf = gitShowOrNull(codeRoot, baseRev, rel);
    const headBuf = gitShowOrNull(mainRoot, mainHead, rel);
    const base = { sha256: baseBuf ? sha256Of(baseBuf) : null };
    const head = { sha256: headBuf ? sha256Of(headBuf) : null };
    /** @type {CodeEntry} */
    const entry = {
      path: rel, action: 'conflict', reason: '', baseSha256: base.sha256, worktreeSha256: work?.sha256 ?? null,
      mainSha256: main?.sha256 ?? null, headSha256: head.sha256,
    };
    entries.push(entry);
    if (protectedPaths.includes(rel)) {
      entry.action = 'protected-skip';
      entry.reason = work?.sha256 === (main?.sha256 ?? null) ? 'user-dirty-identical' : 'user-dirty-differs-from-worktree';
      continue;
    }
    if ((work?.sha256 ?? null) === (main?.sha256 ?? null)) {
      entry.action = 'already-applied';
      entry.reason = 'main-equals-worktree';
      continue;
    }
    // Merge base: the worktree's HEAD blob, else the main HEAD blob (a restored file), else empty (both sides added).
    const mergeBase = baseBuf ?? headBuf ?? Buffer.alloc(0);
    const mergeBaseSha = baseBuf ? base.sha256 : (headBuf ? head.sha256 : null);
    if (!work) {
      if (!main) continue;
      if (main.sha256 === mergeBaseSha) {
        entry.action = 'delete';
        entry.reason = 'deleted-in-worktree-main-untouched';
      } else {
        entry.reason = 'deleted-in-worktree-but-changed-in-main';
      }
      continue;
    }
    if (!main || main.sha256 === mergeBaseSha) {
      entry.action = 'copy';
      entry.reason = !main ? 'absent-in-main' : (baseBuf ? 'main-untouched-since-base' : 'main-equals-restored-base');
      storeCandidate(entry, work.buf, work.mode, candidatesDir);
      continue;
    }
    const merged = mergeThreeWay({ ours: main.buf, base: mergeBase, theirs: work.buf });
    if (!merged.ok) {
      entry.reason = `three-way-${/** @type {any} */ (merged).reason}`;
      continue;
    }
    entry.action = 'merge';
    entry.reason = 'both-sides-changed-clean-three-way';
    if (sha256Of(merged.merged) === main.sha256) {
      entry.action = 'already-applied';
      entry.reason = 'merge-result-equals-main';
      continue;
    }
    storeCandidate(entry, merged.merged, main.mode, candidatesDir);
  }
  const protectedHashes = protectedPaths.map((rel) => {
    const current = readRegularOrNull(path.join(mainRoot, rel));
    return { path: rel, mainSha256: current?.sha256 ?? null };
  });
  const body = {
    schema: CODE_MANIFEST_SCHEMA, baseRev, mainHead, plannedAt: new Date().toISOString(),
    counts: countActions(entries), protectedPaths: protectedHashes, entries,
  };
  return { manifest: { ...body, manifestHash: digestCanonical(body) }, entries };
}

/** @param {CodeEntry[]} entries @returns {Record<string, number>} */
function countActions(entries) {
  const counts = {};
  for (const entry of entries) counts[entry.action] = (counts[entry.action] ?? 0) + 1;
  return counts;
}

/** @param {CodeEntry} entry @param {Buffer} bytes @param {number} mode @param {string} dir */
function storeCandidate(entry, bytes, mode, dir) {
  const name = `${sha256Of(entry.path).slice(0, 16)}-${sha256Of(bytes).slice(0, 16)}.bin`;
  const file = path.join(dir, name);
  if (!lstatOrNull(file)) {
    fs.writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
  }
  entry.candidate = name;
  entry.resultSha256 = sha256Of(bytes);
  entry.resultMode = mode;
}

/**
 * Human-reviewable preview: counts and per-path decisions, no file contents.
 *
 * @param {{ entries: CodeEntry[], counts: Record<string, number>, baseRev: string, mainHead: string, manifestHash: string }} manifest
 * @returns {string}
 */
export function renderCodePreview(manifest) {
  const lines = [`code manifest ${manifest.manifestHash} base=${manifest.baseRev.slice(0, 8)} mainHead=${manifest.mainHead.slice(0, 8)}`];
  lines.push(Object.entries(manifest.counts).map(([key, value]) => `${key}=${value}`).join(' '));
  for (const entry of manifest.entries) {
    if (entry.action === 'already-applied') continue;
    lines.push(`${entry.action.padEnd(15)} ${entry.path}  (${entry.reason})`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Re-read every scoped target and refuse unless nothing moved since the plan.
 *
 * @param {{ mainRoot: string, manifest: Record<string, any>, candidatesDir: string }} options
 * @returns {{ targets: CodeEntry[] }}
 */
export function assertCodeMaterialUnchanged(options) {
  const { mainRoot, manifest, candidatesDir } = options;
  const { manifestHash, ...body } = manifest;
  if (digestCanonical(body) !== manifestHash) refuse('code_manifest_tampered', 'The code manifest does not match its hash');
  const head = git(mainRoot, ['rev-parse', 'HEAD']).toString('utf8').trim();
  if (head !== manifest.mainHead) refuse('code_main_head_changed', 'The main checkout HEAD moved since the plan; plan again', { planned: manifest.mainHead.slice(0, 12), actual: head.slice(0, 12) });
  for (const item of manifest.protectedPaths) {
    const current = readRegularOrNull(path.join(mainRoot, item.path));
    if ((current?.sha256 ?? null) !== item.mainSha256) refuse('code_protected_path_changed', 'A protected user file changed since the plan', { path: item.path });
  }
  const conflicts = manifest.entries.filter((entry) => entry.action === 'conflict');
  if (conflicts.length) refuse('code_plan_has_conflicts', 'The plan has unresolved conflicts; resolve them and plan again', { paths: conflicts.map((entry) => entry.path).slice(0, 20) });
  const targets = manifest.entries.filter((entry) => ['copy', 'merge', 'delete'].includes(entry.action));
  for (const entry of manifest.entries) {
    const current = readRegularOrNull(path.join(mainRoot, entry.path));
    if ((current?.sha256 ?? null) !== entry.mainSha256) refuse('code_target_changed', 'A scoped main path changed since the plan', { path: entry.path });
  }
  for (const entry of targets) {
    if (entry.action === 'delete') continue;
    const candidate = readRegularOrNull(path.join(candidatesDir, String(entry.candidate)));
    if (!candidate || candidate.sha256 !== entry.resultSha256) refuse('code_candidate_tampered', 'A candidate file is missing or differs from the manifest', { path: entry.path });
  }
  return { targets };
}

/**
 * Publish the candidates into the main checkout, per path, with a rollback checkpoint taken first and a journal
 * that `revertCodeApply` can finish after a crash. No commit, no git state change.
 *
 * @param {{ mainRoot: string, manifest: Record<string, any>, candidatesDir: string, checkpointDir: string, journalFile: string, faultHook?: (point: string, entry?: CodeEntry) => void }} options
 * @returns {{ applied: number, deleted: number }}
 */
export function applyCodeCandidates(options) {
  const { mainRoot, manifest, candidatesDir, checkpointDir, journalFile } = options;
  const hook = options.faultHook ?? (() => {});
  const { targets } = assertCodeMaterialUnchanged({ mainRoot, manifest, candidatesDir });
  if (lstatOrNull(journalFile)) refuse('code_journal_exists', 'A code journal already exists; revert or discard it deliberately');
  fs.mkdirSync(checkpointDir, { recursive: true, mode: 0o700 });
  const journal = {
    schema: CODE_JOURNAL_SCHEMA, manifestHash: manifest.manifestHash, mainRoot, state: 'checkpointing',
    entries: targets.map((entry, index) => ({
      path: entry.path, action: entry.action, resultSha256: entry.action === 'delete' ? null : entry.resultSha256,
      originalSha256: entry.mainSha256, originalMode: null, checkpoint: entry.mainSha256 ? `orig-${index}.bin` : null,
      createdDirs: /** @type {string[]} */ ([]), state: 'pending',
    })),
  };
  for (const [index, entry] of targets.entries()) {
    const current = readRegularOrNull(path.join(mainRoot, entry.path));
    if (!current) continue;
    journal.entries[index].originalMode = current.mode;
    fs.writeFileSync(path.join(checkpointDir, `orig-${index}.bin`), current.buf, { mode: 0o600, flag: 'wx' });
  }
  fsyncDirectory(checkpointDir);
  journal.state = 'applying';
  writeJournal(journalFile, journal);
  hook('after-checkpoint');
  try {
    for (const [index, entry] of targets.entries()) {
      const slot = journal.entries[index];
      const target = path.join(mainRoot, entry.path);
      if (entry.action === 'delete') {
        fs.unlinkSync(target);
        fsyncDirectory(path.dirname(target));
      } else {
        slot.createdDirs = ensureDirectories(mainRoot, path.dirname(entry.path));
        writeJournal(journalFile, journal);
        const candidate = fs.readFileSync(path.join(candidatesDir, String(entry.candidate)));
        replaceFileAtomic(target, candidate, slot.originalMode ?? entry.resultMode ?? 0o644);
      }
      slot.state = 'applied';
      writeJournal(journalFile, journal);
      hook('after-entry', entry);
    }
    for (const entry of targets) {
      const current = readRegularOrNull(path.join(mainRoot, entry.path));
      const expected = entry.action === 'delete' ? null : entry.resultSha256;
      if ((current?.sha256 ?? null) !== expected) refuse('code_post_verify_failed', 'A published path does not match its candidate', { path: entry.path });
    }
    for (const item of manifest.protectedPaths) {
      const current = readRegularOrNull(path.join(mainRoot, item.path));
      if ((current?.sha256 ?? null) !== item.mainSha256) refuse('code_protected_path_changed', 'A protected user file changed during the apply', { path: item.path });
    }
  } catch (error) {
    const report = revertCodeApply({ mainRoot, checkpointDir, journalFile });
    if (error instanceof HistoryMigrationError) {
      error.details = { ...error.details, reverted: report.reverted, revertRefused: report.refused };
    }
    throw error;
  }
  journal.state = 'applied';
  writeJournal(journalFile, journal);
  return { applied: targets.filter((entry) => entry.action !== 'delete').length, deleted: targets.filter((entry) => entry.action === 'delete').length };
}

/**
 * Restore the checkpoint of an apply (journal driven, idempotent). A path whose current bytes are neither the
 * candidate nor the original is somebody else's change and is left alone and reported.
 *
 * @param {{ mainRoot: string, checkpointDir: string, journalFile: string }} options
 * @returns {{ reverted: number, refused: string[] }}
 */
export function revertCodeApply(options) {
  const journal = JSON.parse(fs.readFileSync(options.journalFile, 'utf8'));
  if (journal.schema !== CODE_JOURNAL_SCHEMA) refuse('code_journal_invalid', 'Not a cutover code journal');
  let reverted = 0;
  /** @type {string[]} */
  const refused = [];
  for (const slot of [...journal.entries].reverse()) {
    const target = path.join(options.mainRoot, slot.path);
    const current = readRegularOrNull(target);
    const currentSha = current?.sha256 ?? null;
    if (currentSha === slot.originalSha256) {
      removeCreatedDirs(options.mainRoot, slot.createdDirs);
      continue;
    }
    if (currentSha !== slot.resultSha256) {
      refused.push(slot.path);
      continue;
    }
    if (slot.checkpoint) {
      const original = fs.readFileSync(path.join(options.checkpointDir, slot.checkpoint));
      if (sha256Of(original) !== slot.originalSha256) {
        refused.push(slot.path);
        continue;
      }
      replaceFileAtomic(target, original, slot.originalMode ?? 0o644);
    } else if (current) {
      fs.unlinkSync(target);
      fsyncDirectory(path.dirname(target));
    }
    removeCreatedDirs(options.mainRoot, slot.createdDirs);
    reverted += 1;
  }
  journal.state = refused.length ? 'revert-incomplete' : 'reverted';
  writeJournal(options.journalFile, journal);
  return { reverted, refused };
}

/** @param {string} file @param {Record<string, any>} journal */
function writeJournal(file, journal) {
  replaceOwnFileDurable(file, `${JSON.stringify(journal, null, 2)}\n`);
}

/**
 * Create missing parent directories under `root`, returning the ones this call created (deepest last).
 *
 * @param {string} root @param {string} relDir @returns {string[]}
 */
function ensureDirectories(root, relDir) {
  /** @type {string[]} */
  const created = [];
  if (relDir === '.' || relDir === '') return created;
  let current = root;
  for (const part of relDir.split('/')) {
    current = path.join(current, part);
    const stat = lstatOrNull(current);
    if (stat) {
      if (!stat.isDirectory()) refuse('code_path_not_regular', 'A scoped parent is not a directory', { path: path.relative(root, current) });
      continue;
    }
    fs.mkdirSync(current, { mode: 0o755 });
    fsyncDirectory(path.dirname(current));
    created.push(path.relative(root, current));
  }
  return created;
}

/** @param {string} root @param {string[]} created */
function removeCreatedDirs(root, created) {
  for (const rel of [...(created ?? [])].reverse()) {
    try {
      fs.rmdirSync(path.join(root, rel));
    } catch { /* not empty or already gone: left alone */ }
  }
}

/** Same-directory temp + fsync + rename, mode preserved. @param {string} target @param {Buffer} bytes @param {number} mode */
function replaceFileAtomic(target, bytes, mode) {
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.cutover-${randomBytes(4).toString('hex')}.tmp`);
  const fd = fs.openSync(temp, 'wx', mode);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, target);
  fsyncDirectory(path.dirname(target));
}
