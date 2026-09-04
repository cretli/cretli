/**
 * Gemini Live voice conversation over a WebSocket.
 *
 * Audio is PCM both ways. The Cretli server only mints a short-lived token and
 * the setup payload (instructions + tools); the browser talks to Google
 * directly so the key never leaves the server.
 */

import { requestGeminiLiveToken } from '../../api.js';
import { getCurrentLang } from '../../i18n/index.js';
import { appLogger } from '../../logger.js';
import {
  SCO_SETTLE_MS,
  applyAudioOutputSink,
  listAudioInputChoices,
  listAudioOutputChoices,
  openLiveMicrophone,
  openMicByDeviceId,
} from './liveAudioRoute.js';
import { executeRealtimeTool } from './realtimeTools.js';
import { createVoiceCostTracker } from './voiceCost.js';
import { createPendingEndSession } from './voiceEndSession.js';

const GEMINI_LIVE_WS =
  'wss://generativelanguage.googleapis.com/ws/' +
  'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const CAPTURE_RATE = 16000;
const PLAYBACK_RATE = 24000;
const IDLE_CLOSE_MS = 90_000;
const CONNECT_TIMEOUT_MS = 12_000;

/**
 * @param {Float32Array} samples
 * @returns {string} base64 PCM16le
 */
function floatToBase64Pcm16(samples) {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const clipped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff, true);
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/**
 * @param {string} base64
 * @returns {Int16Array}
 */
function base64ToPcm16(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

/**
 * @param {unknown} data
 * @returns {Promise<string>}
 */
async function readSocketData(data) {
  if (typeof data === 'string') return data;
  if (data instanceof Blob) return data.text();
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  return String(data || '');
}

/**
 * @param {unknown} payload
 * @returns {string}
 */
function readGeminiError(payload) {
  const error = payload && typeof payload === 'object' ? payload.error : null;
  if (!error) return '';
  if (typeof error === 'string') return error;
  return String(error.message || error.status || '');
}

/**
 * @param {number} sampleRate
 */
function createPcmPlayer(sampleRate) {
  const ctx = new AudioContext({ sampleRate });
  let nextTime = 0;
  return {
    /**
     * @param {string} sinkId
     * @returns {Promise<boolean>}
     */
    setSink(sinkId) {
      return applyAudioOutputSink(ctx, sinkId);
    },
    /**
     * @param {Int16Array} pcm
     * @returns {Promise<void>}
     */
    async play(pcm) {
      if (ctx.state === 'suspended') await ctx.resume();
      const floats = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) floats[i] = pcm[i] / 32768;
      const buffer = ctx.createBuffer(1, floats.length, sampleRate);
      buffer.getChannelData(0).set(floats);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      const startAt = Math.max(ctx.currentTime, nextTime);
      source.start(startAt);
      nextTime = startAt + buffer.duration;
    },
    interrupt() {
      nextTime = 0;
    },
    close() {
      nextTime = 0;
      try {
        ctx.close();
      } catch {
        // Already closed.
      }
    },
  };
}

/**
 * @param {{
 *   onStatusChange?: (status: string, detail?: string) => void,
 *   onTranscript?: (entry: { role: 'user'|'assistant', text: string }) => void,
 *   onToolCall?: (entry: { name: string, args: object, result: object }) => void,
 *   onCostChange?: (state: { totalUsd: number }) => void,
 *   onNotice?: (message: string) => void,
 * }} [callbacks]
 */
export function createGeminiLiveSession(callbacks = {}) {
  let status = 'idle';
  let epoch = 0;
  /** @type {WebSocket|null} */
  let socket = null;
  /** @type {MediaStream|null} */
  let micStream = null;
  /** @type {AudioContext|null} */
  let captureCtx = null;
  /** @type {ScriptProcessorNode|null} */
  let processor = null;
  /** @type {MediaStreamAudioSourceNode|null} */
  let captureSource = null;
  /** @type {ReturnType<typeof createPcmPlayer>|null} */
  let player = null;
  /** @type {ReturnType<typeof createVoiceCostTracker>|null} */
  let cost = null;
  const handledCalls = new Set();
  /** @type {ReturnType<typeof setTimeout>|0} */
  let idleTimer = 0;

  function setStatus(next, detail = '') {
    status = next;
    if (typeof callbacks.onStatusChange === 'function') callbacks.onStatusChange(next, detail);
  }

  function notice(message) {
    if (typeof callbacks.onNotice === 'function') callbacks.onNotice(message);
  }

  function touchIdle() {
    if (idleTimer) window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => {
      notice('voice.idleClosed');
      stop();
    }, IDLE_CLOSE_MS);
  }

  function send(payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(payload));
    } catch (error) {
      appLogger.log('voice', 'gemini send failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function releaseResources() {
    if (idleTimer) window.clearTimeout(idleTimer);
    idleTimer = 0;
    if (processor) {
      try {
        processor.disconnect();
      } catch {
        // Already gone.
      }
      processor = null;
    }
    if (captureSource) {
      try {
        captureSource.disconnect();
      } catch {
        // Already gone.
      }
      captureSource = null;
    }
    if (captureCtx) {
      try {
        captureCtx.close();
      } catch {
        // Already closed.
      }
      captureCtx = null;
    }
    if (socket) {
      try {
        socket.close();
      } catch {
        // Same.
      }
      socket = null;
    }
    if (micStream) {
      for (const track of micStream.getTracks()) track.stop();
      micStream = null;
    }
    if (player) {
      player.close();
      player = null;
    }
    handledCalls.clear();
  }

  /**
   * @param {object} toolCall
   */
  async function handleToolCall(toolCall) {
    const calls = Array.isArray(toolCall?.functionCalls) ? toolCall.functionCalls : [];
    const myEpoch = epoch;
    const responses = [];
    let wantEnd = false;
    for (const call of calls) {
      const id = String(call?.id || '');
      const name = String(call?.name || '');
      if (!name || handledCalls.has(id || name)) continue;
      handledCalls.add(id || name);
      const result = await executeRealtimeTool(name, call.args || {});
      if (myEpoch !== epoch) return;
      if (typeof callbacks.onToolCall === 'function') {
        callbacks.onToolCall({ name, args: call.args || {}, result });
      }
      responses.push({ id, name, response: result });
      if (result?.endSession === true) wantEnd = true;
    }
    if (responses.length === 0) return;
    send({ toolResponse: { functionResponses: responses } });
    if (wantEnd) endSession.request({ skipCompletions: 1 });
  }

  /**
   * @param {object} payload
   */
  function handleMessage(payload) {
    const errorText = readGeminiError(payload);
    if (errorText) {
      if (status === 'live') {
        notice(errorText);
        stop();
        return;
      }
      setStatus('error', errorText);
      return;
    }
    if (payload?.setupComplete) {
      setStatus('live');
      touchIdle();
      return;
    }
    if (payload?.toolCall) {
      void handleToolCall(payload.toolCall);
      touchIdle();
      return;
    }
    if (payload?.usageMetadata && cost) {
      cost.addGeminiUsage(payload.usageMetadata);
    }
    const inputText = String(payload?.serverContent?.inputTranscription?.text || '').trim();
    if (inputText && typeof callbacks.onTranscript === 'function') {
      callbacks.onTranscript({ role: 'user', text: inputText });
      touchIdle();
    }
    const outputText = String(payload?.serverContent?.outputTranscription?.text || '').trim();
    if (outputText && typeof callbacks.onTranscript === 'function') {
      callbacks.onTranscript({ role: 'assistant', text: outputText });
      touchIdle();
    }
    const parts = payload?.serverContent?.modelTurn?.parts;
    if (Array.isArray(parts) && player) {
      for (const part of parts) {
        const data = part?.inlineData?.data || part?.inline_data?.data;
        if (!data) continue;
        void player.play(base64ToPcm16(data));
      }
    }
    if (payload?.serverContent?.turnComplete || payload?.serverContent?.generationComplete) {
      endSession.onComplete();
    }
  }

  /**
   * @param {{ voice?: string, model?: string, warnUsd?: number, capUsd?: number }} [options]
   * @returns {Promise<boolean>}
   */
  async function start(options = {}) {
    if (status === 'connecting' || status === 'live') return true;
    epoch += 1;
    const myEpoch = epoch;
    setStatus('connecting');
    // Prime PCM playback in the Connect click, before any await.
    player = createPcmPlayer(PLAYBACK_RATE);

    try {
      const token = await requestGeminiLiveToken({
        lang: getCurrentLang(),
        voice: options.voice,
        model: options.model,
      });
      if (myEpoch !== epoch) {
        releaseResources();
        return false;
      }
      if (!token?.ok || !token.token || !token.setup) {
        throw new Error(token?.error || 'Could not mint a Gemini live token');
      }

      cost = createVoiceCostTracker({
        model: token.model || 'gemini',
        provider: 'google',
        warnUsd: options.warnUsd,
        capUsd: options.capUsd,
        onChange: (state) => {
          if (myEpoch !== epoch) return;
          if (typeof callbacks.onCostChange === 'function') callbacks.onCostChange(state);
        },
        onWarn: (totalUsd) => {
          if (myEpoch !== epoch) return;
          notice(`voice.costWarn:${totalUsd.toFixed(2)}`);
        },
        onCap: (totalUsd) => {
          if (myEpoch !== epoch) return;
          notice(`voice.costCap:${totalUsd.toFixed(2)}`);
          stop();
        },
      });

      const liveMic = await openLiveMicrophone(navigator.mediaDevices, { settleMs: 400 });
      micStream = liveMic.stream;
      appLogger.log('voice', 'live audio route', {
        input: micStream.getAudioTracks()[0]?.label || '',
        outputId: liveMic.outputId || '',
        devices: liveMic.devices,
      });
      if (myEpoch !== epoch) {
        releaseResources();
        return false;
      }
      if (liveMic.outputId) {
        await player.setSink(liveMic.outputId);
        window.setTimeout(() => {
          if (myEpoch !== epoch || !player) return;
          void player.setSink(liveMic.outputId);
        }, SCO_SETTLE_MS);
      }
      const wsUrl = token.wsUrl || `${GEMINI_LIVE_WS}?key=${encodeURIComponent(token.token)}`;
      socket = new WebSocket(wsUrl);
      await new Promise((resolve, reject) => {
        if (!socket) return reject(new Error('WebSocket missing'));
        const timer = window.setTimeout(() => reject(new Error('Gemini live socket timed out')), CONNECT_TIMEOUT_MS);
        const settle = (error) => {
          window.clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        };
        socket.onopen = () => settle();
        socket.onerror = () => settle(new Error('Gemini live socket failed'));
        socket.onclose = (event) => settle(new Error(event.reason || `Gemini live socket closed (${event.code})`));
      });
      if (myEpoch !== epoch) {
        releaseResources();
        return false;
      }
      await new Promise((resolve, reject) => {
        if (!socket) return reject(new Error('WebSocket missing'));
        const timer = window.setTimeout(() => reject(new Error('Gemini live setup timed out')), CONNECT_TIMEOUT_MS);
        let settled = false;
        const settle = (error) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        };
        socket.onmessage = async (event) => {
          if (myEpoch !== epoch) return;
          try {
            handleMessage(JSON.parse((await readSocketData(event.data)) || '{}'));
          } catch {
            settle(new Error('Gemini live sent a non-JSON frame'));
            return;
          }
          if (status === 'live') settle();
          if (status === 'error') settle(new Error('Gemini live setup failed'));
        };
        socket.onclose = (event) => {
          if (myEpoch !== epoch) return;
          const reason = event.reason || `Gemini live socket closed (${event.code})`;
          if (status === 'connecting') {
            settle(new Error(reason));
            return;
          }
          if (status === 'live') {
            notice('voice.connectionLost');
            stop();
          }
        };
        send(token.setup);
      });
      if (myEpoch !== epoch) {
        releaseResources();
        return false;
      }

      captureCtx = new AudioContext({ sampleRate: CAPTURE_RATE });
      captureSource = captureCtx.createMediaStreamSource(micStream);
      processor = captureCtx.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (event) => {
        if (myEpoch !== epoch) return;
        const samples = event.inputBuffer.getChannelData(0);
        send({
          realtimeInput: {
            audio: { data: floatToBase64Pcm16(samples), mimeType: `audio/pcm;rate=${CAPTURE_RATE}` },
          },
        });
      };
      captureSource.connect(processor);
      // ScriptProcessor only fires when it has an output. Do not connect that
      // output to the speakers — that is what pulls Android onto the handset.
      processor.connect(captureCtx.createMediaStreamDestination());
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appLogger.log('voice', 'gemini live start failed', { message });
      if (myEpoch === epoch) {
        releaseResources();
        setStatus('error', message);
      }
      return false;
    }
  }

  function stopLive() {
    if (status === 'idle') return;
    epoch += 1;
    setStatus('closing');
    releaseResources();
    setStatus('idle');
  }

  const endSession = createPendingEndSession({ stop: stopLive });

  function stop() {
    endSession.reset();
    stopLive();
  }

  return {
    start,
    stop,
    getStatus() {
      return status;
    },
    isLive() {
      return status === 'live';
    },
    setMicMuted(muted) {
      if (!micStream) return;
      for (const track of micStream.getAudioTracks()) track.enabled = !muted;
    },
    isMicMuted() {
      if (!micStream) return false;
      return micStream.getAudioTracks().some((track) => !track.enabled);
    },

    /** Live capture stream — the panel meter reads level from this. */
    getMicStream() {
      return micStream;
    },

    async listMicInputs() {
      try {
        return listAudioInputChoices(await navigator.mediaDevices.enumerateDevices());
      } catch {
        return [];
      }
    },

    async listSpeakerOutputs() {
      try {
        return listAudioOutputChoices(await navigator.mediaDevices.enumerateDevices());
      } catch {
        return [];
      }
    },

    /**
     * @param {string} deviceId
     * @returns {Promise<boolean>}
     */
    async switchSpeaker(deviceId) {
      if (!player) return false;
      const ok = await player.setSink(deviceId);
      if (ok) {
        window.setTimeout(() => {
          void player?.setSink(deviceId);
        }, SCO_SETTLE_MS);
      }
      return ok;
    },

    /**
     * @param {string} deviceId
     * @returns {Promise<string>}
     */
    async switchMic(deviceId) {
      if (!captureCtx || !processor || !micStream) return '';
      const next = await openMicByDeviceId(navigator.mediaDevices, deviceId);
      try {
        captureSource?.disconnect();
      } catch {
        // Replacing the capture graph.
      }
      for (const old of micStream.getTracks()) old.stop();
      micStream = next;
      captureSource = captureCtx.createMediaStreamSource(next);
      captureSource.connect(processor);
      return String(next.getAudioTracks()[0]?.label || '');
    },
    interrupt() {
      player?.interrupt();
      send({ realtimeInput: { activityEnd: {} } });
    },
    sendText(text) {
      const value = String(text || '').trim();
      if (!value) return;
      send({ realtimeInput: { text: value } });
    },
    getTotalUsd() {
      return cost ? cost.getTotalUsd() : 0;
    },
  };
}
