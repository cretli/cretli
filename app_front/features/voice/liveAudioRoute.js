/**
 * Live voice audio routing on phones.
 *
 * Classic Bluetooth cannot do A2DP (music) and a headset mic at once. Chrome
 * on Android follows Meet: picking the Bluetooth mic turns on communication
 * mode and switches output A2DP → SCO, so both directions use the headset
 * (lower quality, but duplex). We open the default mic first (labels appear),
 * then reopen the BT mic with call processing. Playback uses a hidden
 * `<audio>` element: Chrome will not render a remote WebRTC track through
 * Web Audio alone, and that path also lands on the Android earpiece.
 *
 * @see https://chromium.googlesource.com/chromium/src/+/78d0de138346e6edfc8c33bdd22c45b3eec4f3d0
 */

const MEDIA_AUDIO_PROCESS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 1,
};

const SCO_AUDIO_PROCESS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
};

/** SCO setup on Android is not instant — re-apply setSinkId after this. */
export const SCO_SETTLE_MS = 900;

const BLUETOOTH_LABEL =
  /bluetooth|hands-?free|headset|airpods|galaxy buds|pixel buds|freebuds|redmi buds|soundcore|\bbuds\b|\bwh-\d|\bwf-\d|\bjabra|\bbose\b|\bsennheiser|\bsony\b|\bbeats\b|\bjbl\b/i;

const PHONE_SPEAKER_LABEL =
  /speakerphone|earpiece|phone speaker|built-in|wbudowan|głośnik telefonu|^speaker$|^default$|^domyśln|^default - speaker|^microphone$|^mic$/i;

/**
 * @param {unknown} label
 * @returns {boolean}
 */
function isPhoneSpeakerLabel(label) {
  return PHONE_SPEAKER_LABEL.test(String(label || '').trim());
}

/**
 * @param {unknown} label
 * @returns {boolean}
 */
export function isBluetoothAudioLabel(label) {
  const text = String(label || '').trim();
  if (!text || isPhoneSpeakerLabel(text)) return false;
  return BLUETOOTH_LABEL.test(text);
}

/**
 * @param {Array<{ kind?: string, deviceId?: string, label?: string }>} devices
 * @param {string} kind
 * @returns {Array<{ deviceId: string, label: string, kind: 'headset'|'phone'|'unknown' }>}
 */
function listAudioDeviceChoices(devices, kind) {
  return (Array.isArray(devices) ? devices : [])
    .filter((device) => device?.kind === kind && String(device.deviceId || '').trim())
    .map((device) => ({
      deviceId: String(device.deviceId),
      label: String(device.label || '').trim() || String(device.deviceId).slice(0, 8),
      kind: classifyMicKind(device.label),
    }));
}

export function listAudioInputChoices(devices) {
  return listAudioDeviceChoices(devices, 'audioinput');
}

export function listAudioOutputChoices(devices) {
  return listAudioDeviceChoices(devices, 'audiooutput');
}

export function classifyMicKind(label) {
  const text = String(label || '').trim();
  if (!text) return 'unknown';
  if (isBluetoothAudioLabel(text)) return 'headset';
  if (isPhoneSpeakerLabel(text)) return 'phone';
  return 'headset';
}

/**
 * RMS of an AnalyserNode time-domain buffer, scaled so speech is visible.
 *
 * @param {Uint8Array|Array<number>} samples
 * @returns {number} 0..1
 */
export function computeTimeDomainLevel(samples) {
  const list = samples || [];
  if (list.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < list.length; i++) {
    const v = (Number(list[i]) - 128) / 128;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / list.length) * 4);
}

/**
 * Reads input level from a live mic stream. Does not connect to speakers.
 *
 * @param {MediaStream} stream
 * @param {(level: number) => void} onLevel
 * @param {typeof AudioContext} [AudioContextCtor]
 * @returns {{ stop: () => void }|null}
 */
export function createMicLevelMonitor(stream, onLevel, AudioContextCtor = globalThis.AudioContext) {
  if (!stream || typeof AudioContextCtor !== 'function' || typeof onLevel !== 'function') {
    return null;
  }
  const ctx = new AudioContextCtor();
  if (typeof ctx.resume === 'function') void ctx.resume();
  if (typeof ctx.createMediaStreamSource !== 'function' || typeof ctx.createAnalyser !== 'function') {
    try {
      ctx.close();
    } catch {
      // Nothing to tear down.
    }
    return null;
  }
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.65;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  let raf = 0;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    analyser.getByteTimeDomainData(data);
    onLevel(computeTimeDomainLevel(data));
    raf = globalThis.requestAnimationFrame ? globalThis.requestAnimationFrame(tick) : 0;
  };
  tick();
  return {
    stop() {
      stopped = true;
      if (raf && typeof globalThis.cancelAnimationFrame === 'function') {
        globalThis.cancelAnimationFrame(raf);
      }
      try {
        source.disconnect();
      } catch {
        // Already gone.
      }
      try {
        ctx.close();
      } catch {
        // Already closed.
      }
    },
  };
}

/**
 * On a phone, any extra named device is almost always a headset — even when
 * the label is just "TOZO T6" with no "Bluetooth" word.
 *
 * @param {unknown} label
 * @returns {boolean}
 */
function isHeadsetAudioLabel(label) {
  const text = String(label || '').trim();
  if (!text || isPhoneSpeakerLabel(text)) return false;
  return true;
}

/**
 * @param {Array<{ kind?: string, deviceId?: string, groupId?: string, label?: string }>} devices
 * @returns {{ inputId: string, outputId: string }}
 */
export function pickBluetoothAudioDevices(devices) {
  const list = Array.isArray(devices) ? devices : [];
  const inputs = list.filter((device) => device?.kind === 'audioinput');
  const outputs = list.filter((device) => device?.kind === 'audiooutput');
  const rankHeadset = (device) => (isBluetoothAudioLabel(device.label) ? 0 : 1);
  const btInputs = inputs
    .filter((device) => isHeadsetAudioLabel(device.label))
    .sort((left, right) => rankHeadset(left) - rankHeadset(right));
  const btOutputs = outputs
    .filter((device) => isHeadsetAudioLabel(device.label))
    .sort((left, right) => rankHeadset(left) - rankHeadset(right));
  if (btInputs.length === 0 && btOutputs.length === 0) {
    return { inputId: '', outputId: '' };
  }
  for (const input of btInputs) {
    const paired =
      btOutputs.find((output) => output.groupId && output.groupId === input.groupId) ||
      btOutputs[0] ||
      null;
    return {
      inputId: String(input.deviceId || ''),
      outputId: String(paired?.deviceId || ''),
    };
  }
  const output = btOutputs[0];
  const paired = inputs.find((input) => input.groupId && input.groupId === output.groupId) || null;
  return {
    inputId: String(paired?.deviceId || ''),
    outputId: String(output.deviceId || ''),
  };
}

/**
 * @param {string} [deviceId]
 * @param {{ communication?: boolean }} [options]
 * @returns {{ audio: Record<string, unknown> }}
 */
export function buildLiveAudioConstraints(deviceId = '', options = {}) {
  const audio = { ...(options.communication ? SCO_AUDIO_PROCESS : MEDIA_AUDIO_PROCESS) };
  const id = String(deviceId || '').trim();
  if (id) audio.deviceId = options.exact ? { exact: id } : { ideal: id };
  return { audio };
}

/**
 * @param {{ getUserMedia: (constraints: object) => Promise<MediaStream> }} mediaDevices
 * @param {string} deviceId
 * @returns {Promise<MediaStream>}
 */
export function openMicByDeviceId(mediaDevices, deviceId) {
  const id = String(deviceId || '').trim();
  const exact = Boolean(id) && id !== 'default' && id !== 'communications';
  return mediaDevices.getUserMedia(
    buildLiveAudioConstraints(exact ? id : '', { communication: true, exact })
  );
}

/**
 * @param {{ setSinkId?: (id: string) => Promise<void> }|null|undefined} target
 * @param {string} sinkId
 * @returns {Promise<boolean>}
 */
export async function applyAudioOutputSink(target, sinkId) {
  const id = String(sinkId || '').trim();
  if (!id || typeof target?.setSinkId !== 'function') return false;
  try {
    await target.setSinkId(id);
    return true;
  } catch {
    return false;
  }
}

/**
 * Hidden autoplay element. Chrome will not render a remote WebRTC track through
 * Web Audio alone; Android also sends that path to the earpiece, which is
 * inaudible while looking at the screen.
 *
 * @param {Document} [doc]
 * @returns {HTMLAudioElement|null}
 */
export function createHiddenPlaybackAudio(doc = globalThis.document) {
  if (!doc || typeof doc.createElement !== 'function') return null;
  const audio = doc.createElement('audio');
  audio.autoplay = true;
  audio.preload = 'auto';
  audio.controls = false;
  audio.muted = false;
  audio.volume = 1;
  if ('playsInline' in audio) audio.playsInline = true;
  audio.setAttribute('playsinline', '');
  audio.setAttribute('webkit-playsinline', '');
  if (doc.body && typeof doc.body.appendChild === 'function') doc.body.appendChild(audio);
  return audio;
}

/**
 * WebRTC `ontrack` sometimes has the track but an empty `streams` array.
 *
 * @param {{ streams?: Array<MediaStream>, track?: MediaStreamTrack }|null|undefined} event
 * @returns {MediaStream|null}
 */
export function remoteStreamFromTrackEvent(event, StreamCtor = globalThis.MediaStream) {
  if (event?.streams?.[0]) return event.streams[0];
  if (event?.track && typeof StreamCtor === 'function') return new StreamCtor([event.track]);
  return null;
}

/**
 * Short beep on the same HTMLAudioElement path as live voice, so a silent
 * session can be told apart from a muted phone.
 *
 * @param {{
 *   AudioContextCtor?: typeof AudioContext,
 *   document?: Document,
 *   sinkId?: string,
 *   durationMs?: number,
 * }} [options]
 * @returns {Promise<boolean>}
 */
export async function playLiveOutputTest(options = {}) {
  const AudioContextCtor = options.AudioContextCtor || globalThis.AudioContext;
  const doc = options.document || globalThis.document;
  const sinkId = String(options.sinkId || '');
  const durationMs = Math.max(120, Number(options.durationMs) || 450);
  if (typeof AudioContextCtor !== 'function') return false;
  const ctx = new AudioContextCtor();
  if (typeof ctx.resume === 'function') await ctx.resume();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = 880;
  gain.gain.value = 0.22;
  osc.connect(gain);
  const dest = typeof ctx.createMediaStreamDestination === 'function' ? ctx.createMediaStreamDestination() : null;
  const audio = dest ? createHiddenPlaybackAudio(doc) : null;
  if (dest && audio) {
    gain.connect(dest);
    audio.srcObject = dest.stream;
    await applyAudioOutputSink(audio, sinkId);
    if (typeof audio.play === 'function') await audio.play().catch(() => {});
  } else if (typeof ctx.destination !== 'undefined') {
    gain.connect(ctx.destination);
    await applyAudioOutputSink(ctx, sinkId);
  }
  const now = Number(ctx.currentTime) || 0;
  osc.start(now);
  osc.stop(now + durationMs / 1000);
  await new Promise((resolve) => setTimeout(resolve, durationMs + 80));
  if (audio) {
    try {
      audio.pause();
    } catch {
      // Removing next.
    }
    audio.srcObject = null;
    if (typeof audio.remove === 'function') audio.remove();
  }
  try {
    ctx.close();
  } catch {
    // Already closed.
  }
  return true;
}

/**
 * @typedef {Object} LivePlayback
 * @property {AudioContext} context
 * @property {(stream: MediaStream) => void} attachRemoteStream
 * @property {(sinkId: string) => Promise<boolean>} setSink
 * @property {() => Promise<void>} resume
 * @property {(sinkId?: string) => Promise<boolean>} playTestTone
 * @property {() => void} close
 */

/**
 * Must run inside the Connect click, before any `await`, so the browser
 * unlocks media playback on a user gesture.
 *
 * @param {typeof AudioContext} [AudioContextCtor]
 * @param {Document} [doc]
 * @returns {LivePlayback|null}
 */
export function createLivePlayback(AudioContextCtor = globalThis.AudioContext, doc = globalThis.document) {
  if (typeof AudioContextCtor !== 'function') return null;
  const ctx = new AudioContextCtor();
  if (typeof ctx.resume === 'function') void ctx.resume();
  try {
    const buffer = ctx.createBuffer(1, 1, ctx.sampleRate || 44100);
    const tick = ctx.createBufferSource();
    tick.buffer = buffer;
    tick.connect(ctx.destination);
    tick.start();
  } catch {
    // Priming is best effort; the <audio> element still attaches later.
  }
  const audio = createHiddenPlaybackAudio(doc);
  const playWhenReady = () => {
    if (!audio?.srcObject || typeof audio.play !== 'function') return;
    void audio.play().catch(() => {});
  };
  return {
    context: ctx,
    attachRemoteStream(stream) {
      if (!audio || !stream) return;
      audio.muted = false;
      audio.volume = 1;
      audio.srcObject = stream;
      playWhenReady();
    },
    setSink(sinkId) {
      return applyAudioOutputSink(audio, sinkId);
    },
    async resume() {
      if (typeof ctx.resume === 'function') await ctx.resume();
      playWhenReady();
    },
    playTestTone(sinkId) {
      return playLiveOutputTest({
        AudioContextCtor,
        document: doc,
        sinkId: sinkId || (audio && audio.sinkId) || '',
      });
    },
    close() {
      if (audio) {
        try {
          audio.pause();
        } catch {
          // Removing next.
        }
        audio.srcObject = null;
        if (typeof audio.remove === 'function') audio.remove();
      }
      try {
        ctx.close();
      } catch {
        // Already closed.
      }
    },
  };
}

/**
 * @param {string} deviceId
 * @returns {boolean}
 */
function isGenericDeviceId(deviceId) {
  const id = String(deviceId || '').trim().toLowerCase();
  return !id || id === 'default' || id === 'communications';
}

/**
 * Walks listed inputs (headset first) with communication-mode constraints so
 * Chrome enables SCO. A failed or phone-labelled attempt is discarded.
 *
 * @param {{
 *   getUserMedia: (constraints: object) => Promise<MediaStream>,
 * }} mediaDevices
 * @param {Array<{ kind?: string, deviceId?: string, label?: string }>} devices
 * @returns {Promise<MediaStream|null>}
 */
async function openHeadsetCapture(mediaDevices, devices) {
  const picked = pickBluetoothAudioDevices(devices);
  const inputs = devices.filter((device) => device?.kind === 'audioinput');
  /** @type {string[]} */
  const candidateIds = [];
  if (picked.inputId) candidateIds.push(picked.inputId);
  for (const input of inputs) {
    const id = String(input.deviceId || '');
    if (id && !candidateIds.includes(id)) candidateIds.push(id);
  }
  if (picked.outputId) candidateIds.push('');
  for (const id of candidateIds) {
    const exact = !isGenericDeviceId(id);
    try {
      const next = await mediaDevices.getUserMedia(
        buildLiveAudioConstraints(exact ? id : '', { communication: true, exact })
      );
      const label = String(next.getAudioTracks()[0]?.label || '');
      const requested = devices.find((device) => device.deviceId === id);
      const looksHeadset =
        classifyMicKind(label) === 'headset' ||
        (requested && isHeadsetAudioLabel(requested.label)) ||
        (exact && picked.inputId === id);
      if (!looksHeadset) {
        for (const track of next.getTracks()) track.stop();
        continue;
      }
      return next;
    } catch {
      // Try the next listed input.
    }
  }
  return null;
}

/**
 * @param {{
 *   getUserMedia: (constraints: object) => Promise<MediaStream>,
 *   enumerateDevices: () => Promise<MediaDeviceInfo[]>,
 * }} mediaDevices
 * @param {{ settleMs?: number }} [options]
 * @returns {Promise<{ stream: MediaStream, outputId: string, devices: Array<{ kind: string, label: string }> }>}
 */
export async function openLiveMicrophone(mediaDevices, options = {}) {
  let stream = await mediaDevices.getUserMedia(buildLiveAudioConstraints());
  let devices = [];
  try {
    devices = await mediaDevices.enumerateDevices();
  } catch {
    return { stream, outputId: '', devices: [] };
  }
  const settleMs = Math.max(0, Number(options.settleMs || 0));
  if (settleMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, settleMs));
    try {
      const later = await mediaDevices.enumerateDevices();
      if (later.length > 0) devices = later;
    } catch {
      // Keep the first snapshot.
    }
  }
  const headset = await openHeadsetCapture(mediaDevices, devices);
  if (headset) {
    for (const track of stream.getTracks()) track.stop();
    stream = headset;
  }
  const picked = pickBluetoothAudioDevices(devices);
  return {
    stream,
    outputId: picked.outputId,
    devices: devices.map((device) => ({
      kind: String(device.kind || ''),
      label: String(device.label || ''),
    })),
  };
}
