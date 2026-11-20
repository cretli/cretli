#!/usr/bin/env node
/**
 * Operator tool for the history cutover (stage 3). It PREPARES a reviewable operation and carries out the
 * quiesced steps; it never stops or starts the server (the offline snapshot tool's `--stopped-hook` does, with
 * its identity/writer/reparent guards) and never commits, pushes or merges.
 *
 *   prepare   --code-root D --main-root D --data-root D --ops-dir NEW --backup-op-dir D --min-chats N
 *             [--legacy-dir D] [--dataset-generation G] [--protect REL]...
 *             --backup-not-before ISO [--backup-max-age-ms N] [--base-rev REV]   read-only: code candidates + private manifest
 *   preview   --ops-dir D                                      per-path decisions, no contents
 *   verify    --ops-dir D --confirm-manifest-hash H            every precondition checkable before the stop
 *   hook-spec --ops-dir D --confirm-manifest-hash H --mode cutover|recover|rollback-precutover --out FILE
 *   cutover | recover | rollback-precutover --ops-dir D --confirm-manifest-hash H     (quiesced window only)
 *   post-check --ops-dir D [--previous FILE] [--out FILE]      read-only evidence of the live store
 *   rehearse-rollback --ops-dir D --scratch-dir NEW            export rehearsal on an isolated copy
 *
 * Output is JSON with codes and counts only. docs/storage-pre-cutover-runbook.md describes the sequence.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { listWorktreeChanges, planCodeCandidates, renderCodePreview, sha256Of } from '../lib/storage/cutover-code.js';
import {
  CUTOVER_MANIFEST_SCHEMA, collectPostCutoverEvidence, newOperationId, recoverInterrupted, rehearseRollbackOnCopy,
  resolveCutoverPaths, rollbackPreCutover, runQuiescedCutover, verifyCutoverMaterial,
} from '../lib/storage/cutover-history.js';
import { HistoryMigrationError } from '../lib/storage/history-legacy-format.js';
import { lstatOrNull, replaceOwnFileDurable } from '../lib/storage/history-migration-fs.js';
import { digestCanonical } from '../lib/storage/history-sidecar.js';

const SELF = fileURLToPath(import.meta.url);
/** The checkout this script runs from: the tree whose tools are pinned by the manifest. */
const TOOL_ROOT = path.resolve(path.dirname(SELF), '..');
const OPTIONS = {
  'code-root': { type: 'string' }, 'main-root': { type: 'string' }, 'data-root': { type: 'string' }, 'ops-dir': { type: 'string' },
  'backup-op-dir': { type: 'string' }, 'min-chats': { type: 'string' }, 'legacy-dir': { type: 'string' },
  'dataset-generation': { type: 'string' }, protect: { type: 'string', multiple: true }, 'backup-not-before': { type: 'string' },
  'backup-max-age-ms': { type: 'string' }, 'base-rev': { type: 'string' }, 'confirm-manifest-hash': { type: 'string' },
  mode: { type: 'string' }, out: { type: 'string' }, previous: { type: 'string' }, 'scratch-dir': { type: 'string' },
  help: { type: 'boolean', default: false },
};
/** Fixed-size safety margin for the staging import (the plan estimate is 1.5x source bytes). */
const STAGING_MARGIN_BYTES = 256 * 1024 * 1024;

/** @param {string} name @param {Record<string, any>} values @returns {string} */
function need(name, values) {
  const value = values[name];
  if (typeof value !== 'string' || !value) throw new HistoryMigrationError('cli_usage', `Missing --${name}`);
  return value;
}

/** @param {unknown} value */
function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** @param {string} opsDir @returns {Record<string, any>} */
function readManifest(opsDir) {
  return JSON.parse(fs.readFileSync(path.join(opsDir, 'cutover-manifest.json'), 'utf8'));
}

/**
 * Hash of every file that decides the outcome of the quiesced run: this script, the storage libraries and the
 * marker module. The hook spec pins the script; the manifest pins this digest, re-checked inside the window.
 *
 * @param {string} codeRoot
 */
function toolDigest(codeRoot) {
  const files = [];
  const add = (dir, filter) => {
    for (const name of fs.readdirSync(path.join(codeRoot, dir)).sort()) {
      if (filter(name) && fs.statSync(path.join(codeRoot, dir, name)).isFile()) files.push(`${dir}/${name}`);
    }
  };
  add('lib/storage', (name) => name.endsWith('.js'));
  add('lib/persist', (name) => name.startsWith('chat-history-') && name.endsWith('.js'));
  files.push('scripts/storage-history-cutover.mjs', 'scripts/cretli-offline-snapshot.mjs');
  const entries = files.map((rel) => [rel, sha256Of(fs.readFileSync(path.join(codeRoot, rel)))]);
  return { digest: digestCanonical(entries), files: entries.length };
}

/** @param {string} child @param {string} parent */
const isInside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** @param {Record<string, any>} values */
function prepare(values) {
  const codeRoot = fs.realpathSync(need('code-root', values));
  const mainRoot = fs.realpathSync(need('main-root', values));
  const dataRoot = fs.realpathSync(need('data-root', values));
  const opsDir = path.resolve(need('ops-dir', values));
  const backupOpDir = fs.realpathSync(need('backup-op-dir', values));
  const minChats = Number(need('min-chats', values));
  if (!Number.isInteger(minChats) || minChats < 1) throw new HistoryMigrationError('cli_usage', '--min-chats must be a positive integer (the preflight floor)');
  for (const dir of [codeRoot, mainRoot, dataRoot]) {
    if (isInside(opsDir, dir) || isInside(dir, opsDir)) throw new HistoryMigrationError('cli_usage', 'The operation directory must be outside the code, main and data trees');
  }
  if (lstatOrNull(opsDir)) throw new HistoryMigrationError('cli_usage', 'The operation directory must not exist yet');
  fs.mkdirSync(opsDir, { recursive: true, mode: 0o700 });
  const notBefore = new Date(need('backup-not-before', values));
  if (Number.isNaN(notBefore.getTime())) throw new HistoryMigrationError('cli_usage', '--backup-not-before must be an ISO time: a backup older than it is stale');
  const opId = newOperationId();
  const paths = { codeRoot, mainRoot, dataRoot, opsDir, toolRoot: TOOL_ROOT, ...resolveCutoverPaths(dataRoot, values['legacy-dir']) };
  const { manifest: code } = planCodeCandidates({
    codeRoot, mainRoot, candidatesDir: path.join(opsDir, 'code', 'candidates'), protectedPaths: values.protect ?? [], baseRev: values['base-rev'],
  });
  fs.mkdirSync(path.join(opsDir, 'code'), { recursive: true, mode: 0o700 });
  replaceOwnFileDurable(path.join(opsDir, 'code', 'manifest.json'), `${JSON.stringify(code, null, 2)}\n`);
  replaceOwnFileDurable(path.join(opsDir, 'code', 'preview.txt'), renderCodePreview(code));
  const legacyBytes = fs.readdirSync(paths.legacyDir).reduce((sum, name) => sum + (fs.lstatSync(path.join(paths.legacyDir, name)).size || 0), 0);
  const backupStatus = JSON.parse(fs.readFileSync(path.join(backupOpDir, 'status.json'), 'utf8'));
  const body = {
    schema: CUTOVER_MANIFEST_SCHEMA, opId, createdAt: new Date().toISOString(),
    datasetGeneration: values['dataset-generation'] ?? `gen-${opId}`, opsDir, paths,
    backup: {
      opDir: backupOpDir, sha256: backupStatus?.result?.sha256 ?? null, notBefore: notBefore.toISOString(),
      maxAgeMs: values['backup-max-age-ms'] === undefined ? undefined : Number(values['backup-max-age-ms']),
    },
    code: { manifestHash: code.manifestHash, counts: code.counts, baseRev: code.baseRev, mainHead: code.mainHead },
    expect: { minChats }, tool: toolDigest(TOOL_ROOT),
    space: { opsBytesRequired: Math.ceil(legacyBytes * 1.5) + STAGING_MARGIN_BYTES, dataBytesRequired: Math.ceil(legacyBytes * 1.5) + STAGING_MARGIN_BYTES },
    protectedPaths: code.protectedPaths,
  };
  const manifest = { ...body, manifestHash: digestCanonical(body) };
  replaceOwnFileDurable(path.join(opsDir, 'cutover-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    mode: 'prepare', opId, manifestHash: manifest.manifestHash, datasetGeneration: manifest.datasetGeneration, code: manifest.code,
    worktreeChangedPaths: listWorktreeChanges(codeRoot).length, toolRootIsCodeRoot: TOOL_ROOT === codeRoot, protectedPaths: code.protectedPaths, tool: manifest.tool,
    previewFile: 'code/preview.txt', next: 'review preview, then: verify -> hook-spec -> snapshot tool --stopped-hook',
  };
}

/** @param {Record<string, any>} manifest */
function assertToolUnchanged(manifest) {
  if (TOOL_ROOT !== manifest.paths.toolRoot) throw new HistoryMigrationError('cutover_tool_changed', 'The tool does not run from the prepared tool root');
  if (toolDigest(TOOL_ROOT).digest !== manifest.tool.digest) throw new HistoryMigrationError('cutover_tool_changed', 'The cutover tool or storage libraries changed since prepare');
}

/**
 * Durable end-state proof for the snapshot helper's stopped-window hook (docs/storage-pre-cutover-runbook.md). The
 * helper passes a fresh per-attempt nonce and a proof path; without the proof it must NOT restart the service after a
 * failed hook. `safe-legacy`: code and data are back on the legacy backend; `safe-new`: new code and a verified marker, written only after every post-marker validation passed.
 * No-op outside a helper run.
 *
 * @param {Record<string, any>} manifest @param {'safe-legacy'|'safe-new'} outcome
 */
function writeHookProof(manifest, outcome) {
  const proofPath = process.env.CRETLI_HOOK_PROOF_PATH;
  const attempt = process.env.CRETLI_HOOK_ATTEMPT;
  if (!proofPath || !attempt) return;
  const body = { schema: 'cretli-hook-proof-v1', attempt, helperOpId: process.env.CRETLI_HOOK_OP_ID ?? null, cutoverOpId: manifest.opId, outcome, at: new Date().toISOString() };
  replaceOwnFileDurable(proofPath, `${JSON.stringify(body)}\n`);
}

/** @param {{ codeRefused?: string[] }} undo @returns {boolean} true when the abort left nothing unreverted */
const isCleanAbort = (undo) => (undo.codeRefused ?? []).length === 0;

/** Run one quiesced mode and emit the proof its end state justifies; any other end state leaves NO proof. */
function runWithProof(manifest, action) {
  try {
    const out = action();
    return out;
  } catch (error) {
    const outcome = /** @type {any} */ (error)?.cutoverOutcome;
    if (outcome === 'aborted-before-marker' || outcome === 'failed-before-writes') writeHookProof(manifest, 'safe-legacy');
    // failed-after-marker deliberately leaves NO proof: the marker may exist while validation failed, so the helper stays stopped.
    throw error;
  }
}

/** @param {string} command @param {Record<string, any>} values */
async function run(command, values) {
  if (command === 'prepare') {
    print(prepare(values));
    return 0;
  }
  const opsDir = path.resolve(need('ops-dir', values));
  const manifest = readManifest(opsDir);
  if (command === 'preview') {
    process.stdout.write(fs.readFileSync(path.join(opsDir, 'code', 'preview.txt'), 'utf8'));
    return 0;
  }
  if (command === 'post-check') {
    const previous = values.previous ? JSON.parse(fs.readFileSync(values.previous, 'utf8')) : null;
    const evidence = collectPostCutoverEvidence({ manifest, previous });
    if (values.out) replaceOwnFileDurable(path.resolve(values.out), `${JSON.stringify(evidence, null, 2)}\n`);
    print({ mode: 'post-check', ...evidence, newEvents: evidence.newEvents.length, anchors: { receipts: evidence.anchors.receipts.length, chats: Object.keys(evidence.anchors.chats).length } });
    return evidence.ok ? 0 : 2;
  }
  if (command === 'rehearse-rollback') {
    print({ mode: 'rehearse-rollback', ...(await rehearseRollbackOnCopy({ manifest, scratchDir: path.resolve(need('scratch-dir', values)) })) });
    return 0;
  }
  const confirm = need('confirm-manifest-hash', values);
  if (command === 'verify') {
    assertToolUnchanged(manifest);
    const material = verifyCutoverMaterial({ manifest, confirmManifestHash: confirm });
    print({ mode: 'verify', ok: true, backup: material.backup, code: material.code, controlPreexisting: material.controlPreexisting });
    return 0;
  }
  if (command === 'hook-spec') {
    const mode = need('mode', values);
    if (!['cutover', 'recover', 'rollback-precutover'].includes(mode)) throw new HistoryMigrationError('cli_usage', 'Unknown --mode');
    const spec = {
      label: `history-${mode}`, script: SELF, scriptSha256: createHash('sha256').update(fs.readFileSync(SELF)).digest('hex'),
      args: [mode, '--ops-dir', opsDir, '--confirm-manifest-hash', confirm],
    };
    const text = `${JSON.stringify(spec, null, 2)}\n`;
    const out = path.resolve(need('out', values));
    replaceOwnFileDurable(out, text);
    print({ mode: 'hook-spec', out, specSha256: createHash('sha256').update(text).digest('hex') });
    return 0;
  }
  if (command === 'cutover') {
    assertToolUnchanged(manifest);
    const result = runWithProof(manifest, () => runQuiescedCutover({ manifest, confirmManifestHash: confirm }));
    writeHookProof(manifest, 'safe-new');
    print({ mode: 'cutover', ok: true, ...result });
    return 0;
  }
  if (command === 'recover') {
    assertToolUnchanged(manifest);
    const result = recoverInterrupted({ manifest, confirmManifestHash: confirm });
    if (result.action !== 'aborted' || !isCleanAbort(result)) {
      // Marker present (state is the operator's call) or an incomplete code revert: no proof, the helper stays stopped.
      print({ mode: 'recover', ok: false, ...result });
      return 3;
    }
    writeHookProof(manifest, 'safe-legacy');
    print({ mode: 'recover', ...result });
    return 0;
  }
  if (command === 'rollback-precutover') {
    assertToolUnchanged(manifest);
    const result = rollbackPreCutover({ manifest, confirmManifestHash: confirm });
    if (!isCleanAbort(result)) {
      print({ mode: 'rollback-precutover', ok: false, ...result });
      return 3;
    }
    writeHookProof(manifest, 'safe-legacy');
    print({ mode: 'rollback-precutover', ...result });
    return 0;
  }
  throw new HistoryMigrationError('cli_usage', 'Unknown command');
}

const { positionals, values } = parseArgs({ options: OPTIONS, allowPositionals: true });
if (values.help || positionals.length === 0) {
  process.stdout.write(`${fs.readFileSync(SELF, 'utf8').split('*/')[0].replace('#!/usr/bin/env node\n', '')}*/\n`);
  process.exit(positionals.length === 0 && !values.help ? 64 : 0);
}
try {
  process.exitCode = await run(positionals[0], values);
} catch (error) {
  const known = error instanceof HistoryMigrationError || (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string');
  process.stderr.write(`${JSON.stringify({ ok: false, code: known ? error.code : 'INTERNAL', message: known ? error.message : 'unexpected failure', details: known ? error.details : undefined })}\n`);
  process.exitCode = 1;
}
