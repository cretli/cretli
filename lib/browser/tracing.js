import { randomUUID } from 'node:crypto';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { BROWSER_LIMITS } from './constants.js';
import { summarizeTrace, traceError } from './trace-summary.js';

export const TRACE_CATEGORIES = Object.freeze([
  'devtools.timeline', 'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame', 'disabled-by-default-devtools.timeline.stack',
  'v8.execute', 'disabled-by-default-v8.cpu_profiler', 'blink.user_timing', 'latencyInfo',
]);
// Process-wide reservation: never reveal the holder's identifiers in busy errors.
let active = null;

/** Injectable CDP factories keep browser and page fallback on the same browser. */
export function createTracingController({ dataDir, limits = BROWSER_LIMITS, io = fs, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const records = new Map();
  const directory = path.join(dataDir, 'browser-traces');
  const limit = (name) => limits[name] ?? BROWSER_LIMITS[name];
  async function retain(keep = limit('TRACE_MAX_FILES')) {
    await io.mkdir(directory, { recursive: true, mode: 0o700 });
    const files = [];
    for (const name of await io.readdir(directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      const file = path.join(directory, name);
      if (file === active?.file) continue;
      const stat = await io.lstat(file);
      if (stat.isFile()) files.push({ file, at: stat.mtimeMs });
    }
    files.sort((a, b) => b.at - a.at);
    for (let i = 0; i < files.length; i++) {
      if (i >= keep || Date.now() - files[i].at > limit('TRACE_MAX_AGE_MS')) {
        await io.unlink(files[i].file);
        records.delete(path.basename(files[i].file, '.json'));
      }
    }
  }
  function view(r) {
    return { traceId: r.traceId, state: r.state, sizeBytes: r.sizeBytes, path: r.state === 'ready' ? r.file : null,
      ...(r.code ? { code: r.code } : {}), cdpSession: r.cdpSession, conditions: r.conditions, warnings: r.warnings };
  }
  function requireRecord(traceId, scope) {
    const r = records.get(String(traceId));
    if (!r || r.owner !== scope.owner || r.chat !== scope.chat || r.workspace !== scope.workspace) throw traceError('trace-not-found');
    return r;
  }
  const bounded = (fn) => new Promise((resolve, reject) => {
    const timer = setTimer(() => reject(traceError('trace-end-timeout')), limit('TRACE_END_TIMEOUT_MS'));
    Promise.resolve().then(fn).then(resolve, reject).finally(() => clearTimer(timer));
  });
  async function cleanup(r) {
    clearTimer(r.timer);
    if (r.cdp) {
      r.cdp.off?.('Tracing.tracingComplete', r.complete);
      r.cdp.off?.('Inspector.detached', r.detached);
      try { await bounded(() => r.cdp.detach()); } catch { /* Best-effort after transport loss. */ }
    }
    if ((r.outcome || r.state) === 'failed') { try { await io.unlink(r.file); } catch { /* A failed start may have no file. */ } }
    if (r.outcome === 'ready') {
      try { await retain(limit('TRACE_MAX_FILES') - 1); }
      catch { r.failure = 'trace-write-failed'; }
      if (r.failure) {
        r.code = r.failure; r.outcome = 'failed';
        try { await io.unlink(r.file); } catch { /* Preserve the recording error. */ }
      }
    }
    if (active === r) active = null;
  }
  async function endOnce(r) {
    if (!r.started || r.ended) return;
    r.ended = true;
    await bounded(() => r.cdp.send('Tracing.end'));
  }
  async function finish(r, failure = '') {
    if (r.finishPromise) {
      if (failure) r.failure = failure;
      return r.finishPromise;
    }
    r.failure = failure;
    r.state = 'finishing';
    clearTimer(r.timer);
    r.finishPromise = (async () => {
      let handle, output;
      try {
        await endOnce(r);
        const completed = await bounded(() => r.completion);
        handle = completed.stream;
        if (r.failure) throw traceError(r.failure);
        if (!handle) throw traceError('trace-unavailable');
        output = await io.open(r.file, 'wx', 0o600);
        while (true) {
          const chunk = await bounded(() => r.cdp.send('IO.read', { handle, size: 65536 }));
          const bytes = Buffer.from(chunk.data || '', chunk.base64Encoded ? 'base64' : 'utf8');
          r.sizeBytes += bytes.length;
          if (r.sizeBytes > limit('TRACE_MAX_BYTES')) throw traceError('trace-too-large');
          if (r.failure) throw traceError(r.failure);
          await bounded(() => output.writeFile(bytes));
          if (chunk.eof) break;
        }
        await output.close(); output = null;
        if (r.failure) throw traceError(r.failure);
        await bounded(() => r.cdp.send('IO.close', { handle })); handle = null;
        r.outcome = 'ready';
      } catch (error) {
        r.code = r.failure || (error.code?.startsWith('trace-') ? error.code : 'trace-write-failed'); r.outcome = 'failed';
      } finally {
        try { await output?.close(); } catch { /* Preserve the original failure. */ }
        if (handle) { try { await bounded(() => r.cdp.send('IO.close', { handle })); } catch { /* Transport may be gone. */ } }
        await cleanup(r);
        r.state = r.outcome;
      }
    })();
    return r.finishPromise;
  }
  return {
    async start({ owner, chat, workspace, tabId, durationMs = 60000, factories, conditions, mark }) {
      if (!Number.isInteger(durationMs) || durationMs < 1000 || durationMs > 120000) throw traceError('invalid-duration');
      if (active) throw traceError('trace-busy');
      const traceId = randomUUID();
      const r = { traceId, file: path.join(directory, `${traceId}.json`), owner, chat, workspace, tabId,
        state: 'recording', sizeBytes: 0, cdpSession: null, conditions: {}, warnings: [], started: false, ended: false };
      active = r; // Reserve synchronously before the first await, including failed starts.
      records.set(traceId, r);
      // Keep diagnostic failure metadata bounded as well as recorded files.
      for (const [id, previous] of records) {
        if (records.size <= 100) break;
        if (previous.state === 'failed') records.delete(id);
      }
      try {
        if (!dataDir) throw traceError('trace-unavailable');
        await retain();
        r.conditions = await bounded(conditions);
        if (r.failure) throw traceError(r.failure);
        r.warnings = Object.keys(r.conditions).filter((key) => r.conditions[key]);
        for (const factory of factories) {
          let cdp;
          try {
            cdp = await bounded(factory.create);
            r.cdp = cdp;
            r.completion = new Promise((resolve) => { r.complete = resolve; });
            cdp.on('Tracing.tracingComplete', r.complete);
            await bounded(() => cdp.send('Tracing.start', { categories: TRACE_CATEGORIES.join(','), transferMode: 'ReturnAsStream' }));
            r.started = true; r.cdpSession = factory.name;
            r.detached = () => { void finish(r, 'trace-tab-closed'); };
            cdp.on('Inspector.detached', r.detached);
            break;
          } catch (error) {
            cdp?.off?.('Tracing.tracingComplete', r.complete);
            try { await bounded(() => cdp?.detach()); } catch { /* Try the page fallback. */ }
            r.cdp = null;
            if (/already (started|tracing)|tracing.*already/i.test(String(error.message))) throw traceError('trace-busy');
          }
        }
        if (!r.started) throw traceError('trace-unavailable');
        if (r.failure) { await finish(r, r.failure); return view(r); }
        let marked = false;
        for (let i = 0; i < 2; i++) {
          try { await bounded(() => mark(`cretli-trace-${traceId}`)); marked = true; break; }
          catch (error) { if (!/context|navigation/i.test(String(error.message))) break; }
        }
        if (!marked) { await finish(r, 'trace-marker-failed'); return view(r); }
        if (r.failure) { await finish(r, r.failure); return view(r); }
        r.timer = setTimer(() => { void finish(r); }, durationMs);
        r.timer?.unref?.();
        return view(r);
      } catch (error) {
        r.state = 'failed'; r.code = error.code || 'trace-unavailable';
        await cleanup(r);
        throw traceError(r.code);
      }
    },
    status(traceId, scope) { return view(requireRecord(traceId, scope)); },
    async summary(traceId, scope, topFunctions) {
      const r = requireRecord(traceId, scope);
      if (r.state !== 'ready') throw traceError('trace-not-ready');
      return summarizeTrace(r.file, r.traceId, { topFunctions, conditions: r.conditions, warnings: r.warnings });
    },
    async closeTab(tabId) {
      const r = active;
      if (r && records.get(r.traceId) === r && r.tabId === tabId) {
        // A close during start is remembered; start will terminate after attaching.
        r.failure = 'trace-tab-closed';
        if (r.started) await finish(r, r.failure);
      }
    },
  };
}
