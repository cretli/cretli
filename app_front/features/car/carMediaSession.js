/**
 * Car mode headset / steering-wheel buttons through the Media Session API.
 *
 * Constraints (browsers only route media keys to a page that owns *active audio*):
 * - We play a silent, looped, near-inaudible WAV for as long as the car view is open. It is
 *   separate from the TTS `Audio`/speechSynthesis output, which never touches this element, and
 *   this element never pauses or cancels speech.
 * - `play()` needs a user gesture. When the view is restored without one it rejects; `resume()`
 *   is called again from the next tap.
 * - Android Chrome shows a media notification and routes the buttons; iOS Safari does so only
 *   while the page is foreground or its audio keeps playing, and the silent track takes the
 *   "now playing" slot from a music player, so it is started only in car mode and released on close.
 * - Pressing play/pause pauses our element; we restart it so the session stays registered.
 *
 * Pure of globals: `navigator`, the audio factory and `MediaMetadata` are injected.
 */

/** Tiny 8-bit mono PCM WAV of silence (0.5 s at 8 kHz), as a data URI. */
export function silentWavDataUri() {
  const samples = 4000;
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const text = (offset, value) => { for (let i = 0; i < value.length; i += 1) bytes[offset + i] = value.charCodeAt(i); };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  text(36, 'data');
  view.setUint32(40, samples, true);
  bytes.fill(128, 44);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:audio/wav;base64,${btoa(binary)}`;
}

export const MEDIA_ACTIONS = ['play', 'pause', 'stop', 'nexttrack', 'previoustrack'];

/**
 * Maps Media Session actions to car handlers.
 *
 * @param {{ toggleMic: () => any, cycleAgent: (direction: 1|-1) => any }} handlers
 * @returns {Record<string, () => void>}
 */
export function mapMediaActions(handlers) {
  const mic = () => { void handlers.toggleMic(); };
  return {
    play: mic,
    pause: mic,
    stop: mic,
    nexttrack: () => { void handlers.cycleAgent(1); },
    previoustrack: () => { void handlers.cycleAgent(-1); },
  };
}

/**
 * @param {{
 *   navigator?: any,
 *   createAudio?: () => any,
 *   MediaMetadata?: any,
 *   handlers: { toggleMic: () => any, cycleAgent: (direction: 1|-1) => any },
 * }} deps
 */
export function createCarMediaSession(deps) {
  const nav = deps.navigator;
  const session = nav && nav.mediaSession;
  const Metadata = deps.MediaMetadata;
  const actions = mapMediaActions(deps.handlers);
  let audio = null;
  let running = false;
  /** Bumped by every stop(): a play() of an earlier session must not write the state of a new one. */
  let sessionEpoch = 0;

  function keepAudioPlaying() {
    if (!running || !audio) return Promise.resolve(false);
    try {
      return Promise.resolve(audio.play()).then(() => true, () => false);
    } catch {
      return Promise.resolve(false);
    }
  }

  function bind(action) {
    return () => {
      actions[action]();
      // The browser pauses the element on a "pause" key; keep the session registered.
      void keepAudioPlaying();
    };
  }

  return {
    isSupported: () => !!session,
    isRunning: () => running,
    /**
     * Registers handlers and starts the silent audio. Safe to call twice.
     *
     * @returns {Promise<boolean>} whether the audio is playing (false without a gesture)
     */
    async start() {
      if (!session) return false;
      if (!running) {
        running = true;
        if (deps.createAudio) {
          audio = deps.createAudio();
          audio.loop = true;
          audio.volume = 0.01;
        }
        for (const action of MEDIA_ACTIONS) {
          try {
            session.setActionHandler(action, bind(action));
          } catch {
            // An action this browser does not know is simply skipped.
          }
        }
      }
      const epoch = sessionEpoch;
      const playing = await keepAudioPlaying();
      // stop() (and maybe a new start()) may have run while play() was pending.
      if (!running || epoch !== sessionEpoch) return false;
      try {
        session.playbackState = playing ? 'playing' : 'none';
      } catch {
        // playbackState is optional.
      }
      return playing;
    },
    /** Retries the audio after a user gesture. */
    resume() {
      return running ? this.start() : Promise.resolve(false);
    },
    /** @param {{ title?: string, artist?: string }} info */
    setMetadata(info) {
      if (!session || !running || !Metadata) return;
      try {
        session.metadata = new Metadata({ title: String(info.title || ''), artist: String(info.artist || ''), album: 'Cretli' });
      } catch {
        // Metadata is cosmetic.
      }
    },
    /** Clears handlers and metadata and releases the audio. */
    stop() {
      if (!running) return;
      running = false;
      sessionEpoch += 1;
      if (session) {
        for (const action of MEDIA_ACTIONS) {
          try { session.setActionHandler(action, null); } catch { /* unknown action */ }
        }
        try { session.metadata = null; } catch { /* ignore */ }
        try { session.playbackState = 'none'; } catch { /* ignore */ }
      }
      try {
        audio?.pause();
        if (audio) audio.src = '';
      } catch {
        // Already released.
      }
      audio = null;
    },
  };
}
