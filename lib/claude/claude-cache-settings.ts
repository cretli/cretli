/**
 * Opt-in Claude Code caching / auto-compaction environment overrides.
 *
 * Cretli cannot rewrite Claude history, and Claude Code already caches prompts
 * automatically. These knobs only tune the CLI's own native behavior and are
 * all OFF by default:
 *
 * - `ENABLE_PROMPT_CACHING_1H` requests the 1-hour prompt-cache TTL.
 * - `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` changes the auto-compaction percentage.
 * - `DISABLE_AUTO_COMPACT` turns automatic compaction off.
 *
 * IMPORTANT: these variable names come from third-party issue reports
 * (anthropics/claude-code #48082, #49139), not from official Anthropic
 * documentation, and the 1-hour cache reportedly does not work for every API
 * key. Treat them as unverified, keep them opt-in, and verify by measuring
 * `cache_creation.ephemeral_1h` before relying on them.
 */

import { loadSettings } from '../persist/settings.js';
import { normalizeAutoContextCompressionThresholdPercent } from '../context-compression.js';

export interface ClaudeCacheSettings {
  promptCaching1h: boolean;
  autocompactPctOverride: number | null;
  disableAutoCompact: boolean;
}

type ClaudeSettingsSource = ReturnType<typeof loadSettings>;
type ClaudeEnv = Record<string, string | undefined>;

/** Defaults stay off so an existing Claude setup is unchanged. */
export const CLAUDE_CACHE_SETTINGS_DEFAULTS = Object.freeze({
  promptCaching1h: false,
  autocompactPctOverride: null,
  disableAutoCompact: false,
});

export const CLAUDE_CACHE_ENV = Object.freeze({
  promptCaching1h: 'ENABLE_PROMPT_CACHING_1H',
  autocompactPctOverride: 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
  disableAutoCompact: 'DISABLE_AUTO_COMPACT',
});

function isEnabled(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value == null) return false;
  const raw = String(value).trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * Normalize the auto-compaction percentage. Claude expects a positive integer
 * percentage; out-of-range input is dropped instead of silently clamping.
 */
export function normalizeClaudeAutocompactPct(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) return null;
  return parsed;
}

/**
 * Resolve the opt-in cache settings from config.json.
 *
 * @param settings - loadSettings() result; loaded when omitted
 */
export function resolveClaudeCacheSettings(settings: ClaudeSettingsSource | null = null): ClaudeCacheSettings {
  const source = settings || loadSettings();
  return {
    promptCaching1h: isEnabled(source?.claudePromptCaching1h),
    autocompactPctOverride: normalizeClaudeAutocompactPct(source?.claudeAutocompactPctOverride),
    disableAutoCompact: isEnabled(source?.claudeDisableAutoCompact),
  };
}

/**
 * Merge the opt-in cache/compaction overrides into a Claude subprocess env.
 * Mutates and returns `env` for convenience. A disabled/normalized-away option
 * is left untouched, so an operator's own process env still passes through.
 */
export function applyClaudeCacheEnv(env: ClaudeEnv, settings: ClaudeSettingsSource | null = null): ClaudeEnv {
  const target: ClaudeEnv = env && typeof env === 'object' ? env : {};
  const resolved = resolveClaudeCacheSettings(settings);
  if (resolved.promptCaching1h) target[CLAUDE_CACHE_ENV.promptCaching1h] = '1';
  if (resolved.autocompactPctOverride !== null) {
    target[CLAUDE_CACHE_ENV.autocompactPctOverride] = String(resolved.autocompactPctOverride);
  }
  if (resolved.disableAutoCompact) target[CLAUDE_CACHE_ENV.disableAutoCompact] = '1';
  return target;
}

/**
 * Per-chat bridge between Cretli's auto context compression setting and
 * Claude Code's native auto-compaction. A Claude chat cannot use Cretli's
 * summarize + reset path (that one rotates a Cursor SDK agent), so when the
 * chat opts into auto-compression its threshold is handed to the CLI instead:
 * Claude compacts in place at that fill level and keeps the session.
 *
 * Returns the percentage to apply, or null when the chat did not opt in.
 */
export function resolveClaudeChatAutocompactPct(
  chat: { autoContextCompressionEnabled?: unknown; autoContextCompressionThreshold?: unknown } | null | undefined,
): number | null {
  if (!chat || typeof chat !== 'object' || chat.autoContextCompressionEnabled !== true) return null;
  return normalizeAutoContextCompressionThresholdPercent(chat.autoContextCompressionThreshold);
}

/**
 * Overlay the per-chat compaction threshold on a Claude subprocess env built by
 * `buildClaudeProcessEnv`. The chat's explicit opt-in wins over the global
 * percentage and over a global `DISABLE_AUTO_COMPACT`. Without an opt-in the
 * env is left untouched. Mutates and returns `env`.
 */
export function applyClaudeChatCompactionEnv(
  env: ClaudeEnv,
  chat: Parameters<typeof resolveClaudeChatAutocompactPct>[0],
): ClaudeEnv {
  const target: ClaudeEnv = env && typeof env === 'object' ? env : {};
  const pct = resolveClaudeChatAutocompactPct(chat);
  if (pct === null) return target;
  target[CLAUDE_CACHE_ENV.autocompactPctOverride] = String(pct);
  delete target[CLAUDE_CACHE_ENV.disableAutoCompact];
  return target;
}

/**
 * Secret-free signature of the compaction env. Part of the session start key:
 * the CLI reads these variables only at spawn, so a changed threshold needs a
 * new process (resumed, so the transcript survives).
 */
export function buildClaudeCompactionSignature(env: ClaudeEnv | null | undefined): string {
  const source = env && typeof env === 'object' ? env : {};
  return `autocompact=${String(source[CLAUDE_CACHE_ENV.autocompactPctOverride] || '')}`
    + `|noAutocompact=${String(source[CLAUDE_CACHE_ENV.disableAutoCompact] || '')}`;
}

/** Build only the overlay map (useful for tests and diagnostics). */
export function buildClaudeCacheEnvOverlay(settings: ClaudeSettingsSource | null = null): Record<string, string> {
  const overlay: Record<string, string> = {};
  applyClaudeCacheEnv(overlay, settings);
  return overlay;
}
