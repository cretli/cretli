import { createReadStream } from 'node:fs';
import { redactText } from './redaction.js';

/** Event names intentionally live in one table; categories approximate DevTools. */
export const TRACE_EVENT_CATEGORIES = Object.freeze({
  FunctionCall: 'scriptingMs', EvaluateScript: 'scriptingMs', EventDispatch: 'scriptingMs',
  TimerFire: 'scriptingMs', FireAnimationFrame: 'scriptingMs', RunMicrotasks: 'scriptingMs',
  UpdateLayoutTree: 'renderingMs', Layout: 'renderingMs',
  Paint: 'paintingMs', PrePaint: 'paintingMs', CompositeLayers: 'paintingMs',
});

export function traceError(code, reason = '') {
  return Object.assign(new Error(reason ? `${code}: ${reason}` : code), { code, status: code === 'trace-not-found' ? 404 : code === 'trace-busy' || code === 'trace-not-ready' ? 409 : 400, ...(reason ? { reason } : {}) });
}

/**
 * Tokenize one event at a time, including across UTF-8/chunk boundaries. The
 * prefix and individual event caps reject corrupt files without unbounded buffers.
 * No array of events is ever retained. stats counts live parsed event objects.
 */
export async function* readTraceEvents(source, stats = { maxLiveEvents: 0 }) {
  let prefix = '', prefixSize = 0, started = false, ended = false, token = '', depth = 0, quoted = false, escaped = false;
  for await (const chunk of source) {
    for (const c of String(chunk)) {
      if (!started) {
        prefix = (prefix + c).slice(-64);
        prefixSize++;
        if (/^\s*\[$/.test(prefix) || /"traceEvents"\s*:\s*\[$/.test(prefix)) { started = true; prefix = ''; }
        else if (prefixSize > 1024 * 1024) throw traceError('trace-invalid');
        continue;
      }
      if (ended) continue;
      if (!depth) {
        if (c === ']') { ended = true; continue; }
        if (/[\s,]/.test(c)) continue;
        if (c !== '{') throw traceError('trace-invalid');
        depth = 1; token = c; continue;
      }
      token += c;
      if (token.length > 16 * 1024 * 1024) throw traceError('trace-invalid');
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') depth--;
      if (!depth) {
        stats.maxLiveEvents = Math.max(stats.maxLiveEvents, 1);
        yield JSON.parse(token);
        token = '';
      }
    }
  }
  if (!started || !ended || depth) throw traceError('trace-invalid');
}

/** Two passes allow the marker to follow earlier events in file order. */
export async function summarizeTrace(file, traceId, { topFunctions = 20, conditions = {}, warnings = [], stats = { maxLiveEvents: 0 } } = {}) {
  if (!Number.isInteger(topFunctions) || topFunctions < 0 || topFunctions > 100) throw traceError('invalid-top-functions');
  const events = () => readTraceEvents(createReadStream(file, { encoding: 'utf8' }), stats);
  let marker;
  const profiles = new Map(), threadEnds = new Map();
  for await (const e of events()) {
    if (e.name === `cretli-trace-${traceId}`) marker = { pid: e.pid, tid: e.tid, ts: e.ts };
    if (Number.isFinite(e.ts)) {
      const key = `${e.pid}:${e.tid}`;
      threadEnds.set(key, Math.max(threadEnds.get(key) || 0, e.ts + (Number(e.dur) || 0)));
    }
    if (e.name === 'Profile') profiles.set(`${e.pid}:${e.id}`, { pid: e.pid, tid: e.tid, time: e.args?.data?.startTime ?? e.ts });
  }
  if (!marker) throw traceError('trace-unsupported', 'no-marker');
  const result = {
    durationMs: 0, busyMs: 0, busyShare: 0, tasks: 0, longTasks: 0, longestTaskMs: 0, incompleteTasks: 0,
    categories: { scriptingMs: 0, renderingMs: 0, paintingMs: 0 },
    updateLayoutTree: { count: 0, totalMs: 0 }, layout: { count: 0, totalMs: 0 }, slotchange: { count: 0, totalMs: 0 },
    topFunctions: [], conditions, warnings: [...warnings],
  };
  const stack = [], nodes = new Map(), functionTimes = new Map();
  let end = marker.ts, sawTask = false;
  const finish = (frame, stop) => {
    const elapsed = Math.max(0, stop - Math.max(marker.ts, frame.start));
    const own = Math.max(0, elapsed - frame.children);
    if (stack.length) stack[stack.length - 1].children += elapsed;
    if (stop < marker.ts) return;
    const category = TRACE_EVENT_CATEGORIES[frame.name];
    if (category) result.categories[category] += own / 1000;
    const metric = frame.name === 'UpdateLayoutTree' ? result.updateLayoutTree : frame.name === 'Layout' ? result.layout : frame.slotchange ? result.slotchange : null;
    if (metric) { metric.count++; metric.totalMs += elapsed / 1000; }
    if (frame.name === 'RunTask' && !stack.some((f) => f.name === 'RunTask')) {
      const ms = elapsed / 1000;
      result.tasks++; result.busyMs += ms;
      if (ms > 50) result.longTasks++;
      result.longestTaskMs = Math.max(result.longestTaskMs, ms);
    }
  };
  for await (const e of events()) {
    const profile = profiles.get(`${e.pid}:${e.id}`);
    if (e.name === 'ProfileChunk' && profile?.pid === marker.pid && profile?.tid === marker.tid) {
      const data = e.args?.data || {}, cpu = data.cpuProfile || {};
      for (const n of cpu.nodes || []) nodes.set(`${e.pid}:${e.id}:${n.id}`, n.callFrame || {});
      const samples = cpu.samples || [], deltas = data.timeDeltas || cpu.timeDeltas || [];
      for (let i = 0; i < samples.length; i++) {
        const key = `${e.pid}:${e.id}:${samples[i]}`;
        const delta = Number(deltas[i]) || 0;
        const start = profile.time;
        profile.time += delta;
        const inWindow = Math.max(0, Math.min(profile.time, threadEnds.get(`${marker.pid}:${marker.tid}`)) - Math.max(start, marker.ts));
        if (inWindow) functionTimes.set(key, (functionTimes.get(key) || 0) + inWindow);
      }
    }
    if (e.pid !== marker.pid || e.tid !== marker.tid || !Number.isFinite(e.ts)) continue;
    end = Math.max(end, e.ts + (Number(e.dur) || 0));
    while (stack.length && stack[stack.length - 1].end !== null && stack[stack.length - 1].end <= e.ts) {
      const frame = stack.pop(); finish(frame, frame.end);
    }
    if (e.name === 'RunTask') sawTask = true;
    if (e.ph === 'X' || e.ph === 'B') {
      stack.push({ name: e.name, start: e.ts, end: e.ph === 'X' ? e.ts + Math.max(0, Number(e.dur) || 0) : null, children: 0, slotchange: e.name === 'EventDispatch' && e.args?.data?.type === 'slotchange' });
    } else if (e.ph === 'E' && stack.length) {
      const frame = stack.pop(); finish(frame, e.ts);
    }
  }
  while (stack.length) {
    const frame = stack.pop();
    if (frame.end !== null) finish(frame, frame.end);
    else if (frame.name === 'RunTask') result.incompleteTasks++;
  }
  if (!sawTask) throw traceError('trace-unsupported', 'no-run-task');
  result.durationMs = Math.max(0, end - marker.ts) / 1000;
  result.busyShare = result.durationMs ? result.busyMs / result.durationMs : 0;
  const functions = new Map();
  for (const [key, time] of functionTimes) {
    const frame = nodes.get(key) || {};
    const entry = {
      name: redactText(String(frame.functionName || '(anonymous)').slice(0, 4096)),
      script: redactText(String(frame.url || '').slice(0, 8192)),
      line: Number(frame.lineNumber) || 0, selfTimeMs: 0,
    };
    const functionKey = JSON.stringify([entry.name, entry.script, entry.line]);
    const aggregate = functions.get(functionKey) || entry;
    aggregate.selfTimeMs += time / 1000;
    functions.set(functionKey, aggregate);
  }
  result.topFunctions = [...functions.values()].sort((a, b) => b.selfTimeMs - a.selfTimeMs).slice(0, topFunctions);
  if (!functionTimes.size) result.warnings.push('no-profile-samples');
  return result;
}
