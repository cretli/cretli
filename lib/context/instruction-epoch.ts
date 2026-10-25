/**
 * Instruction epoch: what Cretli may assume about instructions it delivered
 * into a native harness session.
 *
 * Cretli delivers rules/skills as a message prefix. Whether a later turn may
 * skip that prefix depends on the harness still holding the earlier copy, and
 * Cretli cannot read a harness's native memory. So:
 *
 * - The default is delivery on every turn (`always`). Skipping the static block
 *   (`dedupe`) is opt-in and only for adapters listed in
 *   `INSTRUCTION_RETENTION_PROOFS`, whose proof names the signals that
 *   invalidate the earlier copy.
 * - Every event that can make the earlier copy unusable bumps the epoch and
 *   drops the remembered decoration state, so the next turn re-delivers the
 *   full required blocks: new native session, failed resume, reset, lost
 *   process memory, history trim/hydrate, compaction / compact_boundary, and a
 *   model/mode change.
 * - The epoch records what Cretli did, never what the model remembers.
 *
 * Leaf module: no imports, so usage/restart code can bump the epoch without a
 * dependency cycle.
 */

export const INSTRUCTION_EPOCH_REASON = Object.freeze({
  NEW_SESSION: 'new_session',
  RESUME_FAILED: 'resume_failed',
  RESET: 'reset',
  SEED: 'seed',
  PROCESS_LOST: 'process_lost',
  HISTORY_TRIM: 'history_trim',
  HYDRATE: 'hydrate',
  COMPACTION: 'compaction',
  COMPACT_BOUNDARY: 'compact_boundary',
  MODEL_CHANGE: 'model_change',
  MODE_CHANGE: 'mode_change',
  CHANNEL_CHANGE: 'channel_change',
});

const KNOWN_REASONS = new Set(Object.values(INSTRUCTION_EPOCH_REASON));
const MAX_LOG = 10;

/**
 * Adapters with proof that instructions delivered once stay in the native
 * session until a signal we observe says otherwise. A transport that is not
 * listed here never dedupes, whatever the setting says. Proof is per
 * transport and names the invalidation signals the adapter wires into
 * `bumpInstructionEpoch`; it is not a claim about the model's memory.
 */
export const INSTRUCTION_RETENTION_PROOFS: Readonly<Record<string, { channel: string, signals: readonly string[], evidence: string }>> = Object.freeze({
  claude: Object.freeze({
    channel: 'native_session_history',
    signals: Object.freeze(['new_session', 'resume_failed', 'compact_boundary', 'model_change', 'mode_change', 'process_lost']),
    evidence: 'lib/claude/claude-agent-ws.ts bumps the epoch at session creation, failed resume and compact_boundary; tests/instruction-epoch.test.js',
  }),
});

export interface InstructionEpochLogEntry { epoch: number, reason: string, at: number }

export interface InstructionEpochState {
  epoch: number;
  reason: string;
  at: number;
  nativeSessionId: string;
  log: InstructionEpochLogEntry[];
}

type EpochRoom = Record<string, any>;

export function readInstructionEpoch(room: unknown): InstructionEpochState {
  const state = room && typeof room === 'object' ? (room as Record<string, any>)._instructionEpoch : null;
  if (!state || typeof state !== 'object') {
    return { epoch: 0, reason: '', at: 0, nativeSessionId: '', log: [] };
  }
  return {
    epoch: Math.max(0, Math.floor(Number(state.epoch) || 0)),
    reason: String(state.reason || ''),
    at: Number(state.at) || 0,
    nativeSessionId: String(state.nativeSessionId || ''),
    log: Array.isArray(state.log) ? state.log : [],
  };
}

/**
 * Invalidate what Cretli knows about delivered instructions. Idempotent per
 * call site only in the sense that each call is one new epoch; callers bump
 * once per event.
 *
 * @param reason One of `INSTRUCTION_EPOCH_REASON`; unknown values are kept as `unknown`.
 * @returns The new epoch, or null for a non-object room.
 */
export function bumpInstructionEpoch(
  room: EpochRoom | null | undefined,
  reason: string,
  detail: { nativeSessionId?: string, now?: number } = {},
): number | null {
  if (!room || typeof room !== 'object') return null;
  const current = readInstructionEpoch(room);
  const normalized = (KNOWN_REASONS as Set<string>).has(reason) ? reason : 'unknown';
  const epoch = current.epoch + 1;
  const at = Number.isFinite(Number(detail.now)) ? Number(detail.now) : Date.now();
  room._instructionEpoch = {
    epoch,
    reason: normalized,
    at,
    nativeSessionId: detail.nativeSessionId !== undefined ? String(detail.nativeSessionId || '') : current.nativeSessionId,
    log: [...current.log, { epoch, reason: normalized, at }].slice(-MAX_LOG),
  };
  // The remembered decoration state describes the old epoch; without it the
  // next turn treats the session as new and re-delivers every required block.
  room._promptDecorationState = null;
  return epoch;
}

/**
 * Record the native session identity of a turn. A different non-empty id than
 * the one seen before is a new session (or a resume that fell back to one).
 */
export function noteNativeSession(
  room: EpochRoom | null | undefined,
  input: { nativeSessionId?: string, resumeRequested?: boolean } = {},
): { bumped: boolean, epoch: number } {
  if (!room || typeof room !== 'object') return { bumped: false, epoch: 0 };
  const id = String(input.nativeSessionId || '').trim();
  const current = readInstructionEpoch(room);
  if (!id) return { bumped: false, epoch: current.epoch };
  if (!current.nativeSessionId) {
    room._instructionEpoch = { ...(room._instructionEpoch || { epoch: 0, reason: '', at: 0, log: [] }), nativeSessionId: id };
    return { bumped: false, epoch: current.epoch };
  }
  if (current.nativeSessionId === id) return { bumped: false, epoch: current.epoch };
  const epoch = bumpInstructionEpoch(room, input.resumeRequested
    ? INSTRUCTION_EPOCH_REASON.RESUME_FAILED
    : INSTRUCTION_EPOCH_REASON.NEW_SESSION, { nativeSessionId: id }) as number;
  return { bumped: true, epoch };
}

/** Suffix for the prompt-decoration session key: a new epoch is a new session. */
export function instructionEpochKey(room: unknown): string {
  return `e${readInstructionEpoch(room).epoch}`;
}

export const INSTRUCTION_DEDUPE_SETTINGS = Object.freeze(['off', 'proven_adapters']);

/**
 * How the static block is delivered this turn.
 */
export function resolveInstructionDelivery(
  input: { transport?: string, dedupeSetting?: string, room?: unknown } = {},
): { staticMode: 'always' | 'dedupe', reason: string, epoch: number, proof: string } {
  const transport = String(input.transport || '').trim().toLowerCase();
  const epoch = readInstructionEpoch(input.room).epoch;
  const fallback = (reason: string) => ({ staticMode: 'always' as const, reason, epoch, proof: '' });
  if (input.dedupeSetting !== 'proven_adapters') return fallback('dedupe_off_by_setting');
  const proof = (INSTRUCTION_RETENTION_PROOFS as Record<string, { channel: string } | undefined>)[transport];
  if (!proof) return fallback('no_retention_proof');
  if (!readInstructionEpoch(input.room).nativeSessionId) return fallback('no_native_session_identity');
  return { staticMode: 'dedupe', reason: 'proven_adapter', epoch, proof: proof.channel };
}
