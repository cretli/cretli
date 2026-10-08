/**
 * Steering a live `@cursor/sdk` run.
 *
 * `Run.steer(text)` is an *optional* method: an old SDK, a rehydrated/detached
 * handle, or a cloud run may all lack it, so the only reliable probe is
 * `typeof run.steer === 'function'` (`Run.supports()` covers stream/wait/cancel/
 * conversation only and must not be asked about steer).
 *
 * The ack has two outcomes and the caller must handle both:
 * - `complete_delivered` — the turn has the text; drop the client copy.
 * - `revert_to_followup` — the text was NOT injected; the caller has to send it
 *   as an ordinary follow-up message, otherwise the user's input is lost.
 * Anything else (a throw, an unknown ack) is treated as a revert for the same
 * reason: never silently lose a message.
 */

export const STEER_ACK_DELIVERED = 'complete_delivered';
export const STEER_ACK_REVERT = 'revert_to_followup';

export const SDK_STEER_OUTCOMES = Object.freeze([
  STEER_ACK_DELIVERED,
  STEER_ACK_REVERT,
]);

/** Typed error codes the WS client can switch on. */
export const SDK_STEER_ERROR_CODES = Object.freeze({
  EMPTY_TEXT: 'steer_empty_text',
  NO_ACTIVE_RUN: 'steer_no_active_run',
  UNSUPPORTED: 'steer_unsupported',
  CLOUD_RUN: 'steer_cloud_run_unsupported',
  REMOTE_ROOM: 'steer_remote_room',
  DELIVERY_FAILED: 'steer_delivery_failed',
});

/**
 * @param {unknown} outcome
 * @returns {boolean}
 */
export function isSdkSteerAckOutcome(outcome) {
  return typeof outcome === 'string' && SDK_STEER_OUTCOMES.includes(outcome.trim());
}

/**
 * @param {unknown} run
 * @returns {boolean}
 */
export function supportsSdkRunSteer(run) {
  return !!run && typeof run === 'object' && typeof run.steer === 'function';
}

/**
 * Cloud agent ids are prefixed `bc-`; a handle without a usable steer is
 * reported as generically unsupported instead.
 *
 * @param {unknown} run
 * @returns {boolean}
 */
export function isCloudSdkRunHandle(run) {
  const agentId = run && typeof run === 'object' && typeof run.agentId === 'string'
    ? run.agentId.trim()
    : '';
  return agentId.startsWith('bc-');
}

/**
 * @param {unknown} run
 * @returns {{ code: string, message: string }}
 */
export function resolveSdkSteerUnsupported(run) {
  if (isCloudSdkRunHandle(run)) {
    return {
      code: SDK_STEER_ERROR_CODES.CLOUD_RUN,
      message:
        'Steering is only available for local Cursor agents; this run is a cloud run, so the message was not injected.',
    };
  }
  return {
    code: SDK_STEER_ERROR_CODES.UNSUPPORTED,
    message:
      'The active run does not support steering (older SDK or a detached run handle); the message was not injected.',
  };
}

/**
 * @param {string} code
 * @param {string} message
 * @returns {Error & { code: string }}
 */
export function createSdkSteerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function readMessage(err) {
  if (err && typeof err === 'object' && typeof err.message === 'string' && err.message.trim()) {
    return err.message.trim();
  }
  return String(err ?? '').trim();
}

/**
 * Attempts to inject `text` into the running run. Never throws and never
 * queues by itself — `queue` in the result tells the caller (the WS room) to
 * hand the text to the normal follow-up path so it cannot be lost.
 *
 * @param {{
 *   run?: unknown,
 *   busy?: boolean,
 *   remoteRoom?: boolean,
 *   text?: unknown,
 * }} input
 * @returns {Promise<{
 *   status: 'delivered' | 'queued' | 'rejected',
 *   outcome: string,
 *   code: string,
 *   message: string,
 *   runId: string,
 * }>}
 */
export async function requestSdkRunSteer(input = {}) {
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text) {
    return {
      status: 'rejected',
      outcome: '',
      code: SDK_STEER_ERROR_CODES.EMPTY_TEXT,
      message: 'Steer needs a non-empty message.',
      runId: '',
    };
  }
  const runId = input.run && typeof input.run === 'object' && typeof input.run.id === 'string'
    ? input.run.id.trim()
    : '';
  if (input.remoteRoom === true) {
    return {
      status: 'rejected',
      outcome: '',
      code: SDK_STEER_ERROR_CODES.REMOTE_ROOM,
      message: 'This chat run is owned by another server instance and cannot be steered here.',
      runId,
    };
  }
  if (!input.busy || !input.run) {
    return {
      status: 'rejected',
      outcome: '',
      code: SDK_STEER_ERROR_CODES.NO_ACTIVE_RUN,
      message: 'There is no active run to steer.',
      runId,
    };
  }
  if (isCloudSdkRunHandle(input.run)) {
    const unsupported = resolveSdkSteerUnsupported(input.run);
    return { status: 'rejected', outcome: '', code: unsupported.code, message: unsupported.message, runId };
  }
  if (!supportsSdkRunSteer(input.run)) {
    const unsupported = resolveSdkSteerUnsupported(input.run);
    return { status: 'rejected', outcome: '', code: unsupported.code, message: unsupported.message, runId };
  }

  let rawOutcome = '';
  try {
    rawOutcome = String(await input.run.steer(text) ?? '').trim();
  } catch (err) {
    return {
      status: 'queued',
      outcome: '',
      code: SDK_STEER_ERROR_CODES.DELIVERY_FAILED,
      message: readMessage(err) || 'The run rejected the steering request.',
      runId,
    };
  }
  if (rawOutcome === STEER_ACK_DELIVERED) {
    return {
      status: 'delivered',
      outcome: STEER_ACK_DELIVERED,
      code: '',
      message: '',
      runId,
    };
  }
  return {
    status: 'queued',
    outcome: isSdkSteerAckOutcome(rawOutcome) ? rawOutcome : '',
    code: SDK_STEER_ERROR_CODES.DELIVERY_FAILED,
    message:
      rawOutcome === STEER_ACK_REVERT
        ? 'The run asked to fall back to a follow-up message.'
        : `Unknown steer acknowledgement "${rawOutcome || 'none'}"; sending the text as a follow-up instead.`,
    runId,
  };
}

/**
 * @param {{ runId?: string, text?: string, outcome?: string }} input
 * @returns {Record<string, unknown>}
 */
export function buildSdkSteerAckPayload(input = {}) {
  return {
    type: 'sdkSteerAck',
    runId: typeof input.runId === 'string' ? input.runId : '',
    outcome: input.outcome === STEER_ACK_DELIVERED ? STEER_ACK_DELIVERED : STEER_ACK_REVERT,
    text: typeof input.text === 'string' ? input.text : '',
    at: Date.now(),
  };
}

/**
 * @param {{ code?: string, message?: string, runId?: string, text?: string }} input
 * @returns {Record<string, unknown>}
 */
export function buildSdkSteerErrorPayload(input = {}) {
  return {
    type: 'sdkSteerError',
    code: typeof input.code === 'string' ? input.code : SDK_STEER_ERROR_CODES.DELIVERY_FAILED,
    message: typeof input.message === 'string' ? input.message : '',
    runId: typeof input.runId === 'string' ? input.runId : '',
    text: typeof input.text === 'string' ? input.text : '',
    at: Date.now(),
  };
}
