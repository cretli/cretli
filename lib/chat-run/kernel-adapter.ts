/**
 * Register a chat-run adapter for a kernel-backed harness room.
 */

import { registerChatRunAdapter } from '../chat-run-service.js';
import { assertChatCanReceiveMessages } from '../chat-message-guard.js';
import { getChatByCursorSessionId } from '../persist/chats-persist.js';
import { describeRecoveryAdapterContract } from '../recovery/recovery-contract.ts';
import { getChatRunRecordByCallerRequest } from './chat-run-recovery.ts';
import { resolveEffectiveRecoveryCapabilities } from './adapter-capabilities.ts';
import {
  beginChatRunRecord,
  noteChatRunStopped,
  recordChatRunAccepted,
  recordChatRunStartFailed,
} from './chat-run-recovery.ts';
import { newRecoveryId } from '../recovery/recovery-ids.ts';
import { buildStartPromptArgs } from './start-prompt-args.ts';
import { selectionFromSkillIds } from '../skills/skill-selection.js';

/** A kernel harness room: a dynamic runtime object that differs per harness. */
type Room = Record<string, any>;
type RecoveryRecord = { run: Record<string, any>, logicalRunId: string } | null;

/**
 * Transcript preservation is observed in the room, not inferred from Map presence.
 */
export function resolveObservedTranscriptLoss(input: {
  contract: ReturnType<typeof describeRecoveryAdapterContract>,
  room: Room | null | undefined,
  durableRunId: string,
  roomMissing: boolean,
  effectiveReattach: boolean,
}): { transcriptLost: boolean, transcriptLossReason: string } {
  const contract = input.contract;
  if (!contract.supported) {
    return { transcriptLost: true, transcriptLossReason: 'no_recovery_contract' };
  }
  if (input.roomMissing) {
    return { transcriptLost: true, transcriptLossReason: 'room_missing' };
  }
  if (!input.effectiveReattach) {
    const reason = contract.transcriptLossReason === 'none'
      ? 'fresh_turn_in_saved_session'
      : contract.transcriptLossReason;
    return { transcriptLost: reason !== 'none', transcriptLossReason: reason };
  }
  const durableId = String(input.durableRunId || '').trim();
  if (!durableId) {
    return { transcriptLost: true, transcriptLossReason: 'no_live_run_match' };
  }
  const liveId = String(input.room?.currentRun?.id || '').trim();
  if (liveId !== durableId) {
    return { transcriptLost: true, transcriptLossReason: 'no_live_run_match' };
  }
  return { transcriptLost: false, transcriptLossReason: 'none' };
}

/**
 * Kick off a room prompt without waiting for the model to finish.
 */
export function acceptRoomPrompt(
  room: Room,
  startInput: {
    prompt: string,
    mode?: string,
    displayText?: string,
    selectedSkillIds?: string[],
    requestId?: string,
    startPrompt?: (...args: unknown[]) => unknown,
    recoveryRecord?: RecoveryRecord,
  },
  waitingForInput: (room: Room) => boolean = () => false,
): { runId: string, accepted: true, requestId: string } {
  const startPrompt = typeof startInput.startPrompt === 'function'
    ? startInput.startPrompt
    : room?.startPrompt;
  if (!room || typeof startPrompt !== 'function') {
    const error: Error & { code?: string } = new Error('Prompt runner is missing');
    error.code = 'adapter_unavailable';
    throw error;
  }
  if (waitingForInput(room) || room.busy) {
    const error: Error & { code?: string } = new Error('Recipient is busy');
    error.code = 'recipient_busy';
    throw error;
  }
  const requestId = String(startInput.requestId || '').trim();
  const record = startInput.recoveryRecord || beginChatRunRecord({
    chat: { id: room.chatId, workspaceFolder: room.cwd, cursorSessionId: room.sessionKey },
    transport: room.transport || '',
    requestId: requestId || newRecoveryId('request'),
    mode: startInput.mode || 'agent',
    store: room.recoveryStore,
  });
  room.serverHold = true;
  let launch: any;
  try {
    room._recoveryRecord = record;
    // The argument layout is per harness (selection is not always the 5th argument).
    launch = startPrompt.apply(room, buildStartPromptArgs(room, {
      text: startInput.prompt,
      mode: startInput.mode || 'agent',
      displayText: startInput.displayText || '',
      selection: selectionFromSkillIds(startInput.selectedSkillIds),
    }));
  } catch (err) {
    if (record) recordChatRunStartFailed({ record, error: err, store: room.recoveryStore });
    throw err;
  } finally {
    room._recoveryRecord = null;
  }
  const runId = String(room.currentRun?.id || '');
  if (record) recordChatRunAccepted({ record, runId, store: room.recoveryStore });
  if (launch && typeof launch.catch === 'function') {
    void launch.catch((error: unknown) => recordChatRunStartFailed({ record: record as NonNullable<RecoveryRecord>, error, store: room.recoveryStore }));
  }
  // Bind the room's executor run to the caller's requestId so the recovery
  // layer can record/lookup a durable row for the run this accept started.
  if (requestId && room.currentRun && typeof room.currentRun === 'object') {
    room.currentRun.requestId = requestId;
  }
  return {
    runId,
    accepted: true,
    requestId,
  };
}

/**
 * Wrap a room's direct WS prompt and cancel methods with recovery evidence.
 */
export function bindRoomRecoveryLifecycle({ room, chat, transport }: { room: Room, chat: Record<string, any>, transport: string }): void {
  if (!room || typeof room.startPrompt !== 'function') return;
  // Callers (OpenCode/SDK) re-assign `room.startPrompt` on every bind, which
  // strips our wrapper. Re-wrap whenever the current function is not the
  // wrapper we installed; never wrap our own wrapper.
  // Always keep the latest chat/transport on the room: wrappers read them at
  // call time so a re-bind with a refreshed chat is not shadowed by a stale closure.
  room._recoveryChat = chat;
  room._recoveryTransport = transport;
  if (room.startPrompt !== room._recoveryStartPromptWrapper) {
    const prompt = room.startPrompt;
    // Rest args: the runner signatures differ per harness (some append a client
    // timestamp, an accept callback or the skill selection), the wrapper must not drop them.
    const wrapped = function wrappedStartPrompt(this: unknown, ...args: any[]) {
      const mode = args[1];
      // `room.recoveryStore` is normally unset: the recovery helpers then fall
      // back to the process-default store.
      const record = room._recoveryRecord || beginChatRunRecord({
        chat: room._recoveryChat,
        transport: room._recoveryTransport,
        requestId: newRecoveryId('request'),
        mode: mode || 'agent',
        store: room.recoveryStore,
      });
      const launch = prompt.apply(this, args);
      if (record) recordChatRunAccepted({ record, runId: room.currentRun?.id, store: room.recoveryStore });
      if (launch && typeof launch.catch === 'function') {
        void launch.catch((error: unknown) => recordChatRunStartFailed({ record: record as NonNullable<RecoveryRecord>, error, store: room.recoveryStore }));
      }
      return launch;
    };
    room.startPrompt = wrapped;
    room._recoveryStartPromptWrapper = wrapped;
  }
  room._recoveryLifecycleBound = true;
  const cancel = room.cancelCurrentRun;
  if (typeof cancel !== 'function' || cancel === room._recoveryCancelWrapper) return;
  const wrappedCancel = async function wrappedCancelCurrentRun(this: unknown, ...args: any[]) {
    if (room._internalRecoveryCancel !== true) {
      noteChatRunStopped({ chatId: room._recoveryChat?.id ?? chat.id, runId: room.currentRun?.id, reason: 'user_stop', store: room.recoveryStore });
    }
    return cancel.apply(this, args);
  };
  room.cancelCurrentRun = wrappedCancel;
  room._recoveryCancelWrapper = wrappedCancel;
}

/**
 * Build the durable `lookupRequest` for a kernel-backed transport (leaf R6).
 *
 * The answer comes from the recovery registry, never from the in-memory `rooms`
 * Map, so a probe after a process restart still finds the run the caller was
 * given an id for. `rooms` is consulted only to say whether the transcript that
 * lived in the room is still here, which is the explicit loss signal — it is
 * never a source of acceptance, and a durable row must not look alive.
 *
 * Outcomes (each one is deliberately distinguishable):
 * - blank `requestId` -> `null`: nothing was asked about.
 * - transport outside the recovery MVP set -> an explicit `unsupported` marker
 *   with `accepted: null`, because "this adapter has no recovery contract" is
 *   not evidence that a run ended, completed or was refused.
 * - no durable row (or a store this process cannot read) -> `null`: unknown,
 *   which callers must treat as "not proven", never as "finished".
 * - row without `acceptance.state === 'accepted'` -> `accepted: false`: the run
 *   is known, but nothing proves the executor ever took it.
 * - accepted row -> `accepted: true` with the durable `adapterRunId`.
 *
 * The `reattachCapability` / `canResumeSessionCapability` flags are the room's
 * own runtime claims and default to "no narrowing": an omitted flag must not
 * silently disable the capability the contract grants. Only an explicit `false`
 * narrows it. Both this lookup and `getChatRunAdapterCapabilities` derive the
 * effective view from the SAME helper
 * (`resolveEffectiveRecoveryCapabilities`), so they can never disagree about a
 * transport (finding F1).
 */
export function createDurableRequestLookup({
  transport,
  rooms,
  recoveryStore,
  reattachCapability,
  canResumeSessionCapability,
}: {
  transport?: string,
  rooms?: Map<string, Room>,
  recoveryStore?: Record<string, any>,
  reattachCapability?: boolean,
  canResumeSessionCapability?: boolean,
} = {}): (lookupInput?: { chat?: Record<string, any>, requestId?: string }) => ({ accepted: boolean | null, runId?: string } & Record<string, unknown>) | null {
  const contract = describeRecoveryAdapterContract(transport as string);
  // Intersection of the contract and the room's claims, not a hard requirement
  // that a caller remembered to pass `reattachCapability: true`. The resume
  // strategy is narrowed symmetrically, so a runtime that disclaims resume never
  // gets a contract strategy handed back through the per-run lookup.
  const { canReattach: effectiveReattach, resumeStrategy } = resolveEffectiveRecoveryCapabilities({
    contract,
    canReattachDeclared: reattachCapability,
    canResumeSessionDeclared: canResumeSessionCapability,
  });
  return ({ chat, requestId } = {}) => {
    const key = String(requestId || '').trim();
    if (!key) return null;
    if (!contract.supported) {
      return {
        accepted: null,
        runId: '',
        unsupported: true,
        decision: contract.decision,
        infraOutcome: contract.infraOutcome,
        recoveryScope: contract.scope,
        rationale: contract.rationale,
        transcriptLost: true,
        transcriptLossReason: 'no_recovery_contract',
        requestId: key,
      };
    }
    let run: Record<string, any> | null = null;
    try {
      run = getChatRunRecordByCallerRequest(key, recoveryStore);
    } catch {
      // A store this process cannot read proves nothing about the run.
      return null;
    }
    if (!run) return null;
    const acceptanceState = String(run.acceptance?.state || '').trim();
    const accepted = acceptanceState === 'accepted';
    const sessionKey = String(chat?.cursorSessionId || '').trim();
    const roomMissing = !(rooms instanceof Map) || !sessionKey || !rooms.has(sessionKey);
    const room = roomMissing ? null : rooms.get(sessionKey);
    const durableRunId = accepted
      ? String(run.acceptance?.adapterRunId || run.adapterRunId || '')
      : '';
    const transcript = resolveObservedTranscriptLoss({
      contract,
      room,
      durableRunId,
      roomMissing,
      effectiveReattach,
    });
    return {
      accepted,
      runId: durableRunId,
      requestId: key,
      logicalRunId: String(run.logicalRunId || ''),
      attemptId: String(run.attemptId || ''),
      state: String(run.state || ''),
      acceptanceState,
      unsupported: false,
      decision: '',
      infraOutcome: String(run.infraOutcome || ''),
      transcriptLost: transcript.transcriptLost,
      transcriptLossReason: transcript.transcriptLossReason,
      resumeStrategy,
    };
  };
}

/**
 * @param input `recoveryStore` overrides the process-default recovery registry for
 *   the durable lookup (tests, multi-store hosts); `reattachCapability` /
 *   `canResumeSessionCapability` are what the room itself can do at runtime. An
 *   omitted flag means "no narrowing" — the recovery contract decides; only an
 *   explicit `false` withholds it. Both flags are threaded from THIS input into
 *   the capability surface and the durable lookup together, so a kernel adapter
 *   cannot express the same fact twice.
 */
export function registerKernelChatRunAdapter(input: {
  transport: string,
  rooms: Map<string, Room>,
  ensureRoom: (sessionKey: string, deps?: object) =>
    | { room: Room, chat: Record<string, any> }
    | { error: string, code: string }
    | Promise<{ room: Room, chat: Record<string, any> } | { error: string, code: string }>,
  waitingForInput?: (room: Room) => boolean,
  recoveryStore?: Record<string, any>,
  reattachCapability?: boolean,
  canResumeSessionCapability?: boolean,
}): void {
  const transport = String(input?.transport || '').trim();
  const rooms = input?.rooms;
  const ensureRoom = input?.ensureRoom;
  if (!transport || !(rooms instanceof Map) || typeof ensureRoom !== 'function') {
    throw new TypeError('Kernel chat-run adapter requires transport, rooms, and ensureRoom');
  }
  const waitingForInput = typeof input.waitingForInput === 'function'
    ? input.waitingForInput
    : () => false;
  const reattachCapability = input?.reattachCapability;
  const canResumeSessionCapability = input?.canResumeSessionCapability;
  registerChatRunAdapter({
    transport,
    capabilities: {
      canLookupRequest: true,
      canCancel: true,
      canReconstructSession: true,
      canReadFiles: true,
      canSearch: true,
      deniesMutation: false,
      // The room's own runtime capabilities, passed through untouched so an
      // absent flag stays "unspecified" and the shared
      // `resolveEffectiveRecoveryCapabilities` intersects the CONTRACT with them.
      canReattach: reattachCapability,
      canResumeSession: canResumeSessionCapability,
    },
    lookupRequest: createDurableRequestLookup({
      transport,
      rooms,
      recoveryStore: input?.recoveryStore,
      reattachCapability,
      canResumeSessionCapability,
    }),
    async start(startInput: Record<string, any>) {
      const sessionKey = String(startInput.chat?.cursorSessionId || '').trim();
      const ensured = await ensureRoom(sessionKey, startInput.deps || {});
      if ('error' in ensured) {
        const error: Error & { code?: string } = new Error(ensured.error);
        error.code = ensured.code;
        throw error;
      }
      const { room } = ensured;
      assertChatCanReceiveMessages(getChatByCursorSessionId(sessionKey));
      return acceptRoomPrompt(room, {
        prompt: startInput.prompt,
        mode: startInput.mode,
        displayText: startInput.displayText,
        selectedSkillIds: startInput.selectedSkillIds,
        requestId: startInput.requestId,
        recoveryRecord: startInput.recoveryRecord,
      }, waitingForInput);
    },
    async cancel(cancelInput: Record<string, any>) {
      const room = rooms.get(String(cancelInput.chat?.cursorSessionId || ''));
      if (!room) return;
      if (cancelInput.runId && room.currentRun?.id && room.currentRun.id !== cancelInput.runId) {
        return;
      }
      if (typeof room.cancelCurrentRun === 'function') {
        room._internalRecoveryCancel = true;
        try {
          await room.cancelCurrentRun();
        } finally {
          room._internalRecoveryCancel = false;
        }
        return;
      }
      room.cancelled = true;
    },
    getState({ chat, runId }: { chat: Record<string, any>, runId?: string }) {
      const room = rooms.get(String(chat?.cursorSessionId || ''));
      if (!room) return null;
      if (runId && room.currentRun?.id && room.currentRun.id !== runId) return null;
      return {
        runId: String(room.currentRun?.id || room.lastRunId || ''),
        busy: !!room.busy,
        waitingForInput: waitingForInput(room),
        // A watcher cycle close needs the concrete reason of the last finished
        // run (e.g. an MCP gate refusal) before it falls back to missing_report.
        lastErrorCode: typeof room.lastErrorCode === 'string' ? room.lastErrorCode.trim() : '',
      };
    },
  });
}
