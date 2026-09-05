import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyAudioOutputSink,
  buildLiveAudioConstraints,
  classifyMicKind,
  computeTimeDomainLevel,
  createLivePlayback,
  playLiveOutputTest,
  remoteStreamFromTrackEvent,
  isBluetoothAudioLabel,
  listAudioInputChoices,
  listAudioOutputChoices,
  openLiveMicrophone,
  pickBluetoothAudioDevices,
} from '../app_front/features/voice/liveAudioRoute.js';

test('listAudioOutputChoices keeps only named audio outputs', () => {
  const actual = listAudioOutputChoices([
    { kind: 'audioinput', deviceId: 'bt-mic', label: 'Bluetooth headset' },
    { kind: 'audiooutput', deviceId: 'phone-spk', label: 'Speakerphone' },
    { kind: 'audiooutput', deviceId: 'bt-out', label: 'Bluetooth headset' },
    { kind: 'audiooutput', deviceId: '', label: 'ghost' },
  ]);
  assert.deepEqual(actual, [
    { deviceId: 'phone-spk', label: 'Speakerphone', kind: 'phone' },
    { deviceId: 'bt-out', label: 'Bluetooth headset', kind: 'headset' },
  ]);
});

test('listAudioInputChoices keeps only named audio inputs', () => {
  const actual = listAudioInputChoices([
    { kind: 'audiooutput', deviceId: 'bt-out', label: 'Bluetooth headset' },
    { kind: 'audioinput', deviceId: 'phone-mic', label: 'Built-in Microphone' },
    { kind: 'audioinput', deviceId: 'bt-mic', label: 'Galaxy Buds2 Pro' },
    { kind: 'audioinput', deviceId: '', label: 'ghost' },
  ]);
  assert.deepEqual(actual, [
    { deviceId: 'phone-mic', label: 'Built-in Microphone', kind: 'phone' },
    { deviceId: 'bt-mic', label: 'Galaxy Buds2 Pro', kind: 'headset' },
  ]);
});

test('classifyMicKind tells a headset from the phone mic', () => {
  assert.equal(classifyMicKind('Bluetooth headset'), 'headset');
  assert.equal(classifyMicKind('Galaxy Buds2 Pro'), 'headset');
  assert.equal(classifyMicKind('TOZO T6'), 'headset');
  assert.equal(classifyMicKind('Built-in Microphone'), 'phone');
  assert.equal(classifyMicKind('Default'), 'phone');
  assert.equal(classifyMicKind('Domyślny'), 'phone');
  assert.equal(classifyMicKind(''), 'unknown');
});

test('computeTimeDomainLevel is silent at the midpoint and rises with amplitude', () => {
  assert.equal(computeTimeDomainLevel(new Uint8Array(8).fill(128)), 0);
  assert.ok(computeTimeDomainLevel(new Uint8Array([0, 255, 0, 255])) > 0.5);
});

test('isBluetoothAudioLabel recognises headset names and skips the phone speaker', () => {
  assert.equal(isBluetoothAudioLabel('Bluetooth headset'), true);
  assert.equal(isBluetoothAudioLabel('Galaxy Buds2 Pro'), true);
  assert.equal(isBluetoothAudioLabel('WH-1000XM5'), true);
  assert.equal(isBluetoothAudioLabel('AirPods Pro'), true);
  assert.equal(isBluetoothAudioLabel('Speaker'), false);
  assert.equal(isBluetoothAudioLabel('Built-in Microphone'), false);
  assert.equal(isBluetoothAudioLabel(''), false);
});

test('pickBluetoothAudioDevices pairs input and output that share a groupId', () => {
  const actual = pickBluetoothAudioDevices([
    { kind: 'audioinput', deviceId: 'phone-mic', groupId: 'phone', label: 'Built-in Microphone' },
    { kind: 'audiooutput', deviceId: 'phone-spk', groupId: 'phone', label: 'Speaker' },
    { kind: 'audioinput', deviceId: 'bt-mic', groupId: 'buds', label: 'Galaxy Buds2 Pro' },
    { kind: 'audiooutput', deviceId: 'bt-out', groupId: 'buds', label: 'Galaxy Buds2 Pro' },
  ]);
  assert.deepEqual(actual, { inputId: 'bt-mic', outputId: 'bt-out' });
});

test('pickBluetoothAudioDevices treats a named extra device as a headset', () => {
  const actual = pickBluetoothAudioDevices([
    { kind: 'audioinput', deviceId: 'phone-mic', groupId: 'phone', label: 'Built-in Microphone' },
    { kind: 'audiooutput', deviceId: 'phone-spk', groupId: 'phone', label: 'Speaker' },
    { kind: 'audioinput', deviceId: 'bt-mic', groupId: 'tozo', label: 'TOZO T6' },
    { kind: 'audiooutput', deviceId: 'bt-out', groupId: 'tozo', label: 'TOZO T6' },
  ]);
  assert.deepEqual(actual, { inputId: 'bt-mic', outputId: 'bt-out' });
});

test('pickBluetoothAudioDevices returns empty ids when only the phone is listed', () => {
  const actual = pickBluetoothAudioDevices([
    { kind: 'audioinput', deviceId: 'phone-mic', groupId: 'phone', label: 'Microphone' },
    { kind: 'audiooutput', deviceId: 'phone-spk', groupId: 'phone', label: 'Speaker' },
  ]);
  assert.deepEqual(actual, { inputId: '', outputId: '' });
});

test('buildLiveAudioConstraints skips call processing unless SCO headset capture is requested', () => {
  const media = buildLiveAudioConstraints('bt-mic');
  assert.equal(media.audio.echoCancellation, false);
  assert.deepEqual(media.audio.deviceId, { ideal: 'bt-mic' });
  const sco = buildLiveAudioConstraints('bt-mic', { communication: true });
  assert.equal(sco.audio.echoCancellation, true);
  assert.equal(sco.audio.noiseSuppression, true);
  assert.equal(sco.audio.autoGainControl, true);
  assert.deepEqual(sco.audio.deviceId, { ideal: 'bt-mic' });
});

test('openLiveMicrophone reopens the Bluetooth mic with call processing so Chrome enables SCO', async () => {
  const stopped = [];
  const phoneTrack = {
    getSettings: () => ({ deviceId: 'phone-mic' }),
    stop: () => stopped.push('phone-mic'),
  };
  const btTrack = {
    getSettings: () => ({ deviceId: 'bt-mic' }),
    stop: () => stopped.push('bt-mic'),
  };
  const calls = [];
  const mediaDevices = {
    async getUserMedia(constraints) {
      calls.push(constraints);
      const deviceId = constraints?.audio?.deviceId?.exact || constraints?.audio?.deviceId?.ideal;
      const track = deviceId === 'bt-mic' ? btTrack : phoneTrack;
      return { getAudioTracks: () => [track], getTracks: () => [track] };
    },
    async enumerateDevices() {
      return [
        { kind: 'audioinput', deviceId: 'phone-mic', groupId: 'phone', label: 'Built-in Microphone' },
        { kind: 'audioinput', deviceId: 'bt-mic', groupId: 'buds', label: 'Bluetooth headset' },
        { kind: 'audiooutput', deviceId: 'bt-out', groupId: 'buds', label: 'Bluetooth headset' },
      ];
    },
  };

  const actual = await openLiveMicrophone(mediaDevices);

  assert.equal(actual.stream.getAudioTracks()[0].getSettings().deviceId, 'bt-mic');
  assert.equal(actual.outputId, 'bt-out');
  assert.deepEqual(stopped, ['phone-mic']);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].audio.echoCancellation, false);
  assert.equal(calls[1].audio.echoCancellation, true);
  assert.deepEqual(calls[1].audio.deviceId, { exact: 'bt-mic' });
});

test('openLiveMicrophone tries SCO on the default input when only the headset output is listed', async () => {
  const phoneTrack = {
    label: 'Built-in Microphone',
    getSettings: () => ({ deviceId: 'phone-mic' }),
    stop: () => {},
  };
  const scoTrack = {
    label: 'Bluetooth headset',
    getSettings: () => ({ deviceId: 'sco' }),
    stop: () => {},
  };
  const mediaDevices = {
    async getUserMedia(constraints) {
      if (constraints?.audio?.echoCancellation && !constraints?.audio?.deviceId) {
        return { getAudioTracks: () => [scoTrack], getTracks: () => [scoTrack] };
      }
      return { getAudioTracks: () => [phoneTrack], getTracks: () => [phoneTrack] };
    },
    async enumerateDevices() {
      return [
        { kind: 'audioinput', deviceId: 'phone-mic', groupId: 'phone', label: 'Built-in Microphone' },
        { kind: 'audiooutput', deviceId: 'bt-out', groupId: 'buds', label: 'Bluetooth headset' },
      ];
    },
  };

  const actual = await openLiveMicrophone(mediaDevices);

  assert.equal(actual.stream.getAudioTracks()[0].label, 'Bluetooth headset');
  assert.equal(actual.outputId, 'bt-out');
});

test('openLiveMicrophone keeps the default mic when the headset reopen fails', async () => {
  const phoneTrack = {
    getSettings: () => ({ deviceId: 'phone-mic' }),
    stop: () => {},
  };
  const mediaDevices = {
    async getUserMedia(constraints) {
      if (constraints?.audio?.deviceId?.exact === 'bt-mic' || constraints?.audio?.deviceId?.ideal === 'bt-mic') {
        throw new Error('headset busy');
      }
      return { getAudioTracks: () => [phoneTrack], getTracks: () => [phoneTrack] };
    },
    async enumerateDevices() {
      return [
        { kind: 'audioinput', deviceId: 'bt-mic', groupId: 'buds', label: 'Bluetooth headset' },
        { kind: 'audiooutput', deviceId: 'bt-out', groupId: 'buds', label: 'Bluetooth headset' },
      ];
    },
  };

  const actual = await openLiveMicrophone(mediaDevices);

  assert.equal(actual.stream.getAudioTracks()[0].getSettings().deviceId, 'phone-mic');
  assert.equal(actual.outputId, 'bt-out');
});

test('createLivePlayback primes playback and attaches the remote stream to a hidden audio element', () => {
  const started = [];
  const fakeAudio = {
    autoplay: false,
    volume: 0,
    muted: true,
    srcObject: null,
    sinkId: '',
    play: async () => {
      started.push('play');
    },
    pause: () => started.push('pause'),
    remove: () => started.push('remove'),
    setAttribute: () => {},
    setSinkId: async () => {},
  };
  const fakeDoc = {
    createElement: () => fakeAudio,
    body: { appendChild: (node) => started.push(node === fakeAudio ? 'append' : 'other') },
  };
  const fakeCtx = {
    sampleRate: 48000,
    resume: async () => {},
    createBuffer: () => ({}),
    createBufferSource: () => ({
      buffer: null,
      connect: () => {},
      start: () => started.push('tick'),
    }),
    close: () => started.push('close'),
  };
  const playback = createLivePlayback(function AudioContext() {
    return fakeCtx;
  }, fakeDoc);
  assert.ok(playback);
  assert.ok(started.includes('tick'));
  assert.ok(started.includes('append'));
  playback.attachRemoteStream({ id: 'remote' });
  assert.equal(fakeAudio.srcObject.id, 'remote');
  assert.equal(fakeAudio.muted, false);
  assert.equal(fakeAudio.volume, 1);
  playback.close();
  assert.ok(started.includes('close'));
  assert.ok(started.includes('remove'));
});

test('createLivePlayback resume does not wait for play() before a remote stream exists', async () => {
  const fakeAudio = {
    srcObject: null,
    play: () => new Promise(() => {}),
    pause: () => {},
    remove: () => {},
    setAttribute: () => {},
  };
  const playback = createLivePlayback(
    function AudioContext() {
      return {
        resume: async () => {},
        createBuffer: () => ({}),
        createBufferSource: () => ({ buffer: null, connect: () => {}, start: () => {} }),
        close: () => {},
      };
    },
    { createElement: () => fakeAudio, body: { appendChild: () => {} } }
  );
  await Promise.race([
    playback.resume(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('resume hung')), 80)),
  ]);
});

test('remoteStreamFromTrackEvent falls back to the track when streams is empty', () => {
  const track = { id: 't1', kind: 'audio' };
  assert.equal(remoteStreamFromTrackEvent({ streams: [{ id: 's1' }] }).id, 's1');
  function FakeStream(tracks) {
    this.getTracks = () => tracks;
  }
  const fromTrack = remoteStreamFromTrackEvent({ streams: [], track }, FakeStream);
  assert.ok(fromTrack);
  assert.equal(fromTrack.getTracks()[0], track);
  assert.equal(remoteStreamFromTrackEvent({}), null);
});

test('playLiveOutputTest starts an oscillator and plays it through a hidden audio element', async () => {
  const started = [];
  const fakeAudio = {
    autoplay: false,
    volume: 1,
    srcObject: null,
    play: async () => {
      started.push(fakeAudio.srcObject?.id || 'play');
    },
    pause: () => {},
    remove: () => started.push('remove'),
    setAttribute: () => {},
  };
  const dest = { stream: { id: 'beep' } };
  const fakeCtx = {
    currentTime: 0,
    resume: async () => {},
    createOscillator: () => ({
      type: '',
      frequency: { value: 0 },
      connect: () => {},
      start: () => started.push('start'),
      stop: () => started.push('stop'),
    }),
    createGain: () => ({
      gain: { value: 0 },
      connect: (node) => started.push(node === dest ? 'dest' : 'other'),
    }),
    createMediaStreamDestination: () => dest,
    close: () => started.push('close'),
  };
  const actual = await playLiveOutputTest({
    AudioContextCtor: function AudioContext() {
      return fakeCtx;
    },
    document: {
      createElement: () => fakeAudio,
      body: { appendChild: () => {} },
    },
    durationMs: 120,
  });
  assert.equal(actual, true);
  assert.ok(started.includes('beep'));
  assert.ok(started.includes('start'));
  assert.ok(started.includes('stop'));
  assert.ok(started.includes('remove'));
  assert.equal(fakeAudio.srcObject, null);
});

test('applyAudioOutputSink no-ops when the browser cannot pick an output', async () => {
  assert.equal(await applyAudioOutputSink({}, 'bt-out'), false);
  assert.equal(await applyAudioOutputSink({ setSinkId: async () => {} }, ''), false);
});

test('applyAudioOutputSink calls setSinkId on the playback target', async () => {
  const seen = [];
  const actual = await applyAudioOutputSink(
    { setSinkId: async (id) => seen.push(id) },
    'bt-out'
  );
  assert.equal(actual, true);
  assert.deepEqual(seen, ['bt-out']);
});
