/**
 * `portExposure` settings block in `data/config.json`. A missing or malformed
 * block yields the safe defaults; every value is clamped. The service reads the
 * policy on every call, so these limits apply no matter which caller (REST, MCP,
 * UI) asks.
 */

import { loadSettings } from '../persist/settings.js';

/** Ports that must never be exposed to the LAN: browser/IDE debug and similar control ports. */
export const DEFAULT_DENYLIST = Object.freeze([9222, 9229, 9230, 5858, 5037, 2375, 2376]);
export const AGENT_MODES = Object.freeze(['ask', 'allow_in_range', 'never']);
export const BACKEND_KINDS = Object.freeze(['wsl-nat', 'wsl-mirrored', 'linux', 'manual']);

export const PORT_EXPOSURE_DEFAULTS = Object.freeze({
  range: Object.freeze({ min: 3000, max: 9999 }),
  denylist: DEFAULT_DENYLIST,
  defaultTtlMs: 8 * 3600_000,
  maxTtlMs: 7 * 86_400_000,
  agentMode: 'ask',
  backend: 'auto',
});

const clampInt = (value, min, max, fallback) => {
  const n = Math.round(Number(value));
  if (value === null || value === '' || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

/**
 * @param {any} raw
 * @returns {{ range: { min: number, max: number }, denylist: number[], defaultTtlMs: number, maxTtlMs: number, agentMode: string, backend: string }}
 */
export function normalizePortExposurePolicy(raw) {
  const cfg = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const d = PORT_EXPOSURE_DEFAULTS;
  let min = clampInt(cfg.range?.min, 1, 65535, d.range.min);
  let max = clampInt(cfg.range?.max, 1, 65535, d.range.max);
  if (min > max) [min, max] = [max, min];
  // Configured entries extend the built-in list; the defaults cannot be removed by a bad config.
  const extra = Array.isArray(cfg.denylist) ? cfg.denylist.map(Number).filter((p) => Number.isInteger(p) && p >= 1 && p <= 65535) : [];
  const denylist = [...new Set([...d.denylist, ...extra])].sort((a, b) => a - b);
  const maxTtlMs = clampInt(cfg.maxTtlMs, 60_000, 30 * 86_400_000, d.maxTtlMs);
  const defaultTtlMs = Math.min(maxTtlMs, clampInt(cfg.defaultTtlMs, 60_000, 30 * 86_400_000, d.defaultTtlMs));
  return {
    range: { min, max },
    denylist,
    defaultTtlMs,
    maxTtlMs,
    agentMode: AGENT_MODES.includes(cfg.agentMode) ? cfg.agentMode : d.agentMode,
    backend: BACKEND_KINDS.includes(cfg.backend) ? cfg.backend : d.backend,
  };
}

export function loadPortExposurePolicy() {
  let raw = null;
  try { raw = /** @type {any} */ (loadSettings()).portExposure; } catch { /* Unreadable settings fall back to defaults. */ }
  return normalizePortExposurePolicy(raw);
}
