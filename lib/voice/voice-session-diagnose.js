/**
 * Turns a voice session debug log into gap timings so a slow model change
 * can be distinguished from a slow local tool.
 */

/**
 * Nearest-rank percentile over an ascending list.
 *
 * @param {number[]} sorted
 * @param {number} percent
 * @returns {number|null}
 */
export function percentile(sorted, percent) {
  if (!Array.isArray(sorted) || sorted.length === 0) return null;
  const rank = Math.ceil((percent / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index];
}

/**
 * @param {number[]} samples
 * @returns {{ count: number, p50Ms: number|null, p95Ms: number|null }}
 */
function summarizeSamples(samples) {
  if (samples.length === 0) return { count: 0, p50Ms: null, p95Ms: null };
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
  };
}

/**
 * @param {object} session
 * @returns {{
 *   sessionId: string,
 *   durationMs: number,
 *   userTurns: number,
 *   toolCalls: Array<{ name: string, ts: number, durationMs: number|null, resultBytes: number|null, modelCount: number|null, ok: boolean|null }>,
 *   gaps: Array<{ from: string, to: string, fromTs: number, toTs: number, gapMs: number }>,
 *   largestGapMs: number,
 *   responseTiming: {
 *     responses: number,
 *     firstAudio: { count: number, p50Ms: number|null, p95Ms: number|null },
 *     end: { count: number, p50Ms: number|null, p95Ms: number|null },
 *   },
 * }}
 */
export function diagnoseVoiceSessionLog(session) {
  const entries = Array.isArray(session?.entries) ? session.entries : [];
  const startedAt = Number(session?.startedAt) || (entries[0] ? Number(entries[0].ts) : 0);
  const endedAt = session?.endedAt == null ? Number(entries[entries.length - 1]?.ts) || startedAt : Number(session.endedAt);
  const toolCalls = [];
  const gaps = [];
  /** @type {number[]} */
  const firstAudioSamples = [];
  /** @type {number[]} */
  const endSamples = [];
  /** Distinct response ids that reported timing; anonymous responses are counted separately. */
  const responseIds = new Set();
  let anonymousResponses = 0;
  let lastUserTs = 0;
  let lastUserText = '';
  let lastAssistantTs = 0;
  /**
   * @param {unknown} value
   * @returns {string}
   */
  function noteResponseId(value) {
    const id = String(value || '').trim();
    if (id) responseIds.add(id);
    return id;
  }
  for (const entry of entries) {
    const ts = Number(entry?.ts);
    if (!Number.isFinite(ts)) continue;
    const event = String(entry.event || '');
    if (event === 'transcript' && entry.role === 'user') {
      lastUserTs = ts;
      lastUserText = String(entry.text || '').slice(0, 120);
      continue;
    }
    if (event === 'transcript' && entry.role === 'assistant') {
      lastAssistantTs = ts;
      continue;
    }
    if (event === 'response.first_audio') {
      const latencyMs = Number(entry.latencyMs);
      if (Number.isFinite(latencyMs) && latencyMs >= 0) {
        noteResponseId(entry.responseId);
        firstAudioSamples.push(latencyMs);
      }
      continue;
    }
    if (event === 'response.end') {
      const durationMs = Number(entry.durationMs);
      if (Number.isFinite(durationMs) && durationMs >= 0) {
        if (!noteResponseId(entry.responseId)) anonymousResponses += 1;
        endSamples.push(durationMs);
      }
      continue;
    }
    if (event === 'tool.start') {
      const name = String(entry.name || 'tool');
      if (lastUserTs > 0) {
        gaps.push({
          from: `user:${lastUserText || 'speech'}`,
          to: `tool.start:${name}`,
          fromTs: lastUserTs,
          toTs: ts,
          gapMs: ts - lastUserTs,
        });
      }
      if (lastAssistantTs > lastUserTs) {
        gaps.push({
          from: 'assistant:speech',
          to: `tool.start:${name}`,
          fromTs: lastAssistantTs,
          toTs: ts,
          gapMs: ts - lastAssistantTs,
        });
      }
      continue;
    }
    if (event === 'tool.call') {
      toolCalls.push({
        name: String(entry.name || ''),
        ts,
        durationMs: Number.isFinite(Number(entry.durationMs)) ? Number(entry.durationMs) : null,
        resultBytes: Number.isFinite(Number(entry.resultBytes)) ? Number(entry.resultBytes) : null,
        modelCount: Number.isFinite(Number(entry.modelCount)) ? Number(entry.modelCount) : null,
        ok: entry.ok === true ? true : entry.ok === false ? false : null,
      });
    }
  }
  const largestGapMs = gaps.reduce((max, gap) => Math.max(max, gap.gapMs), 0);
  return {
    sessionId: String(session?.sessionId || ''),
    durationMs: Math.max(0, endedAt - startedAt),
    userTurns: entries.filter((entry) => entry?.event === 'transcript' && entry.role === 'user').length,
    toolCalls,
    gaps,
    largestGapMs,
    responseTiming: {
      responses: responseIds.size + anonymousResponses,
      firstAudio: summarizeSamples(firstAudioSamples),
      end: summarizeSamples(endSamples),
    },
  };
}
