import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyAudioOutputSink,
  buildLiveAudioConstraints,
  classifyMicKind,
  computeTimeDomainLevel,
  createLivePlayback,
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

test('createLivePlayback primes a media AudioContext and attaches the remote stream', () => {
  const started = [];
  const connected = [];
  const fakeCtx = {
    sampleRate: 48000,
    resume: async () => {},
    createBuffer: () => ({}),
    createBufferSource: () => ({
      buffer: null,
      connect: (node) => connected.push(node),
      start: () => started.push('tick'),
    }),
    createGain: () => {
      const gain = { gain: { value: 1 }, connect: (node) => connected.push(node) };
      return gain;
    },
    createMediaStreamSource: (stream) => ({
      stream,
      connect: (node) => connected.push({ stream, node }),
      disconnect: () => {},
    }),
    close: () => started.push('close'),
  };
  const playback = createLivePlayback(function AudioContext() {
    return fakeCtx;
  });
  assert.ok(playback);
  assert.deepEqual(started, ['tick']);
  playback.attachRemoteStream({ id: 'remote' });
  assert.equal(connected.some((item) => item?.stream?.id === 'remote'), true);
  playback.close();
  assert.ok(started.includes('close'));
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
