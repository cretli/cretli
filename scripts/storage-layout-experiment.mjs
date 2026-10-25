#!/usr/bin/env node
/**
 * A1 bounded SQLite physical-layout experiment (page_size) with full checks.
 * Report: docs/storage-a1-layout-experiment.md. Synthetic data in OS temp dirs only.
 *
 *   CRETLI_CODE_REVISION=$(git rev-parse HEAD) \
 *   node scripts/storage-layout-experiment.mjs [--samples 15] [--chats 100] [--events 200] \
 *        [--tail 5] [--out result.json] [--md results.md]
 *
 * Variants: baseline (real default page_size, untouched creation path) and at
 * most two unique candidates (8192, 16384) pre-created before the production
 * worker first opens the file. Production storage code is not modified; every
 * variant keeps the full integrity_check + foreign_key_check and the
 * unconditional TRUNCATE barrier under synchronous=FULL (asserted per sample).
 * Cases: `clean` (clean close, no WAL) and `pendingWal` (committed frames that
 * were never checkpointed; proven by the fixture, else UNVERIFIED).
 * Samples run in a deterministic interleaved shuffle, each in a fresh process
 * on its own copy, with a warm OS cache (no cold-disk claim).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  FROZEN_THRESHOLDS, MEDIUM_SHAPE, SEED, DB_FILENAME, buildPendingFixture, candidatePageSizes, copyStoreFiles, defaultPageSize,
  diffExports, environmentInfo, generateStore, inputHash, interleavedOrder, jsonRewriteBytes, logicalExport, readLayout, summarize,
  thresholdsSha256, writeJsonStore, walFrameCount,
} from './storage-layout-lib.mjs';

const CHILD = fileURLToPath(new URL('./storage-layout-child.mjs', import.meta.url));
const DOC = fileURLToPath(new URL('../docs/storage-a1-layout-experiment.md', import.meta.url));
const MODES = ['reopen', 'e2e', 'components'];

function parseArgs(argv) {
  const opt = { samples: 15, chats: MEDIUM_SHAPE.chats, events: MEDIUM_SHAPE.eventsPerChat, tail: 5, out: null, md: null };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (!Object.hasOwn(opt, key)) throw new Error(`unknown option ${argv[i]}`);
    opt[key] = ['out', 'md'].includes(key) ? argv[i + 1] : Number(argv[i + 1]);
  }
  for (const k of ['samples', 'chats', 'events', 'tail']) if (!Number.isInteger(opt[k]) || opt[k] < 1) throw new Error(`invalid --${k}`);
  return opt;
}

/** Spawn one fresh process; a failed sample is returned as { ok: false } and never as a number. */
function runChild(mode, dir, env = {}) {
  const r = spawnSync(process.execPath, ['--no-warnings', CHILD, mode, dir], { encoding: 'utf8', timeout: 180000, env: { ...process.env, ...env } });
  const line = (r.stdout || '').trim().split('\n').filter(Boolean).pop();
  try { return JSON.parse(line); } catch { return { ok: false, stage: 'spawn', error: `status=${r.status} ${(r.stderr || '').slice(0, 300)}` }; }
}

const finite = (v) => Number.isFinite(v);

export async function runExperiment(opt) {
  const shape = /** @type {any} */ ({ chats: opt.chats, eventsPerChat: opt.events, appendRounds: 1 });
  const full = opt.chats === MEDIUM_SHAPE.chats && opt.events === MEDIUM_SHAPE.eventsPerChat;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-a1-layout-'));
  try {
    const baselineSize = defaultPageSize();
    const variants = [{ name: 'baseline', pageSize: null }, ...candidatePageSizes(baselineSize).map((p) => ({ name: `page${p}`, pageSize: p }))];
    const skipped = [8192, 16384].filter((p) => !candidatePageSizes(baselineSize).includes(p));
    const env = environmentInfo(root);
    const result = {
      experiment: 'A1 bounded SQLite physical-layout experiment', generatedAt: new Date().toISOString(), env,
      shape: { ...shape, retention: 2000, seed: SEED, mediumDefinition: full }, inputSha256: inputHash(shape),
      frozenThresholds: FROZEN_THRESHOLDS, frozenThresholdsSha256: thresholdsSha256(),
      method: { samplesPerVariantCase: opt.samples, order: 'per round a seeded shuffle of all variant x case units (and the JSON denominator); each unit = 3 fresh child processes on 3 separate copies', cache: 'warm OS page cache; cold-disk restart NOT measured', tailPerChat: opt.tail },
      skippedDuplicateCandidates: skipped, variants: {},
    };

    // 1. Generate each variant from the exact A1 generator; export logical state; build the pending fixture.
    const fixtures = {};
    for (const v of variants) {
      const dir = path.join(root, `${v.name}-clean`);
      const gen = await generateStore({ dir, pageSize: v.pageSize, shape });
      const layout = readLayout(path.join(dir, DB_FILENAME));
      const cleanWal = walFrameCount(path.join(dir, `${DB_FILENAME}-wal`)).frames;
      const scratch = path.join(root, `${v.name}-export-clean`);
      copyStoreFiles(dir, scratch);
      const cleanExport = logicalExport(scratch);
      fs.rmSync(scratch, { recursive: true, force: true });
      const pendingDir = path.join(root, `${v.name}-pending`);
      const pending = await buildPendingFixture({ cleanDir: dir, workDir: path.join(root, `${v.name}-pending-work`), outDir: pendingDir, shape, tailPerChat: opt.tail });
      fs.rmSync(path.join(root, `${v.name}-pending-work`), { recursive: true, force: true });
      const scratchP = path.join(root, `${v.name}-export-pending`);
      copyStoreFiles(pendingDir, scratchP);
      const pendingExport = logicalExport(scratchP);
      fs.rmSync(scratchP, { recursive: true, force: true });
      fixtures[v.name] = { clean: dir, pendingWal: pendingDir };
      result.variants[v.name] = {
        requestedPageSize: v.pageSize ?? `default(${baselineSize})`, expectedPageSize: v.pageSize ?? baselineSize, layout,
        fixture: { cleanWalFrames: cleanWal, pending, cleanExportSha256: cleanExport.sha256, pendingExportSha256: pendingExport.sha256, tables: cleanExport.tables, maskedColumns: cleanExport.maskedColumns },
        exports: { clean: cleanExport, pendingWal: pendingExport }, generation: gen, cases: { clean: {}, pendingWal: {} },
      };
    }
    const base = result.variants.baseline.exports;
    for (const v of variants) {
      const ex = result.variants[v.name].exports;
      result.variants[v.name].identity = { cleanDiff: diffExports(base.clean, ex.clean), pendingDiff: diffExports(base.pendingWal, ex.pendingWal) };
      result.variants[v.name].identity.pass = result.variants[v.name].identity.cleanDiff.length === 0 && result.variants[v.name].identity.pendingDiff.length === 0;
      delete result.variants[v.name].exports;
    }

    // 2. JSON denominator input (same stream) and byte baseline.
    const jsonInfo = jsonRewriteBytes(shape);
    const jsonDir = path.join(root, 'json');
    writeJsonStore(jsonDir, jsonInfo.documents);
    result.json = { rewriteBytes: jsonInfo.bytes, rewriteBytesPer1000Events: jsonInfo.perThousandEvents, coldLoad: { rawMs: [], failures: [] } };

    // 3. Measurement: interleaved, fresh process + separate copy per sample.
    const units = [...variants.flatMap((v) => ['clean', 'pendingWal'].map((c) => `${v.name}|${c}`)), 'json|json'];
    const raw = Object.fromEntries(units.map((u) => [u, []]));
    let n = 0;
    for (const { round, item } of interleavedOrder(units, opt.samples)) {
      const [name, cas] = item.split('|');
      if (name === 'json') {
        const r = runChild('json', jsonDir);
        r.ok ? result.json.coldLoad.rawMs.push(r.coldLoadMs) : result.json.coldLoad.failures.push(r);
        continue;
      }
      const sample = { round, order: n += 1 };
      for (const mode of MODES) {
        const copy = path.join(root, `s-${n}-${mode}`);
        copyStoreFiles(fixtures[name][cas], copy);
        const r = runChild(mode, copy);
        // F29 evidence from the copy after the run: the barrier must have truncated any WAL.
        if (r.ok && mode !== 'components') r.walBytesAfter = (() => { try { return fs.statSync(path.join(copy, `${DB_FILENAME}-wal`)).size; } catch { return 0; } })();
        sample[mode] = r;
        fs.rmSync(copy, { recursive: true, force: true });
      }
      raw[item].push(sample);
    }

    // 4. Aggregate per variant x case.
    const jsonSummary = summarize(result.json.coldLoad.rawMs);
    result.json.coldLoad = { ...result.json.coldLoad, ...jsonSummary, requested: opt.samples, input: 'same synthetic stream, final pretty-printed documents, one file per chat, retention 2000' };
    const budget = jsonSummary.valid ? FROZEN_THRESHOLDS.startup.maxMultipleOfRemeasuredJsonColdLoad * jsonSummary.median : NaN;
    result.startupBudgetMs = budget;
    for (const v of variants) {
      const rec = result.variants[v.name];
      for (const cas of ['clean', 'pendingWal']) {
        const samples = raw[`${v.name}|${cas}`];
        const ok = (mode) => samples.map((s) => s[mode]).filter((r) => r?.ok);
        const failures = samples.flatMap((s) => MODES.map((m) => s[m]).filter((r) => r && !r.ok));
        const col = (mode, key) => summarize(ok(mode).map((r) => r[key]));
        const reopen = ok('reopen');
        const checks = {
          allSamplesCompleted: failures.length === 0 && samples.length === opt.samples,
          pageSizeEffective: ['reopen', 'e2e'].every((m) => ok(m).length > 0 && ok(m).every((r) => r.effective.page_size === rec.expectedPageSize)),
          integrityForeignKeyOk: ['reopen', 'e2e'].every((m) => ok(m).length > 0 && ok(m).every((r) => r.verify.integrityOk && r.verify.foreignKeyViolations === 0)),
          f29BarrierBusy0AllFramesCheckpointed: reopen.length > 0 && reopen.every((r) => r.f29.busy === 0 && r.f29.checkpointed === r.f29.log),
          walTruncatedAfterBarrier: ['reopen', 'e2e'].every((m) => ok(m).length > 0 && ok(m).every((r) => r.walBytesAfter === 0 || r.walBytesAfter === undefined)),
          walFullSynchronous: reopen.length > 0 && reopen.every((r) => r.effective.journal_mode === 'wal' && r.effective.synchronous === 2 && r.effective.foreign_keys === 1),
          pendingProven: cas === 'clean' ? true : rec.fixture.pending.proven === true && reopen.every((r) => r.walBytesBefore > 0),
        };
        rec.cases[cas] = {
          n: samples.length, failures,
          a1OpenBarrierColdPage: col('reopen', 'totalMs'), a1Open: col('reopen', 'openMs'), a1Barrier: col('reopen', 'barrierMs'), a1ColdPage: col('reopen', 'coldReadMs'),
          e2eSpawnToReadyPlusColdPage: col('e2e', 'totalMs'), e2eSpawnToReady: col('e2e', 'startMs'), e2eColdPage: col('e2e', 'coldReadMs'),
          e2eWorkerOpen: summarize(ok('e2e').map((r) => r.phases.openMs)), e2eWorkerBarrier: summarize(ok('e2e').map((r) => r.phases.barrierMs)),
          components: Object.fromEntries(['roOpenMs', 'peeksMs', 'integrityMs', 'foreignKeyMs', 'roCloseMs', 'rwOpenMs', 'walPragmaMs', 'migrationsMs', 'barrierMs', 'componentsTotalMs'].map((k) => [k, col('components', k)])),
          componentsNote: 'components are a separate run on its own copy; medians are never summed to replace the direct totals above',
          ratioToJsonColdLoad: { a1: col('reopen', 'totalMs').median / jsonSummary.median, e2e: col('e2e', 'totalMs').median / jsonSummary.median },
          checks, rawSamples: samples,
        };
      }
      rec.verdict = verdictFor(rec, result, budget, opt.samples);
    }
    result.screeningNote = 'GO means "shortlisted by screening" only; it is not a production PASS and A3a stays NO-GO. Shortlisting would still require one full run of the four frozen workloads against the JSON baseline.';
    return result;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** GO / NO-GO / UNVERIFIED per variant; any missing or non-finite input is UNVERIFIED, never GO. */
export function verdictFor(rec, result, budget, requestedSamples) {
  const reasons = [];
  const unverified = [];
  const T = FROZEN_THRESHOLDS;
  const gen = rec.generation;
  if (!finite(budget)) unverified.push('JSON cold-load denominator missing or non-finite');
  if (rec.layout.pageSize !== rec.expectedPageSize) unverified.push(`effective page_size ${rec.layout.pageSize} != requested ${rec.expectedPageSize}`);
  if (!rec.identity.pass) reasons.push(`logical export differs from baseline (${[...rec.identity.cleanDiff, ...rec.identity.pendingDiff].join(',')})`);
  for (const cas of ['clean', 'pendingWal']) {
    const c = rec.cases[cas];
    for (const [k, ok] of Object.entries(c.checks)) if (!ok) (k === 'pendingProven' || k === 'allSamplesCompleted' ? unverified : reasons).push(`${cas}: check ${k} failed`);
    if (c.n < Math.max(requestedSamples, T.startup.minSamplesPerVariantCase)) unverified.push(`${cas}: n=${c.n} < ${T.startup.minSamplesPerVariantCase}`);
    for (const key of ['a1OpenBarrierColdPage', 'e2eSpawnToReadyPlusColdPage']) if (!c[key].valid) unverified.push(`${cas}: ${key} has NaN/missing samples`);
    if (c.a1OpenBarrierColdPage.valid && finite(budget) && c.a1OpenBarrierColdPage.median > budget) reasons.push(`${cas}: A1 start median ${c.a1OpenBarrierColdPage.median} ms > ${budget.toFixed(3)} ms (2x JSON cold load)`);
  }
  const metric = (value, limit, label, bad) => { if (!finite(value)) unverified.push(`${label} not measurable`); else if (value > limit) bad.push(`${label} ${value} > ${limit}`); };
  const wl = [];
  metric(gen.appendLatencyMs.p95, T.apiAppendWallMs.p95, 'append p95', wl); metric(gen.appendLatencyMs.p99, T.apiAppendWallMs.p99, 'append p99', wl);
  metric(gen.workerRequestMs?.p95, T.workerQueueWaitPlusExecuteMs.p95, 'worker request p95', wl); metric(gen.workerRequestMs?.p99, T.workerQueueWaitPlusExecuteMs.p99, 'worker request p99', wl);
  metric(gen.queryLatencyMs.p95, T.historyPageQueryMs.p95, 'page query p95', wl); metric(gen.queryLatencyMs.p99, T.historyPageQueryMs.p99, 'page query p99', wl);
  metric(gen.eventLoopDelayMs.p99, T.eventLoopDelayMs.p99, 'event-loop p99', wl); metric(gen.eventLoopDelayMs.max, T.eventLoopDelayMs.max, 'event-loop max', wl);
  metric(gen.queueAgeMs?.p95, T.queueAgeMs.steadyP95, 'queue age p95', wl);
  const pct = gen.bytesWritten * 100 / result.json.rewriteBytes;
  metric(pct, T.bytesWrittenPct.maxPercentOfJsonRewriteBytes, 'bytes written % of JSON', wl);
  reasons.push(...wl.map((m) => `workload screening: ${m}`));
  const outstanding = ['burst queue-age max (not run)', `FULL checkpoint stall p99 (n=${gen.fullCheckpoint.n} < 30)`, 'small/growing/mixed workloads (not run)'];
  const verdict = reasons.length ? 'NO-GO' : unverified.length ? 'UNVERIFIED' : 'GO (screening shortlist only)';
  return { verdict, reasons, unverified, outstandingBeforeAnyProductionDecision: outstanding, bytesWrittenPercentOfJson: finite(pct) ? Number(pct.toFixed(3)) : NaN };
}

export function renderMarkdown(result) {
  const L = [];
  const f = (s) => (s && s.valid ? `${s.median} / ${s.p95} / ${s.n}` : 'UNVERIFIED');
  L.push(`Environment: node ${result.env.node}, SQLite ${result.env.sqlite}, ${result.env.platform}, fs ${result.env.fsType}, default page_size ${result.env.defaultPageSize}, revision ${result.env.codeRevision}, storage-code sha256 ${result.env.storageCodeSha256.slice(0, 16)}...`);
  L.push(`Input: seed ${result.shape.seed}, ${result.shape.chats} chats x ${result.shape.eventsPerChat} events x ${result.shape.appendRounds} round, retention ${result.shape.retention}, input sha256 ${result.inputSha256}.`);
  L.push('', `JSON cold load re-measured: median / p95 / n = ${f(result.json.coldLoad)} ms; 2x budget = ${Number.isFinite(result.startupBudgetMs) ? result.startupBudgetMs.toFixed(3) : 'UNVERIFIED'} ms.`, '');
  L.push('| Variant | Case | A1 open+barrier+coldpage median / p95 / n | x JSON | E2E spawn-to-ready+coldpage median / p95 / n | x JSON | Verdict |', '| --- | --- | --- | ---: | --- | ---: | --- |');
  for (const [name, rec] of Object.entries(result.variants)) {
    for (const cas of ['clean', 'pendingWal']) {
      const c = rec.cases[cas];
      L.push(`| ${name} | ${cas} | ${f(c.a1OpenBarrierColdPage)} | ${c.ratioToJsonColdLoad.a1.toFixed(2)} | ${f(c.e2eSpawnToReadyPlusColdPage)} | ${c.ratioToJsonColdLoad.e2e.toFixed(2)} | ${rec.verdict.verdict} |`);
    }
  }
  return `${L.join('\n')}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const opt = parseArgs(process.argv.slice(2));
  if (!process.env.CRETLI_LAYOUT_SKIP_DOC_CHECK) {
    const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : '';
    if (!doc.includes(thresholdsSha256())) { console.error(`refusing to measure: ${DOC} does not contain frozen thresholds sha256 ${thresholdsSha256()}`); process.exit(2); }
  }
  const result = await runExperiment(opt);
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (opt.out) fs.writeFileSync(opt.out, json); else process.stdout.write(json);
  if (opt.md) fs.writeFileSync(opt.md, renderMarkdown(result));
  console.error(Object.entries(result.variants).map(([n, r]) => `${n}: ${r.verdict.verdict}`).join('\n'));
}
