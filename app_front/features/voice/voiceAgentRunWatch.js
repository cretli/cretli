/**
 * Polls coding-agent busyness after voice send_prompt so the panel can show
 * a working chip without the Live model having to ask get_chat_status.
 */

const DEFAULT_INTERVAL_MS = 800;
const DEFAULT_START_GRACE_MS = 4000;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * @param {{
 *   isBusy: () => boolean,
 *   isAwaiting?: () => boolean,
 *   onBusy?: (phase: 'working'|'awaiting') => void,
 *   onIdle?: (info: { timedOut: boolean }) => void,
 *   now?: () => number,
 *   schedule?: (fn: () => void, ms: number) => unknown,
 *   intervalMs?: number,
 *   startGraceMs?: number,
 *   timeoutMs?: number,
 * }} options
 * @returns {() => void} stop
 */
export function watchVoiceAgentRun(options) {
  const isBusy = typeof options?.isBusy === 'function' ? options.isBusy : () => false;
  const isAwaiting = typeof options?.isAwaiting === 'function' ? options.isAwaiting : () => false;
  const onBusy = typeof options?.onBusy === 'function' ? options.onBusy : null;
  const onIdle = typeof options?.onIdle === 'function' ? options.onIdle : null;
  const now = typeof options?.now === 'function' ? options.now : () => Date.now();
  const intervalMs = Number.isFinite(options?.intervalMs) && options.intervalMs > 0
    ? options.intervalMs
    : DEFAULT_INTERVAL_MS;
  const startGraceMs = Number.isFinite(options?.startGraceMs) && options.startGraceMs >= 0
    ? options.startGraceMs
    : DEFAULT_START_GRACE_MS;
  const timeoutMs = Number.isFinite(options?.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const schedule = typeof options?.schedule === 'function'
    ? options.schedule
    : (fn, ms) => setTimeout(fn, ms);
  let stopped = false;
  let sawBusy = false;
  let timer = null;
  const startedAt = now();

  function finish(timedOut) {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    onIdle?.({ timedOut });
  }

  function tick() {
    if (stopped) return;
    if (now() - startedAt > timeoutMs) {
      finish(true);
      return;
    }
    const awaiting = isAwaiting();
    const busy = awaiting || isBusy();
    if (busy) {
      sawBusy = true;
      onBusy?.(awaiting ? 'awaiting' : 'working');
      timer = schedule(tick, intervalMs);
      return;
    }
    if (!sawBusy && now() - startedAt < startGraceMs) {
      timer = schedule(tick, intervalMs);
      return;
    }
    finish(false);
  }

  tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
