/**
 * Persisted results of the live R7 adapter validation (kill mid-run, resume the
 * saved session) keyed by `harness@sdkVersion`.
 *
 * The file is the only thing that can lift `enableGateValidation` from
 * `pending` to `validated`. Reads fail closed: a missing, unreadable, malformed
 * or version-mismatched entry means "not validated". An SDK upgrade changes the
 * version key, so the old PASS never applies to the new version.
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveDataPath } from '../runtime-paths.js';

export const RECOVERY_ADAPTER_VALIDATION_RESULTS_FILE = 'recovery-adapter-validation.json';
export const RECOVERY_ADAPTER_VALIDATION_RESULTS_SCHEMA_VERSION = 1;

export interface StoredAdapterValidation {
  harness: string;
  sdkVersion: string;
  packageName: string;
  versionKey: string;
  status: 'passed' | 'failed';
  validatedAt: string;
  /** Per-step outcome: scenario names plus `crash_resume` and `store_states`. */
  steps: Record<string, Record<string, any>>;
}

function text(value: unknown): string {
  return String(value ?? '').trim();
}

export function resolveAdapterValidationResultsPath(resultsPath?: unknown): string {
  return text(resultsPath) || resolveDataPath(RECOVERY_ADAPTER_VALIDATION_RESULTS_FILE);
}

/**
 * @returns Stored entries by version key; `{}` for any read problem.
 */
export function readAdapterValidationResults(resultsPath?: unknown): Record<string, StoredAdapterValidation> {
  try {
    const raw = JSON.parse(fs.readFileSync(resolveAdapterValidationResultsPath(resultsPath), 'utf8'));
    if (!raw || typeof raw !== 'object' || raw.schemaVersion !== RECOVERY_ADAPTER_VALIDATION_RESULTS_SCHEMA_VERSION) return {};
    const results = raw.results;
    if (!results || typeof results !== 'object' || Array.isArray(results)) return {};
    return results as Record<string, StoredAdapterValidation>;
  } catch {
    return {};
  }
}

/**
 * Entry for the exact installed version, or null. Only a `passed` entry whose
 * stored harness/version agree with its key and whose required steps all passed
 * is returned; anything else is treated as not validated.
 */
export function getStoredAdapterValidation(
  harness: unknown,
  sdkVersion: unknown,
  resultsPath?: unknown,
): StoredAdapterValidation | null {
  const id = text(harness).toLowerCase();
  const version = text(sdkVersion);
  if (!id || !version || version === 'unknown') return null;
  const key = `${id}@${version}`;
  const entry = readAdapterValidationResults(resultsPath)[key];
  if (!entry || typeof entry !== 'object') return null;
  if (entry.status !== 'passed') return null;
  if (text(entry.harness).toLowerCase() !== id || text(entry.sdkVersion) !== version || text(entry.versionKey) !== key) return null;
  const steps = entry.steps && typeof entry.steps === 'object' ? entry.steps : {};
  if (steps.crash_resume?.status !== 'validated' || steps.store_states?.status !== 'validated') return null;
  return entry;
}

/**
 * Upserts one entry (atomic temp-file rename) and keeps entries of other keys.
 */
export function recordAdapterValidationResult(entry: StoredAdapterValidation, resultsPath?: unknown): string {
  const file = resolveAdapterValidationResultsPath(resultsPath);
  const results = readAdapterValidationResults(resultsPath);
  results[entry.versionKey] = entry;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({
    schemaVersion: RECOVERY_ADAPTER_VALIDATION_RESULTS_SCHEMA_VERSION,
    results,
  }, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return file;
}
