/**
 * Microphone and sound diagnostics. Pure logic with an injected `window` /
 * `navigator`, so Settings → Voice, the listen bar and the node tests share one
 * source of truth for "why does the microphone not work".
 */

/**
 * `denied` – no permission; `insecure` – page is not a secure context (http over
 * LAN); `service` – the browser has no speech-recognition service; `unsupported` –
 * no API at all; `nodevice` – no microphone found; `error` – anything else.
 *
 * @typedef {'denied'|'insecure'|'service'|'unsupported'|'nodevice'|'error'} VoiceErrorCode
 */

/**
 * Why a diagnostic could not start or was stopped: another one runs (`busy`), a
 * Realtime conversation owns the microphone (`realtime`), the app is speaking
 * (`speaking`) or the user left the panel (`cancelled`).
 *
 * @typedef {'busy'|'realtime'|'speaking'|'cancelled'} VoiceDiagBlock
 */

/** Codes that end a voice session for good (retrying cannot help). */
export const FATAL_VOICE_ERRORS = ['denied', 'insecure', 'service', 'unsupported', 'nodevice'];

/**
 * @param {unknown} win
 * @returns {boolean} false only when the page is known to be insecure
 */
export function isSecure(win) {
  return /** @type {any} */ (win)?.isSecureContext !== false;
}

/**
 * Maps a Web Speech `error` string to a code. Returns `''` for routine events
 * (silence, our own stop) that must not surface.
 *
 * @param {string} webSpeechError
 * @param {{ secure?: boolean }} [context]
 * @returns {VoiceErrorCode|''}
 */
export function mapSpeechError(webSpeechError, { secure = true } = {}) {
  const code = String(webSpeechError || '');
  if (code === 'no-speech' || code === 'aborted') return '';
  if (code === 'not-allowed') return secure ? 'denied' : 'insecure';
  if (code === 'service-not-allowed') return 'service';
  if (code === 'audio-capture') return 'nodevice';
  return 'error';
}

/**
 * Maps a `getUserMedia` rejection (a DOMException-like value) to a code.
 *
 * @param {unknown} err
 * @param {{ secure?: boolean }} [context]
 * @returns {VoiceErrorCode}
 */
export function mapMediaError(err, { secure = true } = {}) {
  const name = String(/** @type {any} */ (err)?.name || '');
  if (!secure) return 'insecure';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return 'nodevice';
  return 'error';
}

/**
 * i18n keys of the message and the short advice for a code.
 *
 * @param {string} code
 * @returns {{ message: string, advice: string }}
 */
export function voiceErrorKeys(code) {
  const id = ['denied', 'insecure', 'service', 'unsupported', 'nodevice'].includes(code) ? code : 'error';
  return { message: `voice.browser.${id}`, advice: `voice.browser.${id}Advice` };
}

/**
 * @param {unknown} nav
 * @returns {Promise<'granted'|'denied'|'prompt'|'unknown'>}
 */
export async function queryMicPermission(nav) {
  const permissions = /** @type {any} */ (nav)?.permissions;
  if (!permissions || typeof permissions.query !== 'function') return 'unknown';
  try {
    const status = await permissions.query({ name: 'microphone' });
    const state = String(status?.state || '');
    return state === 'granted' || state === 'denied' || state === 'prompt' ? state : 'unknown';
  } catch {
    // Firefox/Safari reject the unknown permission name.
    return 'unknown';
  }
}

/**
 * Snapshot of what the device can do for voice.
 *
 * @param {{ win?: any, nav?: any }} [env]
 * @returns {Promise<{
 *   secure: boolean,
 *   protocol: string,
 *   permission: 'granted'|'denied'|'prompt'|'unknown',
 *   permissionsApi: boolean,
 *   speechRecognition: boolean,
 *   getUserMedia: boolean,
 *   mediaRecorder: boolean,
 *   speechSynthesis: boolean,
 *   audioContext: boolean,
 *   outputSelection: boolean,
 *   hint: ''|VoiceErrorCode,
 * }>}
 */
export async function collectVoiceDiagnostics({ win, nav } = {}) {
  const permission = await queryMicPermission(nav);
  const secure = isSecure(win);
  const speechRecognition = Boolean(win && (win.SpeechRecognition || win.webkitSpeechRecognition));
  const getUserMedia = typeof nav?.mediaDevices?.getUserMedia === 'function';
  const report = {
    secure,
    protocol: String(win?.location?.protocol || ''),
    permission,
    permissionsApi: permission !== 'unknown',
    speechRecognition,
    getUserMedia,
    mediaRecorder: typeof win?.MediaRecorder === 'function',
    speechSynthesis: Boolean(win?.speechSynthesis) && typeof win?.SpeechSynthesisUtterance === 'function',
    audioContext: Boolean(win?.AudioContext || win?.webkitAudioContext),
    outputSelection: supportsOutputSelection(win, nav),
    hint: /** @type {''|VoiceErrorCode} */ (''),
  };
  // The most actionable problem first; it is what the status line leads with.
  if (!secure) report.hint = 'insecure';
  else if (permission === 'denied') report.hint = 'denied';
  else if (!speechRecognition) report.hint = 'unsupported';
  return report;
}

/**
 * Output device selection: `setSinkId` on media elements (Chrome desktop) or
 * `selectAudioOutput`. Usually absent on Android.
 *
 * @param {any} win
 * @param {any} nav
 * @returns {boolean}
 */
export function supportsOutputSelection(win, nav) {
  const proto = win?.HTMLMediaElement?.prototype;
  if (proto && typeof proto.setSinkId === 'function') return true;
  return typeof nav?.mediaDevices?.selectAudioOutput === 'function';
}

/**
 * Opens the microphone for `durationMs`, reports the input level and releases
 * the stream. Never leaves a track running, also when the analyser fails.
 *
 * @param {{
 *   win?: any,
 *   nav?: any,
 *   durationMs?: number,
 *   onLevel?: (level: number) => void,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (handle: unknown) => void,
 *   signal?: AbortSignal,
 * }} [options]
 * @returns {Promise<{ ok: true, peak: number } | { ok: false, code: VoiceErrorCode|'cancelled' }>}
 */
export async function runMicTest({
  win,
  nav,
  durationMs = 5000,
  onLevel = () => {},
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(/** @type {any} */ (handle)),
  signal,
} = {}) {
  const secure = isSecure(win);
  if (!secure) return { ok: false, code: 'insecure' };
  if (typeof nav?.mediaDevices?.getUserMedia !== 'function') return { ok: false, code: 'unsupported' };
  let stream = null;
  try {
    stream = await nav.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    return { ok: false, code: signal?.aborted ? 'cancelled' : mapMediaError(err, { secure }) };
  }
  if (signal?.aborted) {
    // The user left before the permission prompt was answered: never start recording late.
    for (const track of stream.getTracks?.() || []) track.stop();
    return { ok: false, code: 'cancelled' };
  }
  let context = null;
  let timer = null;
  let overall = null;
  let peak = 0;
  try {
    const Ctx = win?.AudioContext || win?.webkitAudioContext;
    if (Ctx) {
      context = new Ctx();
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      await new Promise((resolve) => {
        const finish = () => resolve(undefined);
        const tick = () => {
          if (signal?.aborted) return finish();
          analyser.getByteTimeDomainData(samples);
          let max = 0;
          for (const value of samples) max = Math.max(max, Math.abs(value - 128));
          const level = Math.min(1, max / 64);
          peak = Math.max(peak, level);
          onLevel(level);
          timer = setTimer(tick, 80);
        };
        signal?.addEventListener?.('abort', finish, { once: true });
        tick();
        // The overall budget; the tick chain above is stopped by clearing `timer`.
        overall = setTimer(() => {
          if (timer != null) clearTimer(timer);
          finish();
        }, durationMs);
      });
    } else {
      // No analyser: opening the stream already proves the permission and the device.
      await new Promise((resolve) => setTimer(() => resolve(undefined), Math.min(durationMs, 800)));
    }
  } catch {
    // The stream opened; a failing visualiser must not turn that into a failure.
  } finally {
    if (timer != null) clearTimer(timer);
    if (overall != null) clearTimer(overall);
    for (const track of stream.getTracks?.() || []) track.stop();
    try {
      await context?.close?.();
    } catch {
      // Closing an already closed context throws; nothing to do.
    }
  }
  return signal?.aborted ? { ok: false, code: 'cancelled' } : { ok: true, peak };
}

/**
 * One utterance through SpeechRecognition.
 *
 * @param {{
 *   win?: any,
 *   lang?: string,
 *   timeoutMs?: number,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (handle: unknown) => void,
 *   signal?: AbortSignal,
 * }} [options]
 * @returns {Promise<{ ok: true, text: string } | { ok: false, code: VoiceErrorCode|'no-speech'|'cancelled' }>}
 */
export function runRecognitionTest({
  win,
  lang = 'en-US',
  timeoutMs = 10000,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(/** @type {any} */ (handle)),
  signal,
} = {}) {
  const Ctor = win && (win.SpeechRecognition || win.webkitSpeechRecognition);
  if (!Ctor) return Promise.resolve({ ok: false, code: 'unsupported' });
  const secure = isSecure(win);
  if (signal?.aborted) return Promise.resolve({ ok: false, code: 'cancelled' });
  return new Promise((resolve) => {
    let settled = false;
    let text = '';
    let timer = null;
    const recognition = new Ctor();
    const done = (result) => {
      if (settled) return;
      settled = true;
      if (timer != null) clearTimer(timer);
      try {
        recognition.stop();
      } catch {
        // Already stopped.
      }
      resolve(result);
    };
    signal?.addEventListener?.('abort', () => done({ ok: false, code: 'cancelled' }), { once: true });
    recognition.lang = lang;
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      for (let i = event.resultIndex || 0; i < event.results.length; i += 1) {
        const alt = event.results[i]?.[0];
        if (alt?.transcript) text = `${text} ${alt.transcript}`.trim();
      }
      if (text) done({ ok: true, text });
    };
    recognition.onerror = (event) => {
      const raw = String(event?.error || '');
      if (raw === 'no-speech') return done({ ok: false, code: 'no-speech' });
      const code = mapSpeechError(raw, { secure });
      if (code) done({ ok: false, code });
    };
    recognition.onend = () => done(text ? { ok: true, text } : { ok: false, code: 'no-speech' });
    timer = setTimer(() => done(text ? { ok: true, text } : { ok: false, code: 'no-speech' }), timeoutMs);
    try {
      recognition.start();
    } catch {
      done({ ok: false, code: 'error' });
    }
  });
}

/**
 * Single owner of the microphone for the diagnostics block. At most one of the
 * mic test, recognition test and speaker sample runs; the mic and recognition
 * tests never start while a Realtime conversation is open (a second stream would
 * fight it), and they stop browser voice mode first so a test phrase can never
 * reach the agent as a prompt. Voice mode is not resumed automatically: the user
 * left the conversation on purpose to test, and a silent restart would open the
 * microphone again behind their back (car mode would also not know about it).
 *
 * @param {{
 *   isRealtimeActive?: () => boolean,
 *   getVoiceMode?: () => { isActive: () => boolean, stop: () => void } | null,
 *   isSpeaking?: () => boolean,
 * }} [deps]
 */
export function createDiagnosticsCoordinator({
  isRealtimeActive = () => false,
  getVoiceMode = () => null,
  isSpeaking = () => false,
} = {}) {
  /** @type {{ kind: string, controller: AbortController }|null} */
  let current = null;

  function cancel() {
    const running = current;
    current = null;
    running?.controller.abort();
  }

  return {
    /**
     * @param {'mic'|'recognition'|'speaker'} kind
     * @returns {{ ok: false, code: VoiceDiagBlock } | { ok: true, signal: AbortSignal, stoppedVoiceMode: boolean, finish: () => void }}
     */
    start(kind) {
      if (current) return { ok: false, code: 'busy' };
      const needsMic = kind === 'mic' || kind === 'recognition';
      if (needsMic && isRealtimeActive()) return { ok: false, code: 'realtime' };
      if (kind === 'recognition' && isSpeaking()) return { ok: false, code: 'speaking' };
      let stoppedVoiceMode = false;
      if (needsMic) {
        const mode = getVoiceMode();
        if (typeof mode?.isActive === 'function' && mode.isActive()) {
          mode.stop();
          stoppedVoiceMode = true;
        }
      }
      const entry = { kind, controller: new AbortController() };
      current = entry;
      return {
        ok: true,
        signal: entry.controller.signal,
        stoppedVoiceMode,
        finish() {
          if (current === entry) current = null;
        },
      };
    },
    /** Aborts whatever runs (panel hidden or destroyed). */
    cancel,
    /** The app started speaking: a recognition test would hear it, so it is dropped. */
    noteSpeaking(active) {
      if (active && current?.kind === 'recognition') cancel();
    },
    /** @returns {''|'mic'|'recognition'|'speaker'} */
    active() {
      return /** @type {any} */ (current?.kind || '');
    },
  };
}

/**
 * Decides whether an IntersectionObserver report should cancel a running test. A section that
 * merely scrolled out of view is still rendered (it has layout boxes); only a hidden tab,
 * panel or page removes them.
 *
 * @param {{ isIntersecting: boolean }[]} entries
 * @param {() => boolean} isRendered true while the observed block still has layout boxes
 * @returns {boolean}
 */
export function shouldCancelOnIntersection(entries, isRendered) {
  if (!entries.some((entry) => !entry.isIntersecting)) return false;
  return !isRendered();
}

/** Collects teardown callbacks so a listener set can be released in one call and never doubled. */
export function createDisposer() {
  /** @type {(() => void)[]} */
  let fns = [];
  return {
    add(fn) {
      fns.push(fn);
    },
    /** Adds a listener and remembers how to remove it. */
    listen(target, type, handler) {
      target.addEventListener(type, handler);
      fns.push(() => target.removeEventListener(type, handler));
    },
    get size() {
      return fns.length;
    },
    dispose() {
      const pending = fns;
      fns = [];
      for (const fn of pending) fn();
    },
  };
}
