#!/usr/bin/env node
/**
 * Live R7 validation of a chat-restart-recovery adapter (claude, codex).
 *
 *   node scripts/validate-recovery-adapter.mjs --list
 *   node scripts/validate-recovery-adapter.mjs --harness claude --yes
 *
 * Runs two SHORT real model turns against the installed SDK (the first is killed
 * mid-run, the second resumes the saved session) and stores the result in
 * data/recovery-adapter-validation.json under `harness@sdkVersion`. It uses your
 * normal local SDK login and costs a few cents. `--yes` acknowledges that cost.
 * Exit code: 0 PASS, 1 FAIL, 2 usage error.
 */

import { parseArgs } from 'node:util';
import { runLiveAdapterValidation } from '../lib/recovery/adapter-live-validation.ts';
import { listAutomaticResumeAdapters } from '../lib/recovery/adapter-validation.ts';
import { resolveAdapterValidationResultsPath } from '../lib/recovery/adapter-validation-results.ts';
import { LIVE_VALIDATION_HARNESSES, createLiveValidationDriver } from './lib/recovery-validation-drivers.mjs';

const { values } = parseArgs({
  options: {
    harness: { type: 'string' },
    list: { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
    timeout: { type: 'string', default: '120' },
  },
});

if (values.list) {
  for (const row of listAutomaticResumeAdapters()) {
    const live = LIVE_VALIDATION_HARNESSES.includes(row.harness) ? 'live driver' : 'no live driver';
    console.log(`${row.harness}@${row.sdkVersion || 'unknown'}\t${row.validated ? 'validated' : 'pending'}\t${live}`);
  }
  console.log(`results file: ${resolveAdapterValidationResultsPath()}`);
  process.exit(0);
}

const harness = String(values.harness || '').toLowerCase();
if (!LIVE_VALIDATION_HARNESSES.includes(harness)) {
  console.error(`--harness must be one of: ${LIVE_VALIDATION_HARNESSES.join(', ')}`);
  process.exit(2);
}
if (!values.yes) {
  console.error('This runs two short real model turns (small but real cost). Re-run with --yes to proceed.');
  process.exit(2);
}

const entry = await runLiveAdapterValidation({
  harness,
  driver: createLiveValidationDriver(harness),
  timeoutMs: Math.max(10, Number(values.timeout) || 120) * 1000,
});
for (const [name, step] of Object.entries(entry.steps)) {
  console.log(`${step.status === 'validated' ? 'PASS' : 'FAIL'}  ${name}${step.checks ? ` ${JSON.stringify(step.checks)}` : ''}${step.error ? ` ${step.error}` : ''}`);
}
console.log(`${entry.status === 'passed' ? 'PASS' : 'FAIL'}  ${entry.versionKey} -> ${resolveAdapterValidationResultsPath()}`);
process.exit(entry.status === 'passed' ? 0 : 1);
