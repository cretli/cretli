/**
 * Metrics snapshot for the S1 exporter (the health load snapshot): every open
 * queue (depth, running, wait time per priority class, cache hit/miss) plus
 * the number of auto-verify chains in flight. Counts and durations only, no
 * payloads.
 */
import { countAutoVerifyChainsInFlight } from '../auto-verify-inflight.js';
import { getJobQueueMetricsSnapshot as queueMetrics } from './job-queue.js';

/** @returns {{ queues: object[], autoVerifyChainsInFlight: number }} */
export function getJobQueueMetricsSnapshot() {
  return { queues: queueMetrics(), autoVerifyChainsInFlight: countAutoVerifyChainsInFlight() };
}
