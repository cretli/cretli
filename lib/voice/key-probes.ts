/**
 * Cheap credential checks for the OpenAI and Azure Speech engines. Neither
 * synthesizes audio nor bills: OpenAI lists models, Azure exchanges the
 * subscription key for a short-lived token.
 */

const PROBE_TIMEOUT_MS = 12_000;

export const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';

export type KeyProbeResult = { ok: boolean; status?: number; error?: string };

async function timedFetch(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  label: string
): Promise<{ response?: Response; error?: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetchFn(url, { ...init, signal: controller.signal });
    return { response };
  } catch {
    return { error: controller.signal.aborted ? `${label} key check timed out` : `${label} key check failed` };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function probeOpenAiApiKey(options: { apiKey: string; fetchFn?: typeof fetch }): Promise<KeyProbeResult> {
  const apiKey = String(options.apiKey || '').trim();
  if (!apiKey) return { ok: false, error: 'OpenAI API key is not configured' };
  const { response, error } = await timedFetch(
    options.fetchFn || fetch,
    OPENAI_MODELS_URL,
    { headers: { Authorization: `Bearer ${apiKey}` } },
    'OpenAI'
  );
  if (!response) return { ok: false, error };
  if (response.ok) return { ok: true };
  const payload = (await response.json().catch(() => null)) as { error?: { message?: unknown } } | null;
  return {
    ok: false,
    status: response.status,
    error: payload?.error?.message ? String(payload.error.message) : `OpenAI key check failed (HTTP ${response.status})`,
  };
}

export async function probeAzureSpeechKey(options: {
  key: string;
  region: string;
  fetchFn?: typeof fetch;
}): Promise<KeyProbeResult> {
  const key = String(options.key || '').trim();
  const region = String(options.region || '').trim().toLowerCase();
  if (!key || !region) return { ok: false, error: 'Azure Speech key and region are not configured' };
  const { response, error } = await timedFetch(
    options.fetchFn || fetch,
    `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`,
    { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': key, 'Content-Length': '0' } },
    'Azure Speech'
  );
  if (!response) return { ok: false, error };
  if (response.ok) return { ok: true };
  const detail =
    response.status === 401 || response.status === 403
      ? 'the key was rejected for this region'
      : `HTTP ${response.status}`;
  return { ok: false, status: response.status, error: `Azure Speech key check failed (${detail})` };
}
