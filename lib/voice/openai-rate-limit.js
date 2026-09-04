/**
 * Opt-in per-IP throttle for the OpenAI-backed voice endpoints.
 *
 * A LAN-visible Cretli brokers the server's OpenAI key to anyone who can reach
 * it, so the throttle exists to bound abuse. It is an app-level guard, not a
 * billing cap — set provider-side usage limits as well.
 */

import { getRequestClientIp } from '../http-request.js';

const WINDOW_MS = 60_000;

/** @type {Map<string, { count: number, resetAt: number }>} */
const buckets = new Map();

/**
 * @returns {number} requests per minute, or 0 when the throttle is disabled
 */
function getConfiguredLimitPerMinute() {
  const parsed = Number.parseInt(String(process.env.CRETLI_RATELIMIT_OPENAI_PER_MIN || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {boolean} false when the request was rejected and the response is sent
 */
export function enforceOpenAiRateLimit(req, res) {
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
