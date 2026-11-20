/**
 * Shared engine for run-based panels (tasks/agents/terminal).
 * Provides:
 * - the run list and the active run,
 * - a guard against opening the WS connection twice,
 * - output batching/flushing with catch-up handling.
 */

/**
 * @typedef {{
 *   flushIntervalMs?: number,
 *   maxQueueChars?: number,
 *   transformCatchUp?: (data: string, run: object) => string,
 *   onFlush?: (payload: { run: object, output: string, shouldReset: boolean }) => void
 * }} RunPanelOutputOptions
 */

/**
 * @typedef {{
 *   createSocket: (run: object) => WebSocket,
 *   isSocketActive?: (run: object) => boolean,
 *   parseMessage?: (raw: string) => any,
 *   output?: RunPanelOutputOptions,
 *   onSelectRun?: (payload: { id: string, run: object | null }) => void,
 *   onBeforeConnect?: (payload: { run: object }) => void,
 *   onMessage?: (payload: { run: object, message: any, event: MessageEvent }) => void,
 *   onOpen?: (payload: { run: object, event: Event }) => void,
 *   onClose?: (payload: { run: object, event: CloseEvent }) => void
 * }} RunPanelEngineOptions
 */

/**
 * @param {RunPanelEngineOptions} options
 */
export function createRunPanelEngine(options) {
  const runs = [];
  let activeRunId = null;
  const connectingRunIds = new Set();

  const outputFlushIntervalMs = Math.max(0, Number(options?.output?.flushIntervalMs || 16));
  const outputMaxQueueChars = Math.max(0, Number(options?.output?.maxQueueChars || 0));

  const isSocketActive =
    typeof options?.isSocketActive === 'function'
      ? options.isSocketActive
      : (run) => !!run?.ws && (run.ws.readyState === WebSocket.OPEN || run.ws.readyState === WebSocket.CONNECTING);

  const parseMessage =
    typeof options?.parseMessage === 'function'
      ? options.parseMessage
      : (raw) => {
          try {
            return JSON.parse(raw);
          } catch (_) {
            return null;
          }
        };

  function getRuns() {
    return runs;
  }

  function getActiveRunId() {
    return activeRunId;
  }

  function getActiveRun() {
    if (!activeRunId) return null;
    return runs.find((run) => run.id === activeRunId) || null;
  }

  function findRunById(id) {
    if (!id) return null;
    return runs.find((run) => run.id === id) || null;
  }

  function addRun(run) {
    if (!run || !run.id) return null;
    const existing = findRunById(run.id);
    if (existing) return existing;
    runs.push(run);
    return run;
  }

  function removeRunById(id) {
    if (!id) return;
    const idx = runs.findIndex((run) => run.id === id);
    if (idx === -1) return;
    const [run] = runs.splice(idx, 1);
    if (!run) return;
    clearRunOutputState(run);
    if (activeRunId === id) {
      activeRunId = null;
      options?.onSelectRun?.({ id: '', run: null });
    }
  }

  function selectRun(id) {
    activeRunId = id || null;
    const run = activeRunId ? findRunById(activeRunId) : null;
    options?.onSelectRun?.({ id: activeRunId || '', run });
    return run;
  }

  function ensureRunOutputState(run) {
    if (!run) return;
    if (typeof run.pendingOutput !== 'string') run.pendingOutput = '';
    if (typeof run.needsTerminalReset !== 'boolean') run.needsTerminalReset = false;
    if (typeof run.flushTimerId !== 'number' && run.flushTimerId !== null) {
      run.flushTimerId = null;
    }
  }

  function clearRunOutputState(run) {
    if (!run) return;
    if (run.flushTimerId != null) {
      clearTimeout(run.flushTimerId);
      run.flushTimerId = null;
    }
    run.pendingOutput = '';
    run.needsTerminalReset = false;
  }

  function flushRunOutput(run) {
    if (!run || !options?.output?.onFlush) return;
    ensureRunOutputState(run);
    const output = run.pendingOutput || '';
    const shouldReset = run.needsTerminalReset === true;
    run.pendingOutput = '';
    run.needsTerminalReset = false;
    run.flushTimerId = null;
    options.output.onFlush({ run, output, shouldReset });
  }

  function scheduleRunOutputFlush(run) {
    if (!run || !options?.output?.onFlush) return;
    ensureRunOutputState(run);
    if (run.flushTimerId != null) return;
    run.flushTimerId = setTimeout(() => {
      flushRunOutput(run);
    }, outputFlushIntervalMs);
  }

  function queueRunOutput(run, data, isCatchUp = false) {
    if (!run || !options?.output?.onFlush) return;
    ensureRunOutputState(run);
    const rawChunk = typeof data === 'string' ? data : '';
    if (!rawChunk) return;

    const chunk =
      isCatchUp && typeof options?.output?.transformCatchUp === 'function'
        ? options.output.transformCatchUp(rawChunk, run)
        : rawChunk;

    if (!chunk) return;

    if (isCatchUp) {
      run.needsTerminalReset = true;
      run.pendingOutput = chunk;
      scheduleRunOutputFlush(run);
      return;
    }

    run.pendingOutput += chunk;
    if (outputMaxQueueChars > 0 && run.pendingOutput.length > outputMaxQueueChars) {
      run.pendingOutput = run.pendingOutput.slice(-outputMaxQueueChars);
    }
    scheduleRunOutputFlush(run);
  }

  function connectRun(run) {
    if (!run || !run.id) return null;
    if (connectingRunIds.has(run.id)) return run.ws || null;
    if (isSocketActive(run)) return run.ws || null;

    connectingRunIds.add(run.id);
    options?.onBeforeConnect?.({ run });
    const ws = options.createSocket(run);
    run.ws = ws;

    ws.onmessage = (event) => {
      const message = parseMessage(typeof event?.data === 'string' ? event.data : '');
      if (!message) return;
      if (message.type === 'output') {
        queueRunOutput(run, message.data, !!message.catchUp);
      }
      options?.onMessage?.({ run, message, event });
    };

    ws.onopen = (event) => {
      connectingRunIds.delete(run.id);
      options?.onOpen?.({ run, event });
    };

    ws.onclose = (event) => {
      connectingRunIds.delete(run.id);
      if (run.ws === ws) run.ws = null;
      options?.onClose?.({ run, event });
    };

    return ws;
  }

  function ensureConnected(run) {
    if (!run) return null;
    if (isSocketActive(run)) return run.ws || null;
    return connectRun(run);
  }

  return {
    addRun,
    removeRunById,
    findRunById,
    getRuns,
    getActiveRun,
    getActiveRunId,
    isSocketActive,
    selectRun,
    connectRun,
    ensureConnected,
    queueRunOutput,
    flushRunOutput,
    clearRunOutputState,
  };
}
