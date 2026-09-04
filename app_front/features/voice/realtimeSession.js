/**
 * Realtime voice conversation over WebRTC.
 *
 * Audio goes browser <-> OpenAI directly; the Cretli server only mints the
 * ephemeral token. Tool calls arrive on the `oai-events` data channel and are
 * executed locally against the running app.
 *
 * Start attempts are guarded by an epoch counter: an aborted start must not
 * leave an orphaned microphone track or peer connection behind, which is the
 * one failure mode users notice immediately (the tab keeps recording).
 */

import { postUsageEvent, requestRealtimeToken } from '../../api.js';
import { getCurrentLang } from '../../i18n/index.js';
import { appLogger } from '../../logger.js';
import {
  SCO_SETTLE_MS,
  createLivePlayback,
  listAudioInputChoices,
  listAudioOutputChoices,
  openLiveMicrophone,
  openMicByDeviceId,
} from './liveAudioRoute.js';
import { executeRealtimeTool } from './realtimeTools.js';
import { createVoiceCostTracker } from './voiceCost.js';
import { createPendingEndSession } from './voiceEndSession.js';

const OPENAI_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
/** Older audio items are re-billed as input on every later turn. */
const KEEP_RECENT_ITEMS = 4;
/** A forgotten live session is the expensive failure mode. */
const IDLE_CLOSE_MS = 90_000;

/**
 * @typedef {'idle'|'connecting'|'live'|'closing'|'error'} RealtimeStatus
 */

/**
 * The SDP exchange answers with plain text or a JSON error. A bare status code
 * tells the user nothing, and 429 here usually means exhausted credits rather
 * than too many requests.
 *
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function describeHandshakeFailure(response) {
  const raw = await response.text().catch(() => '');
  let message = '';
  try {
    message = String(JSON.parse(raw)?.error?.message || '');
  } catch {
    message = raw.trim().slice(0, 200);
  }
  if (message) return message;
  if (response.status === 429) return 'voice.quotaOrRateLimit';
  if (response.status === 401 || response.status === 403) return 'voice.tokenRejected';
  return `Realtime handshake failed (HTTP ${response.status})`;
}

/**
 * @param {{
 *   onStatusChange?: (status: RealtimeStatus, detail?: string) => void,
 *   onTranscript?: (entry: { role: 'user'|'assistant', text: string }) => void,
 *   onToolCall?: (entry: { name: string, args: object, result: object }) => void,
 *   onCostChange?: (state: { totalUsd: number }) => void,
 *   onNotice?: (message: string) => void,
 * }} [callbacks]
 */
export function createRealtimeSession(callbacks = {}) {
  /** @type {RealtimeStatus} */
  let status = 'idle';
  /** Bumped on every start and stop, so a superseded start tears itself down. */
  let epoch = 0;
  /** @type {RTCPeerConnection|null} */
  let peer = null;
  /** @type {MediaStream|null} */
  let micStream = null;
  /** @type {RTCDataChannel|null} */
  let channel = null;
  /** @type {ReturnType<typeof createLivePlayback>} */
  let playback = null;
  /** @type {ReturnType<typeof createVoiceCostTracker>|null} */
  let cost = null;
  /** Tool calls already executed, keyed by call_id — the API can repeat them. */
  const handledCalls = new Set();
  /** @type {string[]} */
  let itemIds = [];
  /** @type {ReturnType<typeof setTimeout>|0} */
  let idleTimer = 0;

  function touchIdle() {
    if (idleTimer) window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => {
      notice('voice.idleClosed');
      stop();
    }, IDLE_CLOSE_MS);
  }

  /**
   * @param {RealtimeStatus} next
   * @param {string} [detail]
   */
  function setStatus(next, detail = '') {
    status = next;
    if (typeof callbacks.onStatusChange === 'function') callbacks.onStatusChange(next, detail);
  }

  /**
   * @param {string} message
   */
  function notice(message) {
    if (typeof callbacks.onNotice === 'function') callbacks.onNotice(message);
  }

  function releaseResources() {
    if (channel) {
      try {
        channel.close();
      } catch {
        // Already closed with the peer connection.
      }
      channel = null;
    }
    if (peer) {
      try {
        peer.close();
      } catch {
        // Same.
      }
      peer = null;
    }
    if (micStream) {
      for (const track of micStream.getTracks()) track.stop();
      micStream = null;
    }
    if (playback) {
      playback.close();
      playback = null;
    }
    handledCalls.clear();
    itemIds = [];
    if (idleTimer) window.clearTimeout(idleTimer);
    idleTimer = 0;
  }

  /**
   * @param {object} payload
   */
  function sendEvent(payload) {
    if (!channel || channel.readyState !== 'open') return;
    try {
      channel.send(JSON.stringify(payload));
    } catch (error) {
      appLogger.log('voice', 'realtime send failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * @param {string} callId
   * @param {string} name
   * @param {string} rawArguments
   */
  async function handleToolCall(callId, name, rawArguments) {
    if (!callId || handledCalls.has(callId)) return;
    handledCalls.add(callId);
    const myEpoch = epoch;

    /** @type {object} */
    let args = {};
    try {
      args = rawArguments ? JSON.parse(rawArguments) : {};
    } catch {
      args = {};
    }
    const result = await executeRealtimeTool(name, args);
    if (myEpoch !== epoch) return;

    if (typeof callbacks.onToolCall === 'function') callbacks.onToolCall({ name, args, result });
    sendEvent({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) },
    });
    // Without an explicit response the model waits silently for the next turn.
    sendEvent({ type: 'response.create' });
    if (result?.endSession === true) endSession.request({ skipCompletions: 1 });
  }

  /**
   * @param {MessageEvent} event
   */
  function handleChannelMessage(event) {
    /** @type {any} */
    let payload = null;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    const type = String(payload?.type || '');

    if (type === 'conversation.item.created' && payload?.item?.id) {
      itemIds.push(String(payload.item.id));
      return;
    }
    if (type === 'response.function_call_arguments.done') {
      void handleToolCall(payload.call_id, payload.name, payload.arguments);
      return;
    }
    if (type === 'response.output_item.done' && payload?.item?.type === 'function_call') {
      void handleToolCall(payload.item.call_id, payload.item.name, payload.item.arguments);
      return;
    }
    if (type === 'conversation.item.input_audio_transcription.completed') {
      const text = String(payload?.transcript || '').trim();
      if (text && typeof callbacks.onTranscript === 'function') {
        callbacks.onTranscript({ role: 'user', text });
      }
      touchIdle();
      return;
    }
    if (type === 'response.output_audio_transcript.done' || type === 'response.audio_transcript.done') {
      const text = String(payload?.transcript || '').trim();
      if (text && typeof callbacks.onTranscript === 'function') {
        callbacks.onTranscript({ role: 'assistant', text });
      }
      touchIdle();
      return;
    }
    if (type === 'response.done') {
      if (cost && payload?.response?.usage) cost.addUsage(payload.response.usage);
      // Drop earlier items so their audio is not sent (and billed) again.
      const stale = itemIds.splice(0, Math.max(0, itemIds.length - KEEP_RECENT_ITEMS));
      for (const itemId of stale) {
        sendEvent({ type: 'conversation.item.delete', item_id: itemId });
      }
      touchIdle();
      endSession.onComplete();
      return;
    }
    if (type === 'error') {
      const message = String(payload?.error?.message || 'Realtime error');
      appLogger.log('voice', 'realtime error event', { message });
      notice(message);
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
    // Prime media playback in the Connect click, before any await.
    playback = createLivePlayback();

    try {
      const token = await requestRealtimeToken({
        lang: getCurrentLang(),
        voice: options.voice,
        model: options.model,
      });
      if (myEpoch !== epoch) {
        releaseResources();
        return false;
      }
      if (!token?.ok || !token.clientSecret) {
        throw new Error(token?.error || 'Could not mint a realtime token');
      }

      cost = createVoiceCostTracker({
        model: token.model,
        provider: 'openai',
        warnUsd: options.warnUsd,
        capUsd: options.capUsd,
        onUsageDelta: (delta) => {
          if (myEpoch !== epoch) return;
          void postUsageEvent({
            provider: 'openai',
            feature: 'voice-live',
            model: token.model,
            tokens: delta,
          }).catch(() => {});
        },
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
      if (playback && liveMic.outputId) {
        await playback.setSink(liveMic.outputId);
        window.setTimeout(() => {
          if (myEpoch !== epoch || !playback) return;
          void playback.setSink(liveMic.outputId);
        }, SCO_SETTLE_MS);
      }

      peer = new RTCPeerConnection();
      peer.ontrack = (event) => {
        if (!event.streams[0] || !playback) return;
        playback.attachRemoteStream(event.streams[0]);
        if (liveMic.outputId) void playback.setSink(liveMic.outputId);
      };
      peer.onconnectionstatechange = () => {
        if (myEpoch !== epoch || !peer) return;
        const state = peer.connectionState;
        if (state === 'failed' || state === 'disconnected' || state === 'closed') {
          if (status === 'live') notice('voice.connectionLost');
          stop();
        }
      };
      for (const track of micStream.getAudioTracks()) peer.addTrack(track, micStream);

      channel = peer.createDataChannel('oai-events');
      channel.onmessage = handleChannelMessage;

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      if (myEpoch !== epoch) {
        releaseResources();
        return false;
      }

      const answer = await fetch(`${OPENAI_CALLS_URL}?model=${encodeURIComponent(token.model || '')}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token.clientSecret}`,
          'Content-Type': 'application/sdp',
        },
        body: offer.sdp,
      });
      if (myEpoch !== epoch) {
        releaseResources();
        return false;
      }
      if (!answer.ok) {
        throw new Error(await describeHandshakeFailure(answer));
      }
      await peer.setRemoteDescription({ type: 'answer', sdp: await answer.text() });
      if (myEpoch !== epoch) {
        releaseResources();
        return false;
      }

      setStatus('live');
      touchIdle();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appLogger.log('voice', 'realtime start failed', { message });
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

    /**
     * Mutes or unmutes the microphone without dropping the session, so the
     * model stops hearing the room during a side conversation.
     *
     * @param {boolean} muted
     * @returns {void}
     */
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
      if (!playback) return false;
      const ok = await playback.setSink(deviceId);
      if (ok) {
        window.setTimeout(() => {
          void playback?.setSink(deviceId);
        }, SCO_SETTLE_MS);
      }
      return ok;
    },

    /**
     * @param {string} deviceId
     * @returns {Promise<string>}
     */
    async switchMic(deviceId) {
      if (!peer || !micStream) return '';
      const next = await openMicByDeviceId(navigator.mediaDevices, deviceId);
      const track = next.getAudioTracks()[0];
      const sender = peer.getSenders().find((item) => item.track?.kind === 'audio');
      if (sender && track) await sender.replaceTrack(track);
      for (const old of micStream.getTracks()) old.stop();
      micStream = next;
      return String(track?.label || '');
    },

    /** Cuts the model off mid-sentence, the spoken equivalent of Escape. */
    interrupt() {
      sendEvent({ type: 'response.cancel' });
    },

    /**
     * @param {string} text
     * @returns {void}
     */
    sendText(text) {
      const value = String(text || '').trim();
      if (!value) return;
      sendEvent({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: value }] },
      });
      sendEvent({ type: 'response.create' });
    },

    getTotalUsd() {
      return cost ? cost.getTotalUsd() : 0;
    },
  };
}
