/**
 * Pure helpers and a CDP Debugger controller for the Browser module.
 *
 * Design choice (epic P2): the debugger rides on its own CDP session
 * (`tab.debuggerCdpSession`), separate from `tab.cdpSession` used by screencast
 * and navigation history reads. Navigation reload or screencast teardown may
 * detach the shared session without stopping the debugger or leaving paused JS
 * on an orphaned listener — `detachDebuggerForTab` is the single teardown path.
 *
 * Breakpoints use `Debugger.setBreakpointByUrl` (URL + line/column) so agents
 * do not need a live `scriptId` before navigation; CDP resolves the script when
 * it loads. `Debugger.setBreakpoint` by scriptId is not exposed.
 */

import { SourceMapConsumer } from 'source-map-js';
import { BROWSER_LIMITS } from './constants.js';
import { redactValue, redactTextCapped, redactCdpScopeProperties } from './redaction.js';

/** @typedef {'none'|'paused'|'running'} DebuggerRunState */

/**
 * @param {Record<string, any>} [limits]
 * @returns {number}
 */
export function debuggerCdpSendTimeoutMs(limits = BROWSER_LIMITS) {
  const ms = Number(limits.DEBUGGER_CDP_SEND_TIMEOUT_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : 8000;
}

/**
 * @param {Record<string, any>} [limits]
 * @returns {number}
 */
export function debuggerAutoResumeMs(limits = BROWSER_LIMITS) {
  const ms = Number(limits.DEBUGGER_AUTO_RESUME_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : 60000;
}

/**
 * @param {unknown} url
 * @param {unknown} lineNumber
 * @param {unknown} columnNumber
 * @returns {{ url: string, lineNumber: number, columnNumber: number }|null}
 */
export function normalizeBreakpointLocation(url, lineNumber, columnNumber = 0) {
  const text = String(url ?? '').trim();
  if (!text) return null;
  const line = Number(lineNumber);
  const column = Number(columnNumber);
  if (!Number.isFinite(line) || line < 0) return null;
  return {
    url: text,
    lineNumber: Math.floor(line),
    columnNumber: Number.isFinite(column) && column >= 0 ? Math.floor(column) : 0,
  };
}

/**
 * Builds `Debugger.setBreakpointByUrl` params.
 * @param {{ url: string, lineNumber: number, columnNumber?: number, condition?: string }} input
 * @returns {Record<string, unknown>}
 */
export function buildSetBreakpointByUrlParams(input) {
  const params = {
    url: input.url,
    lineNumber: input.lineNumber,
    columnNumber: input.columnNumber ?? 0,
  };
  const condition = String(input.condition ?? '').trim();
  if (condition) params.condition = condition;
  return params;
}

/**
 * @param {unknown[]} frames
 * @param {Record<string, any>} [limits]
 * @returns {unknown[]}
 */
export function truncateCallFrames(frames, limits = BROWSER_LIMITS) {
  const max = Number(limits.DEBUGGER_MAX_STACK_DEPTH);
  const cap = Number.isFinite(max) && max > 0 ? Math.floor(max) : 32;
  if (!Array.isArray(frames)) return [];
  return frames.slice(0, cap);
}

/**
 * @param {unknown} scopeChain
 * @param {Record<string, any>} [limits]
 * @returns {unknown[]}
 */
export function truncateScopeChain(scopeChain, limits = BROWSER_LIMITS) {
  const max = Number(limits.DEBUGGER_MAX_SCOPE_DEPTH);
  const cap = Number.isFinite(max) && max > 0 ? Math.floor(max) : 8;
  if (!Array.isArray(scopeChain)) return [];
  return scopeChain.slice(0, cap);
}

/**
 * Scope entries look like CDP RemoteObjects (`type` string) but carry a `properties`
 * array that must be redacted before the generic walker treats the scope as atomic.
 * @param {unknown} value
 * @param {number} maxItems
 * @returns {unknown}
 */
function preprocessDebuggerScopes(value, maxItems) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = /** @type {Record<string, unknown>} */ (value);
  if (!Array.isArray(record.scopes)) return value;
  const scopes = record.scopes.map((scope) => {
    if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return scope;
    const copy = { .../** @type {Record<string, unknown>} */ (scope) };
    if (Array.isArray(copy.properties)) {
      copy.properties = redactCdpScopeProperties(copy.properties, maxItems);
    }
    return copy;
  });
  return { ...record, scopes };
}

/**
 * Caps serialized debugger payload size after redaction.
 * @param {unknown} value
 * @param {Record<string, any>} [limits]
 * @returns {{ value: unknown, truncated: boolean }}
 */
export function redactDebuggerPayload(value, limits = BROWSER_LIMITS) {
  const maxBytes = Number(limits.DEBUGGER_MAX_RESULT_BYTES);
  const maxDepth = Number(limits.DEBUGGER_REDACT_MAX_DEPTH);
  const maxItems = Number(limits.DEBUGGER_REDACT_MAX_ITEMS);
  const itemsCap = Number.isFinite(maxItems) && maxItems > 0 ? maxItems : 40;
  const prepared = preprocessDebuggerScopes(value, itemsCap);
  const redacted = redactValue(prepared, {
    maxDepth: Number.isFinite(maxDepth) && maxDepth > 0 ? maxDepth : 5,
    maxItems: itemsCap,
  });
  const serialized = JSON.stringify(redacted);
  const capped = redactTextCapped(serialized, maxBytes);
  if (!capped.truncated) {
    return { value: redacted, truncated: false };
  }
  return { value: capped.value, truncated: true };
}

/**
 * Maps a generated position using VLQ `mappings` when present.
 * Does not invent originals from `sourcesContent` alone — without mappings, returns null.
 * @param {Record<string, unknown>} map
 * @param {number} generatedLine 0-based line in the generated script
 * @param {number} [generatedColumn] 0-based column
 * @returns {Promise<{ source: string, line: number, column: number }|null>}
 */
export async function mapGeneratedPositionFromSourceMap(map, generatedLine, generatedColumn = 0) {
  const mappings = map?.mappings;
  if (typeof mappings !== 'string' || !mappings.length) return null;
  const line = Math.max(0, Math.floor(Number(generatedLine) || 0));
  const column = Math.max(0, Math.floor(Number(generatedColumn) || 0));
  let consumer = null;
  try {
    consumer = await new SourceMapConsumer(map);
    const pos = consumer.originalPositionFor({
      line: line + 1,
      column,
    });
    if (!pos?.source) return null;
    return {
      source: String(pos.source),
      line: Math.max(0, (Number(pos.line) || 1) - 1),
      column: Math.max(0, Number(pos.column) || 0),
    };
  } catch {
    return null;
  } finally {
    if (consumer && typeof consumer.destroy === 'function') consumer.destroy();
  }
}

/**
 * @param {Promise<unknown>} promise
 * @param {number} timeoutMs
 * @param {string} label
 * @returns {Promise<unknown>}
 */
export async function withCdpTimeout(promise, timeoutMs, label) {
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 8000;
  let timer = null;
  const guard = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([Promise.resolve(promise), guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * @typedef {Object} DebuggerControllerOptions
 * @property {() => number} [now]
 * @property {Record<string, any>} [limits]
 * @property {(method: string, params?: Record<string, unknown>) => Promise<unknown>} send
 * @property {(event: string, handler: (...args: any[]) => void) => void} on
 * @property {(event: string, handler: (...args: any[]) => void) => void} [off]
 * @property {typeof setTimeout} [setTimeoutFn]
 * @property {typeof clearTimeout} [clearTimeoutFn]
 * @property {(sourceMapUrl: string, scriptUrl: string) => Promise<Record<string, unknown>|null>} [fetchSourceMap]
 * @property {(payload: Record<string, unknown>) => void} [onEvent]
 */

/**
 * CDP Debugger controller (testable with a fake session).
 * @param {DebuggerControllerOptions} options
 */
export function createDebuggerController(options) {
  const limits = options.limits || BROWSER_LIMITS;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const setTimeoutFn = options.setTimeoutFn || setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
  const sendRaw = options.send;
  const on = options.on;
  const off = options.off || (() => {});
  const fetchSourceMap = options.fetchSourceMap || (async () => null);
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
  const sendTimeoutMs = () => debuggerCdpSendTimeoutMs(limits);
  const maxBreakpoints = () => {
    const n = Number(limits.DEBUGGER_MAX_BREAKPOINTS);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 20;
  };
  /** @type {DebuggerRunState} */
  let runState = 'none';
  /** @type {unknown[]} */
  let callFrames = [];
  /** @type {string} */
  let pauseReason = '';
  /** @type {Map<string, { url: string, lineNumber: number, columnNumber: number, condition?: string }>} */
  const breakpoints = new Map();
  /** @type {Map<string, { url: string, sourceMapURL?: string }>} */
  const scripts = new Map();
  /** @type {Map<string, Record<string, unknown>>} */
  const sourceMaps = new Map();
  const maxSourceMapCache = () => {
    const n = Number(limits.DEBUGGER_MAX_SOURCE_MAP_CACHE);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 32;
  };

  /**
   * @param {string} scriptUrl
   * @param {string} sourceMapURL
   * @returns {string}
   */
  function sourceMapCacheKey(scriptUrl, sourceMapURL) {
    return `${String(scriptUrl || '')}\0${String(sourceMapURL || '')}`;
  }

  /**
   * @param {string} key
   * @param {Record<string, unknown>} map
   */
  function rememberSourceMap(key, map) {
    if (sourceMaps.has(key)) {
      sourceMaps.delete(key);
    }
    sourceMaps.set(key, map);
    while (sourceMaps.size > maxSourceMapCache()) {
      const oldest = sourceMaps.keys().next().value;
      if (oldest === undefined) break;
      sourceMaps.delete(oldest);
    }
  }
  /** @type {ReturnType<typeof setTimeout>|null} */
  let autoResumeTimer = null;
  let attached = false;
  const onPaused = (params) => { void handlePaused(params); };
  const onResumed = () => { void handleResumed(); };
  const onScriptParsed = (params) => { void handleScriptParsed(params); };

  async function cdpSend(method, params = {}) {
    return withCdpTimeout(sendRaw(method, params), sendTimeoutMs(), method);
  }

  function clearAutoResume() {
    if (autoResumeTimer != null) {
      try {
        clearTimeoutFn(autoResumeTimer);
      } catch {
        // ignore
      }
      autoResumeTimer = null;
    }
  }

  function scheduleAutoResume() {
    clearAutoResume();
    autoResumeTimer = setTimeoutFn(() => {
      void resumeInternal('auto-resume');
    }, debuggerAutoResumeMs(limits));
  }

  async function handlePaused(params) {
    runState = 'paused';
    pauseReason = String(params?.reason ?? '');
    callFrames = truncateCallFrames(params?.callFrames || [], limits);
    scheduleAutoResume();
    onEvent({
      type: 'debugger-paused',
      reason: pauseReason,
      at: now(),
      frameCount: callFrames.length,
    });
  }

  async function handleResumed() {
    runState = 'running';
    callFrames = [];
    pauseReason = '';
    clearAutoResume();
    onEvent({ type: 'debugger-resumed', at: now() });
  }

  async function handleScriptParsed(params) {
    const scriptId = String(params?.scriptId ?? '');
    if (!scriptId) return;
    const url = String(params?.url ?? '');
    const sourceMapURL = String(params?.sourceMapURL ?? '').trim();
    scripts.set(scriptId, { url, sourceMapURL: sourceMapURL || undefined });
    if (sourceMapURL) {
      const cacheKey = sourceMapCacheKey(url, sourceMapURL);
      const cached = sourceMaps.get(cacheKey);
      if (!cached) {
        const map = await fetchSourceMap(sourceMapURL, url);
        if (map && typeof map === 'object') rememberSourceMap(cacheKey, map);
      }
    }
  }

  async function attach() {
    if (attached) return { ok: true, attached: true };
    await cdpSend('Debugger.enable');
    await cdpSend('Runtime.enable');
    try {
      await cdpSend('Network.enable');
    } catch {
      // Source maps may still resolve from scriptParsed URLs without Network.
    }
    on('Debugger.paused', onPaused);
    on('Debugger.resumed', onResumed);
    on('Debugger.scriptParsed', onScriptParsed);
    attached = true;
    runState = 'running';
    return { ok: true, attached: true };
  }

  async function detach() {
    clearAutoResume();
    if (attached) {
      try {
        off('Debugger.paused', onPaused);
        off('Debugger.resumed', onResumed);
        off('Debugger.scriptParsed', onScriptParsed);
      } catch {
        // ignore
      }
    }
    if (runState === 'paused') {
      try {
        await cdpSend('Debugger.resume');
      } catch {
        // best effort — page must not stay paused after teardown
      }
    }
    attached = false;
    runState = 'none';
    callFrames = [];
    pauseReason = '';
    breakpoints.clear();
    scripts.clear();
    sourceMaps.clear();
    return { ok: true };
  }

  async function pause() {
    await attach();
    await cdpSend('Debugger.pause');
    return { ok: true, state: getState() };
  }

  async function resumeInternal(reason = 'explicit') {
    clearAutoResume();
    if (runState !== 'paused') {
      return { ok: true, state: getState(), skipped: true, reason };
    }
    await cdpSend('Debugger.resume');
    return { ok: true, state: getState(), reason };
  }

  async function resume() {
    return resumeInternal('explicit');
  }

  async function setBreakpoint(input) {
    await attach();
    if (breakpoints.size >= maxBreakpoints()) {
      throw new Error(`breakpoint limit (${maxBreakpoints()}) reached`);
    }
    const loc = normalizeBreakpointLocation(input?.url, input?.lineNumber, input?.columnNumber);
    if (!loc) throw new Error('url and lineNumber are required for setBreakpointByUrl');
    const params = buildSetBreakpointByUrlParams({
      ...loc,
      condition: input?.condition,
    });
    const result = /** @type {{ breakpointId?: string, locations?: unknown[] }} */ (
      await cdpSend('Debugger.setBreakpointByUrl', params)
    );
    const breakpointId = String(result?.breakpointId ?? '');
    if (!breakpointId) throw new Error('Debugger.setBreakpointByUrl returned no breakpointId');
    breakpoints.set(breakpointId, {
      url: loc.url,
      lineNumber: loc.lineNumber,
      columnNumber: loc.columnNumber,
      ...(input?.condition ? { condition: String(input.condition) } : {}),
    });
    return {
      ok: true,
      breakpointId,
      locations: result?.locations || [],
      state: getState(),
    };
  }

  async function removeBreakpoint(breakpointId) {
    const id = String(breakpointId ?? '').trim();
    if (!id) throw new Error('breakpointId is required');
    await attach();
    await cdpSend('Debugger.removeBreakpoint', { breakpointId: id });
    breakpoints.delete(id);
    return { ok: true, breakpointId: id, state: getState() };
  }

  /**
   * @param {string} [callFrameId]
   */
  function pickCallFrame(callFrameId) {
    if (!callFrames.length) return null;
    const id = String(callFrameId ?? '').trim();
    if (!id) return callFrames[0];
    return callFrames.find((frame) => String(/** @type {any} */ (frame)?.callFrameId ?? '') === id) || callFrames[0];
  }

  function getState() {
    return {
      runState,
      paused: runState === 'paused',
      pauseReason: pauseReason || null,
      breakpointCount: breakpoints.size,
      breakpoints: [...breakpoints.entries()].map(([id, meta]) => ({ breakpointId: id, ...meta })),
      attached,
      at: now(),
    };
  }

  async function getStack(callFrameId) {
    if (runState !== 'paused') {
      return {
        ok: false,
        error: 'debugger-not-paused',
        frames: [],
        paused: false,
      };
    }
    const syncFrames = truncateCallFrames(callFrames, limits);
    if (!syncFrames.length) {
      return { ok: true, frames: [], paused: true };
    }
    const anchor = pickCallFrame(callFrameId) || syncFrames[0];
    const stackTraceId = /** @type {any} */ (anchor)?.stackTrace?.parentId
      || /** @type {any} */ (anchor)?.stackTrace?.parent;
    let asyncFrames = [];
    if (stackTraceId) {
      try {
        const trace = /** @type {{ stackTrace?: { callFrames?: unknown[] } }} */ (
          await cdpSend('Debugger.getStackTrace', { stackTraceId })
        );
        asyncFrames = truncateCallFrames(trace?.stackTrace?.callFrames || [], limits);
      } catch {
        asyncFrames = [];
      }
    }
    const seen = new Set(syncFrames.map((entry) => String(/** @type {any} */ (entry)?.callFrameId ?? '')));
    const extraAsync = asyncFrames.filter((entry) => {
      const id = String(/** @type {any} */ (entry)?.callFrameId ?? '');
      return id && !seen.has(id);
    });
    const frames = truncateCallFrames([...syncFrames, ...extraAsync], limits);
    const mapped = await Promise.all(frames.map((entry) => mapFrameLocation(entry)));
    const payload = redactDebuggerPayload({ frames: mapped }, limits);
    return {
      ok: true,
      frames: /** @type {{ frames?: unknown[] }} */ (payload.value)?.frames || [],
      truncated: payload.truncated,
      paused: true,
    };
  }

  /**
   * @param {unknown} frame
   */
  async function mapFrameLocation(frame) {
    const scriptId = String(/** @type {any} */ (frame)?.location?.scriptId ?? '');
    const line = Number(/** @type {any} */ (frame)?.location?.lineNumber ?? 0);
    const column = Number(/** @type {any} */ (frame)?.location?.columnNumber ?? 0);
    const script = scripts.get(scriptId);
    let original = null;
    if (script?.sourceMapURL) {
      const cacheKey = sourceMapCacheKey(script.url || '', script.sourceMapURL);
      const map = sourceMaps.get(cacheKey);
      if (map) original = await mapGeneratedPositionFromSourceMap(map, line, column);
    }
    return redactDebuggerPayload({
      callFrameId: /** @type {any} */ (frame)?.callFrameId,
      functionName: /** @type {any} */ (frame)?.functionName,
      url: /** @type {any} */ (frame)?.url || script?.url,
      location: { scriptId, lineNumber: line, columnNumber: column },
      original,
    }, limits).value;
  }

  async function resetForNavigation() {
    clearAutoResume();
    if (runState === 'paused') {
      try {
        await cdpSend('Debugger.resume');
      } catch {
        // page navigated — best effort so JS is not left paused
      }
    }
    runState = 'running';
    callFrames = [];
    pauseReason = '';
    scripts.clear();
    sourceMaps.clear();
    return { ok: true };
  }

  async function getScopes(callFrameId) {
    const frame = pickCallFrame(callFrameId);
    if (!frame) {
      return { ok: true, scopes: [], paused: runState === 'paused' };
    }
    const chain = truncateScopeChain(/** @type {any} */ (frame)?.scopeChain || [], limits);
    /** @type {unknown[]} */
    const scopes = [];
    for (const scope of chain) {
      const type = String(/** @type {any} */ (scope)?.type ?? '');
      const name = String(/** @type {any} */ (scope)?.name ?? '');
      const objectId = String(/** @type {any} */ (scope)?.object?.objectId ?? '');
      let properties = [];
      if (objectId) {
        try {
          const props = /** @type {{ result?: unknown[] }} */ (
            await cdpSend('Runtime.getProperties', {
              objectId,
              ownProperties: true,
              generatePreview: false,
            })
          );
          properties = Array.isArray(props?.result) ? props.result.slice(0, limits.DEBUGGER_MAX_SCOPE_PROPERTIES || 24) : [];
        } catch {
          properties = [];
        }
      }
      scopes.push({ type, name, properties });
    }
    const payload = redactDebuggerPayload({ scopes }, limits);
    return {
      ok: true,
      scopes: /** @type {{ scopes?: unknown[] }} */ (payload.value)?.scopes || [],
      truncated: payload.truncated,
      paused: runState === 'paused',
    };
  }

  async function getScriptSource(scriptId) {
    const id = String(scriptId ?? '').trim();
    if (!id) throw new Error('scriptId is required');
    const result = /** @type {{ scriptSource?: string }} */ (await cdpSend('Debugger.getScriptSource', { scriptId: id }));
    const capped = redactTextCapped(String(result?.scriptSource ?? ''), limits.DEBUGGER_MAX_SCRIPT_SOURCE_BYTES || 65536);
    return { ok: true, scriptId: id, source: capped.value, truncated: capped.truncated };
  }

  async function watch(expression, callFrameId) {
    const expr = String(expression ?? '').trim();
    if (!expr) throw new Error('expression is required');
    const frame = pickCallFrame(callFrameId);
    if (!frame || runState !== 'paused') {
      throw new Error('watch requires an active pause and call frame');
    }
    const id = String(/** @type {any} */ (frame)?.callFrameId ?? '');
    const result = /** @type {{ result?: unknown, exceptionDetails?: unknown }} */ (
      await cdpSend('Debugger.evaluateOnCallFrame', {
        callFrameId: id,
        expression: expr,
        returnByValue: true,
        throwOnSideEffect: false,
      })
    );
    const payload = redactDebuggerPayload({
      result: result?.result,
      exceptionDetails: result?.exceptionDetails,
    }, limits);
    return { ok: true, value: payload.value, truncated: payload.truncated };
  }

  return {
    attach,
    detach,
    pause,
    resume,
    resumeInternal,
    setBreakpoint,
    removeBreakpoint,
    getState,
    getStack,
    getScopes,
    getScriptSource,
    watch,
    resetForNavigation,
    /** Exposed for tests. */
    _handlePaused: handlePaused,
    _handleResumed: handleResumed,
    _handleScriptParsed: handleScriptParsed,
  };
}
