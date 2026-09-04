/**
 * Cheap Gemini key check: list one model. No generation, no Live session.
 */

export const GEMINI_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1';
const PROBE_TIMEOUT_MS = 12_000;

/**
 * @param {{ apiKey: string, fetchFn?: typeof fetch }} options
 * @returns {Promise<{ ok: boolean, model?: string, status?: number, error?: string }>}
 */
export async function probeGeminiApiKey(options) {
  const apiKey = String(options.apiKey || '').trim();
  if (!apiKey) return { ok: false, error: 'Gemini API key is not configured' };
  const fetchFn = options.fetchFn || fetch;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const upstream = await fetchFn(GEMINI_MODELS_URL, {
      headers: { 'x-goog-api-key': apiKey },
      signal: controller.signal,
    });
    const payload = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      const error = payload?.error?.message
        ? String(payload.error.message)
        : `Gemini key check failed (HTTP ${upstream.status})`;
      return { ok: false, status: upstream.status, error };
    }
    const name = String(payload?.models?.[0]?.name || '').replace(/^models\//, '');
    return { ok: true, model: name || undefined };
  } catch {
    const aborted = controller.signal.aborted;
    return {
      ok: false,
      error: aborted ? 'Gemini key check timed out' : 'Gemini key check failed',
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
