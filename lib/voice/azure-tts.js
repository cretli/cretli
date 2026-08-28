/**
 * Azure Speech text-to-speech over the REST endpoint.
 *
 * Azure is here for one reason: it has native `pl-PL` neural voices, while the
 * OpenAI voices are trained on English and read Polish with an accent.
 *
 * The endpoint speaks SSML, which is also how rate is set — the REST API has no
 * `speed` field.
 */

const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const OUTPUT_MIME_TYPE = 'audio/mpeg';
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Curated voices offered in the UI. Any other valid Azure voice name still
 * works — the list is a shortcut, not a whitelist.
 */
export const AZURE_TTS_VOICES = [
  'pl-PL-AgnieszkaNeural',
  'pl-PL-MarekNeural',
  'pl-PL-ZofiaNeural',
  'en-US-AvaMultilingualNeural',
  'en-US-AndrewMultilingualNeural',
];

export const AZURE_DEFAULT_VOICES = {
  pl: 'pl-PL-AgnieszkaNeural',
  en: 'en-US-AvaMultilingualNeural',
};

/**
 * Voice names look like `pl-PL-AgnieszkaNeural`, and the HD ones like
 * `en-US-Ava:DragonHDLatestNeural`. Validating the shape keeps arbitrary text
 * out of the SSML attribute without pinning the list to today's catalogue.
 */
const VOICE_NAME_PATTERN = /^[a-z]{2,3}(-[A-Za-z]{2,8})?-[A-Za-z0-9:]+$/;

/**
 * @param {unknown} voice
 * @returns {boolean}
 */
export function isValidAzureVoiceName(voice) {
  const raw = String(voice || '').trim();
  return raw.length <= 64 && VOICE_NAME_PATTERN.test(raw);
}

/**
 * @param {string} lang two-letter UI language
 * @returns {string}
 */
export function getAzureDefaultVoice(lang) {
  return AZURE_DEFAULT_VOICES[String(lang || '').slice(0, 2)] || AZURE_DEFAULT_VOICES.en;
}

/**
 * @param {string} voice
 * @returns {string} locale taken from the voice name, e.g. `pl-PL`
 */
function localeFromVoice(voice) {
  const parts = String(voice).split('-');
  return parts.length >= 2 ? `${parts[0]}-${parts[1]}` : 'en-US';
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * @param {number} rate multiplier, 1 means unchanged
 * @returns {string} SSML percentage, empty when there is nothing to change
 */
function toProsodyRate(rate) {
  const parsed = Number(rate);
  if (!Number.isFinite(parsed)) return '';
  const clamped = Math.min(2, Math.max(0.5, parsed));
  const percent = Math.round((clamped - 1) * 100);
  if (percent === 0) return '';
  return `${percent > 0 ? '+' : ''}${percent}%`;
}

/**
 * @param {{ text: string, voice: string, rate?: number }} params
 * @returns {string}
 */
export function buildSpeechSsml({ text, voice, rate }) {
  const locale = localeFromVoice(voice);
  const prosodyRate = toProsodyRate(rate);
  const body = escapeXml(text);
  const inner = prosodyRate ? `<prosody rate="${prosodyRate}">${body}</prosody>` : body;
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}">` +
    `<voice name="${escapeXml(voice)}">${inner}</voice>` +
    '</speak>'
  );
}

/**
 * @param {{ region: string, key: string, text: string, voice: string, rate?: number }} params
 * @returns {Promise<{ ok: true, audioBase64: string, mimeType: string }
 *   | { ok: false, error: string, status: number }>}
 */
export async function synthesizeAzureSpeech({ region, key, text, voice, rate }) {
  const url = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': OUTPUT_FORMAT,
        // Azure rejects requests without a User-Agent.
        'User-Agent': 'cretli',
      },
      body: buildSpeechSsml({ text, voice, rate }),
      signal: controller.signal,
    });
    if (!upstream.ok) {
      const detail = (await upstream.text().catch(() => '')).slice(0, 300);
      return {
        ok: false,
        status: upstream.status,
        error: detail || `Azure Speech failed with HTTP ${upstream.status}`,
      };
    }
    const buffer = Buffer.from(await upstream.arrayBuffer());
    return { ok: true, audioBase64: buffer.toString('base64'), mimeType: OUTPUT_MIME_TYPE };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    if (aborted) return { ok: false, status: 504, error: 'Azure Speech timed out' };
    // A bare "could not reach" hides the usual cause: a region that does not
    // exist, or a key from a different service pasted into the Azure field.
    const cause = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: 502,
      error: `Could not reach Azure Speech at ${region} (${cause})`,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
