/**
 * Opt-in per-IP throttle for the OpenAI-backed voice endpoints.
 *
 * A LAN-visible Cretli brokers the server's OpenAI key to anyone who can reach
 * it, so the throttle exists to bound abuse. It is an app-level guard, not a
 * billing cap — set provider-side usage limits as well.
 */

import { getRequestClientIp } from '../http-request.js';

/** Minimal response surface used here (express types are not installed). */
interface RateLimitResponse {
  status(code: number): { json(body: unknown): unknown };
}

const WINDOW_MS = 60_000;

const buckets = new Map<string, { count: number; resetAt: number }>();

/**
 * Requests per minute, or 0 when the throttle is disabled.
 */
function getConfiguredLimitPerMinute(): number {
  const parsed = Number.parseInt(String(process.env.CRETLI_RATELIMIT_OPENAI_PER_MIN || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Returns false when the request was rejected and the response is sent.
 */
export function enforceOpenAiRateLimit(req: Parameters<typeof getRequestClientIp>[0], res: RateLimitResponse): boolean {
  const limit = getConfiguredLimitPerMinute();
  if (limit <= 0) return true;

  const key = getRequestClientIp(req) || 'unknown';
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (bucket.count < limit) {
    bucket.count += 1;
    return true;
  }
  res.status(429).json({
    ok: false,
    error: `Voice rate limit reached (${limit}/min). Try again shortly.`,
  });
  return false;
}
