/** Output pipeline helpers of a task run: catch-up trimming, terminal flush, socket URL, debug stats. */
import { t } from '../../../i18n/index.js';
import { readCurrentWorkspaceScope } from '../state/workspaceScope.js';
import {
  TASK_DEBUG_REPORT_INTERVAL_MS,
  isTasksDebugEnabled,
  tasksDebugLog,
  tasksPerfLog,
} from './tasksDebug.js';

export const TASK_CATCHUP_MAX_CHARS = 12000;

export function processCatchUpOutput(data) {
  let out = typeof data === 'string' ? data : '';
  if (out.length > 0) {
    tasksPerfLog('Received catch-up payload', { chars: out.length });
  }
  if (out.length <= TASK_CATCHUP_MAX_CHARS) return out;
  out = out.slice(-TASK_CATCHUP_MAX_CHARS);
  return (
    '\r\n\x1b[33m' + t('tasks.catchUpTruncated', { chars: TASK_CATCHUP_MAX_CHARS }) + '\x1b[0m\r\n' + out
  );
}

export function flushTaskRunOutput(run, output, shouldReset) {
  if (!run) return;
  const startTs = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (shouldReset) run.term.reset();
  if (output) run.term.write(output);
  const endTs = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const flushMs = endTs - startTs;
  if (run.debugStats) {
    run.debugStats.flushCount += 1;
    run.debugStats.flushedChars += output.length;
    if (flushMs > run.debugStats.maxFlushMs) run.debugStats.maxFlushMs = flushMs;
    maybeReportRunDebugStats(run);
  }
  if (flushMs > 24) {
    tasksPerfLog('Slow terminal flush', {
      taskLabel: run.taskLabel,
      runId: run.runId,
      flushMs: Number(flushMs.toFixed(2)),
      outputChars: output.length,
      shouldReset,
    });
    tasksDebugLog('Slow flush detected', {
      taskLabel: run.taskLabel,
      runId: run.runId,
      flushMs,
      outputChars: output.length,
      shouldReset,
    });
  }
}

export function buildTaskRunSocket(run) {
  const protocol = typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = typeof location !== 'undefined' ? location.host : '';
  let wsPath = '/ws-task?task=' + encodeURIComponent(run.taskLabel);
  const workspaceFile = readCurrentWorkspaceScope().workspaceFile;
  if (workspaceFile) wsPath += '&workspaceFile=' + encodeURIComponent(workspaceFile);
  if (run.runId) wsPath += '&run=' + encodeURIComponent(run.runId);
  return new WebSocket(protocol + '//' + host + wsPath);
}

export function maybeReportRunDebugStats(run) {
  if (!isTasksDebugEnabled()) return;
  if (!run?.debugStats) return;
  const now = Date.now();
  if (now - run.debugStats.lastReportAt < TASK_DEBUG_REPORT_INTERVAL_MS) return;
  const s = run.debugStats;
  tasksDebugLog('Run stats', {
    taskLabel: run.taskLabel,
    runId: run.runId,
    wsState: run.ws ? run.ws.readyState : null,
    msgCount: s.msgCount,
    bytes: s.bytes,
    catchUpCount: s.catchUpCount,
    catchUpBytes: s.catchUpBytes,
    flushCount: s.flushCount,
    flushedChars: s.flushedChars,
    maxQueueChars: s.maxQueueChars,
    maxFlushMs: Number(s.maxFlushMs.toFixed(2)),
  });
  run.debugStats.lastReportAt = now;
  run.debugStats.msgCount = 0;
  run.debugStats.bytes = 0;
  run.debugStats.catchUpCount = 0;
  run.debugStats.catchUpBytes = 0;
  run.debugStats.flushCount = 0;
  run.debugStats.flushedChars = 0;
  run.debugStats.maxQueueChars = 0;
  run.debugStats.maxFlushMs = 0;
}

export function createRunDebugStats() {
  return {
    lastReportAt: Date.now(),
    msgCount: 0,
    bytes: 0,
    catchUpCount: 0,
    catchUpBytes: 0,
    flushCount: 0,
    flushedChars: 0,
    maxQueueChars: 0,
    maxFlushMs: 0,
  };
}
