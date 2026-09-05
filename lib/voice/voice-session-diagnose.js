/**
 * Turns a voice session debug log into gap timings so a slow model change
 * can be distinguished from a slow local tool.
 */

/**
 * @param {object} session
 * @returns {{
 *   sessionId: string,
 *   durationMs: number,
 *   userTurns: number,
 *   toolCalls: Array<{ name: string, ts: number, durationMs: number|null, resultBytes: number|null, modelCount: number|null, ok: boolean|null }>,
 *   gaps: Array<{ from: string, to: string, fromTs: number, toTs: number, gapMs: number }>,
 *   largestGapMs: number,
 * }}
 */
export function diagnoseVoiceSessionLog(session) {
  const entries = Array.isArray(session?.entries) ? session.entries : [];
  const startedAt = Number(session?.startedAt) || (entries[0] ? Number(entries[0].ts) : 0);
  const endedAt = session?.endedAt == null ? Number(entries[entries.length - 1]?.ts) || startedAt : Number(session.endedAt);
  const toolCalls = [];
  const gaps = [];
  let lastUserTs = 0;
  let lastUserText = '';
  let lastAssistantTs = 0;
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
  };
}
