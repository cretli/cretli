/**
 * Live R7 validation of one adapter against the REAL installed SDK.
 *
 * The orchestration is driver-agnostic so it can be unit-tested with a fake
 * driver; `scripts/validate-recovery-adapter.mjs` supplies the real
 * claude/codex drivers. Procedure (two short model turns, cost is bounded):
 *
 *  1. `driver.startAndKill` starts a turn that must run one shell command (it
 *     appends a line to a marker file) and then stay busy; the driver kills the
 *     executor process after the marker line appears and reports the session id.
 *  2. `driver.resume` resumes that saved session in a new process with a prompt
 *     that asks for the secret word from turn one without using any tool.
 *  3. Checks: the secret word is recalled (context kept), the resumed session id
 *     is the original one, the marker still holds exactly one line and the
 *     resume made no tool call (no double execution, no replayed turn).
 *  4. The recovery store walks the run through launch → ack → interrupted and the
 *     automatic-resume policy accepts exactly that confirmed interruption.
 *
 * A PASS is persisted under `harness@sdkVersion`; a failure is persisted too so
 * the operator sees it, but it never lifts the gate.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  RECOVERY_VALIDATION_SCENARIOS,
  evaluateRecoveryAdapterValidation,
  resolveHarnessSdkPackageInfo,
} from './adapter-validation.ts';
import { recordAdapterValidationResult } from './adapter-validation-results.ts';
import type { StoredAdapterValidation } from './adapter-validation-results.ts';
import { resolveRecoveryAdapter } from './recovery-contract.ts';
import { createRecoveryIds } from './recovery-ids.ts';
import { beginRunLaunch, recordExecutorAck } from './recovery-lifecycle.ts';
import { evaluateAutomaticResume } from './recovery-policy.ts';
import { closeRecoveryStore, getRun, openRecoveryStore, transitionRun } from './recovery-store.ts';

export interface LiveValidationDriver {
  /** Runs turn one, kills the executor once `markerFile` has a line, returns the session id. */
  startAndKill(input: { cwd: string, markerFile: string, secret: string, timeoutMs: number }): Promise<{ sessionId: string, killed: boolean }>;
  /** Resumes `sessionId` in a fresh process and reports what the turn did. */
  resume(input: { cwd: string, sessionId: string, timeoutMs: number }): Promise<{ sessionId: string, replyText: string, toolCalls: number }>;
}

function markerLines(markerFile: string): number {
  try {
    return readFileSync(markerFile, 'utf8').split('\n').filter((line) => line.trim()).length;
  } catch {
    return 0;
  }
}

function step(ok: boolean, detail: Record<string, any>): Record<string, any> {
  return { status: ok ? 'validated' : 'failed', ...detail };
}

function storeStatesStep(harness: string, sessionId: string): Record<string, any> {
  const dir = mkdtempSync(path.join(tmpdir(), 'recovery-live-val-'));
  const store = openRecoveryStore({ dataDir: dir });
  try {
    const ids = createRecoveryIds();
    const launched = beginRunLaunch({
      ...ids, family: 'chat', owner: 'chat-run-service', chatId: `live-val-${harness}`, harness, sessionId,
    }, store);
    const acked = recordExecutorAck({
      logicalRunId: ids.logicalRunId,
      expectedRevision: launched.run.revision,
      source: 'adapter_ack',
      adapterRunId: `run-${ids.requestId.slice(0, 8)}`,
    }, store);
    const moved = transitionRun({
      logicalRunId: ids.logicalRunId,
      expectedRevision: Number(acked.run?.revision),
      to: 'interrupted',
      reason: 'server_restart',
    }, store);
    const run = getRun(ids.logicalRunId, store);
    const policy = evaluateAutomaticResume({
      mode: 'automatic',
      run,
      liveness: 'dead',
      capabilities: { canResumeSession: resolveRecoveryAdapter(harness).resumeStrategy !== '' },
      adapterValidated: true,
    });
    const ok = acked.applied === true && moved.applied === true && run?.state === 'interrupted'
      && run?.acceptance?.state === 'accepted' && policy.allowed === true;
    return step(ok, { runState: run?.state || '', acceptance: run?.acceptance?.state || '', policyReason: policy.reason });
  } finally {
    closeRecoveryStore(store);
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * @returns The stored entry (also written to `resultsPath`/default data path unless `persist: false`).
 */
export async function runLiveAdapterValidation(options: {
  harness: string,
  driver: LiveValidationDriver,
  repoRoot?: string,
  resultsPath?: string,
  timeoutMs?: number,
  persist?: boolean,
  now?: () => Date,
}): Promise<StoredAdapterValidation> {
  const harness = String(options.harness || '').trim().toLowerCase();
  const pkg = resolveHarnessSdkPackageInfo(harness, options.repoRoot);
  if (pkg.unpinned) throw new Error(`Installed SDK version for ${harness} cannot be read; install the SDK first.`);
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 120_000;
  const workDir = mkdtempSync(path.join(tmpdir(), `recovery-live-${harness}-`));
  const markerFile = path.join(workDir, 'marker.txt');
  const secret = `PINEAPPLE-${createRecoveryIds().requestId.slice(0, 8).toUpperCase()}`;
  const steps: Record<string, Record<string, any>> = {};
  try {
    Object.assign(steps, evaluateRecoveryAdapterValidation({ harness, openEphemeralStore: true }));
    let sessionId = '';
    try {
      const started = await options.driver.startAndKill({ cwd: workDir, markerFile, secret, timeoutMs });
      sessionId = started.sessionId;
      const linesAfterKill = markerLines(markerFile);
      const resumed = sessionId
        ? await options.driver.resume({ cwd: workDir, sessionId, timeoutMs })
        : { sessionId: '', replyText: '', toolCalls: -1 };
      const linesAfterResume = markerLines(markerFile);
      const checks = {
        sessionCaptured: Boolean(sessionId),
        executorKilled: started.killed === true,
        toolRanBeforeKill: linesAfterKill === 1,
        contextKept: resumed.replyText.includes(secret),
        sameSession: resumed.sessionId === sessionId,
        noDoubleToolExecution: linesAfterResume === 1,
        noToolCallOnResume: resumed.toolCalls === 0,
      };
      steps.crash_resume = step(Object.values(checks).every(Boolean), { checks });
    } catch (err) {
      steps.crash_resume = step(false, { error: err instanceof Error ? err.message : String(err) });
    }
    steps.store_states = storeStatesStep(harness, sessionId || 'session-unknown');
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  const passed = [...RECOVERY_VALIDATION_SCENARIOS, 'crash_resume', 'store_states']
    .every((name) => steps[name]?.status === 'validated');
  const entry: StoredAdapterValidation = {
    harness,
    sdkVersion: pkg.sdkVersion,
    packageName: pkg.packageName,
    versionKey: `${harness}@${pkg.sdkVersion}`,
    status: passed ? 'passed' : 'failed',
    validatedAt: (options.now ? options.now() : new Date()).toISOString(),
    steps,
  };
  if (options.persist !== false) recordAdapterValidationResult(entry, options.resultsPath);
  return entry;
}
