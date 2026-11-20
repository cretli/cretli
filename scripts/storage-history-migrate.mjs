#!/usr/bin/env node
/**
 * Offline history migration tool (stage 1). Plan is the default; --apply writes
 * ONLY a new staging/export directory. It never writes to the legacy history
 * directory or to the store it reads, never takes locks and never talks to a
 * running server. Run it with every Cretli writer stopped.
 *
 *   import   --legacy-dir D --dataset-generation G [--staging-out O --apply --confirm-plan HASH [--resume]]
 *   verify-import --staging-dir O [--legacy-dir D]
 *   rollback --store-dir S [--legacy-out O --apply --confirm-plan HASH [--discard-partial] [--cursor-session-map FILE]]
 *   verify-rollback --export-dir O [--store-dir S]
 *
 * Output is JSON with codes and counts only (no conversation text).
 * docs/storage-history-migration.md describes the contract and its limits.
 */
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { HistoryMigrationError, parseStrictJson } from '../lib/storage/history-legacy-format.js';
import { applyLegacyImport, planLegacyImport, verifyImportStaging } from '../lib/storage/history-import.js';
import { applyRollbackExport, planRollbackExport, verifyRollbackExport } from '../lib/storage/history-rollback.js';

const OPTIONS = {
  'legacy-dir': { type: 'string' },
  'dataset-generation': { type: 'string' },
  'staging-out': { type: 'string' },
  'staging-dir': { type: 'string' },
  'store-dir': { type: 'string' },
  'legacy-out': { type: 'string' },
  'export-dir': { type: 'string' },
  'confirm-plan': { type: 'string' },
  'cursor-session-map': { type: 'string' },
  'min-quiet-ms': { type: 'string' },
  apply: { type: 'boolean', default: false },
  resume: { type: 'boolean', default: false },
  'discard-partial': { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
};

/** @param {string} name @param {Record<string, unknown>} values @returns {string} */
function need(name, values) {
  const value = values[name];
  if (typeof value !== 'string' || !value) throw new HistoryMigrationError('cli_usage', `Missing --${name}`);
  return value;
}

/** @param {Record<string, unknown>} values @returns {Record<string, string> | undefined} */
function readCursorMap(values) {
  const file = values['cursor-session-map'];
  if (typeof file !== 'string') return undefined;
  const parsed = parseStrictJson(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some((v) => typeof v !== 'string')) {
    throw new HistoryMigrationError('cli_usage', '--cursor-session-map must be a JSON object of chatId -> cursorSessionId strings');
  }
  return /** @type {Record<string, string>} */ (parsed);
}

/** @param {unknown} value */
function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** @param {string} command @param {Record<string, unknown>} values */
function run(command, values) {
  const minQuietMs = values['min-quiet-ms'] === undefined ? 5000 : Number(values['min-quiet-ms']);
  if (!Number.isFinite(minQuietMs) || minQuietMs < 0) throw new HistoryMigrationError('cli_usage', '--min-quiet-ms must be a non-negative number');
  if (command === 'import') {
    const common = { legacyDir: need('legacy-dir', values), datasetGeneration: need('dataset-generation', values), minQuietMs };
    if (!values.apply) {
      const plan = planLegacyImport(common);
      print({ mode: 'plan', ...plan, files: plan.files.length > 50 ? `${plan.files.length} files (see totals)` : plan.files });
      return plan.ok ? 0 : 2;
    }
    const result = applyLegacyImport({ ...common, stagingOut: need('staging-out', values), confirmPlanHash: need('confirm-plan', values), resume: Boolean(values.resume) });
    print({ mode: 'apply', output: result.output, manifestHash: result.manifest.manifestHash, totals: result.manifest.totals, validation: result.manifest.validation, resumedChats: result.resumedChats });
    return 0;
  }
  if (command === 'verify-import') {
    print({ mode: 'verify-import', ...verifyImportStaging({ stagingDir: need('staging-dir', values), legacyDir: /** @type {string | undefined} */ (values['legacy-dir']) }) });
    return 0;
  }
  if (command === 'rollback') {
    const storeDir = need('store-dir', values);
    if (!values.apply) {
      const plan = planRollbackExport({ storeDir });
      print({ mode: 'plan', ...plan, chats: plan.chats.length > 50 ? `${plan.chats.length} chats (see totals)` : plan.chats });
      return 0;
    }
    const result = applyRollbackExport({
      storeDir, legacyOut: need('legacy-out', values), confirmPlanHash: need('confirm-plan', values),
      discardPartial: Boolean(values['discard-partial']), cursorSessionIds: readCursorMap(values),
    });
    print({ mode: 'apply', output: result.output, manifestHash: result.manifest.manifestHash, totals: result.manifest.totals, summary: result.manifest.summary });
    return 0;
  }
  if (command === 'verify-rollback') {
    print({ mode: 'verify-rollback', ...verifyRollbackExport({ exportDir: need('export-dir', values), storeDir: /** @type {string | undefined} */ (values['store-dir']) }) });
    return 0;
  }
  throw new HistoryMigrationError('cli_usage', 'Unknown command; use import | verify-import | rollback | verify-rollback');
}

const { positionals, values } = parseArgs({ options: OPTIONS, allowPositionals: true });
if (values.help || positionals.length === 0) {
  process.stdout.write(`${fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace('#!/usr/bin/env node\n', '')}*/\n`);
  process.exit(positionals.length === 0 && !values.help ? 64 : 0);
}
try {
  process.exitCode = run(positionals[0], values);
} catch (error) {
  if (!(error instanceof HistoryMigrationError)) throw error;
  process.stderr.write(`${JSON.stringify({ ok: false, code: error.code, message: error.message, details: error.details })}\n`);
  process.exitCode = 1;
}
