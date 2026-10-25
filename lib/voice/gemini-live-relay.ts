/**
 * Same-origin WebSocket relay for Gemini Live. AQ auth keys from AI Studio
 * are rejected by Google's ephemeral-token API, so the browser talks to
 * Cretli and Cretli talks to Google with the stored key.
 */

import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import { getEffectiveGeminiApiKey } from './gemini-api-key.ts';
import {
  buildGeminiLiveUpstreamWsUrl,
  GEMINI_LIVE_RELAY_TICKET_TTL_MS,
} from './gemini-live-config.ts';
import { emptyUsageTokens } from '../usage/usage-event.js';
import { fromGeminiLiveUsage, readGeminiLiveCumulative } from '../usage/usage-normalize.js';
import { safeRecordUsage } from '../usage/usage-ledger.ts';

const tickets = new Map<string, number>();

export function issueGeminiLiveRelayTicket(): string {
  const ticket = randomBytes(24).toString('hex');
  tickets.set(ticket, Date.now() + GEMINI_LIVE_RELAY_TICKET_TTL_MS);
  return ticket;
}

export function consumeGeminiLiveRelayTicket(ticket: unknown): boolean {
  const raw = String(ticket || '').trim();
  const expiresAt = tickets.get(raw);
  tickets.delete(raw);
  if (!expiresAt) return false;
  return Date.now() <= expiresAt;
}

function tryParseJson(data: unknown): Record<string, unknown> | null {
  try {
    const raw = Buffer.isBuffer(data) ? data.toString('utf8') : String(data || '');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Records a Gemini Live usage delta and returns the new cumulative snapshot.
 */
export function noteGeminiLiveUsage(
  payload: Record<string, unknown> | null,
  previousTokens: Record<string, unknown>,
  record: (partial: Record<string, unknown>) => unknown = safeRecordUsage,
): Record<string, unknown> {
  if (!payload?.usageMetadata) return previousTokens || emptyUsageTokens();
  const tokens = fromGeminiLiveUsage(payload.usageMetadata as Record<string, unknown>, previousTokens);
  const hasQty = Object.values(tokens).some((count) => Number(count) > 0);
  if (hasQty && typeof record === 'function') {
    record({
      provider: 'google',
      feature: 'voice-live',
      model: 'gemini-3.1-flash-live-preview',
      tokens,
      source: 'server',
    });
  }
  return readGeminiLiveCumulative(payload.usageMetadata as Record<string, unknown>);
}

export function handleGeminiLiveRelayConnection(
  client: WebSocket,
  ticket: unknown,
  hooks: { recordUsage?: (partial: Record<string, unknown>) => unknown } = {},
): void {
  if (!consumeGeminiLiveRelayTicket(ticket)) {
    client.close(4403, 'Invalid Gemini live ticket');
    return;
  }
  const apiKey = getEffectiveGeminiApiKey();
  if (!apiKey) {
    client.close(4403, 'Gemini API key is not configured');
    return;
  }
  const record = typeof hooks.recordUsage === 'function' ? hooks.recordUsage : safeRecordUsage;
  let lastTokens: Record<string, unknown> = emptyUsageTokens();
  const pending: Array<{ data: RawData; isBinary: boolean }> = [];
  const upstream = new WebSocket(buildGeminiLiveUpstreamWsUrl(apiKey));
  client.on('message', (data, isBinary) => {
    if (upstream.readyState !== WebSocket.OPEN) {
      pending.push({ data, isBinary });
      return;
    }
    upstream.send(data, { binary: isBinary });
  });
  client.on('close', () => closeIfOpen(upstream));
  client.on('error', () => closeIfOpen(upstream));
  upstream.on('open', () => {
    for (const item of pending) {
      if (upstream.readyState !== WebSocket.OPEN) break;
      upstream.send(item.data, { binary: item.isBinary });
    }
    pending.length = 0;
  });
  upstream.on('message', (data, isBinary) => {
    const payload = !isBinary ? tryParseJson(data) : null;
    if (payload?.usageMetadata) lastTokens = noteGeminiLiveUsage(payload, lastTokens, record);
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });
  upstream.on('close', (code, reason) => {
    if (client.readyState !== WebSocket.OPEN) return;
    const text = Buffer.isBuffer(reason) ? reason.toString() : String(reason || '');
    client.close(code || 1000, text.slice(0, 120));
  });
  upstream.on('error', () => {
    if (client.readyState === WebSocket.OPEN) client.close(1011, 'Gemini live upstream failed');
  });
}

function closeIfOpen(socket: WebSocket): void {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.close();
  }
}
