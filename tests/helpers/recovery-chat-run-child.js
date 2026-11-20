/**
 * Child-process body for the chat-run SIGKILL boundary matrix (leaf R19a).
 *
 * `tests/recovery-chat-run-crash.test.js` spawns this module through the
 * isolated crash harness (own data dir, real SIGKILL). It drives the REAL
 * `startChatRun` / `noteChatRunFinished` / `cancelChatRun` / resume service
 * against a mock executor whose only observable effect is a line appended to
 * `<dataDir>/side-effects.log` (`LAUNCH`, `TOOL`, `FINISH`, `CANCEL`,
 * `CONTINUATION`, `CLEANUP_BEGIN`). No model is ever called.
 *
 * Parameters arrive through the environment:
 * - `CR_STAGE`    `run` | `seed` | `recover` | `boot` | `race`
 * - `CR_KILL_AT`  (`run`) the boundary at which the child announces READY and
 *                 then freezes so the parent can SIGKILL it
 * - `CR_ERR_CODE` (`run`) the code the mock adapter rejects `start` with
 * - `CR_REQ`      caller requestId (default `req-fixed`)
 * - `CR_PROBE`    (`boot`) `missing` | `idle` | `executor`
 * - `CR_RETRY`    (`boot`) `1` re-issues `startChatRun` with the same requestId
 * - `CR_FINISH_LATE` (`boot`) `1` replays the harness `finished` event
 * - `CR_RACE_KEY` (`race`) idempotency key of this instance
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { addChat } from '../../lib/persist/chats-persist.js';
import {
  cancelChatRun,
  probeChatRunLiveness,
  registerChatRunAdapter,
  startChatRun,
  unregisterChatRunAdapter,
} from '../../lib/chat-run-service.js';
import { createDurableRequestLookup } from '../../lib/chat-run/kernel-adapter.ts';
import {
  getChatRunRecordByCallerRequest,
  noteChatRunFinished,
} from '../../lib/chat-run/chat-run-recovery.ts';
import { classifyAndRecordOpenRuns } from '../../lib/recovery/recovery-boot.ts';
import { createRecoveryResumeService } from '../../lib/recovery/recovery-resume.ts';
import { openRecoveryStore } from '../../lib/recovery/recovery-store.ts';

const env = process.env;
const dataDir = env.RECOVERY_CRASH_DATA_DIR;
const SIDE_EFFECTS = path.join(dataDir, 'side-effects.log');
const IDS_FILE = path.join(dataDir, 'ids.json');
const EXECUTOR_PID_FILE = path.join(dataDir, 'executor.pid');
const REQ = env.CR_REQ || 'req-fixed';
const TRANSPORT = 'codex';
const ADAPTER_RUN_ID = 'run-1';

// A never-resolving promise would let node exit; keep the loop alive instead.
setInterval(() => {}, 1000);

function side(line) {
  fs.appendFileSync(SIDE_EFFECTS, `${line}\n`);
}

function ready() {
  fs.writeSync(1, 'READY\n');
}

function emit(tag, value) {
  fs.writeSync(1, `${tag} ${JSON.stringify(value)}\n`);
}

/** Announce READY, then block this thread so the parent kills a frozen process. */
function freezeSync() {
  ready();
  const cell = new Int32Array(new SharedArrayBuffer(4));
  for (;;) Atomics.wait(cell, 0, 0, 1000);
}

/** Announce READY, then never settle. */
function freezeAsync() {
  ready();
  return new Promise(() => {});
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function installAdapter({ start, cancel, getState }) {
  unregisterChatRunAdapter(TRANSPORT);
  registerChatRunAdapter({
    transport: TRANSPORT,
    capabilities: {
      canLookupRequest: true,
      canCancel: true,
      canReconstructSession: true,
      canReadFiles: true,
      canSearch: true,
      deniesMutation: false,
      canResumeSession: true,
    },
    lookupRequest: createDurableRequestLookup({
      transport: TRANSPORT,
      rooms: new Map(),
      canResumeSessionCapability: true,
    }),
    start,
    cancel: cancel || (async () => {}),
    getState,
  });
}

function readChatId() {
  return JSON.parse(fs.readFileSync(IDS_FILE, 'utf8')).chatId;
}

function createChat() {
  const chat = addChat(`sess-crash-${process.pid}`, 'Crash matrix', null, '/tmp', 'm', {
    agentTransport: TRANSPORT,
    sdkMode: 'agent',
  });
  fs.writeFileSync(IDS_FILE, JSON.stringify({ chatId: chat.id }));
  return chat;
}

function finishedRunId() {
  return ADAPTER_RUN_ID;
}

/** Mock executor that counts each launch as an observable side effect. */
function launchingAdapterHooks(killAt, errCode) {
  return {
    getState() {
      if (killAt === 'before_intent') freezeSync();
      return { busy: false, waitingForInput: false };
    },
    async start() {
      if (killAt === 'before_accept') return freezeAsync();
      if (errCode) {
        const error = new Error('adapter rejected the launch');
        error.code = errCode;
        throw error;
      }
      side('LAUNCH');
      if (killAt === 'executor') {
        const executor = spawn(
          process.execPath,
          ['-e', 'setInterval(() => {}, 1000)'],
          { detached: true, stdio: 'ignore' }
        );
        executor.unref();
        fs.writeFileSync(EXECUTOR_PID_FILE, String(executor.pid));
      }
      if (killAt === 'before_ack_persist') {
        // `startChatRun` reads `runId` right before it persists the ack.
        return {
          accepted: true,
          get runId() {
            return freezeSync();
          },
        };
      }
      return { runId: ADAPTER_RUN_ID, accepted: true };
    },
    async cancel() {
      side('CANCEL');
    },
  };
}

async function runStage() {
  const killAt = env.CR_KILL_AT || '';
  const errCode = env.CR_ERR_CODE || '';
  openRecoveryStore({ dataDir });
  const chat = createChat();
  installAdapter(launchingAdapterHooks(killAt, errCode));
  try {
    await startChatRun({ chatId: chat.id, prompt: 'do the thing', requestId: REQ });
  } catch (err) {
    emit('RESULT', { startError: err?.code || String(err?.message || err) });
    return freezeAsync();
  }
  if (killAt === 'tool') {
    side('TOOL');
    return freezeAsync();
  }
  if (killAt === 'executor') return freezeAsync();
  if (killAt === 'before_terminal') {
    side('TOOL');
    side('FINISH');
    // `noteChatRunFinished` stringifies `status` after it matched the open run
    // and before it writes the terminal record: the exact boundary.
    noteChatRunFinished({
      chatId: chat.id,
      runId: finishedRunId(),
      status: { toString: () => freezeSync() },
    });
    return undefined;
  }
  if (killAt === 'cleanup') {
    side('TOOL');
    side('FINISH');
    const written = noteChatRunFinished({ chatId: chat.id, runId: finishedRunId(), status: 'finished' });
    emit('RESULT', { terminalWritten: written });
    side('CLEANUP_BEGIN');
    return freezeAsync();
  }
  if (killAt === 'stop') {
    side('TOOL');
    await cancelChatRun({ chatId: chat.id, runId: ADAPTER_RUN_ID, reason: 'user_stop' });
    return freezeAsync();
  }
  if (killAt === 'seed_interrupted') {
    side('TOOL');
    const written = noteChatRunFinished({ chatId: chat.id, runId: finishedRunId(), status: 'error' });
    emit('RESULT', { terminalWritten: written });
    ready();
    process.exit(0);
  }
  return freezeAsync();
}

function bootProbe(mode) {
  return (run) => {
    if (mode === 'executor') {
      const pid = Number(fs.readFileSync(EXECUTOR_PID_FILE, 'utf8'));
      return isPidAlive(pid)
        ? { known: true, busy: true }
        : { known: true, busy: false };
    }
    return probeChatRunLiveness({
      chatId: run.chatId,
      runId: run.acceptance?.adapterRunId || run.adapterRunId,
    });
  };
}

async function bootStage() {
  const probeMode = env.CR_PROBE || 'missing';
  openRecoveryStore({ dataDir });
  const chatId = readChatId();
  installAdapter({
    getState() {
      if (probeMode === 'idle') return { busy: false, waitingForInput: false, runId: '' };
      if (probeMode === 'executor') {
        const pid = Number(fs.readFileSync(EXECUTOR_PID_FILE, 'utf8'));
        return { busy: isPidAlive(pid), waitingForInput: false, runId: ADAPTER_RUN_ID };
      }
      return null;
    },
    async start() {
      side('LAUNCH');
      return { runId: 'run-2', accepted: true };
    },
  });
  const classified = classifyAndRecordOpenRuns({ probeLiveness: bootProbe(probeMode) });
  const result = {
    scanned: classified.scanned,
    ok: classified.ok,
    classifications: classified.classifications.map((entry) => ({
      logicalRunId: entry.logicalRunId,
      state: entry.classification.state,
      reason: entry.classification.reason,
      attempt: entry.attempt,
      reprobeAt: entry.reprobeAt,
      interrupted: entry.interrupted === true,
    })),
  };
  if (env.CR_FINISH_LATE === '1') {
    result.finishLate = [
      noteChatRunFinished({ chatId, runId: ADAPTER_RUN_ID, status: 'finished' }),
      noteChatRunFinished({ chatId, runId: ADAPTER_RUN_ID, status: 'finished' }),
    ];
  }
  if (env.CR_RETRY === '1') {
    try {
      const retried = await startChatRun({ chatId, prompt: 'do the thing', requestId: REQ });
      result.retry = { ok: true, runId: retried.runId };
    } catch (err) {
      result.retry = { ok: false, code: err?.code || String(err?.message || err) };
    }
  }
  emit('RESULT', result);
  ready();
  process.exit(0);
}

function continuationService({ onContinuation }) {
  return createRecoveryResumeService({
    probeLiveness: () => 'dead',
    getCapabilities: () => ({ canResumeSession: true, canReattach: false }),
    startContinuation: onContinuation,
  });
}

async function recoverStage() {
  openRecoveryStore({ dataDir });
  const row = getChatRunRecordByCallerRequest(REQ);
  const service = continuationService({
    onContinuation: async () => {
      side('CONTINUATION');
      return freezeAsync();
    },
  });
  await service.resumeRun({
    chatId: row.chatId,
    logicalRunId: row.logicalRunId,
    expectedState: row.state,
    expectedRevision: row.revision,
    idempotencyKey: 'manual-1',
  });
  return undefined;
}

async function raceStage() {
  openRecoveryStore({ dataDir });
  const row = getChatRunRecordByCallerRequest(REQ);
  const go = env.RECOVERY_CRASH_BARRIER;
  const service = continuationService({
    onContinuation: async () => {
      side('CONTINUATION');
      return { accepted: true, adapterRunId: 'run-resumed' };
    },
  });
  ready();
  while (!fs.existsSync(go)) await new Promise((resolve) => setTimeout(resolve, 5));
  const result = await service.resumeRun({
    chatId: row.chatId,
    logicalRunId: row.logicalRunId,
    expectedState: row.state,
    expectedRevision: row.revision,
    idempotencyKey: env.CR_RACE_KEY,
  });
  emit('RESULT', { status: result.status, reason: result.reason });
  process.exit(0);
}

const stages = { run: runStage, seed: runStage, boot: bootStage, recover: recoverStage, race: raceStage };
await stages[env.CR_STAGE]();
