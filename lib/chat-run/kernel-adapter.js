/**
 * Register a chat-run adapter for a kernel-backed harness room.
 */

import { registerChatRunAdapter } from '../chat-run-service.js';
import { assertChatCanReceiveMessages } from '../chat-message-guard.js';
import { getChatByCursorSessionId } from '../persist/chats-persist.js';
import { describeRecoveryAdapterContract } from '../recovery/recovery-contract.js';
import { getRunByRequestId } from '../recovery/recovery-store.js';
import { resolveEffectiveRecoveryCapabilities } from './adapter-capabilities.js';

/**
 * Transcript preservation is observed in the room, not inferred from Map presence.
 *
 * @param {{
 *   contract: ReturnType<typeof describeRecoveryAdapterContract>,
 *   room: object | null | undefined,
 *   durableRunId: string,
 *   roomMissing: boolean,
 *   effectiveReattach: boolean,
 * }} input
 * @returns {{ transcriptLost: boolean, transcriptLossReason: string }}
 */
export function resolveObservedTranscriptLoss(input) {
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
 *
 * @param {object} room
 * @param {{
 *   prompt: string,
 *   mode?: string,
 *   displayText?: string,
 *   requestId?: string,
 *   startPrompt?: (...args: unknown[]) => unknown,
 * }} startInput
 * @param {(room: object) => boolean} waitingForInput
 * @returns {{ runId: string, accepted: true, requestId: string }}
 */
export function acceptRoomPrompt(room, startInput, waitingForInput = () => false) {
  const startPrompt = typeof startInput.startPrompt === 'function'
    ? startInput.startPrompt
    : room?.startPrompt;
  if (!room || typeof startPrompt !== 'function') {
    const error = new Error('Prompt runner is missing');
    error.code = 'adapter_unavailable';
    throw error;
  }
  if (waitingForInput(room) || room.busy) {
    const error = new Error('Recipient is busy');
    error.code = 'recipient_busy';
    throw error;
  }
  room.serverHold = true;
  void startPrompt.call(
    room,
    startInput.prompt,
    startInput.mode || 'agent',
    false,
    startInput.displayText || '',
  );
  const requestId = String(startInput.requestId || '').trim();
  // Bind the room's executor run to the caller's requestId so the recovery
  // layer can record/lookup a durable row for the run this accept started.
  if (requestId && room.currentRun && typeof room.currentRun === 'object') {
    room.currentRun.requestId = requestId;
  }
  return {
    runId: String(room.currentRun?.id || ''),
    accepted: true,
    requestId,
  };
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
 *
 * @param {{
 *   transport: string,
 *   rooms?: Map<string, object>,
 *   recoveryStore?: object,
 *   reattachCapability?: boolean,
 *   canResumeSessionCapability?: boolean,
 * }} input
 * @returns {(lookupInput: { chat?: object, requestId?: string }) => object | null}
 */
export function createDurableRequestLookup({
  transport,
  rooms,
  recoveryStore,
  reattachCapability,
  canResumeSessionCapability,
} = {}) {
  const contract = describeRecoveryAdapterContract(transport);
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
    /** @type {object | null} */
    let run = null;
    try {
      run = getRunByRequestId(key, recoveryStore);
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
 * @param {{
 *   transport: string,
 *   rooms: Map<string, object>,
 *   ensureRoom: (sessionKey: string, deps?: object) =>
 *     | { room: object, chat: object }
 *     | { error: string, code: string }
 *     | Promise<{ room: object, chat: object } | { error: string, code: string }>,
 *   waitingForInput?: (room: object) => boolean,
 *   recoveryStore?: object,
 *   reattachCapability?: boolean,
 *   canResumeSessionCapability?: boolean,
 * }} input `recoveryStore` overrides the process-default recovery registry for
 *   the durable lookup (tests, multi-store hosts); `reattachCapability` /
 *   `canResumeSessionCapability` are what the room itself can do at runtime. An
 *   omitted flag means "no narrowing" — the recovery contract decides; only an
 *   explicit `false` withholds it. Both flags are threaded from THIS input into
 *   the capability surface and the durable lookup together, so a kernel adapter
 *   cannot express the same fact twice.
 */
export function registerKernelChatRunAdapter(input) {
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
    async start(startInput) {
      const sessionKey = String(startInput.chat?.cursorSessionId || '').trim();
      const ensured = await ensureRoom(sessionKey, startInput.deps || {});
      if ('error' in ensured) {
        const error = new Error(ensured.error);
        error.code = ensured.code;
        throw error;
      }
      const { room } = ensured;
      assertChatCanReceiveMessages(getChatByCursorSessionId(sessionKey));
      return acceptRoomPrompt(room, {
        prompt: startInput.prompt,
        mode: startInput.mode,
        displayText: startInput.displayText,
        requestId: startInput.requestId,
      }, waitingForInput);
    },
    async cancel(cancelInput) {
      const room = rooms.get(String(cancelInput.chat?.cursorSessionId || ''));
      if (!room) return;
      if (cancelInput.runId && room.currentRun?.id && room.currentRun.id !== cancelInput.runId) {
        return;
      }
      if (typeof room.cancelCurrentRun === 'function') {
        await room.cancelCurrentRun();
        return;
      }
      room.cancelled = true;
    },
    getState({ chat, runId }) {
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
