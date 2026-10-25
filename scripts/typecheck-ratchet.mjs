#!/usr/bin/env node
/**
 * Type-error ratchet (docs/ts-migration-and-core-harnesses-plan.md, A0).
 *
 * Runs `tsc --noEmit` for every project below and counts errors per file. The
 * check fails when any file has MORE errors than docs/typecheck-baseline.json
 * records (a file missing from the baseline counts as 0). Fewer errors pass and
 * print a hint to lock the gain in with `npm run typecheck:baseline`.
 *
 *   node scripts/typecheck-ratchet.mjs           # compare against the baseline
 *   node scripts/typecheck-ratchet.mjs --update  # rewrite the baseline
 *
 * Errors without a file (bad tsconfig, missing lib) always fail: they mean the
 * checker did not run as configured, so a count of 0 would be meaningless.
 *
 * Strict tier (A1): every file in `tsconfig.strict.json` `files` must have zero
 * errors under `strict`. It has no baseline, so `--update` cannot loosen it, and
 * only the listed files count (looser modules they import are not blamed).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseJsonc } from 'jsonc-parser';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = path.join(projectRoot, 'docs', 'typecheck-baseline.json');
const tscBin = path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const PROJECTS = ['tsconfig.json', 'app_front/tsconfig.json'];
const STRICT_PROJECT = 'tsconfig.strict.json';
const update = process.argv.includes('--update');

// `file(line,col): error TS1234: message`; continuation lines are indented.
const FILE_ERROR = /^(.+?)\(\d+,\d+\): error (TS\d+):/;
const GLOBAL_ERROR = /^error (TS\d+):/;

function runProject(project) {
  const result = spawnSync(process.execPath, [tscBin, '-p', project, '--pretty', 'false'], {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  // tsc exits 0 (clean) or 1/2 (diagnostics); anything else is a crash.
  if (result.status !== 0 && result.status !== 1 && result.status !== 2) {
    throw new Error(`tsc -p ${project} exited with ${result.status}\n${result.stderr}`);
  }
  const counts = {};
  const globalErrors = [];
  for (const line of `${result.stdout}\n${result.stderr}`.split('\n')) {
    const fileMatch = FILE_ERROR.exec(line);
    if (fileMatch) {
      const file = fileMatch[1].split(path.sep).join('/');
      counts[file] = (counts[file] || 0) + 1;
    } else if (GLOBAL_ERROR.test(line)) {
      globalErrors.push(line);
    }
  }
  return { counts, globalErrors };
}

function sortKeys(object) {
  return Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
}

function sum(counts) {
  return Object.values(counts).reduce((total, n) => total + n, 0);
}

function checkStrictTier() {
  const config = parseJsonc(readFileSync(path.join(projectRoot, STRICT_PROJECT), 'utf8')) || {};
  const files = Array.isArray(config.files) ? config.files : [];
  if (files.length === 0) {
    console.error(`[typecheck] ${STRICT_PROJECT}: "files" is empty or unreadable`);
    return false;
  }
  const { counts, globalErrors } = runProject(STRICT_PROJECT);
  if (globalErrors.length > 0) {
    console.error(`[typecheck] ${STRICT_PROJECT}: errors without a file:\n  ${globalErrors.join('\n  ')}`);
    return false;
  }
  const failing = files.filter((file) => counts[file] > 0);
  if (failing.length > 0) {
    console.error(`[typecheck] ${STRICT_PROJECT}: strict files must have 0 errors:`);
    console.error(failing.map((file) => `  ${file}: ${counts[file]}`).join('\n'));
    console.error(`[typecheck] See: npx tsc -p ${STRICT_PROJECT} --pretty false`);
    return false;
  }
  console.log(`[typecheck] ${STRICT_PROJECT}: ${files.length} strict files, 0 errors`);
  return true;
}

if (!checkStrictTier()) process.exit(1);

const current = {};
let configBroken = false;
for (const project of PROJECTS) {
  const { counts, globalErrors } = runProject(project);
  if (globalErrors.length > 0) {
    configBroken = true;
    console.error(`[typecheck] ${project}: errors without a file:\n  ${globalErrors.join('\n  ')}`);
  }
  current[project] = sortKeys(counts);
}
if (configBroken) process.exit(1);

if (update) {
  const baseline = { generatedBy: 'scripts/typecheck-ratchet.mjs --update', projects: current };
  writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  for (const project of PROJECTS) {
    const counts = current[project];
    console.log(`[typecheck] ${project}: ${sum(counts)} errors in ${Object.keys(counts).length} files`);
  }
  console.log(`[typecheck] baseline written to ${path.relative(projectRoot, baselinePath)}`);
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  console.error('[typecheck] docs/typecheck-baseline.json is missing; run: npm run typecheck:baseline');
  process.exit(1);
}
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')).projects || {};

let regressions = 0;
let improvedFiles = 0;
for (const project of PROJECTS) {
  const was = baseline[project] || {};
  const now = current[project];
  const files = new Set([...Object.keys(was), ...Object.keys(now)]);
  const worse = [];
  for (const file of files) {
    const before = was[file] || 0;
    const after = now[file] || 0;
    if (after > before) worse.push(`  ${file}: ${before} -> ${after}`);
    else if (after < before) improvedFiles += 1;
  }
  console.log(`[typecheck] ${project}: ${sum(now)} errors (baseline ${sum(was)})`);
  if (worse.length > 0) {
    regressions += worse.length;
    console.error(`[typecheck] ${project}: more type errors than the baseline in ${worse.length} file(s):`);
    console.error(worse.sort().join('\n'));
  }
}

if (regressions > 0) {
  console.error(
    `\n[typecheck] Fix the new errors (see: npx tsc -p <project> --pretty false).\n` +
      '[typecheck] Rebaseline only on purpose: npm run typecheck:baseline, and say why in the PR.'
  );
  process.exit(1);
}
if (improvedFiles > 0) {
  console.log(`[typecheck] ${improvedFiles} file(s) improved; lock it in with: npm run typecheck:baseline`);
}
console.log('[typecheck] OK: no file has more type errors than the baseline');
