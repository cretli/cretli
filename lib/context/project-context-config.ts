/**
 * Validates optional `.cretli/context.json` under the authorized project root.
 * Repo config may only reference project-relative files; never host/shared/user/bundled sources.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  assertFileSizeWithinLimit,
  assertPathWithinProjectRoot,
  isHostOnlyContextSourceLabel,
  resolveTrustedRoot,
  SOURCE_TRUST_ERROR_CODES,
} from './source-trust.ts';
import { parseProjectContextConfig, PROJECT_CONTEXT_CONFIG_VERSION } from './registry-contract.ts';
import { validateRepoContextSettings } from './context-settings.ts';

export const PROJECT_CONTEXT_CONFIG_REL = '.cretli/context.json';

export function loadValidatedProjectContextConfig(projectRoot: string): { ok: true, config: Record<string, any> | null, path: string } | { ok: false, error: string, code?: string } {
  const rootReal = resolveTrustedRoot(projectRoot);
  if (!rootReal) {
    return { ok: false, error: 'Invalid project root', code: SOURCE_TRUST_ERROR_CODES.OUTSIDE_ROOT };
  }
  const configPath = path.join(rootReal, PROJECT_CONTEXT_CONFIG_REL);
  if (!fs.existsSync(configPath)) {
    return { ok: true, config: null, path: configPath };
  }
  const sizeCheck = assertFileSizeWithinLimit(configPath, 'config');
  if (sizeCheck.ok === false) {
    return { ok: false, error: sizeCheck.error, code: sizeCheck.code };
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return { ok: false, error: 'Invalid JSON in project context config' };
  }
  const schema = parseProjectContextConfig(parsed);
  if (!schema.ok) {
    return { ok: false, error: schema.error as string };
  }
  const config = schema.value as Record<string, any>;
  if (Number(config.version) !== PROJECT_CONTEXT_CONFIG_VERSION) {
    return { ok: false, error: 'Unsupported context config version' };
  }
  const entries = Array.isArray(config.entries) ? config.entries : [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      return { ok: false, error: 'Each config entry must be an object' };
    }
    if (isHostOnlyContextSourceLabel(entry.source)) {
      return {
        ok: false,
        error: 'Project config cannot assign host-only sources',
        code: SOURCE_TRUST_ERROR_CODES.HOST_SOURCE_IN_REPO_CONFIG,
      };
    }
    const relPath = String(entry.path || entry.relPath || '').trim();
    if (!relPath) {
      return { ok: false, error: 'Config entry missing path' };
    }
    const within = assertPathWithinProjectRoot(rootReal, relPath);
    if (within.ok === false) {
      return { ok: false, error: within.error, code: within.code };
    }
  }
  // Optional `settings` / `profiles`: same schema as every other layer; host-only keys are rejected.
  const settingsCheck = validateRepoContextSettings(config);
  if (settingsCheck.ok === false) {
    return { ok: false, error: settingsCheck.error, code: settingsCheck.code };
  }
  return { ok: true, config, path: configPath };
}
