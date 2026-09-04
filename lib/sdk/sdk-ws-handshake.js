/**
 * Pure helpers for SDK WebSocket hello + replay batch handshake (testable without Agent).
 */

import { chunkReplayPayloads, REPLAY_BATCH_DELAY_MS } from './sdk-ws-transport.js';

/**
 * @param {{
 *   sessionKey: string,
 *   transport?: 'cursor-sdk' | 'openrouter' | 'opencode' | 'codebuddy' | 'deepseek' | 'codex' | 'qwen',
 *   agentId?: string | null,
 *   modelId?: string,
 *   sdkMode?: string,
 *   eventStreamId?: string,
 *   busy?: boolean,
 *   queuedPrompts?: string[],
 * }} options
 * @returns {Record<string, unknown>}
 */
export function buildAgentHelloPayload(options) {
  const sessionKey = typeof options.sessionKey === 'string' ? options.sessionKey : '';
  const helloTransports = new Set(['openrouter', 'opencode', 'codebuddy', 'deepseek', 'codex', 'qwen']);
  const requested = typeof options.transport === 'string' ? options.transport.trim() : '';
  const transport = helloTransports.has(requested) ? requested : 'cursor-sdk';
  return {
    type: 'hello',
    transport,
    sessionKey,
    agentId: options.agentId ?? null,
    modelId: options.modelId || '',
    sdkMode: options.sdkMode === 'plan' ? 'plan' : 'agent',
    eventStreamId: options.eventStreamId || '',
    replayTagged: true,
    busy: !!options.busy,
    queuedPrompts: Array.isArray(options.queuedPrompts) ? options.queuedPrompts : [],
  };
}

/** @deprecated Use buildAgentHelloPayload */
export function buildSdkHelloPayload(options) {
  return buildAgentHelloPayload({ ...options, transport: 'cursor-sdk' });
}

/**
 * Sends paced replay batches over a WebSocket-like sender.
 *
 * @param {{
 *   send: (payload: Record<string, unknown>) => void,
 *   entries?: Array<{ payload?: Record<string, unknown> }>,
 *   cancelTimer?: () => void,
 *   setTimer?: (fn: () => void, delayMs: number) => unknown,
 *   batchDelayMs?: number,
 * }} options
 * @returns {{ totalBatches: number, totalEvents: number }}
 */
export function scheduleSdkWsEventLogReplay(options) {
  const send = options.send;
  if (typeof send !== 'function') {
    return { totalBatches: 0, totalEvents: 0 };
  }
  const entries = Array.isArray(options.entries) ? options.entries : [];
  const batches = chunkReplayPayloads(entries);
  if (batches.length === 0) {
    return { totalBatches: 0, totalEvents: 0 };
  }
  const totalEvents = batches.reduce((sum, batch) => sum + batch.length, 0);
  const batchDelayMs =
    Number.isFinite(options.batchDelayMs) && options.batchDelayMs >= 0
      ? options.batchDelayMs
      : REPLAY_BATCH_DELAY_MS;
  const setTimer =
    typeof options.setTimer === 'function'
      ? options.setTimer
      : (fn, delayMs) => setTimeout(fn, delayMs);
  let batchIndex = 0;
  const sendNextBatch = () => {
    if (batchIndex >= batches.length) {
      send({
        type: 'replayBatchEnd',
        totalBatches: batches.length,
        totalEvents,
      });
      return;
    }
    if (batchIndex === 0) {
      send({
        type: 'replayBatchStart',
        totalBatches: batches.length,
        totalEvents,
      });
    }
    send({
      type: 'replayBatch',
      batchIndex,
      totalBatches: batches.length,
      events: batches[batchIndex],
    });
    batchIndex += 1;
    setTimer(sendNextBatch, batchDelayMs);
  };
  setTimer(sendNextBatch, 0);
  return { totalBatches: batches.length, totalEvents };
}
