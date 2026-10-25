/**
 * Opt-in Codex compaction overrides.
 *
 * The installed Codex CLI (0.160.0) has no `codex config`/`codex compact`
 * subcommand, but it does read typed `--config key=value` overrides. The SDK
 * already exposes them as `CodexOptions.config`, so Cretli can lower/raise the
 * native auto-compaction trigger without touching Codex history.
 *
 * Verified keys (see `docs/codex/COMPACTION.md`):
 * - `model_auto_compact_token_limit` (int) — token count that triggers
 *   auto-compaction. Codex derives it from the model catalog when unset.
 * - `model_post_turn_compact_threshold_percent` (0..100) — post-turn trigger.
 *
 * Everything here is OFF by default: with no setting/env the `config` object
 * is empty and Codex keeps its model-derived behavior. Prompt caching itself
 * has no configurable seam in Codex and is not touched.
 */

import { loadSettings } from '../persist/settings.js';

export const CODEX_COMPACTION_ENV = Object.freeze({
  autoCompactTokenLimit: 'CRETLI_CODEX_AUTO_COMPACT_TOKEN_LIMIT',
  postTurnCompactThresholdPercent: 'CRETLI_CODEX_POST_TURN_COMPACT_THRESHOLD_PERCENT',
});

function parseInteger(value: unknown, bounds: { min?: number, max?: number } = {}): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return null;
  if (Number.isFinite(bounds.min) && parsed < Number(bounds.min)) return null;
  if (Number.isFinite(bounds.max) && parsed > Number(bounds.max)) return null;
  return parsed;
}

/**
 * Resolve the opt-in Codex compaction overrides.
 */
export type CodexCompactionOverrides = { autoCompactTokenLimit?: number; postTurnCompactThresholdPercent?: number };

export function resolveCodexCompactionConfig(
  settings: { codexCompaction?: CodexCompactionOverrides } | null = null,
  env: Record<string, string | undefined> = process.env,
): CodexCompactionOverrides {
  const source = env && typeof env === 'object' ? env : {};
  const settingsSource = settings || loadSettings();
  const configured = settingsSource?.codexCompaction;
  const fromSettings: CodexCompactionOverrides = configured && typeof configured === 'object' ? configured : {};

  const limit = parseInteger(
    source[CODEX_COMPACTION_ENV.autoCompactTokenLimit] ?? fromSettings.autoCompactTokenLimit,
    { min: 1 },
  );
  const percent = parseInteger(
    source[CODEX_COMPACTION_ENV.postTurnCompactThresholdPercent] ?? fromSettings.postTurnCompactThresholdPercent,
    { min: 0, max: 100 },
  );

  const resolved: { autoCompactTokenLimit?: number, postTurnCompactThresholdPercent?: number } = {};
  if (limit !== null) resolved.autoCompactTokenLimit = limit;
  if (percent !== null) resolved.postTurnCompactThresholdPercent = percent;
  return resolved;
}

/**
 * Map the resolved overrides to the Codex `--config` object the SDK flattens
 * into dotted TOML paths. Returns `{}` when nothing is configured.
 */
export function buildCodexConfigObject(resolved: ReturnType<typeof resolveCodexCompactionConfig>): Record<string, number> {
  const config: Record<string, number> = {};
  if (Number.isInteger(resolved?.autoCompactTokenLimit)) {
    config.model_auto_compact_token_limit = resolved.autoCompactTokenLimit as number;
  }
  if (Number.isInteger(resolved?.postTurnCompactThresholdPercent)) {
    config.model_post_turn_compact_threshold_percent = resolved.postTurnCompactThresholdPercent as number;
  }
  return config;
}
