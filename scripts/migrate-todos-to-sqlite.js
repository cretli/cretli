#!/usr/bin/env node
/**
 * Offline todos migration tool (JSON documents <-> SQLite store). Run with every Cretli writer stopped.
 * It never touches a running server. Production is not switched by merely having this tool: the
 * `todos-backend.json` marker is written only by `--apply`, after verification.
 *
 *   --data-dir D --dataset-generation G                  plan (same as --dry-run); prints manifest + plan hash
 *   --data-dir D --dataset-generation G --apply --confirm-plan HASH
 *   rollback-export --data-dir D --out O                 fresh logical export (documents + receipts/fencing sidecar)
 *   rollback-verify --export-dir O [--data-dir D]
 *   rollback-source --data-dir D --source-dir S          is S an acceptable rollback source? (old JSON after ACK: no)
 *   rollback-activate --data-dir D --export-dir O        replace todos/ with the export and select legacy-rollback
 *
 * Output is JSON with codes and counts only (no todo text). See docs/storage-contract.md.
 */
import { parseArgs } from 'node:util';
import {
  activateTodosRollback, applyTodosMigration, assertTodosRollbackSource, exportTodosRollback, planTodosMigration,
  verifyTodosRollbackExport,
} from '../lib/storage/todos-migration.js';
import { TodosBackendError } from '../lib/persist/todos-backend-marker.js';

const OPTIONS = {
  'data-dir': { type: 'string' },
  'dataset-generation': { type: 'string' },
  'confirm-plan': { type: 'string' },
  'min-quiet-ms': { type: 'string' },
  out: { type: 'string' },
  'export-dir': { type: 'string' },
  'source-dir': { type: 'string' },
  apply: { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
};

/** @param {string} name @param {Record<string, unknown>} values @returns {string} */
function need(name, values) {
  const value = values[name];
  if (typeof value !== 'string' || !value) throw new TodosBackendError('cli_usage', `Missing --${name}`);
  return value;
}

/** @param {unknown} value */
function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** @param {string} command @param {Record<string, any>} values @returns {number} */
function run(command, values) {
  const minQuietMs = values['min-quiet-ms'] === undefined ? undefined : Number(values['min-quiet-ms']);
  if (command === 'rollback-export') {
    const result = exportTodosRollback({ dataDir: need('data-dir', values), outDir: need('out', values) });
    print({ mode: 'rollback-export', outDir: result.outDir, manifestHash: result.manifestHash, totals: result.manifest.totals });
    return 0;
  }
  if (command === 'rollback-verify') {
    const result = verifyTodosRollbackExport({ exportDir: need('export-dir', values), dataDir: values['data-dir'] });
    print({ mode: 'rollback-verify', manifestHash: result.manifestHash, totals: result.totals });
    return 0;
  }
  if (command === 'rollback-source') {
    print({ mode: 'rollback-source', ...assertTodosRollbackSource({ dataDir: need('data-dir', values), sourceDir: need('source-dir', values) }) });
    return 0;
  }
  if (command === 'rollback-activate') {
    const result = activateTodosRollback({ dataDir: need('data-dir', values), exportDir: need('export-dir', values) });
    print({ mode: 'rollback-activate', manifestHash: result.manifestHash, preservedDirectory: result.preservedDirectory, backend: result.marker.backend });
    return 0;
  }
  const common = { dataDir: need('data-dir', values), datasetGeneration: need('dataset-generation', values), minQuietMs };
  if (!values.apply || values['dry-run']) {
    const plan = planTodosMigration(common);
    print({ mode: 'plan', ...plan, files: plan.files.length > 50 ? `${plan.files.length} files (see totals)` : plan.files });
    return 0;
  }
  const result = applyTodosMigration({ ...common, confirmPlanHash: need('confirm-plan', values) });
  print({ mode: 'apply', manifestHash: result.manifestHash, totals: result.totals, verification: result.verification, backend: result.marker.backend });
  return 0;
}

try {
  const { values, positionals } = /** @type {{ values: Record<string, any>, positionals: string[] }} */ (parseArgs({ options: /** @type {any} */ (OPTIONS), allowPositionals: true }));
  if (values.help) {
    process.stdout.write('See the header of scripts/migrate-todos-to-sqlite.js\n');
    process.exit(0);
  }
  process.exit(run(positionals[0] ?? 'migrate', values));
} catch (error) {
  const e = /** @type {any} */ (error);
  process.stderr.write(`${JSON.stringify({ ok: false, code: e?.code ?? 'error', message: String(e?.message ?? e), details: e?.details })}\n`);
  process.exit(2);
}
