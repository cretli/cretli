/**
 * Voice endpoints. Everything that needs the OpenAI key is brokered here so the
 * browser only ever sees rendered audio or plain text.
 */

import path from 'path';
import { getEffectiveOpenAiApiKey } from '../voice/openai-api-key.js';
import { getEffectiveGeminiApiKey, isValidGeminiApiKeyFormat } from '../voice/gemini-api-key.js';
import { probeGeminiApiKey } from '../voice/gemini-probe.js';
import { getEffectiveAzureSpeechCredentials } from '../voice/azure-speech-key.js';
import {
  buildGeminiLiveRelayClientUrl,
  buildGeminiLiveSetup,
  GEMINI_LIVE_RELAY_TICKET_TTL_MS,
  resolveGeminiLiveModel,
  resolveGeminiLiveVoice,
} from '../voice/gemini-live-config.js';
import { issueGeminiLiveRelayTicket } from '../voice/gemini-live-relay.js';
import {
  getAzureDefaultVoice,
  isValidAzureVoiceName,
  synthesizeAzureSpeech,
} from '../voice/azure-tts.js';
import { enforceOpenAiRateLimit } from '../voice/openai-rate-limit.js';
import { safeRecordUsage } from '../usage/usage-ledger.js';
import {
  buildRealtimeClientSecretBody,
  DEFAULT_REALTIME_MODEL,
} from '../voice/realtime-session-config.js';
import {
  listVoiceSessionLogs,
  readVoiceSessionLog,
  upsertVoiceSessionLog,
} from '../voice/voice-session-log.js';
import { diagnoseVoiceSessionLog } from '../voice/voice-session-diagnose.js';
import { appendVoiceRequestLog, listVoiceRequestLogs } from '../voice/voice-request-log.js';

const OPENAI_SPEECH_URL = 'https://api.openai.com/v1/audio/speech';
const OPENAI_TRANSCRIPTION_URL = 'https://api.openai.com/v1/audio/transcriptions';
const OPENAI_CLIENT_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets';
const CLIENT_SECRET_TIMEOUT_MS = 15_000;
const DEFAULT_TTS_MODEL = 'gpt-4o-mini-tts';
const DEFAULT_TTS_VOICE = 'alloy';
const DEFAULT_STT_MODEL = 'gpt-4o-mini-transcribe';
/** The OpenAI limit is 4096 characters; stay below it so a long answer fails loudly here. */
const MAX_SPEECH_INPUT_LENGTH = 4000;
const SPEECH_TIMEOUT_MS = 30_000;
const TRANSCRIPTION_TIMEOUT_MS = 60_000;
/** Base64 inflates by ~4/3 and express.json caps bodies at 8 MB, so keep audio well under it. */
const MAX_AUDIO_UPLOAD_BYTES = 4 * 1024 * 1024;
const ALLOWED_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'];
const AUDIO_EXTENSIONS_BY_MIME = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
};

/**
 * @param {unknown} value
 * @returns {number}
 */
function normalizeSpeed(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(2, Math.max(0.5, parsed));
}

/**
 * Base MIME type without codec parameters, e.g. `audio/webm;codecs=opus`.
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeAudioMimeType(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw.startsWith('audio/')) return 'audio/webm';
  const base = raw.split(';')[0].trim();
  return AUDIO_EXTENSIONS_BY_MIME[base] ? base : 'audio/webm';
}

/**
 * @param {unknown} value
 * @returns {string} two-letter code, or empty when unknown
 */
function normalizeTranscriptionLang(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!/^[a-z]{2}(-[a-z]{2})?$/.test(raw)) return '';
  return raw.slice(0, 2);
}

/**
 * @param {import('express').Request} req
 * @returns {string}
 */
function readRequestHost(req) {
  const headerHost = typeof req.get === 'function' ? req.get('host') : '';
  const raw = String(headerHost || req.headers?.host || 'localhost').trim();
  return raw || 'localhost';
}

/**
 * @param {import('express').Request} req
 * @returns {'http'|'https'}
 */
function readRequestProto(req) {
  if (req.protocol === 'https' || req.secure) return 'https';
  const forwarded = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
  return forwarded === 'https' ? 'https' : 'http';
}

/**
 * Azure has native `pl-PL` voices, so it is offered next to OpenAI whose voices
 * read Polish with an English accent.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string} text
 * @param {(partial: object) => unknown} [record]
 * @returns {Promise<import('express').Response>}
 */
async function speakWithAzure(req, res, text, record = safeRecordUsage) {
  const { key, region } = getEffectiveAzureSpeechCredentials();
  if (!key) {
    return res.status(503).json({
      ok: false,
      error:
        'Azure Speech is not configured — set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION, or save them in the settings.',
    });
  }

  const requestedVoice = typeof req.body?.voice === 'string' ? req.body.voice.trim() : '';
  const lang = normalizeTranscriptionLang(req.body?.lang);
  const voice = isValidAzureVoiceName(requestedVoice)
    ? requestedVoice
    : process.env.CRETLI_AZURE_TTS_VOICE || getAzureDefaultVoice(lang);

  const result = await synthesizeAzureSpeech({
    region,
    key,
    text,
    voice,
    rate: normalizeSpeed(req.body?.speed),
  });
  if (!result.ok) {
    return res
      .status(result.status === 504 ? 504 : 502)
      .json({ ok: false, error: result.error, upstreamStatus: result.status });
  }
  record({
    provider: 'azure',
    feature: 'voice-tts',
    model: 'azure',
    characters: text.length,
    source: 'server',
  });
  return res.json({
    ok: true,
    audioBase64: result.audioBase64,
    mimeType: result.mimeType,
    provider: 'azure',
    voice,
  });
}

/**
 * @param {import('express').Express} app
 * @param {{ recordUsage?: Function, dataDir?: string }} [ctx]
 */
export function registerVoiceRoutes(app, ctx = {}) {
  const record = typeof ctx.recordUsage === 'function' ? ctx.recordUsage : safeRecordUsage;
  const dataDir = String(ctx.dataDir || path.join(process.cwd(), 'data'));
  /**
   * @param {object} entry
   */
  function recordVoiceHttp(entry) {
    try {
      appendVoiceRequestLog(dataDir, entry);
    } catch {
      // Diagnostics must not fail the voice request.
    }
  }
  /** Text to speech: JSON body { text, voice?, speed?, provider?, lang? }. */
  app.post('/api/voice/speak', async (req, res) => {
    if (!enforceOpenAiRateLimit(req, res)) return;

    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) {
      return res.status(400).json({ ok: false, error: 'Missing text' });
    }
    if (text.length > MAX_SPEECH_INPUT_LENGTH) {
      return res.status(413).json({
        ok: false,
        error: `Text too long (max ${MAX_SPEECH_INPUT_LENGTH} characters)`,
      });
    }

    if (req.body?.provider === 'azure') return speakWithAzure(req, res, text, record);

    const apiKey = getEffectiveOpenAiApiKey();
    if (!apiKey) {
      return res.status(503).json({
        ok: false,
        error: 'OpenAI API key is not configured — set OPENAI_API_KEY or save it in the settings.',
      });
    }

    const requestedVoice = typeof req.body?.voice === 'string' ? req.body.voice.trim() : '';
    const voice = ALLOWED_VOICES.includes(requestedVoice)
      ? requestedVoice
      : process.env.CRETLI_VOICE_TTS_VOICE || DEFAULT_TTS_VOICE;
    const model = process.env.CRETLI_VOICE_TTS_MODEL || DEFAULT_TTS_MODEL;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SPEECH_TIMEOUT_MS);
    try {
      const upstream = await fetch(OPENAI_SPEECH_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          voice,
          input: text,
          speed: normalizeSpeed(req.body?.speed),
          response_format: 'mp3',
        }),
        signal: controller.signal,
      });
      if (!upstream.ok) {
        // Upstream error bodies can echo request content; surface only the message.
        const detail = await upstream.text().catch(() => '');
        let message = `OpenAI speech request failed (HTTP ${upstream.status})`;
        try {
          const parsed = JSON.parse(detail);
          if (parsed?.error?.message) message = String(parsed.error.message);
        } catch {
          // Keep the generic message.
        }
        // The client needs the upstream status to tell a passing hiccup from a
        // wall it cannot retry past (no credits, bad key, quota).
        return res.status(502).json({ ok: false, error: message, upstreamStatus: upstream.status });
      }
      const audio = Buffer.from(await upstream.arrayBuffer());
      record({
        provider: 'openai',
        feature: 'voice-tts',
        model,
        characters: text.length,
        source: 'server',
      });
      return res.json({
        ok: true,
        audioBase64: audio.toString('base64'),
        mimeType: 'audio/mpeg',
        model,
        voice,
      });
    } catch {
      const aborted = controller.signal.aborted;
      return res.status(aborted ? 504 : 502).json({
        ok: false,
        error: aborted ? 'OpenAI speech request timed out' : 'OpenAI speech request failed',
      });
    } finally {
      clearTimeout(timeoutId);
    }
  });

  /** Speech to text: JSON body { base64, mimeType?, lang? } -> { text }. */
  app.post('/api/voice/transcribe', async (req, res) => {
    if (!enforceOpenAiRateLimit(req, res)) return;

    const apiKey = getEffectiveOpenAiApiKey();
    if (!apiKey) {
      return res.status(503).json({
        ok: false,
        error: 'OpenAI API key is not configured — set OPENAI_API_KEY or save it in the settings.',
      });
    }

    const rawBase64 = typeof req.body?.base64 === 'string' ? req.body.base64.trim() : '';
    const base64 = rawBase64.includes(',') ? rawBase64.slice(rawBase64.indexOf(',') + 1) : rawBase64;
    if (!base64) {
      return res.status(400).json({ ok: false, error: 'Missing audio' });
    }
    let audio;
    try {
      audio = Buffer.from(base64, 'base64');
    } catch {
      return res.status(400).json({ ok: false, error: 'Invalid base64' });
    }
    if (audio.length < 512) {
      return res.status(400).json({ ok: false, error: 'Recording too short' });
    }
    if (audio.length > MAX_AUDIO_UPLOAD_BYTES) {
      return res.status(413).json({ ok: false, error: 'Recording too large (max 4 MB)' });
    }

    const mimeType = normalizeAudioMimeType(req.body?.mimeType);
    const model = process.env.CRETLI_VOICE_STT_MODEL || DEFAULT_STT_MODEL;
    const form = new FormData();
    form.append('model', model);
    form.append('response_format', 'json');
    form.append(
      'file',
      new Blob([audio], { type: mimeType }),
      `recording.${AUDIO_EXTENSIONS_BY_MIME[mimeType] || 'webm'}`
    );
    const lang = normalizeTranscriptionLang(req.body?.lang);
    if (lang) form.append('language', lang);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TRANSCRIPTION_TIMEOUT_MS);
    try {
      const upstream = await fetch(OPENAI_TRANSCRIPTION_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: controller.signal,
      });
      const payload = await upstream.json().catch(() => null);
      if (!upstream.ok) {
        const message = payload?.error?.message
          ? String(payload.error.message)
          : `OpenAI transcription failed (HTTP ${upstream.status})`;
        return res.status(502).json({ ok: false, error: message, upstreamStatus: upstream.status });
      }
      const durationSec = Number(req.body?.durationSec);
      record({
        provider: 'openai',
        feature: 'voice-stt',
        model,
        audioSeconds: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0,
        estimated: !(Number.isFinite(durationSec) && durationSec > 0),
        source: 'server',
      });
      return res.json({ ok: true, text: String(payload?.text || '').trim(), model });
    } catch {
      const aborted = controller.signal.aborted;
      return res.status(aborted ? 504 : 502).json({
        ok: false,
        error: aborted ? 'OpenAI transcription timed out' : 'OpenAI transcription failed',
      });
    } finally {
      clearTimeout(timeoutId);
    }
  });

  /**
   * Mints an ephemeral Realtime token. Instructions, tools and audio settings
   * come from the server config, so the browser cannot change them.
   */
  app.post('/api/voice/realtime-token', async (req, res) => {
    if (!enforceOpenAiRateLimit(req, res)) return;

    const apiKey = getEffectiveOpenAiApiKey();
    if (!apiKey) {
      return res.status(503).json({
        ok: false,
        error: 'OpenAI API key is not configured — set OPENAI_API_KEY or save it in the settings.',
      });
    }

    const body = buildRealtimeClientSecretBody({
      lang: normalizeTranscriptionLang(req.body?.lang),
      voice: typeof req.body?.voice === 'string' ? req.body.voice : '',
      model: typeof req.body?.model === 'string' ? req.body.model : '',
    });
    const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
    const startedAt = Date.now();
    let status = 200;
    let error = '';

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CLIENT_SECRET_TIMEOUT_MS);
    try {
      const upstream = await fetch(OPENAI_CLIENT_SECRETS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = await upstream.json().catch(() => null);
      if (!upstream.ok || !payload?.value) {
        const message = payload?.error?.message
          ? String(payload.error.message)
          : `OpenAI realtime token request failed (HTTP ${upstream.status})`;
        status = 502;
        error = message;
        return res.status(502).json({ ok: false, error: message });
      }
      return res.json({
        ok: true,
        clientSecret: payload.value,
        expiresAt: payload.expires_at || null,
        model: body.session.model || DEFAULT_REALTIME_MODEL,
        voice: body.session.audio?.output?.voice || '',
      });
    } catch {
      const aborted = controller.signal.aborted;
      status = aborted ? 504 : 502;
      error = aborted ? 'OpenAI realtime token request timed out' : 'OpenAI realtime token request failed';
      return res.status(status).json({
        ok: false,
        error,
      });
    } finally {
      clearTimeout(timeoutId);
      recordVoiceHttp({
        route: '/api/voice/realtime-token',
        method: 'POST',
        status,
        durationMs: Date.now() - startedAt,
        sessionId,
        model: body.session.model || DEFAULT_REALTIME_MODEL,
        error,
      });
    }
  });

  /**
   * Issues a same-origin Gemini Live relay ticket. The Google key stays on
   * the server; setup (instructions, tools, voice) is pinned here.
   */
  app.post('/api/voice/gemini-live-token', async (req, res) => {
    if (!enforceOpenAiRateLimit(req, res)) return;

    const apiKey = getEffectiveGeminiApiKey();
    if (!apiKey) {
      return res.status(503).json({
        ok: false,
        error: 'Gemini API key is not configured — set GEMINI_API_KEY or save it in the settings.',
      });
    }

    const startedAt = Date.now();
    const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
    const lang = normalizeTranscriptionLang(req.body?.lang);
    const voice = resolveGeminiLiveVoice(req.body?.voice);
    const model = resolveGeminiLiveModel(req.body?.model);
    const setup = buildGeminiLiveSetup({ lang, voice, model });
    const ticket = issueGeminiLiveRelayTicket();
    const host = readRequestHost(req);
    const proto = readRequestProto(req);
    recordVoiceHttp({
      route: '/api/voice/gemini-live-token',
      method: 'POST',
      status: 200,
      durationMs: Date.now() - startedAt,
      sessionId,
      model,
    });
    return res.json({
      ok: true,
      token: ticket,
      wsUrl: buildGeminiLiveRelayClientUrl({ host, proto, ticket }),
      expiresAt: new Date(Date.now() + GEMINI_LIVE_RELAY_TICKET_TTL_MS).toISOString(),
      model,
      voice,
      setup,
    });
  });

  /**
   * Checks that the effective (or just-pasted) Gemini key is accepted by Google.
   * Does not persist an unsaved paste and never returns the key.
   */
  app.post('/api/voice/gemini-probe', async (req, res) => {
    if (!enforceOpenAiRateLimit(req, res)) return;
    const pasted = typeof req.body?.geminiApiKey === 'string' ? req.body.geminiApiKey.trim() : '';
    if (pasted && !isValidGeminiApiKeyFormat(pasted)) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid Gemini API key — it must start with AIza or AQ.',
      });
    }
    const apiKey = pasted || getEffectiveGeminiApiKey();
    if (!apiKey) {
      return res.status(503).json({
        ok: false,
        error: 'Gemini API key is not configured — save it first or set GEMINI_API_KEY.',
      });
    }
    const result = await probeGeminiApiKey({ apiKey });
    if (!result.ok) {
      return res.status(result.status && result.status >= 400 && result.status < 600 ? result.status : 502).json({
        ok: false,
        error: result.error,
      });
    }
    return res.json({ ok: true, model: result.model || null });
  });

  app.get('/api/voice/sessions', (req, res) => {
    try {
      const limit = Number(req.query?.limit);
      const sessions = listVoiceSessionLogs(dataDir, limit);
      return res.json({ ok: true, sessions });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ ok: false, error: message });
    }
  });

  app.get('/api/voice/requests', (req, res) => {
    try {
      const limit = Number(req.query?.limit);
      const requests = listVoiceRequestLogs(dataDir, limit);
      return res.json({ ok: true, requests });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ ok: false, error: message });
    }
  });

  app.get('/api/voice/sessions/:sessionId', (req, res) => {
    try {
      const session = readVoiceSessionLog(dataDir, req.params.sessionId);
      if (!session) return res.status(404).json({ ok: false, error: 'Voice session not found' });
      const wantDiagnose = req.query?.diagnose === '1' || req.query?.diagnose === 'true';
      if (!wantDiagnose) return res.json({ ok: true, session });
      return res.json({ ok: true, session, diagnosis: diagnoseVoiceSessionLog(session) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes('Invalid voice session id') ? 400 : 500;
      return res.status(status).json({ ok: false, error: message });
    }
  });

  app.post('/api/voice/sessions/:sessionId/events', (req, res) => {
    try {
      const result = upsertVoiceSessionLog(dataDir, req.params.sessionId, {
        startedAt: req.body?.startedAt,
        endedAt: req.body?.endedAt,
        provider: req.body?.provider,
        model: req.body?.model,
        chatId: req.body?.chatId,
        entries: req.body?.entries,
      });
      return res.json({ ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes('Invalid voice session id') ? 400 : 500;
      return res.status(status).json({ ok: false, error: message });
    }
  });
}
