#!/usr/bin/env node
/**
 * Live Cursor SDK Glob/Grep/Read/shell isolation. Not part of `npm test`.
 *
 *   npm run test:live-cursor-sdk
 *
 * Without @cursor/sdk or CURSOR_API_KEY the run is skipped. With
 * CRETLI_LIVE_CURSOR_SDK=1 a skip is a failure.
 */

import { runCursorSdkHistoryIsolationProbe } from '../../lib/sdk/sdk-history-isolation-probe.js';

const requireLive = process.env.CRETLI_LIVE_CURSOR_SDK === '1';
const probe = await runCursorSdkHistoryIsolationProbe({
  timeoutMs: Number.parseInt(process.env.CRETLI_LIVE_CURSOR_SDK_TIMEOUT_MS || '60000', 10),
});

if (probe.skipped) {
  const line = `SKIPPED: Cursor SDK history isolation (${probe.reason || 'unavailable'})`;
  console.log(line);
  if (requireLive) {
    console.error('CRETLI_LIVE_CURSOR_SDK=1 requires a live SDK run; skip is not a pass.');
    process.exit(2);
  }
  process.exit(0);
}

function compactTurns(files) {
  return Array.isArray(files?.turns)
    ? files.turns.map((row) => ({
      id: row.id,
      timedOut: row.timedOut === true,
      runStatus: row.runStatus || '',
      retries: Number(row.retries) || 0,
      toolNames: (row.toolCalls || []).map((call) => call.name),
    }))
    : [];
}

function compactEvidence(evidence) {
  if (!evidence) return null;
  return {
    ok: evidence.ok,
    helloSeen: evidence.helloSeen,
    completedToolCallCount: evidence.completedToolCallCount,
    missingAttempts: evidence.missingAttempts,
    leaks: evidence.leaks,
    attempts: evidence.attempts || [],
  };
}

console.log(JSON.stringify({
  ok: probe.ok,
  sdkVersion: probe.sdkVersion,
  agentId: probe.agentId,
  error: probe.error || null,
  limitations: probe.limitations || [],
  createEvidence: compactEvidence(probe.create?.evidence),
  resumeEvidence: compactEvidence(probe.resume?.evidence),
  lateIgnoreEvidence: compactEvidence(probe.lateIgnore?.evidence),
  lateResumeEvidence: compactEvidence(probe.lateIgnore?.resume?.evidence),
  lateWarmupHello: probe.lateIgnore?.warmupHello || false,
  createAttempts: probe.create?.attempts || [],
  resumeAttempts: probe.resume?.attempts || [],
  lateAttempts: probe.lateIgnore?.attempts || [],
  lateResumeAttempts: probe.lateIgnore?.resume?.attempts || [],
  createTurns: compactTurns(probe.create?.files),
  resumeTurns: compactTurns(probe.resume?.files),
  lateTurns: compactTurns(probe.lateIgnore?.files),
  shellIsolation: probe.shellIsolation || null,
  droppedIgnoredReads: probe.droppedIgnoredReads || [],
  fork: probe.fork
    ? {
      markerInFork: probe.fork.markerInFork,
      askKept: probe.fork.askKept,
      persistOk: probe.fork.persistOk,
      distinctAgent: probe.fork.distinctAgent,
      agentId: probe.fork.agentId,
      parentChatId: probe.fork.parentChatId,
      forkParentChatId: probe.fork.forkParentChatId,
      partial: probe.fork.partial,
      toolCallCount: probe.fork.toolCalls?.length || 0,
      assistantText: probe.fork.assistantText || '',
    }
    : null,
  createToolNames: (probe.create?.files?.toolCalls || []).map((row) => row.name),
  resumeToolNames: (probe.resume?.files?.toolCalls || []).map((row) => row.name),
  createShellNames: (probe.create?.shell?.toolCalls || []).map((row) => row.name),
  resumeShellNames: (probe.resume?.shell?.toolCalls || []).map((row) => row.name),
}, null, 2));

if (!probe.ok) {
  console.error('Cursor SDK history isolation live probe failed.');
  process.exit(1);
}
if (probe.shellIsolation && probe.shellIsolation.ok === false) {
  console.warn('LIMITATION: native Cursor SDK shell can still read conversation stores. File tools were isolated. Do not claim history is MCP-only.');
}
console.log('cursor-sdk-history-isolation live OK');
