#!/usr/bin/env node
/**
 * Computes the SHA-256 manifest of every stage 1-7 document, script, test and changed
 * source file for the next root plan version, and compares it with the plan v6 manifest.
 * Run it AFTER the last documentation edit; the output file hashes itself out of the list.
 *
 * Usage: node scripts/architecture-manifest-stage7.mjs [--write docs/architecture-manifest-stage7.json]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = 'docs/architecture-manifest-stage7.json';
/** Snapshot that already contains the V0 request-local index; stages 1-6 start from it. */
const BASE_COMMIT = '065f3d54a1c330b43cc8b0ba74a55e851970a932';
const EXTRA_FILES = ['tests/delegation-route-chat-index.test.js'];

/**
 * Untracked files that belong to the architecture program. Other untracked files
 * (for example an unrelated change pending in the same worktree) are ignored so
 * the manifest describes only this program.
 *
 * @param {string} file project-relative POSIX path
 * @returns {boolean}
 */
function isArchitecturePath(file) {
  return (
    file.startsWith('docs/architecture-') ||
    file === 'docs/ARCHITECTURE.md' ||
    file === 'docs/MULTI-INSTANCE.md' ||
    file.startsWith('scripts/architecture-') ||
    file.startsWith('tests/architecture-') ||
    file === 'tests/multi-instance-regression.test.js'
  );
}

/**
 * Normalizes a CLI path (relative or absolute) to a project-relative POSIX path
 * so it can be compared with the `git ls-files` output.
 *
 * @param {string} file
 * @returns {string}
 */
function toProjectRelative(file) {
  return path.relative(projectRoot, path.resolve(projectRoot, file)).split(path.sep).join('/');
}

/** Manifest of root plan v6 (stage 1 files), copied verbatim from the plan text. */
const PLAN_V6 = {
  'docs/architecture-target-adr.md': '07ee6f761d8f02a08f3e4ce0a32fd1668441c5ba7f45b7b703c948fd09c47c41',
  'docs/architecture-system-map.md': 'a16b32764dbc26143970ded91eddd1303f88255601f9f4cd1f1716ee9ab01529',
  'docs/architecture-vertical-dag.md': 'a35904c1fea5e4ee843f99112c3ca27196d03686af9a12452c9296fe9c4802e0',
  'docs/architecture-baseline.md': '360503e567a28ced9b3425ec2cddc163aa81f85e9667361b04bdc12be0420a10',
  'docs/architecture-sync-io-inventory.json': '032722d033467c1d4b39ff273e31b042b83112b3d3791ca562946c99e249a93c',
  'docs/architecture-chat-list-bench.json': 'e03d2737a6cbe018835083db56bc3f5ba7d4e75960238c79bf89aeb56cf17adf',
  'docs/architecture-baseline-storage-harness.json': '98566a0ee106b51cff729a98e923c95eaa1572126670aa150faf1e88f3840bb4',
  'scripts/architecture-sync-io-inventory.mjs': 'f46e4e1afb421dc69504b169a4ee5d7d403d75b9263eb6661745331d5a46a20c',
  'scripts/architecture-chat-list-bench.mjs': '7a9266a5be81b1589c208b0d3c59640e8acf1eb2a32a13a32eb5a9d3f0cf2e49',
  'docs/ARCHITECTURE.md': 'c5c5794bb110c5355f5cb8b1017a145abe17302be55d45aafca05ed11b24752c',
};

/** @param {string[]} args */
function git(args) {
  return execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8' }).split('\n').filter(Boolean);
}

/** @param {string} file */
function describeFile(file) {
  const bytes = readFileSync(path.join(projectRoot, file));
  const top = file.split('/')[0];
  const group = top === 'docs' ? 'document' : top === 'scripts' ? 'script' : top === 'tests' ? 'test' : 'source';
  return { path: file, group, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}

const writeIndex = process.argv.indexOf('--write');
const writeTarget = writeIndex !== -1 ? process.argv[writeIndex + 1] || OUTPUT : null;
const outputPath = writeTarget ? toProjectRelative(writeTarget) : null;

// Deleted files are skipped (`--diff-filter=d`, plus the existsSync filter below)
// instead of crashing with ENOENT, and the file's own output path is excluded.
const changed = git(['diff', '--name-only', '--diff-filter=d', BASE_COMMIT, '--']);
const untracked = git(['ls-files', '--others', '--exclude-standard']).filter(isArchitecturePath);
const files = [...new Set([...changed, ...untracked, ...EXTRA_FILES])]
  .filter((file) => file !== OUTPUT && file !== outputPath && existsSync(path.join(projectRoot, file)))
  .sort();
const entries = files.map(describeFile);
const byPath = new Map(entries.map((entry) => [entry.path, entry]));
const planV6 = Object.entries(PLAN_V6).map(([file, sha256]) => {
  const current = byPath.get(file)?.sha256 || describeFile(file).sha256;
  return { path: file, planV6Sha256: sha256, currentSha256: current, stale: current !== sha256 };
});
const manifest = {
  schemaVersion: 1,
  generatedBy: 'scripts/architecture-manifest-stage7.mjs',
  baseCommit: BASE_COMMIT,
  note: 'Compute after the last documentation edit. This file is excluded from its own list. Nothing here edits the root plan or its approval state.',
  count: entries.length,
  entries,
  planV6Comparison: planV6,
  staleInPlanV6: planV6.filter((row) => row.stale).map((row) => row.path),
};
if (writeTarget) writeFileSync(path.resolve(projectRoot, writeTarget), `${JSON.stringify(manifest, null, 2)}\n`);
else process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
