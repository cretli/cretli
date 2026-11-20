/**
 * Reactive state of browser voice mode, kept apart from the controller so the
 * header button can watch it without loading the speech stack.
 */

import { signal } from '@lit-labs/signals';

/**
 * @typedef {{
 *   active: boolean,
 *   listening: boolean,
 *   paused: boolean,
 *   interim: string,
 *   error: ''|import('./voiceDiagnostics.js').VoiceErrorCode,
 *   notice: { kind: 'sent'|'done'|'failed'|'message', text: string }|null,
 * }} BrowserVoiceState
 */

/** @type {BrowserVoiceState} */
export const IDLE_STATE = Object.freeze({
  active: false,
  listening: false,
  paused: false,
  interim: '',
  error: '',
  notice: null,
});

export const browserVoiceState = signal(/** @type {BrowserVoiceState} */ (IDLE_STATE));

/**
 * A spoken prompt waiting in the car-mode undo window (`sendUndoWindow.js`), for the car view bar.
 *
 * @type {import('@lit-labs/signals').Signal.State<import('./sendUndoWindow.js').PendingSend|null>}
 */
export const pendingVoiceSend = signal(null);

/**
 * Late outcome of a Realtime prompt (failed send, replaced prompt), shown by the car view.
 *
 * @type {import('@lit-labs/signals').Signal.State<{ kind: 'error'|'info', text: string }|null>}
 */
export const voiceSendOutcome = signal(null);
